/**
 * api/elevation-tile.js
 *
 * Server-side tile renderer for TessaDEM elevation data.
 * Returns coloured-gradient PNG tiles for a Leaflet tile layer.
 *
 * GET /api/elevation-tile?z={z}&x={x}&y={y}
 *   z, x, y : standard XYZ tile coordinates (TMS y-axis NOT used; uses Google/OSM scheme)
 * Returns: image/png (200) with 30-day cache headers on success.
 *
 * Error responses (JSON):
 *   401 — TESSADEM_API_KEY env var missing or rejected by TessaDEM
 *   402 — TessaDEM quota exhausted (Payment Required) — client should auto-disable layer
 *   429 — TessaDEM rate limit (3,600/min for points, 300/min for area)
 *   5xx — Upstream / rendering failure
 *
 * Every TessaDEM call is logged to api_usage_log (api_name='tessadem') including
 * the Request-Balance header so the System Settings dashboard can show remaining quota.
 *
 * Environment variable required:
 *   TESSADEM_API_KEY=...   (Vercel dashboard → Settings → Environment Variables)
 */

import { fromArrayBuffer } from 'geotiff';
import sharp from 'sharp';
import { logApiCall } from './usage.js';

// ── Config ────────────────────────────────────────────────────────────────────
const TESSADEM_URL = 'https://tessadem.com/api/elevation';
const TILE_SIZE = 256;          // standard web tile size
const SAMPLE_GRID = 64;         // 64x64 = 4,096 cells/tile (TessaDEM area-mode max is 16,384)
const CACHE_SECONDS = 60 * 60 * 24 * 30; // 30 days

// ── Tile math (standard XYZ → lat/lng bbox) ──────────────────────────────────
function tile2lon(x, z) { return (x / Math.pow(2, z)) * 360 - 180; }
function tile2lat(y, z) {
  const n = Math.PI - (2 * Math.PI * y) / Math.pow(2, z);
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

function tileBounds(z, x, y) {
  return {
    south: tile2lat(y + 1, z),
    north: tile2lat(y, z),
    west:  tile2lon(x, z),
    east:  tile2lon(x + 1, z),
  };
}

// ── Colour ramp ──────────────────────────────────────────────────────────────
// Topographic-map.com style: green (low) → yellow → orange → brown → white (high).
// Stops are in metres above sea level. NSW max ~2,228m (Mt Kosciuszko).
const RAMP = [
  { e:    0, c: [ 64, 130,  79] }, // dark green (sea level / lowlands)
  { e:  100, c: [126, 178,  92] }, // green
  { e:  300, c: [200, 215, 110] }, // yellow-green
  { e:  600, c: [225, 198, 107] }, // tan
  { e: 1000, c: [194, 155,  93] }, // light brown
  { e: 1500, c: [156, 113,  77] }, // brown
  { e: 2000, c: [121,  85,  61] }, // dark brown
  { e: 2500, c: [240, 240, 240] }, // near-white (snow/peak)
];
const NODATA_RGBA = [0, 0, 0, 0]; // fully transparent for no-data / ocean below 0

function rampColour(elev) {
  if (!Number.isFinite(elev) || elev < -50) return NODATA_RGBA;
  if (elev < 0) elev = 0;
  for (let i = 0; i < RAMP.length - 1; i++) {
    const a = RAMP[i], b = RAMP[i + 1];
    if (elev <= b.e) {
      const t = (elev - a.e) / (b.e - a.e);
      return [
        Math.round(a.c[0] + (b.c[0] - a.c[0]) * t),
        Math.round(a.c[1] + (b.c[1] - a.c[1]) * t),
        Math.round(a.c[2] + (b.c[2] - a.c[2]) * t),
        255,
      ];
    }
  }
  const last = RAMP[RAMP.length - 1].c;
  return [last[0], last[1], last[2], 255];
}

// ── Render: elevation grid → 256x256 PNG ─────────────────────────────────────
async function renderTilePng(elevations, gridW, gridH) {
  // Build raw RGBA buffer at tile resolution by nearest-neighbour sampling the grid.
  const rgba = Buffer.alloc(TILE_SIZE * TILE_SIZE * 4);
  for (let py = 0; py < TILE_SIZE; py++) {
    // tile y=0 is north — corresponds to grid row 0 (north edge)
    const gy = Math.min(gridH - 1, Math.floor((py / TILE_SIZE) * gridH));
    for (let px = 0; px < TILE_SIZE; px++) {
      const gx = Math.min(gridW - 1, Math.floor((px / TILE_SIZE) * gridW));
      const elev = elevations[gy * gridW + gx];
      const [r, g, b, a] = rampColour(elev);
      const idx = (py * TILE_SIZE + px) * 4;
      rgba[idx]     = r;
      rgba[idx + 1] = g;
      rgba[idx + 2] = b;
      rgba[idx + 3] = a;
    }
  }
  return sharp(rgba, {
    raw: { width: TILE_SIZE, height: TILE_SIZE, channels: 4 },
  }).png().toBuffer();
}

// ── Handler ──────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.TESSADEM_API_KEY;
  if (!apiKey) {
    console.error('[elevation-tile] TESSADEM_API_KEY env var not set');
    return res.status(500).json({ error: 'Elevation service not configured' });
  }

  // Parse + validate tile coords
  const z = parseInt(req.query.z, 10);
  const x = parseInt(req.query.x, 10);
  const y = parseInt(req.query.y, 10);
  if (!Number.isFinite(z) || !Number.isFinite(x) || !Number.isFinite(y) ||
      z < 0 || z > 20 || x < 0 || y < 0) {
    return res.status(400).json({ error: 'Invalid tile coordinates' });
  }

  const b = tileBounds(z, x, y);

  // TessaDEM area-mode: locations = SW|NE corners, rows × columns = grid size
  const locations = `${b.south},${b.west}|${b.north},${b.east}`;
  const url = `${TESSADEM_URL}?key=${encodeURIComponent(apiKey)}` +
              `&mode=area` +
              `&format=geotiff` +
              `&rows=${SAMPLE_GRID}` +
              `&columns=${SAMPLE_GRID}` +
              `&locations=${encodeURIComponent(locations)}`;

  let upstreamRes;
  try {
    upstreamRes = await fetch(url);
  } catch (err) {
    console.error('[elevation-tile] network error:', err);
    await logApiCall({ api_name: 'tessadem', status_code: 0, metadata: { error: err.message } });
    return res.status(502).json({ error: 'Failed to reach elevation service', detail: err.message });
  }

  // Capture quota balance from response header (TessaDEM sets Request-Balance)
  const balanceHeader = upstreamRes.headers.get('Request-Balance')
                     || upstreamRes.headers.get('request-balance');
  const balance = balanceHeader != null ? parseInt(balanceHeader, 10) : null;

  // Handle non-200 upstream — translate to actionable client errors and log
  if (!upstreamRes.ok) {
    let detail = null;
    try { detail = await upstreamRes.text(); } catch {}
    console.warn(`[elevation-tile] TessaDEM ${upstreamRes.status}:`, (detail || '').slice(0, 200));

    await logApiCall({
      api_name: 'tessadem',
      status_code: upstreamRes.status,
      balance_remaining: Number.isFinite(balance) ? balance : null,
      metadata: { tile: { z, x, y }, detail: (detail || '').slice(0, 500) },
    });

    if (upstreamRes.status === 401 || upstreamRes.status === 403) {
      return res.status(401).json({ error: 'Elevation API key rejected', code: 'auth' });
    }
    if (upstreamRes.status === 402 || upstreamRes.status === 429 && /quota|balance/i.test(detail || '')) {
      return res.status(402).json({ error: 'Elevation quota exhausted', code: 'quota_exhausted' });
    }
    if (upstreamRes.status === 429) {
      return res.status(429).json({ error: 'Elevation rate limit', code: 'rate_limit' });
    }
    return res.status(502).json({ error: 'Upstream elevation error', code: 'upstream', status: upstreamRes.status });
  }

  // Decode the GeoTIFF response
  let elevations, width, height;
  try {
    const arrayBuf = await upstreamRes.arrayBuffer();
    const tiff = await fromArrayBuffer(arrayBuf);
    const image = await tiff.getImage();
    width = image.getWidth();
    height = image.getHeight();
    const rasters = await image.readRasters();
    // single-band DEM
    elevations = rasters[0];
  } catch (err) {
    console.error('[elevation-tile] geotiff decode failed:', err);
    await logApiCall({
      api_name: 'tessadem', status_code: 200,
      balance_remaining: Number.isFinite(balance) ? balance : null,
      metadata: { tile: { z, x, y }, decode_error: err.message },
    });
    return res.status(500).json({ error: 'Failed to decode elevation data', detail: err.message });
  }

  // Render to PNG
  let png;
  try {
    png = await renderTilePng(elevations, width, height);
  } catch (err) {
    console.error('[elevation-tile] render failed:', err);
    return res.status(500).json({ error: 'Failed to render tile', detail: err.message });
  }

  // Log success
  await logApiCall({
    api_name: 'tessadem',
    status_code: 200,
    balance_remaining: Number.isFinite(balance) ? balance : null,
    metadata: { tile: { z, x, y } },
  });

  // Cache hard — elevation data doesn't change. CDN + browser.
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', `public, max-age=${CACHE_SECONDS}, s-maxage=${CACHE_SECONDS}, immutable`);
  return res.status(200).send(png);
}
