/**
 * api/cadastre.js
 * Server-side proxy for state cadastre ArcGIS endpoints.
 */

const STATE_CADASTRE = {
  NSW: {
    url:      'https://maps.six.nsw.gov.au/arcgis/rest/services/public/NSW_Cadastre/MapServer/9/query',
    lotField: 'lotidstring',
    extraParams: {},
  },
  VIC: {
    url:      'https://services6.arcgis.com/GB33F62SbDxJjwEL/arcgis/rest/services/Vicmap_PROPERTY/FeatureServer/1/query',
    lotField: 'propnum',
    extraParams: { resultRecordCount: '1' },
  },
  QLD: {
    url:      'https://spatial-img.information.qld.gov.au/arcgis/rest/services/Basemaps/QldCadastralData/MapServer/0/query',
    lotField: 'lotplan',
    extraParams: { resultRecordCount: '1' },
  },
  SA: {
    url:      'https://services.sailis.sa.gov.au/arcgis/rest/services/Property/LandParcel/MapServer/0/query',
    lotField: 'parcel_id',
    extraParams: { resultRecordCount: '1' },
  },
  WA: {
    url:      'https://services.slip.wa.gov.au/public/rest/services/SLIP_Public_Services/Cadastre/MapServer/0/query',
    lotField: 'lot',
    extraParams: { resultRecordCount: '1' },
  },
  TAS: {
    url:      'https://services.thelist.tas.gov.au/arcgis/rest/services/Public/Cadastre/MapServer/0/query',
    lotField: 'pid',
    extraParams: { resultRecordCount: '1' },
  },
  ACT: {
    url:      'https://services1.arcgis.com/E5n4f1VY84i0xSjy/arcgis/rest/services/ACT_Cadastre/FeatureServer/0/query',
    lotField: 'block',
    extraParams: { resultRecordCount: '1' },
  },
  NT: {
    url:      'https://services1.arcgis.com/vkTzFGtvYHzHuEWo/arcgis/rest/services/NT_Cadastral_Parcels/FeatureServer/0/query',
    lotField: 'parcel_id',
    extraParams: { resultRecordCount: '1' },
  },
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { state = 'NSW', lat, lng } = req.query;
  if (!lat || !lng) return res.status(400).json({ error: 'lat and lng required' });

  const service = STATE_CADASTRE[state] || STATE_CADASTRE.NSW;

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

  try {
    const upstream = await fetch(upstreamUrl);
    const rawText  = await upstream.text();

    if (!upstream.ok) {
      return res.status(200).json({ lotid: null, areaSqm: null, rings: null });
    }

    let json;
    try { json = JSON.parse(rawText); }
    catch (e) {
      return res.status(200).json({ lotid: null, areaSqm: null, rings: null });
    }

    const feat = (json.features || [])[0];
    if (!feat) return res.status(200).json({ lotid: null, areaSqm: null, rings: null });

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
    console.error('[cadastre]', state, err.message);
    return res.status(200).json({ lotid: null, areaSqm: null, rings: null });
  }
}
