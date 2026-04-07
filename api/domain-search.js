/**
 * api/domain-search.js
 *
 * Server-side proxy for the Domain Developer API.
 * Keeps DOMAIN_API_KEY out of the browser bundle.
 *
 * POST /api/domain-search
 * Body: Domain API search payload (passed through to Domain unchanged)
 * Returns: Domain API response (passed through to client unchanged)
 *
 * Environment variable required (set in Vercel dashboard):
 *   DOMAIN_API_KEY=your_key_here
 */

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.DOMAIN_API_KEY;
  if (!apiKey) {
    console.error('[domain-search] DOMAIN_API_KEY environment variable is not set');
    return res.status(500).json({ error: 'Domain API key not configured on server' });
  }

  // Parse body — Vercel provides req.body automatically for JSON content-type
  // but fall back to raw parsing if needed
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  if (!body || typeof body !== 'object') body = {};

  try {
    const domainRes = await fetch(
      'https://api.domain.com.au/v1/listings/residential/_search',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Api-Key': apiKey,
        },
        body: JSON.stringify(body),
      }
    );

    const data = await domainRes.json();

    if (!domainRes.ok) {
      console.error('[domain-search] Domain API error:', domainRes.status, JSON.stringify(data));
      return res.status(domainRes.status).json({
        error: 'Domain API error',
        status: domainRes.status,
        detail: data,
      });
    }

    return res.status(200).json(data);

  } catch (err) {
    console.error('[domain-search] Fetch failed:', err);
    return res.status(500).json({ error: 'Failed to reach Domain API', detail: err.message });
  }
};
