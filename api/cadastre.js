/**
 * api/cadastre.js
 * Server-side proxy for state cadastre ArcGIS endpoints.
 *
 * Verified working: NSW, QLD, VIC, WA (boundary only — no lot ID on public layer)
 * Pending: ACT
 * Not available (paywalled): SA, TAS, NT
 */

const STATE_CADASTRE = {
  NSW: {
    url:      'https://maps.six.nsw.gov.au/arcgis/rest/services/public/NSW_Cadastre/MapServer/9/query',
    lotField: 'lotidstring',
    areaField: null,
    extraParams: {},
  },
  QLD: {
    url:      'https://spatial-gis.information.qld.gov.au/arcgis/rest/services/PlanningCadastre/LandParcelPropertyFramework/MapServer/4/query',
    lotField: 'lotplan',
    areaField: 'lot_area',
    extraParams: { resultRecordCount: '1', where: "parcel_typ <> 'Watercourse' AND parcel_typ <> 'Road'" },
  },
  VIC: {
    url:      'https://services-ap1.arcgis.com/P744lA0wf4LlBZ84/ArcGIS/rest/services/Vicmap_Parcel/FeatureServer/0/query',
    lotField: 'parcel_spi',
    areaField: 'Shape__Area',
    extraParams: { resultRecordCount: '1', where: "parcel_road = 'N'" },
  },
  WA: {
    // Public layer has geometry only — no lot ID available without subscription
    url:      'https://services.slip.wa.gov.au/public/rest/services/SLIP_Public_Services/Property_and_Planning/MapServer/2/query',
    lotField: null,
    areaField: null,
    extraParams: { resultRecordCount: '1', where: '1=1' },
  },
  ACT: null,  // pending — correct endpoint TBD
  SA:  null,  // paywalled — Land Services SA
  TAS: null,  // pending
  NT:  null,  // pending
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { state = 'NSW', lat, lng } = req.query;
  if (!lat || !lng) return res.status(400).json({ error: 'lat and lng required' });

  const service = STATE_CADASTRE[state];
  if (!service) {
    return res.status(200).json({ lotid: null, areaSqm: null, rings: null });
  }

  const latNum = parseFloat(lat);
  const lngNum = parseFloat(lng);

  // Build outFields — skip if no fields available (WA geometry-only)
  const fieldList = [service.lotField, service.areaField].filter(Boolean);
  const outFields = fieldList.length ? fieldList.join(',') : 'objectid';

  const params = new URLSearchParams({
    f:              'json',
    geometry:       `${lngNum},${latNum}`,
    geometryType:   'esriGeometryPoint',
    inSR:           '4326',
    spatialRel:     'esriSpatialRelIntersects',
    outFields,
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
      return res.status(200).json({ lotid: null, areaSqm: null, rings: null, _debug: { state, parseError: e.message } });
    }

    if (!upstream.ok || json.error) {
      return res.status(200).json({ lotid: null, areaSqm: null, rings: null, _debug: { state, jsonError: json.error } });
    }

    const feat = (json.features || [])[0];
    if (!feat) {
      return res.status(200).json({ lotid: null, areaSqm: null, rings: null, _debug: { state, featureCount: 0 } });
    }

    const attrs = feat.attributes || {};
    const lotid  = service.lotField && attrs[service.lotField] ? String(attrs[service.lotField]) : null;
    let areaSqm  = service.areaField && attrs[service.areaField] ? Math.round(attrs[service.areaField]) : null;

    let rings = null;
    if (feat.geometry && feat.geometry.rings) {
      rings = feat.geometry.rings.map(ring => ring.map(([x, y]) => [y, x]));
      if (!areaSqm) {
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
    }

    return res.status(200).json({ lotid, areaSqm, rings });
  } catch (err) {
    console.error('[cadastre] exception', state, err.message);
    return res.status(200).json({ lotid: null, areaSqm: null, rings: null, _debug: { state, exception: err.message } });
  }
}
