/**
 * nsw-lookup-client.js
 *
 * Browser-side twin of lib/nsw-lookup.js. Runs NSW Spatial Portal lookups
 * directly from the browser, which proved reliable (unlike Vercel→NSW
 * which was timing out on larger lots).
 *
 * Exposed as window.NSWLookup with two methods:
 *   lookupByLotDP(lotDpString)  → resolve a Lot/DP to full property record
 *   lookupByLatLng(lat, lng)    → resolve a coordinate to full property record
 *
 * Both return the same shape:
 *   {
 *     lotidstring, lotnumber, sectionnumber, planlabel,
 *     propid, raw_address, address, suburb, housenumber, urbanity,
 *     lat, lng, areaSqm, rings, source, queried_at
 *   }
 * or null if nothing found.
 *
 * This file is loaded via <script src="nsw-lookup-client.js">. No build step.
 */

(function (global) {

const BASE =
  'https://portal.spatial.nsw.gov.au/server/rest/services/' +
  'NSW_Land_Parcel_Property_Theme_multiCRS/FeatureServer';
const LOT_LAYER      = 8;
const PROPERTY_LAYER = 12;

// Street-type pivot for ALL-CAPS → Title Case address splitter
const STREET_TYPES = new Set([
  'ROAD','RD','STREET','ST','AVENUE','AVE','LANE','LN','DRIVE','DR',
  'PLACE','PL','COURT','CT','CLOSE','CL','CRESCENT','CRES','PARADE','PDE',
  'TERRACE','TCE','WAY','BOULEVARD','BLVD','HIGHWAY','HWY','PARKWAY','PKWY',
  'CIRCUIT','CCT','GROVE','GR','ESPLANADE','ESP','SQUARE','SQ','ALLEY','TRAIL',
  'TRACK','RIDGE','GLEN','WALK','RISE','VISTA','VIEW',
]);

function titleCase(s) {
  if (!s) return s;
  return s.toLowerCase().replace(/\b([a-z])/g, c => c.toUpperCase());
}

function splitAddress(raw) {
  if (!raw) return { address: null, suburb: null };
  const tokens = String(raw).trim().split(/\s+/);
  if (tokens.length < 2) return { address: titleCase(raw), suburb: null };
  for (let i = 1; i < tokens.length; i++) {
    if (STREET_TYPES.has(tokens[i].toUpperCase())) {
      return {
        address: titleCase(tokens.slice(0, i + 1).join(' ')),
        suburb:  titleCase(tokens.slice(i + 1).join(' ')) || null,
      };
    }
  }
  return { address: titleCase(raw), suburb: null };
}

// Shared point-in-polygon query helper
async function queryLayerAtPoint(layerId, lat, lng, outFields) {
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
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Layer ${layerId} HTTP ${r.status}`);
  const j = await r.json();
  if (j?.error) throw new Error(`Layer ${layerId} service error: ${j.error?.message || 'unknown'}`);
  return j?.features?.[0]?.attributes || null;
}

// Resolve a coordinate → full record (both Lot + Property layer)
async function lookupByLatLng(lat, lng) {
  if (lat == null || lng == null) return null;
  const [lotAttrs, propAttrs] = await Promise.all([
    queryLayerAtPoint(LOT_LAYER,      lat, lng, 'lotidstring,lotnumber,sectionnumber,planlabel,planlotarea'),
    queryLayerAtPoint(PROPERTY_LAYER, lat, lng, 'propid,address,housenumber,urbanity'),
  ]);
  if (!lotAttrs && !propAttrs) return null;
  const split = propAttrs ? splitAddress(propAttrs.address) : { address: null, suburb: null };
  return {
    lotidstring:   lotAttrs?.lotidstring || null,
    lotnumber:     lotAttrs?.lotnumber   || null,
    sectionnumber: lotAttrs?.sectionnumber || null,
    planlabel:     lotAttrs?.planlabel   || null,
    propid:        propAttrs?.propid != null ? String(propAttrs.propid) : null,
    raw_address:   propAttrs?.address   || null,
    address:       split.address,
    suburb:        split.suburb,
    housenumber:   propAttrs?.housenumber || null,
    urbanity:      propAttrs?.urbanity  || null,
    lat:           lat,
    lng:           lng,
    areaSqm:       null,
    rings:         null,
    source:        'nsw-spatial-portal-latlng',
    queried_at:    new Date().toISOString(),
  };
}

// Resolve a Lot/DP → polygon + centroid + Property record at centroid
async function lookupByLotDP(lotDpString) {
  if (!lotDpString) return null;
  const normalized = String(lotDpString).trim().toUpperCase();

  // Step 1: Lot layer WHERE lotidstring = X
  const lotParams = new URLSearchParams({
    f:              'json',
    where:          `lotidstring='${normalized}'`,
    outFields:      'lotidstring,lotnumber,sectionnumber,planlabel,planlotarea',
    returnGeometry: 'true',
    outSR:          '4326',
  });
  const lotUrl = `${BASE}/${LOT_LAYER}/query?${lotParams}`;
  const lotRes = await fetch(lotUrl);
  if (!lotRes.ok) throw new Error(`Lot query HTTP ${lotRes.status}`);
  const lotJson = await lotRes.json();
  if (lotJson?.error) throw new Error(`Lot query error: ${lotJson.error?.message || 'unknown'}`);
  const lotFeature = lotJson?.features?.[0];
  if (!lotFeature) return null;

  const rings = lotFeature.geometry?.rings || null;
  const attrs = lotFeature.attributes || {};

  // Compute centroid (average of first ring's points)
  let cLat = null, cLng = null;
  if (rings && rings[0]?.length) {
    let sumLat = 0, sumLng = 0, count = 0;
    for (const [lng, lat] of rings[0]) { sumLng += lng; sumLat += lat; count++; }
    if (count > 0) { cLat = sumLat / count; cLng = sumLng / count; }
  }

  // Step 2: query Property layer at centroid
  let propAttrs = null;
  if (cLat != null && cLng != null) {
    try {
      propAttrs = await queryLayerAtPoint(PROPERTY_LAYER, cLat, cLng, 'propid,address,housenumber,urbanity');
    } catch (err) {
      console.warn('[NSWLookup] Property query failed:', err.message);
    }
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
    areaSqm:       attrs.planlotarea || null,
    rings,
    source:        'nsw-spatial-portal-lotdp',
    queried_at:    new Date().toISOString(),
  };
}

global.NSWLookup = { lookupByLatLng, lookupByLotDP };

})(typeof window !== 'undefined' ? window : globalThis);
