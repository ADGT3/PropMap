/**
 * api/usage.js
 *
 * API call usage tracking for TessaDEM and Domain APIs.
 * Persists to Neon Postgres (table: api_usage_log).
 *
 * GET  /api/usage                              -> { tessadem: {...}, domain: {...} }
 *   Returns aggregated stats for both APIs:
 *     - this_month   : calls in current calendar month
 *     - since_reset  : calls since last "Mark as Topped Up"
 *     - last_balance : most recent Request-Balance reported by TessaDEM (null for Domain)
 *     - last_call_at : ISO timestamp of most recent call
 *     - last_reset_at: ISO timestamp of last reset (null if never)
 *
 * POST /api/usage              (internal, called by other proxies)
 *   Body: { api_name: 'tessadem'|'domain', status_code: int, balance_remaining?: int, metadata?: object }
 *   Logs a single API call.
 *
 * POST /api/usage/reset        (admin only — "Mark as Topped Up")
 *   Body: { api_name: 'tessadem'|'domain' }
 *   Records a reset row. The "since_reset" counter measures from this point forward.
 *
 * Environment variables required:
 *   POSTGRES_URL or DATABASE_URL  - Neon connection
 */

import { neon } from '@neondatabase/serverless';
import { requireSession, requireAdmin } from '../lib/auth.js';

function getDb() {
  const url = process.env.pipeline_POSTGRES_URL
    || process.env.pipeline_DATABASE_URL
    || process.env.PIPELINE_POSTGRES_URL
    || process.env.PIPELINE_DATABASE_URL
    || process.env.POSTGRES_URL
    || process.env.DATABASE_URL;
  if (!url) throw new Error('No database URL found in environment variables');
  return neon(url);
}

const VALID_APIS = ['tessadem', 'domain'];

/**
 * Internal helper — records a single API call.
 * Exported so other proxy routes (api/elevation-tile.js, api/domain-search.js)
 * can call it directly without a fetch round-trip.
 */
export async function logApiCall({ api_name, status_code, balance_remaining = null, metadata = null }) {
  if (!VALID_APIS.includes(api_name)) {
    console.warn(`[usage] ignoring unknown api_name: ${api_name}`);
    return;
  }
  try {
    const sql = getDb();
    await sql`
      CREATE TABLE IF NOT EXISTS api_usage_log (
        id                SERIAL PRIMARY KEY,
        api_name          VARCHAR(50) NOT NULL,
        called_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        status_code       INT,
        balance_remaining INT,
        is_reset_marker   BOOLEAN NOT NULL DEFAULT FALSE,
        metadata          JSONB
      )
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS idx_api_usage_name_time
      ON api_usage_log(api_name, called_at DESC)
    `;
    await sql`
      INSERT INTO api_usage_log (api_name, status_code, balance_remaining, metadata)
      VALUES (${api_name}, ${status_code}, ${balance_remaining}, ${metadata ? JSON.stringify(metadata) : null})
    `;
  } catch (err) {
    // Never let logging failure break the parent request
    console.error('[usage.logApiCall] failed:', err.message);
  }
}

async function ensureSchema(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS api_usage_log (
      id                SERIAL PRIMARY KEY,
      api_name          VARCHAR(50) NOT NULL,
      called_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      status_code       INT,
      balance_remaining INT,
      is_reset_marker   BOOLEAN NOT NULL DEFAULT FALSE,
      metadata          JSONB
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_api_usage_name_time
    ON api_usage_log(api_name, called_at DESC)
  `;
}

async function getStatsForApi(sql, api_name) {
  // Most recent reset marker timestamp (null if never reset)
  const resetRows = await sql`
    SELECT called_at FROM api_usage_log
    WHERE api_name = ${api_name} AND is_reset_marker = TRUE
    ORDER BY called_at DESC LIMIT 1
  `;
  const lastResetAt = resetRows[0]?.called_at || null;

  // Calls this calendar month (excluding reset markers)
  const monthRows = await sql`
    SELECT COUNT(*)::int AS n FROM api_usage_log
    WHERE api_name = ${api_name}
      AND is_reset_marker = FALSE
      AND called_at >= date_trunc('month', NOW())
  `;
  const thisMonth = monthRows[0]?.n || 0;

  // Calls since last reset (or all time if no reset). Excludes reset markers.
  let sinceReset;
  if (lastResetAt) {
    const r = await sql`
      SELECT COUNT(*)::int AS n FROM api_usage_log
      WHERE api_name = ${api_name}
        AND is_reset_marker = FALSE
        AND called_at > ${lastResetAt}
    `;
    sinceReset = r[0]?.n || 0;
  } else {
    const r = await sql`
      SELECT COUNT(*)::int AS n FROM api_usage_log
      WHERE api_name = ${api_name} AND is_reset_marker = FALSE
    `;
    sinceReset = r[0]?.n || 0;
  }

  // Most recent successful call (status 200) — get balance + timestamp
  const lastRows = await sql`
    SELECT called_at, balance_remaining FROM api_usage_log
    WHERE api_name = ${api_name}
      AND is_reset_marker = FALSE
      AND status_code = 200
    ORDER BY called_at DESC LIMIT 1
  `;
  const lastCallAt = lastRows[0]?.called_at || null;
  const lastBalance = lastRows[0]?.balance_remaining ?? null;

  return {
    this_month:    thisMonth,
    since_reset:   sinceReset,
    last_balance:  lastBalance,
    last_call_at:  lastCallAt,
    last_reset_at: lastResetAt,
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  let sql;
  try {
    sql = getDb();
    await ensureSchema(sql);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  // ── GET /api/usage — aggregated stats (admin-only view) ────────────────────
  if (req.method === 'GET') {
    const session = await requireSession(req, res);
    if (!session) return;
    if (!requireAdmin(session, res)) return;

    try {
      const [tessadem, domain] = await Promise.all([
        getStatsForApi(sql, 'tessadem'),
        getStatsForApi(sql, 'domain'),
      ]);
      return res.status(200).json({ tessadem, domain });
    } catch (err) {
      console.error('[usage GET] failed:', err);
      return res.status(500).json({ error: 'Failed to fetch usage stats', detail: err.message });
    }
  }

  // ── POST /api/usage — log a call OR reset (path-suffix routing) ───────────
  if (req.method === 'POST') {
    // Reset path: /api/usage/reset (admin only)
    const isReset = (req.url || '').includes('/reset');

    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { body = {}; }
    }
    if (!body || typeof body !== 'object') body = {};

    const { api_name } = body;
    if (!VALID_APIS.includes(api_name)) {
      return res.status(400).json({ error: `api_name must be one of: ${VALID_APIS.join(', ')}` });
    }

    if (isReset) {
      // Admin-only "Mark as Topped Up"
      const session = await requireSession(req, res);
      if (!session) return;
      if (!requireAdmin(session, res)) return;

      try {
        await sql`
          INSERT INTO api_usage_log (api_name, status_code, is_reset_marker, metadata)
          VALUES (${api_name}, 0, TRUE, ${JSON.stringify({ reset_by: session.email || 'admin' })})
        `;
        const stats = await getStatsForApi(sql, api_name);
        return res.status(200).json({ ok: true, api_name, stats });
      } catch (err) {
        console.error('[usage POST /reset] failed:', err);
        return res.status(500).json({ error: 'Failed to record reset', detail: err.message });
      }
    }

    // Plain log — typically called server-to-server from other proxies
    const { status_code, balance_remaining = null, metadata = null } = body;
    try {
      await sql`
        INSERT INTO api_usage_log (api_name, status_code, balance_remaining, metadata)
        VALUES (${api_name}, ${status_code}, ${balance_remaining}, ${metadata ? JSON.stringify(metadata) : null})
      `;
      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error('[usage POST] failed:', err);
      return res.status(500).json({ error: 'Failed to log call', detail: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
