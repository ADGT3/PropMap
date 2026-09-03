/**
 * GET /api/domain-listing?ids=2018...,2019...
 * Looks up live Domain listings by id (GET /v1/listings/{id}).
 * Uses DOMAIN_API_KEY — same secret as /api/domain-search.
 */
const DOMAIN_LISTING_URL = 'https://api.domain.com.au/v1/listings/';

async function fetchOne(id, apiKey) {
  const res = await fetch(DOMAIN_LISTING_URL + encodeURIComponent(id), {
    headers: {
      Accept: 'application/json',
      'X-API-Key': apiKey,
      Authorization: 'Bearer ' + apiKey,
    },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error('Domain GET listing ' + id + ' ' + res.status + ' ' + text.slice(0, 200));
  }
  return res.json();
}

async function handle(req, res) {
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  const apiKey = process.env.DOMAIN_API_KEY;
  if (!apiKey) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'DOMAIN_API_KEY is not configured' }));
    return;
  }

  let ids = [];
  if (req.method === 'GET') {
    const q = (req.query && (req.query.ids || req.query.id)) || '';
    ids = String(q).split(',').map(s => s.trim()).filter(Boolean);
  } else if (req.method === 'POST') {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    ids = (body.listingIds || body.ids || []).map(String);
  } else {
    res.statusCode = 405;
    res.end(JSON.stringify({ error: 'GET or POST only' }));
    return;
  }

  ids = [...new Set(ids)].slice(0, 25);
  const listings = [];
  const errors = [];
  await Promise.all(ids.map(async (id) => {
    try {
      const row = await fetchOne(id, apiKey);
      if (row) listings.push(row);
    } catch (err) {
      errors.push({ id, error: String(err.message || err) });
    }
  }));

  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(listings));
}

export default handle;
module.exports = handle;
