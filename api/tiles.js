export default async function handler(req, res) {
  const { z, y, x } = req.query;

  if (!z || !y || !x) {
    return res.status(400).json({ error: 'Missing z, y, or x parameters' });
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
    res.status(200).send(Buffer.from(buffer));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}
