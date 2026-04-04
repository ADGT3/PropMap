export default async function handler(req, res) {
  // Vercel may append query strings; strip them before parsing
  const cleanUrl = (req.url || '').split('?')[0];
  const parts = cleanUrl.replace('/api/tiles/', '').split('/');
  const z = parts[0];
  const y = parts[1];
  const x = parts[2] ? parts[2].replace('.pbf', '') : null;

  if (!z || !y || !x) {
    return res.status(400).json({ error: 'Missing z, y, or x parameters', raw: req.url, parts });
  }

  const tileUrl = `https://portal.spatial.nsw.gov.au/vectortileservices/rest/services/Hosted/NSW_BaseMap_VectorTile_Hybrid/VectorTileServer/tile/${z}/${y}/${x}.pbf`;

  try {
    const response = await fetch(tileUrl);
    if (!response.ok) {
      // 404 = tile doesn't exist at this zoom/location — normal, pass through silently
      return res.status(response.status).end();
    }
    const buffer = await response.arrayBuffer();
    res.setHeader('Content-Type', 'application/x-protobuf');
    res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.status(200).send(Buffer.from(buffer));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}
