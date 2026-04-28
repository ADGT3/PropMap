/**
 * domain-api.js
 * Domain Developer API layer for the Sydney Property Map.
 *
 * Live mode:  calls /api/domain-search (server proxy → Domain API)
 * Mock mode:  returns enriched local listings from data.js (no network)
 *
 * Toggle: set DOMAIN_API_MOCK = false to go live.
 * API key lives in the DOMAIN_API_KEY Vercel environment variable — never in this file.
 */

// ─── In-memory cache: id → normalised listing, address → normalised listing ──
const _enrichmentCache = {};
const _addressCache = {};  // normalised lowercase address → listing

// ─── Search payload builder ───────────────────────────────────────────────────
// Builds the POST body for POST /v1/listings/residential/_search
// Adjust suburbs / filters to match your target pipeline area.

function buildSearchPayload(options = {}) {
  const {
    suburbs               = [],
    minBeds               = null,
    maxBeds               = null,
    minBaths              = null,
    minCars               = null,
    minPrice              = null,
    maxPrice              = null,
    minLand               = null,
    maxLand               = null,
    propertyTypes         = [],
    propertyFeatures      = [],
    listingAttributes     = [],
    establishedType       = null,
    excludePriceWithheld  = false,
    excludeDepositTaken   = false,
    newDevOnly            = false,
    listingTypes          = ['Sale'],
    listedSince           = null,   // ISO 8601 datetime — filters to listings created on/after this
    pageNumber            = 1,
    pageSize              = 100,
    sort                  = { sortKey: 'Default', direction: 'Descending' },
    geoWindow             = null,
  } = options;

  const payload = {
    listingType:            listingTypes[0] || 'Sale',
    pageNumber,
    pageSize,
    sort,
    propertyTypes:          propertyTypes.length          ? propertyTypes         : undefined,
    propertyFeatures:       propertyFeatures.length       ? propertyFeatures      : undefined,
    listingAttributes:      listingAttributes.length      ? listingAttributes     : undefined,
    propertyEstablishedType: establishedType              ? establishedType       : undefined,
    excludePriceWithheld:   excludePriceWithheld          ? true                  : undefined,
    excludeDepositTaken:    excludeDepositTaken           ? true                  : undefined,
    newDevOnly:             newDevOnly                    ? true                  : undefined,
    listedSince:            listedSince                   || undefined,
    geoWindow:              geoWindow                     || undefined,
    locations: !geoWindow
      ? suburbs.length
        ? suburbs.map(suburb => ({
            state: 'NSW', region: '', area: '', suburb, postCode: '',
            includeSurroundingSuburbs: false,
          }))
        : [{ state: 'NSW', region: '', area: '', suburb: '', postCode: '', includeSurroundingSuburbs: false }]
      : undefined,
    minBedrooms:  minBeds  ?? undefined,
    maxBedrooms:  maxBeds  ?? undefined,
    minBathrooms: minBaths ?? undefined,
    minCarspaces: minCars  ?? undefined,
    minPrice:     minPrice ?? undefined,
    maxPrice:     maxPrice ?? undefined,
    minLandArea:  minLand  ?? undefined,
    maxLandArea:  maxLand  ?? undefined,
  };

  return JSON.parse(JSON.stringify(payload));
}

// ─── Live API call via server proxy ──────────────────────────────────────────

async function fetchOnePage(options = {}) {
  const payload = buildSearchPayload(options);

  const res = await fetch('/api/domain-search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Domain proxy error ${res.status}: ${err.error || res.statusText}`);
  }

  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

async function liveSearch(options = {}) {
  const MAX_RESULTS = 100;
  const PAGE_SIZE   = 100;
  const allRaw      = [];
  let   page        = 1;

  while (allRaw.length < MAX_RESULTS) {
    const pageRaw = await fetchOnePage({ ...options, pageNumber: page, pageSize: PAGE_SIZE });
    allRaw.push(...pageRaw);
    if (pageRaw.length < PAGE_SIZE) break;   // no more pages
    if (allRaw.length >= MAX_RESULTS) break; // hit cap
    page++;
  }

  const results = allRaw.slice(0, MAX_RESULTS)
    .map(normaliseLiveListing)
    .filter(Boolean); // drops Project-type items

  results.forEach(l => {
    _enrichmentCache[String(l.id)] = l;
    if (l.address) _addressCache[l.address.toLowerCase()] = l;
  });
  return results;
}

// (fetchOnePage used by liveSearch above)
function _unusedPlaceholder() {}

// ─── Normalise live Domain listing → app shape ────────────────────────────────
// Maps Domain's response fields to the structure map.js and kanban.js consume.

function normaliseLiveListing(item) {
  // Response wraps each result as { type: "PropertyListing", listing: { ... } }
  // or { type: "Project", listings: [...], project: { ... } }
  // We only handle PropertyListing here; skip Project types.
  if (item.type === 'Project') return null;
  const listing = item.listing || item;

  const pd    = listing.propertyDetails || {};
  const price = listing.priceDetails    || {};

  // Build listing URL from slug if available (cleaner), else fall back to id
  const listingUrl = listing.listingSlug
    ? `https://www.domain.com.au/${listing.listingSlug}`
    : `https://www.domain.com.au/${listing.id}`;

  // Agent contact: contacts[0] per API docs
  const contact = listing.advertiser?.contacts?.[0] || null;
  const agencyName = listing.advertiser?.name || '';

  return {
    // Identity
    id:         String(listing.id),
    domainId:   listing.id,
    listingUrl,

    // Location — coordinates live directly on propertyDetails per API docs
    lat:     pd.latitude  ?? null,
    lng:     pd.longitude ?? null,
    address: pd.displayableAddress || [pd.streetNumber, pd.street].filter(Boolean).join(' '),
    suburb:  pd.suburb   || '',
    state:   pd.state    || 'NSW',
    postcode: pd.postcode || '',

    // Property details
    type:        (pd.propertyType || 'residential').toLowerCase(),
    beds:        pd.bedrooms  ?? 0,
    baths:       pd.bathrooms ?? 0,
    cars:        pd.carspaces ?? 0,
    landAreaSqm: pd.landArea  ?? null,
    headline:    listing.headline         || '',
    summary:     listing.summaryDescription || '',  // API field is summaryDescription

    // Price — Domain requires agents to populate priceFrom/priceTo accurately,
    // even when displayPrice is text like "Contact Agent" or "Auction".
    // Treat from/to as source of truth; only keep displayPrice if it contains a $ figure.
    price: (() => {
      const from = price.priceFrom ?? null;
      const to   = price.priceTo   ?? null;
      const exact = price.price    ?? null;
      const dp = price.displayPrice || '';
      // Only keep displayPrice if it actually contains a dollar amount
      const dpHasNumber = typeof dp === 'string' && /\$\s?\d/.test(dp);
      return {
        display: dpHasNumber ? dp : '',
        from:    from ?? exact,
        to:      to   ?? exact,
      };
    })(),

    // Agent / agency
    advertiser: listing.advertiser || null,
    agent: contact ? {
      name:     contact.name         || '',
      photoUrl: contact.photoUrl     || '',
      email:    contact.email        || '',
      phone:    contact.phoneNumber  || contact.mobile || contact.phone || '',
      agency:   agencyName,
    } : (agencyName ? { name: '', photoUrl: '', email: '', phone: '', agency: agencyName } : null),

    // Media
    photos: (listing.media || [])
      .filter(m => m.category === 'Image')
      .map(m => ({ url: m.url })),

    // Metadata
    daysOnMarket: listing.daysOnMarket ?? null,
    dateListed:   listing.dateListed   || null,  // API field is dateListed
    status:       listing.status       || 'Live',

    _raw: listing,
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

const DomainAPI = {
  /**
   * Search residential listings via live Domain API.
   * @param {object} options  - geoWindow, propertyTypes, minBeds, maxBeds, minPrice, maxPrice, etc.
   * @returns {Promise<Array>} normalised listing objects
   */
  async search(options = {}) {
    try {
      return await liveSearch(options);
    } catch (err) {
      console.error('[DomainAPI] search() failed:', err);
      throw err;
    }
  },

  /** Synchronous cache lookup by listing id */
  getEnrichedListing(id) {
    return _enrichmentCache[String(id)] || null;
  },

  /** Synchronous cache lookup by address string (case-insensitive) */
  getEnrichedByAddress(address) {
    if (!address) return null;
    return _addressCache[address.toLowerCase()] || null;
  },

  /** Always live */
  isMock() { return false; },
  isLive: true,
};

// Make available globally (loaded via <script> tag)
if (typeof window !== 'undefined') window.DomainAPI = DomainAPI;
