/**
 * api/cadastre.js
 * Server-side proxy for state cadastre ArcGIS endpoints.
 */

// Convert WGS84 lng/lat to Web Mercator x/y
function toWebMercator(lng, lat) {
  const x = lng * 20037508.34 / 180;
  let y = Math.log(Math.tan((90 + lat) * Math.PI / 360)) / (Math.PI / 180);
  y = y * 20037508.34 / 180;
  return { x, y };
}

const STATE_CADASTRE = {
  NSW: {
    url:      'https://maps.six.nsw.gov.au/arcgis/rest/services/public/NSW_Cadastre/MapServer/9/query',
    lotField: 'lotidstring',
    inSR:     '4326',
    outSR:    '4326',
    extraParams: {},
  },
  QLD: {
    url:      'https://spatial-gis.information.qld.gov.au/arcgis/rest/services/PlanningCadastre/LandParcelPropertyFramework/MapServer/6/query',
    lotField: 'lotplan',
    inSR:     '102100',  // Web Mercator
    outSR:    '4326',
    extraParams: { resultRecordCount: '1', where: '1=1' },
  },
  VIC: {
    url:      'https://services-ap1.arcgis.com/P744lA0wf4LlBZ84/ArcGIS/rest/services/Vicmap_Parcel/FeatureServer/0/query',
    lotField: 'spi',
    inSR:     '4326',
    outSR:    '4326',
    extraParams: { resultRecordCount: '1', where: '1=1' },
  },
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
    return res.status(200).json({ lotid: null, areaSqm: null, rings: null });
  }

  const latNum = parseFloat(lat);
  const lngNum = parseFloat(lng);

  // Use Web Mercator geometry for services that need it
  let geomStr;
  if (service.inSR === '102100') {
    const { x, y } = toWebMercator(lngNum, latNum);
    geomStr = `${x},${y}`;
  } else {
    geomStr = `${lngNum},${latNum}`;
  }

  const params = new URLSearchParams({
    f:              'json',
    geometry:       geomStr,
    geometryType:   'esriGeometryPoint',
    inSR:           service.inSR,
    spatialRel:     'esriSpatialRelIntersects',
    outFields:      service.lotField,
    returnGeometry: 'true',
    outSR:          service.outSR,
    ...service.extraParams,
  });

  const upstreamUrl = `${service.url}?${params}`;
  console.log('[cadastre] →', state, upstreamUrl);

  try {
    const upstream = await fetch(upstreamUrl);
    const rawText  = await upstream.text();
    console.log('[cadastre] ←', state, upstream.status, rawText.slice(0, 500));

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
