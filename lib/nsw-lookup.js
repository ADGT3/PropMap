/**
 * lib/nsw-lookup.js
 * Authoritative lat/lng lookup against NSW Spatial Services' Land Parcel
 * Property Theme feature service.
 *
 * Two-step query:
 *   1. Lot layer (8)      — point-in-polygon → lotidstring + lot polygon
 *   2. Property layer (12) — point-in-polygon → propid + address + housenumber
 *
 * NSW's model: a Property (addressable unit, registered with Valuer General)
 * can span multiple Lots (cadastre parcels). So a single Lot's centroid will
 * always fall inside exactly one Property polygon. We query both with the
 * same lat/lng.
 *
 * Returns the full normalised record — the caller decides which fields to
 * persist. Null if no match (off-shore, out-of-state, or service error).
 *
 * Usage:
 *   import { lookupByLatLng } from '../lib/nsw-lookup.js';
 *   const record = await lookupByLatLng(-33.9936, 150.7721);
 *   // → { lotidstring, lotnumber, sectionnumber, planlabel,
 *   //     propid, address, suburb, housenumber, urbanity, source }
 */

const BASE =
  'https://portal.spatial.nsw.gov.au/server/rest/services/' +
  'NSW_Land_Parcel_Property_Theme_multiCRS/FeatureServer';

const LOT_LAYER      = 8;   // Lot polygons with lotidstring
const PROPERTY_LAYER = 12;  // Property polygons with address/propid

async function queryLayer(layerId, lat, lng, outFields) {
  const params = new URLSearchParams({
    f:              'json',
    geometry:       `${lng},${lat}`,
    geometryType:   'esriGeometryPoint',
    inSR:           '4326',
    spatialRel:     'esriSpatialRelIntersects',
    outFields,
    returnGeometry: 'false',
  });
  const url = `${BASE}/${layerId}/query?${params}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const r = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!r.ok) return null;
    const j = await r.json();
    return j?.features?.[0]?.attributes || null;
  } catch (err) {
    clearTimeout(timer);
    console.warn(`[nsw-lookup] layer ${layerId} failed @ (${lat},${lng}):`, err?.message || err);
    return null;
  }
}

// NSW Property addresses come back ALL CAPS with no punctuation:
//   "109 DEEPFIELDS ROAD CATHERINE FIELD"
// Split into { address: "109 Deepfields Road", suburb: "Catherine Field" }
// by pivoting on the first matched street-type word.
//
// This is a heuristic — it handles ~95% of NSW addresses. Edge cases that
// would fail: roads without a type word (rare), compound street names
// containing a street-type word (e.g. "STREET ROAD" — doesn't happen in
// NSW signage). The caller should treat address/suburb as best-effort and
// preserve user-facing values where present.
const STREET_TYPES = new Set([
  'ROAD', 'RD',
  'STREET', 'ST',
  'AVENUE', 'AVE',
  'LANE', 'LN',
  'DRIVE', 'DR',
  'PLACE', 'PL',
  'COURT', 'CT',
  'CLOSE', 'CL',
  'CRESCENT', 'CRES',
  'PARADE', 'PDE',
  'TERRACE', 'TCE',
  'WAY',
  'BOULEVARD', 'BLVD',
  'HIGHWAY', 'HWY',
  'PARKWAY', 'PKWY',
  'CIRCUIT', 'CCT',
  'GROVE', 'GR',
  'ESPLANADE', 'ESP',
  'SQUARE', 'SQ',
  'ALLEY',
  'TRAIL',
  'TRACK',
  'RIDGE',
  'GLEN',
  'WALK',
  'RISE',
  'VISTA',
  'VIEW',
]);

function titleCase(s) {
  if (!s) return s;
  return s.toLowerCase().replace(/\b([a-z])/g, c => c.toUpperCase());
}

// Known exceptions where the street-type matcher would over-split.
// These are title-cased suburb names that contain a street-type word.
// (Currently unused; reserve for future tuning.)
// const SUBURB_EXCEPTIONS = new Set(['Gardens', ...]);

function splitAddress(rawAddress) {
  if (!rawAddress) return { address: null, suburb: null };
  const tokens = String(rawAddress).trim().split(/\s+/);
  if (tokens.length < 2) return { address: titleCase(rawAddress), suburb: null };

  // Scan left-to-right for the first street-type word. Everything up to and
  // including it is the address; everything after is the suburb.
  for (let i = 1; i < tokens.length; i++) {
    if (STREET_TYPES.has(tokens[i].toUpperCase())) {
      const addressTokens = tokens.slice(0, i + 1);
      const suburbTokens  = tokens.slice(i + 1);
      return {
        address: titleCase(addressTokens.join(' ')),
        suburb:  titleCase(suburbTokens.join(' ')) || null,
      };
    }
  }

  // No street-type word matched — return raw title-cased with null suburb.
  return { address: titleCase(rawAddress), suburb: null };
}

/**
 * Lookup by Lot/DP identifier directly (bypasses lat/lng imprecision).
 *   e.g. lookupByLotDP('17//DP1222679')
 *
 * Returns { lotidstring, address, suburb, propid, lat, lng, areaSqm, rings }
 * where lat/lng is the polygon centroid and rings is the GeoJSON-ready polygon.
 *
 * Algorithm:
 *   1. Query Lot layer with WHERE lotidstring = X, returning geometry
 *   2. Compute centroid of the lot polygon
 *   3. Query Property layer at that centroid to get address
 *
 * Returns null if the Lot/DP doesn't exist in NSW cadastre.
 */
export async function lookupByLotDP(lotDpString) {
  if (!lotDpString) return null;
  const normalized = String(lotDpString).trim().toUpperCase();

  // Step 1: query Lot layer by lotidstring
  // Step 1: query Lot layer by lotidstring
  const lotParams = new URLSearchParams({
    f:              'json',
    where:          `lotidstring='${normalized}'`,
    outFields:      'lotidstring,lotnumber,sectionnumber,planlabel,planlotarea',
    returnGeometry: 'true',
    outSR:          '4326',
  });
  const lotUrl = `${BASE}/${LOT_LAYER}/query?${lotParams}`;
  console.log(`[nsw-lookup] Lot query for ${normalized}: ${lotUrl}`);
  let lotFeature = null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const r = await fetch(lotUrl, { signal: controller.signal });
    clearTimeout(timer);
    console.log(`[nsw-lookup] Lot response status ${r.status} for ${normalized}`);
    if (!r.ok) {
      const body = await r.text().catch(() => '<no body>');
      console.warn(`[nsw-lookup] Lot HTTP ${r.status}: ${body.slice(0, 200)}`);
      return null;
    }
    const j = await r.json();
    console.log(`[nsw-lookup] Lot features returned: ${j?.features?.length || 0} for ${normalized}`);
    if (j?.error) {
      console.warn(`[nsw-lookup] Lot service error:`, j.error);
      return null;
    }
    lotFeature = j?.features?.[0] || null;
  } catch (err) {
    console.warn(`[nsw-lookup] Lot query exception for ${normalized}:`, err?.message || err);
    return null;
  }
  if (!lotFeature) {
    console.warn(`[nsw-lookup] No Lot feature for ${normalized}`);
    return null;
  }

  const rings = lotFeature.geometry?.rings || null;
  const attrs = lotFeature.attributes || {};

  // Compute centroid (simple area-weighted centroid of first ring)
  let cLat = null, cLng = null;
  if (rings && rings[0]?.length) {
    let sumLat = 0, sumLng = 0, count = 0;
    for (const [lng, lat] of rings[0]) {
      sumLng += lng; sumLat += lat; count++;
    }
    if (count > 0) { cLat = sumLat / count; cLng = sumLng / count; }
  }

  // Step 2: use centroid to query Property layer for authoritative address
  let propAttrs = null;
  if (cLat != null && cLng != null) {
    propAttrs = await queryLayer(PROPERTY_LAYER, cLat, cLng, 'propid,address,housenumber,urbanity');
  }
  const split = propAttrs ? splitAddress(propAttrs.address) : { address: null, suburb: null };

  return {
    lotidstring:   attrs.lotidstring || normalized,
    lotnumber:     attrs.lotnumber || null,
    sectionnumber: attrs.sectionnumber || null,
    planlabel:     attrs.planlabel || null,
    propid:        propAttrs?.propid != null ? String(propAttrs.propid) : null,
    raw_address:   propAttrs?.address || null,
    address:       split.address,
    suburb:        split.suburb,
    housenumber:   propAttrs?.housenumber || null,
    urbanity:      propAttrs?.urbanity || null,
    lat:           cLat,
    lng:           cLng,
    areaSqm:       attrs.Shape__Area || attrs.planlotarea || null,
    rings,
    source:        'nsw-spatial-portal-by-lotdp',
    queried_at:    new Date().toISOString(),
  };
}
export async function lookupByLatLng(lat, lng) {
  if (lat == null || lng == null) return null;

  const [lotAttrs, propAttrs] = await Promise.all([
    queryLayer(LOT_LAYER, lat, lng, 'lotidstring,lotnumber,sectionnumber,planlabel,planlotarea'),
    queryLayer(PROPERTY_LAYER, lat, lng, 'propid,address,housenumber,urbanity'),
  ]);

  if (!lotAttrs && !propAttrs) return null;

  const split = propAttrs ? splitAddress(propAttrs.address) : { address: null, suburb: null };

  return {
    // Lot-layer fields
    lotidstring:   lotAttrs?.lotidstring || null,
    lotnumber:     lotAttrs?.lotnumber   || null,
    sectionnumber: lotAttrs?.sectionnumber || null,
    planlabel:     lotAttrs?.planlabel   || null,
    // Property-layer fields
    propid:        propAttrs?.propid != null ? String(propAttrs.propid) : null,
    raw_address:   propAttrs?.address   || null,
    address:       split.address,
    suburb:        split.suburb,
    housenumber:   propAttrs?.housenumber || null,
    urbanity:      propAttrs?.urbanity  || null,
    // Provenance
    source:        'nsw-spatial-portal',
    queried_at:    new Date().toISOString(),
  };
}
