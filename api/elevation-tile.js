/**
 * api/elevation-tile.js
 *
 * Server-side renderer for TessaDEM elevation data. Two modes:
 *
 * GET /api/elevation-tile?z={z}&x={x}&y={y}&min={m}&max={m}
 *   Returns a 256×256 PNG tile with a 19-step blue→green→yellow→red→white
 *   colour ramp scaled to the supplied min/max range (metres).
 *   The min/max come from a viewport probe (mode=probe below) computed
 *   client-side, so all tiles in a single viewport share the same scale.
 *
 * GET /api/elevation-tile?mode=probe&south={s}&west={w}&north={n}&east={e}
 *   Returns JSON { min, max, ok: true } — a single low-res TessaDEM area
 *   fetch covering the supplied bounding box. Used by the browser to compute
 *   the viewport elevation range before requesting tiles.
 *
 * Cache: 12 months on success (terrain doesn't change). Tile cache key
 * naturally includes min/max via the query string, so different viewport
 * ranges produce different cached tiles.
 *
 * Errors (JSON):
 *   401 — TESSADEM_API_KEY missing or rejected
 *   402 — quota exhausted (client auto-disables layer + shows banner)
 *   429 — rate limit
 *   5xx — upstream / decode / render failure
 *
 * Every TessaDEM call is logged via api/usage.js → api_usage_log.
 *
 * Env: TESSADEM_API_KEY (Vercel → Settings → Environment Variables)
 */

import { fromArrayBuffer } from 'geotiff';
import sharp from 'sharp';
import { logApiCall, checkApiAllowed } from './usage.js';

import { requireSession, requireModule } from '../lib/auth.js';

// ── Config ────────────────────────────────────────────────────────────────────
const TESSADEM_URL  = 'https://tessadem.com/api/elevation';
const TILE_SIZE     = 256;
const TILE_GRID     = 64;       // 64×64 = 4,096 cells per tile (limit 16,384)
const PROBE_GRID    = 32;       // 32×32 = 1,024 cells for viewport probe
const CACHE_SECONDS = 60 * 60 * 24 * 365;   // 12 months

// ── Tile math ────────────────────────────────────────────────────────────────
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

// ── 19-step palette: blue → green → yellow → red → white ─────────────────────
// Anchor stops sampled to roughly match topographic-map.com's TessaDEM viewer.
// Linear interpolation produces 19 discrete bands when applied to a 0..18 index.
const PALETTE_ANCHORS = [
  [  0,  76, 153], //  0 deep blue
  [ 51, 153, 204], //  1
  [102, 204, 224], //  2
  [153, 224, 204], //  3 cyan-green
  [102, 178,  76], //  4 green
  [128, 204,  76], //  5
  [178, 224,  76], //  6 yellow-green
  [224, 224,  76], //  7
  [255, 224,   0], //  8 yellow
  [255, 200,   0], //  9
  [255, 160,   0], // 10 orange
  [255, 120,   0], // 11
  [230,  80,  20], // 12
  [200,  40,  30], // 13 red
  [170,  30,  50], // 14
  [150,  60,  90], // 15
  [180, 130, 160], // 16
  [220, 200, 220], // 17
  [255, 255, 255], // 18 white (peak)
];
const N_BANDS = PALETTE_ANCHORS.length; // 19

const NODATA_RGBA = [0, 0, 0, 0];

/**
 * Map an elevation value to a discrete band colour, given the viewport range.
 * Returns [r, g, b, a].
 */
function bandColour(elev, vmin, vmax) {
  if (!Number.isFinite(elev)) return NODATA_RGBA;
  if (vmax <= vmin) {
    // Degenerate range — paint everything mid-band
    const mid = PALETTE_ANCHORS[Math.floor(N_BANDS / 2)];
    return [mid[0], mid[1], mid[2], 255];
  }
  // Compute fractional position then snap to discrete band
  let t = (elev - vmin) / (vmax - vmin);
  if (t < 0) t = 0;
  if (t > 1) t = 1;
  const idx = Math.min(N_BANDS - 1, Math.floor(t * N_BANDS));
  const c = PALETTE_ANCHORS[idx];
  return [c[0], c[1], c[2], 255];
}

// ── TessaDEM area fetch ──────────────────────────────────────────────────────
async function fetchArea({ south, west, north, east }, rows, columns, apiKey) {
  const locations = `${south},${west}|${north},${east}`;
  const url = `${TESSADEM_URL}?key=${encodeURIComponent(apiKey)}` +
              `&mode=area&format=geotiff` +
              `&rows=${rows}&columns=${columns}` +
              `&locations=${encodeURIComponent(locations)}`;

  const res = await fetch(url);
  const balanceHeader = res.headers.get('Request-Balance')
                     || res.headers.get('request-balance');
  const balance = balanceHeader != null ? parseInt(balanceHeader, 10) : null;

  if (!res.ok) {
    let detail = null;
    try { detail = await res.text(); } catch {}
    return { ok: false, status: res.status, balance, detail };
  }

  const arrayBuf = await res.arrayBuffer();
  const tiff = await fromArrayBuffer(arrayBuf);
  const image = await tiff.getImage();
  const width  = image.getWidth();
  const height = image.getHeight();
  const rasters = await image.readRasters();
  return { ok: true, balance, elevations: rasters[0], width, height };
}

// ── Render banded tile PNG ───────────────────────────────────────────────────
async function renderTilePng(elevations, gridW, gridH, vmin, vmax) {
  const rgba = Buffer.alloc(TILE_SIZE * TILE_SIZE * 4);
  for (let py = 0; py < TILE_SIZE; py++) {
    const gy = Math.min(gridH - 1, Math.floor((py / TILE_SIZE) * gridH));
    for (let px = 0; px < TILE_SIZE; px++) {
      const gx = Math.min(gridW - 1, Math.floor((px / TILE_SIZE) * gridW));
      const elev = elevations[gy * gridW + gx];
      const [r, g, b, a] = bandColour(elev, vmin, vmax);
      const i = (py * TILE_SIZE + px) * 4;
      rgba[i]     = r;
      rgba[i + 1] = g;
      rgba[i + 2] = b;
      rgba[i + 3] = a;
    }
  }
  return sharp(rgba, {
    raw: { width: TILE_SIZE, height: TILE_SIZE, channels: 4 },
  }).png().toBuffer();
}

// ── Translate upstream errors to client-actionable status codes ──────────────
function mapUpstreamError(status, detail) {
  if (status === 401 || status === 403) return { code: 'auth', clientStatus: 401 };
  if (status === 402) return { code: 'quota_exhausted', clientStatus: 402 };
  if (status === 429 && /quota|balance/i.test(detail || '')) {
    return { code: 'quota_exhausted', clientStatus: 402 };
  }
  if (status === 429) return { code: 'rate_limit', clientStatus: 429 };
  return { code: 'upstream', clientStatus: 502 };
}

// ── Handler ──────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  const session = await requireSession(req, res);
  if (!session) return;
  if (!requireModule(session, res, 'mapping')) return;

  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.TESSADEM_API_KEY;
  if (!apiKey) {
    console.error('[elevation-tile] TESSADEM_API_KEY env var not set');
    return res.status(500).json({ error: 'Elevation service not configured' });
  }

  // V75.7 — block calls when API is inactive or balance exhausted
  const allow = await checkApiAllowed('tessadem');
  if (!allow.allowed) {
    if (allow.reason === 'inactive') {
      return res.status(503).json({ error: 'Elevation API is disabled', code: 'inactive' });
    }
    if (allow.reason === 'quota_exhausted') {
      return res.status(402).json({ error: 'Elevation quota exhausted', code: 'quota_exhausted' });
    }
    if (allow.reason === 'subscription_not_found') {
      return res.status(500).json({ error: 'Elevation API subscription not configured' });
    }
  }

  // ── Mode: probe (viewport min/max) ──────────────────────────────────────────
  if (req.query.mode === 'probe') {
    const south = parseFloat(req.query.south);
    const west  = parseFloat(req.query.west);
    const north = parseFloat(req.query.north);
    const east  = parseFloat(req.query.east);
    if (![south, west, north, east].every(Number.isFinite)) {
      return res.status(400).json({ error: 'probe requires south, west, north, east' });
    }
    if (south >= north || west >= east) {
      return res.status(400).json({ error: 'invalid bbox: south < north and west < east required' });
    }

    const result = await fetchArea({ south, west, north, east }, PROBE_GRID, PROBE_GRID, apiKey)
      .catch(err => ({ ok: false, status: 0, detail: err.message }));

    if (!result.ok) {
      console.warn(`[elevation-tile probe] upstream ${result.status}:`, (result.detail || '').slice(0, 200));
      await logApiCall({
        api_name: 'tessadem',
        status_code: result.status || 0,
        balance_remaining: Number.isFinite(result.balance) ? result.balance : null,
        metadata: { probe: { south, west, north, east }, detail: (result.detail || '').slice(0, 500) },
      });
      const m = mapUpstreamError(result.status, result.detail);
      return res.status(m.clientStatus).json({ error: m.code, code: m.code });
    }

    // Compute min/max ignoring obvious nodata sentinels
    let min = Infinity, max = -Infinity;
    const arr = result.elevations;
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i];
      if (!Number.isFinite(v) || v < -500 || v > 9999) continue;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      return res.status(502).json({ error: 'no valid elevation samples in probe' });
    }

    await logApiCall({
      api_name: 'tessadem',
      status_code: 200,
      balance_remaining: Number.isFinite(result.balance) ? result.balance : null,
      metadata: { probe: { south, west, north, east }, min, max },
    });

    // Probe results cached for 1 hour (viewport-specific, but stable)
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.status(200).json({ ok: true, min, max });
  }

  // ── Mode: tile (default) ────────────────────────────────────────────────────
  const z = parseInt(req.query.z, 10);
  const x = parseInt(req.query.x, 10);
  const y = parseInt(req.query.y, 10);
  const vmin = parseFloat(req.query.min);
  const vmax = parseFloat(req.query.max);

  if (!Number.isFinite(z) || !Number.isFinite(x) || !Number.isFinite(y) ||
      z < 0 || z > 20 || x < 0 || y < 0) {
    return res.status(400).json({ error: 'Invalid tile coordinates' });
  }
  if (!Number.isFinite(vmin) || !Number.isFinite(vmax)) {
    return res.status(400).json({ error: 'min and max query params required (run probe first)' });
  }

  const result = await fetchArea(tileBounds(z, x, y), TILE_GRID, TILE_GRID, apiKey)
    .catch(err => ({ ok: false, status: 0, detail: err.message }));

  if (!result.ok) {
    console.warn(`[elevation-tile] upstream ${result.status}:`, (result.detail || '').slice(0, 200));
    await logApiCall({
      api_name: 'tessadem',
      status_code: result.status || 0,
      balance_remaining: Number.isFinite(result.balance) ? result.balance : null,
      metadata: { tile: { z, x, y }, detail: (result.detail || '').slice(0, 500) },
    });
    const m = mapUpstreamError(result.status, result.detail);
    return res.status(m.clientStatus).json({ error: m.code, code: m.code });
  }

  let png;
  try {
    png = await renderTilePng(result.elevations, result.width, result.height, vmin, vmax);
  } catch (err) {
    console.error('[elevation-tile] render failed:', err);
    return res.status(500).json({ error: 'Failed to render tile', detail: err.message });
  }

  await logApiCall({
    api_name: 'tessadem',
    status_code: 200,
    balance_remaining: Number.isFinite(result.balance) ? result.balance : null,
    metadata: { tile: { z, x, y }, vmin, vmax },
  });

  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', `public, max-age=${CACHE_SECONDS}, s-maxage=${CACHE_SECONDS}, immutable`);
  return res.status(200).send(png);
}
