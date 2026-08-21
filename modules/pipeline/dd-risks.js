/**
 * dd-risks.js
 * Automated Due Diligence risk assessment for the Sydney Property Map.
 *
 * Queries NSW government ArcGIS layers and local GeoJSON data at a property's
 * coordinates and returns pre-populated risk levels for each DD item in the
 * pipeline Kanban board.
 *
 * Called by kanban.js when a property is added to the pipeline.
 * Exposes: window.queryDDRisks(lat, lng) → Promise<DDObject>
 *
 * ADDING NEW RISK SOURCES
 * -----------------------
 * 1. Add a new fetch() call to the Promise.all() block in queryDDRisks()
 * 2. Map the response to a dd.<key> = { status, note } entry below
 * 3. The key must match DD_ITEMS[n].toLowerCase() in kanban.js
 *
 * RISK LEVELS
 * -----------
 *   'low'      — no constraint identified
 *   'possible' — constraint may apply, further investigation needed
 *   'high'     — constraint confirmed present
 */

// ─── Layer endpoints ──────────────────────────────────────────────────────────

const DD_ZONING_BASE   = 'https://mapprod3.environment.nsw.gov.au/arcgis/rest/services/Planning/EPI_Primary_Planning_Layers/MapServer';
const DD_FLOOD_BASE    = 'https://mapprod3.environment.nsw.gov.au/arcgis/rest/services/Planning/Hazard/MapServer';
const DD_ROADS_BASE    = 'https://mapprod.environment.nsw.gov.au/arcgis/rest/services/Planning/EPI_Additional_Layers/MapServer';
const DD_BUSHFIRE_URL  = 'https://mapprod3.environment.nsw.gov.au/arcgis/rest/services/ePlanning/Planning_Portal_Hazard/MapServer/229';
const DD_BIODIV_URL    = 'https://www.lmbc.nsw.gov.au/arcgis/rest/services/BV/BiodiversityValues/MapServer/0';
const DD_ELEC_URL      = 'https://services.ga.gov.au/gis/rest/services/National_Electricity_Infrastructure/MapServer/2';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ddPointParams(lng, lat, extra = {}) {
  return new URLSearchParams({
    f:              'json',
    geometry:       `${lng},${lat}`,
    geometryType:   'esriGeometryPoint',
    inSR:           '4326',
    spatialRel:     'esriSpatialRelIntersects',
    returnGeometry: 'false',
    resultRecordCount: '1',
    ...extra,
  }).toString();
}

function hasFeatures(r) {
  return (r?.features?.length ?? 0) > 0;
}

// Ray-casting point-in-polygon for GeoJSON Polygon geometry
function pointInPolygon(lng, lat, geometry) {
  if (!geometry || geometry.type !== 'Polygon') return false;
  const ring = geometry.coordinates[0]; // outer ring: [[lng,lat], ...]
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (((yi > lat) !== (yj > lat)) && (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

// ─── Main query function ──────────────────────────────────────────────────────

async function queryDDRisks(lat, lng) {
  const dd = {};

  // Fire all external queries in parallel
  const [zoningRes, floodRes, bushfireRes, biodivRes, roadsRes, elecRes] = await Promise.all([
    fetch(`${DD_ZONING_BASE}/2/query?${ddPointParams(lng, lat, { outFields: 'SYM_CODE,LAY_CLASS' })}`).then(r => r.json()).catch(() => null),
    fetch(`${DD_FLOOD_BASE}/1/query?${ddPointParams(lng, lat, { outFields: 'LAY_CLASS,SYM_CODE' })}`).then(r => r.json()).catch(() => null),
    fetch(`${DD_BUSHFIRE_URL}/query?${ddPointParams(lng, lat, { outFields: '*' })}`).then(r => r.json()).catch(() => null),
    fetch(`${DD_BIODIV_URL}/query?${ddPointParams(lng, lat, { outFields: '*' })}`).then(r => r.json()).catch(() => null),
    fetch(`${DD_ROADS_BASE}/10/query?${ddPointParams(lng, lat, { outFields: '*' })}`).then(r => r.json()).catch(() => null),
    fetch(`${DD_ELEC_URL}/query?${ddPointParams(lng, lat, { outFields: 'CAPACITYKV' })}`).then(r => r.json()).catch(() => null),
  ]);

  // ── Zoning ────────────────────────────────────────────────────────────────
  const zoningCode = zoningRes?.features?.[0]?.attributes?.SYM_CODE || '';
  const layClass   = zoningRes?.features?.[0]?.attributes?.LAY_CLASS || '';
  if (zoningCode) {
    const isRural = /^RU/i.test(zoningCode);
    const isEnv   = /^E\d/i.test(zoningCode);
    const isRes   = /^R\d/i.test(zoningCode);
    dd.zoning = {
      status: isRural || isEnv ? 'high' : isRes ? 'low' : 'possible',
      note:   `Zone: ${zoningCode}${layClass ? ' — ' + layClass : ''}`,
    };
  }

  // ── Flooding ──────────────────────────────────────────────────────────────
  if (hasFeatures(floodRes)) {
    const cls = floodRes.features[0].attributes?.LAY_CLASS || '';
    dd.flooding = { status: 'high', note: cls || 'Flood affected land' };
  } else {
    dd.flooding = { status: 'low', note: 'No flood planning overlay at this location' };
  }

  // ── Bushfire ──────────────────────────────────────────────────────────────
  if (hasFeatures(bushfireRes)) {
    dd.bushfire = { status: 'high', note: 'Bushfire prone land' };
  } else {
    dd.bushfire = { status: 'low', note: 'Not bushfire prone' };
  }

  // ── Vegetation / Biodiversity ─────────────────────────────────────────────
  if (hasFeatures(biodivRes)) {
    dd.vegetation = { status: 'high', note: 'Biodiversity Values Map — offset scheme may apply' };
  } else {
    dd.vegetation = { status: 'low', note: 'No BVMap constraint identified' };
  }

  // ── Access / Future road reservations ────────────────────────────────────
  if (hasFeatures(roadsRes)) {
    dd.access = { status: 'high', note: 'Future road reservation on or near site' };
  } else {
    dd.access = { status: 'low', note: 'No road reservation identified' };
  }

  // ── Easements — electricity transmission ─────────────────────────────────
  if (hasFeatures(elecRes)) {
    const kv = elecRes.features[0].attributes?.CAPACITYKV || '';
    dd.easements = { status: 'high', note: `Electricity transmission line nearby${kv ? ' (' + kv + ' kV)' : ''}` };
  } else {
    dd.easements = { status: 'low', note: 'No transmission easement identified' };
  }

  // ── Wastewater — local GSP GeoJSON point-in-polygon ──────────────────────
  try {
    const wwData = typeof GSP_WSA_SW_WW !== 'undefined' ? GSP_WSA_SW_WW : null;
    if (wwData) {
      const wwFeature = wwData.features.find(f => pointInPolygon(lng, lat, f.geometry));
      if (wwFeature) {
        const stage    = wwFeature.properties.planning_stage || '';
        const precinct = wwFeature.properties.precinct_name  || '';
        const fy       = wwFeature.properties.fy_timeline ? ` (${wwFeature.properties.fy_timeline})` : '';
        const stageRisk = {
          'Design & Deliver': 'low',
          'Concept Planning': 'possible',
          'Option Planning':  'possible',
          'Strategic Planning': 'high',
        };
        dd.wastewater = {
          status: stageRisk[stage] || 'possible',
          note:   `${stage}${fy} — ${precinct}`,
        };
      } else {
        dd.wastewater = { status: 'high', note: 'Outside Sydney Water wastewater servicing plan area' };
      }
    }
  } catch (e) {
    console.warn('[DD] wastewater check error:', e.message);
  }

  return dd;
}

// ─── Expose globally ──────────────────────────────────────────────────────────
window.queryDDRisks = queryDDRisks;
