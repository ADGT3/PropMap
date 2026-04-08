/**
 * api/cadastre.js
 * Server-side proxy for state cadastre ArcGIS endpoints.
 *
 * Only NSW, QLD and VIC have verified working endpoints.
 * SA, WA, TAS, ACT, NT are marked as unverified and will return null gracefully.
 */

const STATE_CADASTRE = {
  NSW: {
    url:      'https://maps.six.nsw.gov.au/arcgis/rest/services/public/NSW_Cadastre/MapServer/9/query',
    lotField: 'lotidstring',
    extraParams: {},
  },
  QLD: {
    // QLD Digital Cadastral Database (DCDB) — updated nightly
    url:      'https://spatial-gis.information.qld.gov.au/arcgis/rest/services/PlanningCadastre/LandParcelPropertyFramework/MapServer/4/query',
    lotField: 'lotplan',
    extraParams: { resultRecordCount: '1' },
  },
  VIC: {
    // Vicmap Parcel — Parcel Map Polygons
    url:      'https://services-ap1.arcgis.com/P744lA0wf4LlBZ84/ArcGIS/rest/services/Vicmap_Parcel/FeatureServer/0/query',
    lotField: 'spi',
    extraParams: { resultRecordCount: '1' },
  },
  // Unverified — will silently return null until confirmed
  SA:  null,
  WA:  null,
  TAS: null,
  ACT: null,
  NT:  null,
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { state = 'NSW', lat, lng } = req.query;
  if (!lat || !lng) return res.status(400).json({ error: 'lat and lng required' });

  const service = STATE_CADASTRE[state];
  if (!service) {
    // State not yet supported — return gracefully with no boundary
    return res.status(200).json({ lotid: null, areaSqm: null, rings: null });
  }

  const params = new URLSearchParams({
    f:              'json',
    geometry:       `${lng},${lat}`,
    geometryType:   'esriGeometryPoint',
    inSR:           '4326',
    spatialRel:     'esriSpatialRelIntersects',
    outFields:      service.lotField,
    returnGeometry: 'true',
    outSR:          '4326',
    ...service.extraParams,
  });

  const upstreamUrl = `${service.url}?${params}`;
  console.log('[cadastre] →', state, upstreamUrl);

  try {
    const upstream = await fetch(upstreamUrl);
    const rawText  = await upstream.text();
    console.log('[cadastre] ←', state, upstream.status, rawText.slice(0, 300));

    let json;
    try { json = JSON.parse(rawText); }
    catch (e) {
      return res.status(200).json({ lotid: null, areaSqm: null, rings: null, _debug: { state, parseError: e.message, body: rawText.slice(0, 300) } });
    }

    if (!upstream.ok || json.error) {
      return res.status(200).json({ lotid: null, areaSqm: null, rings: null, _debug: { state, status: upstream.status, jsonError: json.error } });
    }

    const feat = (json.features || [])[0];
    if (!feat) {
      return res.status(200).json({ lotid: null, areaSqm: null, rings: null, _debug: { state, featureCount: 0 } });
    }

    const attrs = feat.attributes || {};
    const lotid = attrs[service.lotField] ? String(attrs[service.lotField]) : null;

    let rings   = null;
    let areaSqm = null;

    if (feat.geometry && feat.geometry.rings) {
      rings = feat.geometry.rings.map(ring => ring.map(([x, y]) => [y, x]));
      const latNum = parseFloat(lat);
      const metersPerDegLng = 111320 * Math.cos(latNum * Math.PI / 180);
      let area = 0;
      for (const ring of feat.geometry.rings) {
        let ringArea = 0;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          ringArea += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
        }
        area += Math.abs(ringArea) / 2;
      }
      areaSqm = Math.round(area * 111320 * metersPerDegLng);
    }

    return res.status(200).json({ lotid, areaSqm, rings });
  } catch (err) {
    console.error('[cadastre] exception', state, err.message);
    return res.status(200).json({ lotid: null, areaSqm: null, rings: null, _debug: { state, exception: err.message } });
  }
}
