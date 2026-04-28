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

  // Diagnostic: log any listings where we can't show a usable price.
  // Helps identify whether the agent has truly omitted price data, or
  // whether our normaliser is dropping something useful.
  const missingPrice = results.filter(l => {
    const p = l.price || {};
    const hasRange = p.from || p.to;
    const hasNumericDisplay = typeof p.display === 'string' && /\$\s?\d/.test(p.display);
    return !hasRange && !hasNumericDisplay;
  });
  if (missingPrice.length) {
    console.warn(`[DomainAPI] ${missingPrice.length} of ${results.length} listings lack a usable price.`,
      'Sample raw priceDetails:',
      missingPrice.slice(0, 3).map(l => ({
        id: l.id,
        address: l.address,
        priceDetails: l._raw?.priceDetails,
      }))
    );
  }

  results.forEach(l => {
    _enrichmentCache[String(l.id)] = l;
    if (l.address) _addressCache[l.address.toLowerCase()] = l;
  });

  // Hydrate cached derived price estimates from the server.
  // For listings WITHOUT a real price → apply the cached estimate (if any).
  // For listings WITH a real price → invalidate the cache (Domain has updated).
  await hydrateDerivedPrices(results);

  return results;
}

// ─── Derived price helpers ────────────────────────────────────────────────────
// "Reveal Price" workflow: for listings with a withheld price (displayPrice
// = "Contact Agent" etc, no priceFrom/priceTo), probe Domain by repeating
// the search at known price brackets and noting which listings drop out.
// Result is cached server-side in domain_price_estimates so it persists
// across sessions and is shared with the kanban modal.

const ESTIMATES_ENDPOINT = '/api/domain-price-estimates';

// Bracket array — per agreement with user. Ascending order.
// Implicit floor (<1M) and ceiling (>30M) handled by probe logic.
const PRICE_BRACKETS = [1000000, 1500000, 2000000, 3000000, 4000000,
                        5000000, 7500000, 10000000, 15000000, 20000000, 30000000];

function listingHasRealPrice(l) {
  const p = l.price || {};
  if (p.from || p.to) return true;
  if (typeof p.display === 'string' && /\$\s?\d/.test(p.display)) return true;
  return false;
}

// Pull cached estimates from server; merge into results; invalidate any
// rows where Domain now returns a real price.
async function hydrateDerivedPrices(results) {
  if (!results.length) return;

  const idsToCheck = results.map(l => String(l.id)).filter(Boolean);
  if (!idsToCheck.length) return;

  let cached = {};
  try {
    const url = `${ESTIMATES_ENDPOINT}?ids=${encodeURIComponent(idsToCheck.join(','))}`;
    const res = await fetch(url);
    if (res.ok) cached = await res.json();
  } catch (err) {
    console.warn('[DomainAPI] hydrateDerivedPrices: lookup failed', err);
    return;
  }

  const toInvalidate = [];
  results.forEach(l => {
    const cachedEntry = cached[String(l.id)];
    if (!cachedEntry) return;

    if (listingHasRealPrice(l)) {
      // Domain now has a real price → wipe stale estimate
      toInvalidate.push(String(l.id));
      return;
    }

    // Apply derived range to the listing's price object.
    // Mark with derived: true so renderers can show "(est.)" indicator.
    l.price = {
      ...(l.price || {}),
      from:    cachedEntry.from,
      to:      cachedEntry.to,
      derived: true,
    };
  });

  // Fire-and-forget invalidations
  toInvalidate.forEach(id => {
    fetch(`${ESTIMATES_ENDPOINT}?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
      .catch(err => console.warn('[DomainAPI] invalidate failed for', id, err));
  });
}

// Run a single price-bracket probe. Returns the set of listing IDs that
// were present in the result set when filtered with minPrice = bracket.
async function probeBracket(geoWindow, bracket, baseOptions) {
  const probeOptions = {
    ...(baseOptions || {}),
    geoWindow,
    minPrice: bracket,
    pageSize: 100,
    pageNumber: 1,
  };
  const raw = await fetchOnePage(probeOptions);
  const ids = new Set();
  raw.forEach(item => {
    const listing = item.listing || item;
    if (listing && listing.id) ids.add(String(listing.id));
  });
  return ids;
}

/**
 * Reveal hidden prices for a batch of listings via bracket-sweep probing.
 *
 * Same API cost regardless of listing count (one Domain call per bracket
 * tests every listing in the batch simultaneously).
 *
 * @param {Object} params
 *   - geoWindow:    Domain geoWindow used by the original search
 *   - hiddenIds:    Array<string> — listing IDs to derive prices for
 *   - userMinPrice: number|null — user's active price filter min (Domain has
 *                   already filtered to >= this, so we skip lower brackets)
 *   - userMaxPrice: number|null — user's active price filter max (we skip
 *                   higher brackets)
 *   - baseOptions:  remaining search options (propertyTypes, beds, etc.) so
 *                   the probe matches the same set as the original search
 * @returns {Object} { [id]: { from, to } } — derived ranges for each id
 */
async function revealHiddenPrices({ geoWindow, hiddenIds, userMinPrice, userMaxPrice, baseOptions }) {
  if (!hiddenIds?.length) return {};
  if (!geoWindow) {
    console.warn('[DomainAPI] revealHiddenPrices: no geoWindow, aborting');
    return {};
  }

  const targetSet = new Set(hiddenIds.map(String));

  // Pick brackets to probe based on the user's active filter — skip
  // anything Domain has already filtered out for us.
  const brackets = PRICE_BRACKETS.filter(b => {
    if (userMinPrice && b <= userMinPrice) return false;
    if (userMaxPrice && b >= userMaxPrice) return false;
    return true;
  });

  // For each target listing, record the highest bracket at which it still
  // appears (lowerBound) and the bracket where it first drops out (upperBound).
  const lowerBound = {};
  const upperBound = {};

  for (const bracket of brackets) {
    let presentIds;
    try {
      presentIds = await probeBracket(geoWindow, bracket, baseOptions);
    } catch (err) {
      console.warn(`[DomainAPI] probe at ${bracket} failed:`, err);
      continue;
    }

    let anyPresent = false;
    targetSet.forEach(id => {
      if (presentIds.has(id)) {
        lowerBound[id] = bracket;
        anyPresent = true;
      } else if (lowerBound[id] !== undefined && upperBound[id] === undefined) {
        upperBound[id] = bracket;
      }
    });

    // Early-stop: if NO target listings are still present, all higher
    // brackets will also return zero (subset property). Stop probing.
    if (!anyPresent && Object.keys(lowerBound).length > 0) break;
  }

  const lowestBracket  = brackets[0];
  const highestBracket = brackets[brackets.length - 1];

  const estimates = {};
  hiddenIds.forEach(id => {
    const lo = lowerBound[id];
    const hi = upperBound[id];

    if (lo === undefined) {
      // Never appeared at any probed bracket → below the lowest probed value
      const from = userMinPrice || 0;
      estimates[id] = { from, to: lowestBracket };
    } else if (hi === undefined && lo === highestBracket) {
      // Present at the topmost bracket — could be 30M+ or "exempt" quirk
      estimates[id] = { from: lo, to: userMaxPrice || null };
    } else if (hi === undefined) {
      // Present at some lower brackets but ran out of brackets to probe
      estimates[id] = { from: lo, to: userMaxPrice || null };
    } else {
      estimates[id] = { from: lo, to: hi };
    }
  });

  // Persist to server cache (best-effort; UI proceeds even if write fails)
  const payload = {
    estimates: hiddenIds.map(id => ({
      domainId:  id,
      priceFrom: estimates[id].from,
      priceTo:   estimates[id].to,
    })),
  };
  try {
    await fetch(ESTIMATES_ENDPOINT, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
  } catch (err) {
    console.warn('[DomainAPI] revealHiddenPrices: cache write failed', err);
  }

  // Apply derived prices to the in-memory enrichment cache so subsequent
  // renders pick them up immediately without another search.
  hiddenIds.forEach(id => {
    const cached = _enrichmentCache[String(id)];
    if (cached) {
      cached.price = {
        ...(cached.price || {}),
        from:    estimates[id].from,
        to:      estimates[id].to,
        derived: true,
      };
    }
  });

  return estimates;
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

    // Price — keep all three fields raw so the renderer can choose the best
    // display. Domain's priceFrom/priceTo are usually populated even when
    // displayPrice is text ("Auction", "Contact Agent"), but not always —
    // some agents leave both null and only put text in displayPrice.
    // Source of truth: from/to numeric range > numeric display > text display.
    price: {
      display: price.displayPrice || '',
      from:    price.priceFrom ?? price.price ?? null,
      to:      price.priceTo   ?? price.price ?? null,
    },

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

  /**
   * Reveal hidden prices for a batch of listings via bracket-sweep probing.
   * See revealHiddenPrices() above for full details.
   */
  async revealHiddenPrices(opts) {
    return revealHiddenPrices(opts);
  },

  /** Always live */
  isMock() { return false; },
  isLive: true,
};

// Make available globally (loaded via <script> tag)
if (typeof window !== 'undefined') window.DomainAPI = DomainAPI;
