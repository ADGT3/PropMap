/**
 * GET /api/domain-listing?ids=2018...,2019...
 * Looks up live Domain listings by id.
 * Keep this file next to api/domain-search.js.
 */
const DOMAIN_LISTING_URL = 'https://api.domain.com.au/v1/listings/';

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function readIds(req) {
  let raw = '';
  if (req.query) raw = req.query.ids || req.query.id || '';
  if (!raw && req.url) {
    try {
      const u = new URL(req.url, 'http://localhost');
      raw = u.searchParams.get('ids') || u.searchParams.get('id') || '';
    } catch (_) {}
  }
  if (!raw && req.body) {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body;
    const arr = body.listingIds || body.ids || [];
    raw = Array.isArray(arr) ? arr.join(',') : String(arr || '');
  }
  return [...new Set(String(raw).split(',').map(s => s.trim()).filter(Boolean))].slice(0, 25);
}

function apiKey() {
  return process.env.DOMAIN_API_KEY
    || process.env.DOMAIN_APIKEY
    || process.env.DOMAIN_CLIENT_SECRET
    || '';
}

async function fetchOne(id, key) {
  const res = await fetch(DOMAIN_LISTING_URL + encodeURIComponent(id), {
    headers: {
      Accept: 'application/json',
      'X-API-Key': key,
    },
  });
  const text = await res.text();
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error('Domain ' + res.status + ' ' + text.slice(0, 180));
  }
  let data;
  try { data = JSON.parse(text); } catch (_) {
    throw new Error('Domain non-JSON ' + text.slice(0, 180));
  }
  if (data && data.listing) return data;
  return { type: 'PropertyListing', listing: data };
}

async function handle(req, res) {
  try {
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }
    const key = apiKey();
    if (!key) {
      json(res, 500, { error: 'DOMAIN_API_KEY is not set on the server' });
      return;
    }
    const ids = readIds(req);
    const listings = [];
    const errors = [];
    for (const id of ids) {
      try {
        const row = await fetchOne(id, key);
        if (row) listings.push(row);
      } catch (err) {
        errors.push({ id, error: String(err.message || err) });
      }
    }
    json(res, 200, listings);
  } catch (err) {
    json(res, 500, { error: String(err.message || err) });
  }
}

module.exports = handle;
exports.default = handle;
