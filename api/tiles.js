import { gunzipSync } from 'node:zlib';

export default async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  let z, y, x;

  if (url.searchParams.has('z')) {
    z = url.searchParams.get('z');
    y = url.searchParams.get('y');
    x = url.searchParams.get('x');
  } else {
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

    let buffer = Buffer.from(await response.arrayBuffer());

    // NSW server sends gzip-compressed PBF tiles.
    // Decompress here so we can send clean uncompressed protobuf to the client.
    // This avoids Content-Encoding mismatches between proxy and browser.
    const isGzip = buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
    if (isGzip) {
      try {
        buffer = gunzipSync(buffer);
      } catch (e) {
        // If decompression fails, send as-is
      }
    }

    res.setHeader('Content-Type', 'application/x-protobuf');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    // No Content-Encoding header — we're sending raw uncompressed protobuf
    res.status(200).send(buffer);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}
