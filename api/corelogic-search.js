/**
 * api/corelogic-search.js — V76.3
 *
 * Server-side proxy for the CoreLogic Commercial API. Handles OAuth2
 * client_credentials grant (token exchange + caching) and proxies
 * forSaleListings / forLeaseListings searches.
 *
 * Keeps CORELOGIC_CLIENT_SECRET out of the browser bundle.
 *
 *   POST /api/corelogic-search
 *     Body:
 *       {
 *         listingType: 'sale' | 'lease',     // required
 *         query: { ...queryParams }          // CoreLogic search params
 *         polygon?: [[[lng,lat],...]]        // optional ring, sent in request body
 *       }
 *     Returns: CoreLogic response shape unchanged — { count, results: [...] }
 *
 * Environment variables required (set in Vercel dashboard):
 *   CORELOGIC_CLIENT_ID
 *   CORELOGIC_CLIENT_SECRET
 *   CORELOGIC_BASE_URL         (optional, defaults to sandbox)
 *   CORELOGIC_TOKEN_URL        (optional, defaults to sandbox token endpoint)
 *
 * Token caching:
 *   Tokens live for ~1 hour (exp claim). We cache in module scope with a
 *   60-second safety buffer so mid-flight requests don't use a just-expired
 *   token. On cold starts the cache is empty and one token fetch happens
 *   before the first search.
 */

// ── Config ────────────────────────────────────────────────────────────────
const DEFAULT_BASE_URL  = 'https://api-sbox.corelogic.asia/commercial-api/au/v1';
const DEFAULT_TOKEN_URL = 'https://api-sbox.corelogic.asia/access/as/token.oauth2';

const ENDPOINTS = {
  sale:  '/forSaleListings',
  lease: '/forLeaseListings',
};

// ── Token cache (module-scoped) ───────────────────────────────────────────
let _cachedToken = null;     // the bearer string
let _cachedExpiry = 0;       // epoch ms — when to refetch

/**
 * Get a valid bearer token — uses the cached one if still valid, otherwise
 * fetches a fresh one from the OAuth token endpoint.
 */
async function getAccessToken() {
  const now = Date.now();
  // 60-second safety buffer so an in-flight request doesn't use a just-expired token
  if (_cachedToken && _cachedExpiry > now + 60_000) {
    return _cachedToken;
  }

  const clientId     = process.env.CORELOGIC_CLIENT_ID;
  const clientSecret = process.env.CORELOGIC_CLIENT_SECRET;
  const tokenUrl     = process.env.CORELOGIC_TOKEN_URL || DEFAULT_TOKEN_URL;

  if (!clientId || !clientSecret) {
    throw new Error('CORELOGIC_CLIENT_ID and CORELOGIC_CLIENT_SECRET must be set');
  }

  // client_credentials grant — form-encoded body, Basic auth header.
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const params    = new URLSearchParams({ grant_type: 'client_credentials' });

  const tokenRes = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basicAuth}`,
      'Content-Type':  'application/x-www-form-urlencoded',
      'Accept':        'application/json',
    },
    body: params.toString(),
  });

  const data = await tokenRes.json().catch(() => ({}));

  if (!tokenRes.ok) {
    console.error('[corelogic] token exchange failed:', tokenRes.status, JSON.stringify(data));
    throw new Error(`CoreLogic token exchange failed (${tokenRes.status}): ${data.error_description || data.error || 'unknown'}`);
  }

  if (!data.access_token) {
    throw new Error('CoreLogic token response missing access_token');
  }

  _cachedToken = data.access_token;
  // expires_in is seconds; fall back to 3300s (55min) if not present
  const expiresInMs = (data.expires_in || 3300) * 1000;
  _cachedExpiry = now + expiresInMs;

  return _cachedToken;
}

/**
 * Build the querystring for the CoreLogic endpoint. Only includes keys with
 * non-empty values — CoreLogic treats empty strings as filter values and
 * returns zero results if you accidentally include them.
 *
 * Array values are appended as repeated keys (e.g. propertyType=Office&propertyType=Retail)
 * which is how CoreLogic's swagger documents multi-value filters.
 */
function buildQueryString(queryObj) {
  if (!queryObj || typeof queryObj !== 'object') return '';
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(queryObj)) {
    if (v === null || v === undefined || v === '') continue;
    if (Array.isArray(v)) {
      for (const item of v) {
        if (item === null || item === undefined || item === '') continue;
        params.append(k, String(item));
      }
    } else {
      params.append(k, String(v));
    }
  }
  return params.toString();
}

// ── Handler ───────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const baseUrl = process.env.CORELOGIC_BASE_URL || DEFAULT_BASE_URL;

  // Parse body
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (_) { body = {}; }
  }
  if (!body || typeof body !== 'object') body = {};

  const { listingType, listingId, query, polygon } = body;

  if (!listingType || !ENDPOINTS[listingType]) {
    return res.status(400).json({ error: "listingType must be 'sale' or 'lease'" });
  }

  let token;
  try {
    token = await getAccessToken();
  } catch (err) {
    console.error('[corelogic] token error:', err.message);
    return res.status(500).json({ error: 'Failed to obtain CoreLogic access token', detail: err.message });
  }

  const qs = buildQueryString(query || {});
  // V76.3.1: if listingId provided, hit the detail endpoint instead of the list endpoint.
  const pathSuffix = listingId ? `/${encodeURIComponent(listingId)}` : '';
  const url = `${baseUrl}${ENDPOINTS[listingType]}${pathSuffix}${qs ? '?' + qs : ''}`;

  // If polygon was provided, it goes in the request body per CoreLogic spec.
  // Otherwise it's a plain GET with no body.
  const hasPolygon = Array.isArray(polygon) && polygon.length > 0;
  const method = (hasPolygon && !listingId) ? 'POST' : 'GET';
  const fetchOpts = {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept':        'application/json',
    },
  };
  if (hasPolygon) {
    fetchOpts.headers['Content-Type'] = 'application/json';
    fetchOpts.body = JSON.stringify(polygon);
  }

  // Build and call — with a single retry if upstream returns 401/502/503/504,
  // which are typically transient token/upstream issues. The retry uses a
  // freshly-minted token.
  async function doFetch() {
    return fetch(url, {
      ...fetchOpts,
      headers: { ...fetchOpts.headers, 'Authorization': `Bearer ${token}` },
    });
  }

  try {
    let upstream = await doFetch();
    let rawText  = await upstream.text();

    if (!upstream.ok && [401, 502, 503, 504].includes(upstream.status)) {
      console.warn('[corelogic] upstream', upstream.status, '— invalidating token and retrying once');
      _cachedToken  = null;
      _cachedExpiry = 0;
      try {
        token = await getAccessToken();
      } catch (tokErr) {
        console.error('[corelogic] retry token fetch failed:', tokErr.message);
        return res.status(502).json({
          error: 'CoreLogic returned ' + upstream.status + ' and token refresh failed',
          detail: tokErr.message,
          upstreamBody: rawText.slice(0, 400),
        });
      }
      upstream = await doFetch();
      rawText  = await upstream.text();
    }

    // Try to parse JSON but preserve raw text for debugging on failure
    let data;
    try { data = JSON.parse(rawText); }
    catch (_) {
      console.error('[corelogic] non-JSON upstream response', {
        status: upstream.status,
        bodyLen: rawText.length,
        bodyHead: rawText.slice(0, 400),
        url,
        method,
      });
      return res.status(upstream.status || 502).json({
        error: 'CoreLogic returned non-JSON',
        status: upstream.status,
        body: rawText.slice(0, 400),
        url: url.replace(/([?&])(client_id|access_token)=[^&]+/g, '$1$2=***'),
      });
    }

    if (!upstream.ok) {
      // If the token was rejected, invalidate our cache so the next call gets a fresh one.
      if (upstream.status === 401) {
        _cachedToken = null;
        _cachedExpiry = 0;
      }
      console.error('[corelogic] upstream error:', upstream.status, JSON.stringify(data).slice(0, 400));
      return res.status(upstream.status).json({
        error: 'CoreLogic API error',
        status: upstream.status,
        detail: data,
      });
    }

    return res.status(200).json(data);
  } catch (err) {
    console.error('[corelogic] fetch failed:', err);
    return res.status(502).json({ error: 'Failed to reach CoreLogic API', detail: err.message });
  }
}
