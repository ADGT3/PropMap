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
 *
 * Each call is logged to api_usage_log (api_name='domain') for the
 * System Settings → API Dashboard view.
 */

import { logApiCall, checkApiAllowed } from './usage.js';

import { requireSession, requireModule } from '../lib/auth.js';

export default async function handler(req, res) {
  const session = await requireSession(req, res);
  if (!session) return;
  if (!requireModule(session, res, 'mapping')) return;

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.DOMAIN_API_KEY;
  if (!apiKey) {
    console.error('[domain-search] DOMAIN_API_KEY environment variable is not set');
    return res.status(500).json({ error: 'Domain API key not configured on server' });
  }

  // V75.7 — block calls when API is inactive or balance exhausted
  const allow = await checkApiAllowed('domain');
  if (!allow.allowed) {
    if (allow.reason === 'inactive') {
      return res.status(503).json({ error: 'Domain API is disabled', code: 'inactive' });
    }
    if (allow.reason === 'quota_exhausted') {
      return res.status(402).json({ error: 'Domain API quota exhausted', code: 'quota_exhausted' });
    }
    if (allow.reason === 'subscription_not_found') {
      return res.status(500).json({ error: 'Domain API subscription not configured' });
    }
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

    // Log every call (success or failure) for the API dashboard
    await logApiCall({
      api_name: 'domain',
      status_code: domainRes.status,
      metadata: domainRes.ok ? null : { detail: typeof data === 'object' ? data : { raw: String(data).slice(0, 500) } },
    });

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
    await logApiCall({ api_name: 'domain', status_code: 0, metadata: { error: err.message } });
    return res.status(500).json({ error: 'Failed to reach Domain API', detail: err.message });
  }
};
