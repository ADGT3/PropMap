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

const DOMAIN_API_MOCK = false;   // ← switched to LIVE

// ─── Search payload builder ───────────────────────────────────────────────────
// Builds the POST body for POST /v1/listings/residential/_search
// Adjust suburbs / filters to match your target pipeline area.

function buildSearchPayload(options = {}) {
  const {
    suburbs        = [],          // e.g. ['Leppington', 'Edmondson Park']
    minBeds        = null,
    maxBeds        = null,
    minPrice       = null,
    maxPrice       = null,
    propertyTypes  = [],          // e.g. ['House', 'Land']
    listingTypes   = ['Sale'],    // 'Sale' | 'Rent' | 'Share'
    pageNumber     = 1,
    pageSize       = 100,         // capped at 100
    sort           = { sortKey: 'Default', direction: 'Descending' },
  } = options;

  const payload = {
    listingType: listingTypes[0] || 'Sale',
    pageNumber,
    pageSize,
    sort,
    propertyTypes: propertyTypes.length ? propertyTypes : undefined,
    locations: suburbs.length
      ? suburbs.map(suburb => ({
          state: 'NSW',
          suburb,
          includeSurroundingSuburbs: false,
        }))
      : undefined,
    minBedrooms: minBeds  ?? undefined,
    maxBedrooms: maxBeds  ?? undefined,
    minPrice:    minPrice ?? undefined,
    maxPrice:    maxPrice ?? undefined,
  };

  // Remove undefined keys so Domain doesn't complain
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

  results.forEach(l => { _enrichmentCache[String(l.id)] = l; });
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

  // Agent contact: contacts[0].name is a full name string per API docs
  const contact = listing.advertiser?.contacts?.[0] || null;

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

    // Price — API uses priceFrom/priceTo, with price as exact if known
    price: {
      display: price.displayPrice || '',
      from:    price.priceFrom    ?? price.price ?? null,
      to:      price.priceTo      ?? null,
    },

    // Agent / agency
    advertiser: listing.advertiser || null,
    agent: contact ? { name: contact.name, photoUrl: contact.photoUrl } : null,

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

// ─── Mock enrichment (kept for fallback / offline dev) ───────────────────────

const MOCK_AGENCIES = [
  { id: 'ray-white-parramatta',     name: 'Ray White Parramatta',     phone: '(02) 9630 0000' },
  { id: 'mcgrath-camden',           name: 'McGrath Camden',            phone: '(02) 4655 1111' },
  { id: 'lj-hooker-campbelltown',   name: 'LJ Hooker Campbelltown',   phone: '(02) 4625 2222' },
  { id: 'century21-penrith',        name: 'Century 21 Penrith',       phone: '(02) 4731 3333' },
  { id: 'harcourts-liverpool',      name: 'Harcourts Liverpool',      phone: '(02) 9822 4444' },
  { id: 'raine-horne-blacktown',    name: 'Raine & Horne Blacktown',  phone: '(02) 9622 5555' },
  { id: 'professionals-rouse-hill', name: 'Professionals Rouse Hill', phone: '(02) 8882 6666' },
  { id: 'first-national-kellyville',name: 'First National Kellyville',phone: '(02) 8883 7777' },
];

const MOCK_AGENTS = [
  { firstName: 'James',   lastName: 'Chen',      mobile: '0411 111 001' },
  { firstName: 'Sarah',   lastName: 'Williams',  mobile: '0422 222 002' },
  { firstName: 'Michael', lastName: 'Nguyen',    mobile: '0433 333 003' },
  { firstName: 'Emma',    lastName: 'Thompson',  mobile: '0444 444 004' },
  { firstName: 'David',   lastName: 'Patel',     mobile: '0455 555 005' },
  { firstName: 'Jessica', lastName: 'Kim',       mobile: '0466 666 006' },
  { firstName: 'Andrew',  lastName: 'Murphy',    mobile: '0477 777 007' },
  { firstName: 'Olivia',  lastName: 'Hassan',    mobile: '0488 888 008' },
];

function seededRand(seed) {
  let s = seed;
  return () => { s = (s * 1664525 + 1013904223) & 0xffffffff; return Math.abs(s) / 0x7fffffff; };
}

function mockListingId(listing) {
  return 2000000 + parseInt(listing.id || 0, 10) * 7919;
}

function mockPrice(listing) {
  const base = { house: 950000, land: 620000, unit: 680000, townhouse: 780000 };
  const b = base[listing.type] || 800000;
  const rand = seededRand(parseInt(listing.id || 1, 10));
  const from = Math.round((b + (rand() - 0.5) * 200000) / 5000) * 5000;
  return { display: `$${from.toLocaleString()}`, from, to: null };
}

function enrichMockListing(listing) {
  const rand    = seededRand(parseInt(listing.id || 1, 10));
  const agency  = MOCK_AGENCIES[Math.floor(rand() * MOCK_AGENCIES.length)];
  const agent   = MOCK_AGENTS[Math.floor(rand()  * MOCK_AGENTS.length)];
  const dom     = Math.floor(rand() * 90) + 1;

  return {
    id:          String(listing.id),
    domainId:    mockListingId(listing),
    listingUrl:  `https://www.domain.com.au/property-profile/${listing.address.toLowerCase().replace(/\s+/g, '-')}-${listing.suburb.toLowerCase().replace(/\s+/g, '-')}-nsw-${mockListingId(listing)}`,
    lat:         listing.lat,
    lng:         listing.lng,
    address:     listing.address,
    suburb:      listing.suburb,
    state:       'NSW',
    postcode:    '',
    type:        listing.type,
    beds:        listing.beds,
    baths:       listing.baths,
    cars:        listing.cars,
    landAreaSqm: listing.type === 'land' ? Math.round(300 + rand() * 400) : null,
    headline:    `${listing.beds > 0 ? listing.beds + ' Bed ' : ''}${listing.type.charAt(0).toUpperCase() + listing.type.slice(1)} in ${listing.suburb}`,
    summary:     `A great opportunity in ${listing.suburb}. Contact ${agent.firstName} for more details.`,
    price:       mockPrice(listing),
    advertiser:  { id: agency.id, name: agency.name, phone: agency.phone },
    agent:       { firstName: agent.firstName, lastName: agent.lastName, mobile: agent.mobile },
    photos:      [],
    daysOnMarket: dom,
    dateListed:  null,
    status:      'Live',
    _raw:        listing,
  };
}

async function mockSearch(options = {}) {
  // Simulate latency
  await new Promise(r => setTimeout(r, 400 + Math.random() * 400));

  if (typeof listings === 'undefined') {
    console.warn('[DomainAPI] Mock mode: listings[] not found — is data.js loaded?');
    return [];
  }

  let results = listings.map(enrichMockListing);

  const { suburbs, minBeds, maxBeds, minPrice, maxPrice, propertyTypes } = options;

  if (suburbs?.length) {
    results = results.filter(l => suburbs.some(s => l.suburb.toLowerCase() === s.toLowerCase()));
  }
  if (minBeds  != null) results = results.filter(l => l.beds  >= minBeds);
  if (maxBeds  != null) results = results.filter(l => l.beds  <= maxBeds);
  if (minPrice != null) results = results.filter(l => l.price.from == null || l.price.from >= minPrice);
  if (maxPrice != null) results = results.filter(l => l.price.from == null || l.price.from <= maxPrice);
  if (propertyTypes?.length) {
    results = results.filter(l => propertyTypes.some(t => l.type === t.toLowerCase()));
  }

  return results;
}

// ─── Public API ───────────────────────────────────────────────────────────────

const DomainAPI = {
  /**
   * Search residential listings.
   * @param {object} options  - suburbs, minBeds, maxBeds, minPrice, maxPrice, propertyTypes, pageSize
   * @returns {Promise<Array>} normalised listing objects
   */
  async search(options = {}) {
    try {
      return DOMAIN_API_MOCK ? await mockSearch(options) : await liveSearch(options);
    } catch (err) {
      console.error('[DomainAPI] search() failed:', err);
      throw err;
    }
  },

  /**
   * Get a single listing by Domain listing ID.
   * In mock mode returns the enriched mock object; in live mode fetches from proxy.
   */
  async getListing(id) {
    if (DOMAIN_API_MOCK) {
      const all = await mockSearch();
      return all.find(l => String(l.domainId) === String(id) || String(l.id) === String(id)) || null;
    }

    const res = await fetch(`/api/domain-listing/${id}`);
    if (!res.ok) return null;
    const data = await res.json();
    return normaliseLiveListing(data);
  },

  /** Synchronous cache lookup — used by map.js for badge/link display */
  getEnrichedListing(id) {
    return _enrichmentCache[String(id)] || null;
  },

  /** Returns true when running in mock mode */
  isMock() {
    return DOMAIN_API_MOCK;
  },

  isLive: !DOMAIN_API_MOCK,
};

// Make available globally (loaded via <script> tag)
if (typeof window !== 'undefined') window.DomainAPI = DomainAPI;
