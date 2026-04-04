export default async function handler(req, res) {
  // Support both path-based and query-based tile coordinates
  // Path: /api/tiles/10/598/469.pbf  →  parsed from req.url
  // Query: /api/tiles?z=10&y=598&x=469  →  parsed from query string
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  let z, y, x;

  // Try query params first (most reliable with Vercel rewrites)
  if (url.searchParams.has('z')) {
    z = url.searchParams.get('z');
    y = url.searchParams.get('y');
    x = url.searchParams.get('x');
  } else {
    // Fall back to path parsing
    const cleanPath = url.pathname.replace('/api/tiles/', '').replace('/api/tiles', '');
    const parts = cleanPath.split('/').filter(Boolean);
    z = parts[0];
    y = parts[1];
    x = parts[2] ? parts[2].replace('.pbf', '') : null;
  }

  if (!z || !y || !x) {
    return res.status(400).json({ error: 'Missing z, y, or x parameters', debug: { url: req.url, z, y, x } });
  }

  const tileUrl = `https://portal.spatial.nsw.gov.au/vectortileservices/rest/services/Hosted/NSW_BaseMap_VectorTile_Hybrid/VectorTileServer/tile/${z}/${y}/${x}.pbf`;

  try {
    const response = await fetch(tileUrl);
    if (!response.ok) {
      return res.status(response.status).end();
    }
    const buffer = await response.arrayBuffer();
    res.setHeader('Content-Type', 'application/x-protobuf');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    // Pass through Content-Encoding if upstream sends gzipped data
    const encoding = response.headers.get('Content-Encoding');
    if (encoding) res.setHeader('Content-Encoding', encoding);
    res.status(200).send(Buffer.from(buffer));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}
