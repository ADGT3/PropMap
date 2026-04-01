/**
 * domain-api.js
 * Mock Domain Developer API layer for the Sydney Property Map.
 *
 * Mirrors the Domain API v1 residential listings response shape so that
 * when a real API key is available, this file can be replaced with a thin
 * wrapper around:
 *   GET https://api.domain.com.au/v1/listings/residential/_search
 *
 * SWITCHING TO LIVE API
 * ---------------------
 * 1. Obtain your API key from https://developer.domain.com.au
 * 2. Replace the DOMAIN_API_KEY constant below with your key
 * 3. Set DOMAIN_API_MOCK = false
 * 4. The rest of the app will work unchanged — all consumers use
 *    DomainAPI.search() and DomainAPI.getListing() exclusively.
 *
 * MOCK BEHAVIOUR
 * --------------
 * - Returns enriched versions of the existing listings from data.js
 * - Simulates network latency (300–800ms)
 * - Generates realistic Domain listing IDs, agency names, days on market,
 *   photo URLs (using a placeholder service), and property descriptions
 * - Pagination, sorting and filtering all work against the mock dataset
 */

const DOMAIN_API_MOCK = true;
const DOMAIN_API_KEY  = 'YOUR_API_KEY_HERE'; // replace when live
const DOMAIN_API_BASE = 'https://api.domain.com.au/v1';

// ─── Mock enrichment data ─────────────────────────────────────────────────────

const MOCK_AGENCIES = [
  { id: 'ray-white-parramatta',    name: 'Ray White Parramatta',      phone: '(02) 9630 0000' },
  { id: 'mcgrath-camden',          name: 'McGrath Camden',             phone: '(02) 4655 1111' },
  { id: 'lj-hooker-campbelltown',  name: 'LJ Hooker Campbelltown',    phone: '(02) 4625 2222' },
  { id: 'century21-penrith',       name: 'Century 21 Penrith',        phone: '(02) 4731 3333' },
  { id: 'harcourts-liverpool',     name: 'Harcourts Liverpool',       phone: '(02) 9822 4444' },
  { id: 'raine-horne-blacktown',   name: 'Raine & Horne Blacktown',   phone: '(02) 9622 5555' },
  { id: 'professionals-rouse-hill',name: 'Professionals Rouse Hill',  phone: '(02) 8882 6666' },
  { id: 'first-national-kellyville',name:'First National Kellyville', phone: '(02) 8883 7777' },
];

const MOCK_AGENTS = [
  { firstName: 'James',    lastName: 'Chen',       mobile: '0411 111 001' },
  { firstName: 'Sarah',    lastName: 'Williams',   mobile: '0422 222 002' },
  { firstName: 'Michael',  lastName: 'Nguyen',     mobile: '0433 333 003' },
  { firstName: 'Emma',     lastName: 'Thompson',   mobile: '0444 444 004' },
  { firstName: 'David',    lastName: 'Patel',      mobile: '0455 555 005' },
  { firstName: 'Jessica',  lastName: 'Kim',        mobile: '0466 666 006' },
  { firstName: 'Andrew',   lastName: 'Murphy',     mobile: '0477 777 007' },
  { firstName: 'Olivia',   lastName: 'Hassan',     mobile: '0488 888 008' },
];

const DESCRIPTION_TEMPLATES = {
  house: [
    'Presenting a stunning {beds}-bedroom family home in the heart of {suburb}. Featuring an open-plan living and dining area, modern kitchen with stone benchtops, and a large entertainer\'s backyard. Walking distance to local schools, shops, and transport.',
    'Welcome to this beautifully presented {beds}-bedroom home offering generous living spaces, a well-appointed kitchen, and a covered alfresco area perfect for year-round entertaining. Set on a generous block in sought-after {suburb}.',
    'Rarely does a home of this calibre come to market in {suburb}. This {beds}-bedroom residence combines contemporary design with practical family living, offering multiple living zones, quality finishes throughout, and a private low-maintenance garden.',
  ],
  apartment: [
    'Perfectly positioned in the vibrant heart of {suburb}, this {beds}-bedroom apartment offers a sophisticated urban lifestyle. Featuring an open-plan layout, quality appliances, and a sunny balcony with treetop views.',
    'Modern living at its finest. This {beds}-bedroom apartment in {suburb} boasts a sleek designer kitchen, spacious living areas, and premium finishes throughout. Enjoy resort-style facilities including pool, gym, and concierge.',
    'Stylish and contemporary, this {beds}-bedroom apartment offers the perfect lock-up-and-leave lifestyle in {suburb}. Bright, north-facing aspect with a generous balcony and secure parking.',
  ],
  land: [
    'Seize this rare opportunity to secure a prime {landSize}sqm parcel in the growing {suburb} corridor. Fully serviced with NBN, water, sewer, and electricity connections available. Ideal for your dream home or investment.',
    'Exceptional {landSize}sqm residential block in {suburb}\'s premier new estate. Flat, regular-shaped allotment with all services to the boundary. DA-approved building envelopes available. Act fast — limited lots remaining.',
    'Build your dream home on this {landSize}sqm block in the heart of {suburb}. Located in a master-planned community with parks, schools, and retail all within walking distance. Titled and ready to build.',
  ],
};

const LAND_SIZES = [450, 500, 556, 600, 630, 700, 750, 800, 900, 1012, 1200, 1500, 2000, 4000, 8000];

// ─── Deterministic pseudo-random helpers ─────────────────────────────────────

function seededRand(seed) {
  // Simple LCG — deterministic so same listing always gets same mock data
  let s = seed;
  return function () {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    return (s >>> 0) / 0xffffffff;
  };
}

function pickFrom(arr, rand) {
  return arr[Math.floor(rand() * arr.length)];
}

function mockDaysOnMarket(rand) {
  return Math.floor(rand() * 60) + 1;
}

function mockLandSize(rand) {
  return pickFrom(LAND_SIZES, rand);
}

function mockPhotoUrl(listing, idx) {
  // Picsum gives consistent images per ID
  const w = 800, h = 600;
  const seed = listing.id * 10 + idx;
  return `https://picsum.photos/seed/prop${seed}/${w}/${h}`;
}

function mockDescription(listing, rand) {
  const templates = DESCRIPTION_TEMPLATES[listing.type] || DESCRIPTION_TEMPLATES.house;
  const tpl = pickFrom(templates, rand);
  return tpl
    .replace(/{beds}/g, listing.beds || '4')
    .replace(/{suburb}/g, listing.suburb)
    .replace(/{landSize}/g, mockLandSize(rand));
}

function mockListingId(listing) {
  // Domain listing IDs are 8-digit numbers
  return 10000000 + listing.id * 37 + 12345;
}

function mockPrice(listing) {
  // Return structured price object matching Domain API shape
  const raw = parseInt(listing.price.replace(/[^0-9]/g, ''), 10) || 0;
  return {
    displayPrice:  listing.price,
    priceFrom:     raw > 0 ? Math.round(raw * 0.95) : null,
    priceTo:       raw > 0 ? Math.round(raw * 1.05) : null,
    isUnderOffer:  false,
  };
}

// ─── Enrich a raw listing into Domain API shape ───────────────────────────────

function enrichListing(listing) {
  const rand = seededRand(listing.id * 999);
  const agency = pickFrom(MOCK_AGENCIES, rand);
  const agent  = pickFrom(MOCK_AGENTS, rand);
  const dom    = mockDaysOnMarket(rand);
  const photos = Array.from({ length: 5 }, (_, i) => ({
    url:      mockPhotoUrl(listing, i),
    category: i === 0 ? 'Main' : 'General',
  }));

  return {
    // Domain API fields
    id:            mockListingId(listing),
    listingType:   'Sale',
    status:        'Live',
    saleMode:      'privateTreaty',
    channel:       'residential',
    domainSaysAdId: `dom${listing.id}`,
    headline:      `${listing.beds > 0 ? listing.beds + ' Bed ' : ''}${listing.type.charAt(0).toUpperCase() + listing.type.slice(1)} in ${listing.suburb}`,
    summary:       mockDescription(listing, rand),
    addressParts: {
      streetNumber:  listing.address.split(' ')[0],
      street:        listing.address.split(' ').slice(1).join(' '),
      suburb:        listing.suburb,
      state:         'NSW',
      postcode:      '2000',
      displayAddress: `${listing.address}, ${listing.suburb} NSW`,
    },
    geoLocation: {
      latitude:  listing.lat,
      longitude: listing.lng,
    },
    propertyTypes:  [listing.type.charAt(0).toUpperCase() + listing.type.slice(1)],
    bedrooms:       listing.beds,
    bathrooms:      listing.baths,
    carspaces:      listing.cars,
    landAreaSqm:    listing.type === 'land' ? mockLandSize(rand) : null,
    price:          mockPrice(listing),
    daysOnMarket:   dom,
    daysOnDomain:   dom,
    photos,
    advertiser: {
      type:    'Agency',
      id:      agency.id,
      name:    agency.name,
      phone:   agency.phone,
      logoUrl: `https://ui-avatars.com/api/?name=${encodeURIComponent(agency.name)}&size=80&background=f5f4f0&color=1a1a1a&bold=true`,
      agents:  [{
        firstName: agent.firstName,
        lastName:  agent.lastName,
        mobile:    agent.mobile,
        photoUrl:  `https://ui-avatars.com/api/?name=${encodeURIComponent(agent.firstName + '+' + agent.lastName)}&size=80&background=c4841a&color=fff&bold=true`,
      }],
    },
    listingUrl:    `https://www.domain.com.au/property-profile/${listing.address.toLowerCase().replace(/\s+/g,'-')}-${listing.suburb.toLowerCase().replace(/\s+/g,'-')}-nsw-${mockListingId(listing)}`,
    inspections:   [],
    // Original fields preserved for map compatibility
    _raw: listing,
  };
}

// Pre-enrich all listings once at startup
const enrichedListings = listings.map(enrichListing);

// ─── Mock API delay ───────────────────────────────────────────────────────────

function mockDelay(min = 300, max = 700) {
  return new Promise(r => setTimeout(r, min + Math.random() * (max - min)));
}

// ─── Domain API interface ─────────────────────────────────────────────────────

const DomainAPI = {

  /**
   * Search listings.
   * @param {object} params — mirrors Domain API /listings/residential/_search body
   *   { suburb, postcode, propertyTypes, minBedrooms, maxBedrooms,
   *     minPrice, maxPrice, page, pageSize, sort }
   * @returns {Promise<{listings: object[], totalResults: number, page: number, pageSize: number}>}
   */
  async search(params = {}) {
    if (DOMAIN_API_MOCK) {
      await mockDelay();
      let results = [...enrichedListings];

      // Filter
      if (params.propertyTypes && params.propertyTypes.length) {
        const types = params.propertyTypes.map(t => t.toLowerCase());
        results = results.filter(l => types.includes(l._raw.type));
      }
      if (params.suburb) {
        const s = params.suburb.toLowerCase();
        results = results.filter(l => l._raw.suburb.toLowerCase().includes(s));
      }
      if (params.minBedrooms) results = results.filter(l => l.bedrooms >= params.minBedrooms);
      if (params.maxBedrooms) results = results.filter(l => l.bedrooms <= params.maxBedrooms);
      if (params.minPrice) {
        results = results.filter(l => l.price.priceFrom && l.price.priceFrom >= params.minPrice);
      }
      if (params.maxPrice) {
        results = results.filter(l => l.price.priceTo && l.price.priceTo <= params.maxPrice);
      }

      // Sort
      if (params.sort === 'price-asc')  results.sort((a, b) => (a.price.priceFrom||0) - (b.price.priceFrom||0));
      if (params.sort === 'price-desc') results.sort((a, b) => (b.price.priceFrom||0) - (a.price.priceFrom||0));
      if (params.sort === 'newest')     results.sort((a, b) => a.daysOnMarket - b.daysOnMarket);

      // Paginate
      const page     = params.page || 1;
      const pageSize = params.pageSize || 20;
      const start    = (page - 1) * pageSize;
      const paged    = results.slice(start, start + pageSize);

      return { listings: paged, totalResults: results.length, page, pageSize };
    }

    // ── Live API ──
    const res = await fetch(`${DOMAIN_API_BASE}/listings/residential/_search`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'X-Api-Key':     DOMAIN_API_KEY,
      },
      body: JSON.stringify({
        listingType: 'Sale',
        locations: [{ state: 'NSW', suburb: params.suburb || '' }],
        propertyTypes: params.propertyTypes || [],
        minBedrooms: params.minBedrooms,
        maxBedrooms: params.maxBedrooms,
        minPrice:    params.minPrice,
        maxPrice:    params.maxPrice,
        sort:        { sortKey: 'Default', direction: 'Descending' },
        page:        params.page || 1,
        pageSize:    params.pageSize || 20,
      }),
    });
    if (!res.ok) throw new Error(`Domain API error: ${res.status}`);
    return res.json();
  },

  /**
   * Get a single listing by its Domain listing ID or internal _raw.id.
   * @param {number|string} id
   * @returns {Promise<object>}
   */
  async getListing(id) {
    if (DOMAIN_API_MOCK) {
      await mockDelay(100, 300);
      const listing = enrichedListings.find(
        l => l.id === Number(id) || l._raw.id === Number(id)
      );
      if (!listing) throw new Error(`Listing ${id} not found`);
      return listing;
    }

    const res = await fetch(`${DOMAIN_API_BASE}/listings/${id}`, {
      headers: { 'X-Api-Key': DOMAIN_API_KEY },
    });
    if (!res.ok) throw new Error(`Domain API error: ${res.status}`);
    return res.json();
  },

  /**
   * Get the enriched listing for an internal listing id (from data.js).
   * Convenience method — not part of Domain API but used throughout the app.
   */
  getEnrichedListing(rawId) {
    return enrichedListings.find(l => l._raw.id === Number(rawId)) || null;
  },

  /** All enriched listings — useful for seeding the map without a search call */
  getAllListings() {
    return enrichedListings;
  },

  /** True when running in mock mode */
  isMock() { return DOMAIN_API_MOCK; },
};

// Expose globally
window.DomainAPI = DomainAPI;
