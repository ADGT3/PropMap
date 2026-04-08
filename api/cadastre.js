/**
 * api/cadastre.js
 * Server-side proxy for state cadastre ArcGIS endpoints.
 * Avoids browser CORS restrictions on state government tile servers.
 *
 * GET /api/cadastre?state=NSW&lng=151.21&lat=-33.87
 * Returns: { lotid, areaSqm, rings } or { lotid: null, areaSqm: null, rings: null }
 */

const STATE_CADASTRE = {
  NSW: {
    url:      'https://maps.six.nsw.gov.au/arcgis/rest/services/public/NSW_Cadastre/MapServer/9/query',
    lotField: 'lotidstring',
  },
  VIC: {
    url:      'https://services6.arcgis.com/GB33F62SbDxJjwEL/arcgis/rest/services/Vicmap_PROPERTY/FeatureServer/1/query',
    lotField: 'propnum',
  },
  QLD: {
    url:      'https://spatial-img.information.qld.gov.au/arcgis/rest/services/Basemaps/QldCadastralData/MapServer/0/query',
    lotField: 'lotplan',
  },
  SA: {
    url:      'https://services.sailis.sa.gov.au/arcgis/rest/services/Property/LandParcel/MapServer/0/query',
    lotField: 'parcel_id',
  },
  WA: {
    url:      'https://services.slip.wa.gov.au/public/rest/services/SLIP_Public_Services/Cadastre/MapServer/0/query',
    lotField: 'lot',
  },
  TAS: {
    url:      'https://services.thelist.tas.gov.au/arcgis/rest/services/Public/Cadastre/MapServer/0/query',
    lotField: 'pid',
  },
  ACT: {
    url:      'https://services1.arcgis.com/E5n4f1VY84i0xSjy/arcgis/rest/services/ACT_Cadastre/FeatureServer/0/query',
    lotField: 'block',
  },
  NT: {
    url:      'https://services1.arcgis.com/vkTzFGtvYHzHuEWo/arcgis/rest/services/NT_Cadastral_Parcels/FeatureServer/0/query',
    lotField: 'parcel_id',
  },
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { state = 'NSW', lat, lng } = req.query;
  if (!lat || !lng) return res.status(400).json({ error: 'lat and lng required' });

  const service = STATE_CADASTRE[state] || STATE_CADASTRE.NSW;

  const params = new URLSearchParams({
    f:                 'json',
    geometry:          `${lng},${lat}`,
    geometryType:      'esriGeometryPoint',
    inSR:              '4326',
    spatialRel:        'esriSpatialRelIntersects',
    outFields:         service.lotField,
    returnGeometry:    'true',
    outSR:             '4326',
    resultRecordCount: '1',
  });

  try {
    const upstream = await fetch(`${service.url}?${params}`);
    if (!upstream.ok) {
      return res.status(200).json({ lotid: null, areaSqm: null, rings: null });
    }
    const json = await upstream.json();
    const feat = (json.features || [])[0];

    if (!feat) return res.status(200).json({ lotid: null, areaSqm: null, rings: null });

    const attrs = feat.attributes || {};
    const lotid = attrs[service.lotField] ? String(attrs[service.lotField]) : null;

    let rings   = null;
    let areaSqm = null;

    if (feat.geometry && feat.geometry.rings) {
      rings = feat.geometry.rings.map(ring => ring.map(([x, y]) => [y, x]));
      const latNum = parseFloat(lat);
      const metersPerDegLat = 111320;
      const metersPerDegLng = 111320 * Math.cos(latNum * Math.PI / 180);
      let area = 0;
      for (const ring of feat.geometry.rings) {
        let ringArea = 0;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          ringArea += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
        }
        area += Math.abs(ringArea) / 2;
      }
      areaSqm = Math.round(area * metersPerDegLng * metersPerDegLat);
    }

    return res.status(200).json({ lotid, areaSqm, rings });
  } catch (err) {
    console.error('[cadastre]', state, err.message);
    return res.status(200).json({ lotid: null, areaSqm: null, rings: null });
  }
}
