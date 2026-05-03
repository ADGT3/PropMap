/**
 * api/usage.js
 *
 * API call usage tracking AND subscription management for TessaDEM and Domain.
 *
 * Two backing tables:
 *   api_subscriptions — one row per API:
 *     api_name, sub_type ('monthly'|'total'), sub_amount, effective_start_date,
 *     is_active, updated_at, updated_by
 *
 *   api_usage_log — one row per call (existing schema, unchanged).
 *
 * Endpoints:
 *   GET  /api/usage
 *     Returns full state for both APIs:
 *       { tessadem: { sub_type, sub_amount, effective_start_date, is_active,
 *                     this_month_calls, period_calls, balance_remaining,
 *                     period_start, period_end, last_call_at, last_balance },
 *         domain:   { same shape } }
 *     Public read for any signed-in user (the listings button needs to know
 *     Domain's is_active state). Admin gating happens on writes only.
 *
 *   PUT  /api/usage  (admin only)
 *     Body: { api_name, sub_type?, sub_amount?, effective_start_date?, is_active? }
 *     Update one or more subscription fields. Used by the dashboard edit form.
 *
 *   POST /api/usage  (server-internal, called by other proxies)
 *     Body: { api_name, status_code, balance_remaining?, metadata? }
 *
 *   POST /api/usage/active  (special — non-admin allowed for Domain only)
 *     Body: { api_name, is_active }
 *     Lets the public Listings button toggle Domain on/off without admin rights.
 *     For api_name='tessadem' this still requires admin.
 *
 * Defaults seeded on first GET (per spec):
 *   Domain   — monthly, 10000, 2026-04-27, active
 *   TessaDEM — total,   12000, 2026-05-03, active
 */

import { neon } from '@neondatabase/serverless';
import { requireSession, requireAdmin, isAdmin } from '../lib/auth.js';

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

const VALID_APIS  = ['tessadem', 'domain'];
const VALID_TYPES = ['monthly', 'total'];

// ── Schema setup (idempotent, runs on every request) ────────────────────────
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
  await sql`
    CREATE TABLE IF NOT EXISTS api_subscriptions (
      api_name             VARCHAR(50) PRIMARY KEY,
      sub_type             VARCHAR(10) NOT NULL,
      sub_amount           INT NOT NULL,
      effective_start_date DATE NOT NULL,
      is_active            BOOLEAN NOT NULL DEFAULT TRUE,
      updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_by           VARCHAR(255)
    )
  `;
  // Seed defaults if missing
  await sql`
    INSERT INTO api_subscriptions (api_name, sub_type, sub_amount, effective_start_date, is_active, updated_by)
    VALUES ('domain', 'monthly', 10000, DATE '2026-04-27', TRUE, 'system-seed')
    ON CONFLICT (api_name) DO NOTHING
  `;
  await sql`
    INSERT INTO api_subscriptions (api_name, sub_type, sub_amount, effective_start_date, is_active, updated_by)
    VALUES ('tessadem', 'total', 12000, DATE '2026-05-03', TRUE, 'system-seed')
    ON CONFLICT (api_name) DO NOTHING
  `;
}

// ── Period math: given an effective_start_date and now, find current sub-period ─
/**
 * For a 'monthly' subscription with effective_start_date e.g. 2026-04-27:
 *   period N runs from e + N months (inclusive) to e + (N+1) months (exclusive).
 *   "Current" period contains today.
 * For 'total': there is one period that runs e → forever.
 *
 * Returns { period_start: Date, period_end: Date|null }.
 */
function computeCurrentPeriod(subType, effectiveStartDate, nowDate = new Date()) {
  const start = new Date(effectiveStartDate);
  if (subType === 'total') {
    return { period_start: start, period_end: null };
  }
  // monthly: roll forward in calendar months until period end > now
  let periodStart = new Date(start);
  let periodEnd   = new Date(start);
  periodEnd.setMonth(periodEnd.getMonth() + 1);
  while (periodEnd <= nowDate) {
    periodStart = periodEnd;
    periodEnd = new Date(periodStart);
    periodEnd.setMonth(periodEnd.getMonth() + 1);
  }
  return { period_start: periodStart, period_end: periodEnd };
}

// ── Stats for one API ──────────────────────────────────────────────────────
async function getStatsForApi(sql, api_name) {
  const subRows = await sql`SELECT * FROM api_subscriptions WHERE api_name = ${api_name}`;
  const sub = subRows[0];
  if (!sub) return null; // shouldn't happen post-seed

  const period = computeCurrentPeriod(sub.sub_type, sub.effective_start_date);

  // Calls within the current sub-period (excluding reset markers; status 200 only —
  // we don't bill the user for failed calls)
  let periodCalls;
  if (period.period_end) {
    const r = await sql`
      SELECT COUNT(*)::int AS n FROM api_usage_log
      WHERE api_name = ${api_name}
        AND is_reset_marker = FALSE
        AND status_code = 200
        AND called_at >= ${period.period_start.toISOString()}
        AND called_at <  ${period.period_end.toISOString()}
    `;
    periodCalls = r[0]?.n || 0;
  } else {
    const r = await sql`
      SELECT COUNT(*)::int AS n FROM api_usage_log
      WHERE api_name = ${api_name}
        AND is_reset_marker = FALSE
        AND status_code = 200
        AND called_at >= ${period.period_start.toISOString()}
    `;
    periodCalls = r[0]?.n || 0;
  }

  // "This month calls" — same as period calls (per user's spec: this_month is
  // the running subscription month / period, not the calendar month).
  const thisMonthCalls = periodCalls;

  const lastRows = await sql`
    SELECT called_at, balance_remaining FROM api_usage_log
    WHERE api_name = ${api_name}
      AND is_reset_marker = FALSE
      AND status_code = 200
    ORDER BY called_at DESC LIMIT 1
  `;
  const lastCallAt = lastRows[0]?.called_at || null;
  const lastBalance = lastRows[0]?.balance_remaining ?? null;

  const balance = Math.max(0, sub.sub_amount - periodCalls);

  return {
    api_name:             sub.api_name,
    sub_type:             sub.sub_type,
    sub_amount:           sub.sub_amount,
    effective_start_date: sub.effective_start_date,
    is_active:            sub.is_active,
    updated_at:           sub.updated_at,
    updated_by:           sub.updated_by,

    period_start:    period.period_start.toISOString(),
    period_end:      period.period_end ? period.period_end.toISOString() : null,
    period_calls:    periodCalls,
    this_month_calls: thisMonthCalls,
    balance_remaining: balance,

    last_call_at:  lastCallAt,
    last_balance:  lastBalance,
  };
}

/**
 * Internal helper used by other proxies. Logs a call with full provenance.
 */
export async function logApiCall({ api_name, status_code, balance_remaining = null, metadata = null }) {
  if (!VALID_APIS.includes(api_name)) {
    console.warn(`[usage] ignoring unknown api_name: ${api_name}`);
    return;
  }
  try {
    const sql = getDb();
    await ensureSchema(sql);
    await sql`
      INSERT INTO api_usage_log (api_name, status_code, balance_remaining, metadata)
      VALUES (${api_name}, ${status_code}, ${balance_remaining}, ${metadata ? JSON.stringify(metadata) : null})
    `;
  } catch (err) {
    console.error('[usage.logApiCall] failed:', err.message);
  }
}

/**
 * Internal helper — checks if an API is allowed to make a call right now.
 * Returns { allowed: boolean, reason: string|null, balance: number }.
 * Used by domain-search.js and elevation-tile.js to short-circuit before
 * hitting the upstream API.
 */
export async function checkApiAllowed(api_name) {
  try {
    const sql = getDb();
    await ensureSchema(sql);
    const stats = await getStatsForApi(sql, api_name);
    if (!stats) return { allowed: false, reason: 'subscription_not_found', balance: 0 };
    if (!stats.is_active) return { allowed: false, reason: 'inactive', balance: stats.balance_remaining };
    if (stats.balance_remaining <= 0) return { allowed: false, reason: 'quota_exhausted', balance: 0 };
    return { allowed: true, reason: null, balance: stats.balance_remaining };
  } catch (err) {
    console.error('[usage.checkApiAllowed] failed:', err.message);
    // Fail-open on errors — better to make a call than block legitimate use
    return { allowed: true, reason: 'check_failed', balance: 0 };
  }
}

// ── Handler ──────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  let sql;
  try {
    sql = getDb();
    await ensureSchema(sql);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  const url = req.url || '';

  // ── GET — read state (any signed-in user, so listings button can read is_active) ─
  if (req.method === 'GET') {
    const session = await requireSession(req, res);
    if (!session) return;
    try {
      const [tessadem, domain] = await Promise.all([
        getStatsForApi(sql, 'tessadem'),
        getStatsForApi(sql, 'domain'),
      ]);
      return res.status(200).json({ tessadem, domain });
    } catch (err) {
      console.error('[usage GET] failed:', err);
      return res.status(500).json({ error: 'Failed to fetch usage', detail: err.message });
    }
  }

  // ── PUT — update subscription fields (admin only) ──────────────────────────
  if (req.method === 'PUT') {
    const session = await requireSession(req, res);
    if (!session) return;
    if (!requireAdmin(session, res)) return;

    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    if (!body || typeof body !== 'object') body = {};

    const { api_name, sub_type, sub_amount, effective_start_date, is_active } = body;
    if (!VALID_APIS.includes(api_name)) {
      return res.status(400).json({ error: `api_name must be one of: ${VALID_APIS.join(', ')}` });
    }
    if (sub_type !== undefined && !VALID_TYPES.includes(sub_type)) {
      return res.status(400).json({ error: `sub_type must be one of: ${VALID_TYPES.join(', ')}` });
    }
    if (sub_amount !== undefined && (!Number.isFinite(sub_amount) || sub_amount < 0)) {
      return res.status(400).json({ error: 'sub_amount must be a non-negative number' });
    }
    if (effective_start_date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(effective_start_date)) {
      return res.status(400).json({ error: 'effective_start_date must be ISO date (YYYY-MM-DD)' });
    }

    try {
      // Build dynamic update — neon's tagged template doesn't support COALESCE-style
      // partial updates trivially, so we read-modify-write.
      const cur = (await sql`SELECT * FROM api_subscriptions WHERE api_name = ${api_name}`)[0];
      if (!cur) return res.status(404).json({ error: 'subscription not found (DB seed missing?)' });

      const newSubType = sub_type !== undefined ? sub_type : cur.sub_type;
      const newSubAmount = sub_amount !== undefined ? sub_amount : cur.sub_amount;
      const newEffective = effective_start_date !== undefined ? effective_start_date : cur.effective_start_date;
      const newActive = is_active !== undefined ? !!is_active : cur.is_active;
      const updatedBy = session.email || session.name || 'admin';

      await sql`
        UPDATE api_subscriptions SET
          sub_type             = ${newSubType},
          sub_amount           = ${newSubAmount},
          effective_start_date = ${newEffective},
          is_active            = ${newActive},
          updated_at           = NOW(),
          updated_by           = ${updatedBy}
        WHERE api_name = ${api_name}
      `;
      const stats = await getStatsForApi(sql, api_name);
      return res.status(200).json({ ok: true, subscription: stats });
    } catch (err) {
      console.error('[usage PUT] failed:', err);
      return res.status(500).json({ error: 'Failed to update subscription', detail: err.message });
    }
  }

  // ── POST /api/usage/active — toggle is_active (Domain: any user, TessaDEM: admin) ─
  if (req.method === 'POST' && url.includes('/active')) {
    const session = await requireSession(req, res);
    if (!session) return;

    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    if (!body || typeof body !== 'object') body = {};

    const { api_name, is_active } = body;
    if (!VALID_APIS.includes(api_name)) {
      return res.status(400).json({ error: `api_name must be one of: ${VALID_APIS.join(', ')}` });
    }
    if (typeof is_active !== 'boolean') {
      return res.status(400).json({ error: 'is_active must be boolean' });
    }
    // TessaDEM: admin-only; Domain: any signed-in user
    if (api_name === 'tessadem' && !isAdmin(session)) {
      return res.status(403).json({ error: 'Admin access required for tessadem' });
    }

    try {
      const updatedBy = session.email || session.name || 'user';
      await sql`
        UPDATE api_subscriptions
        SET is_active = ${is_active},
            updated_at = NOW(),
            updated_by = ${updatedBy}
        WHERE api_name = ${api_name}
      `;
      const stats = await getStatsForApi(sql, api_name);
      return res.status(200).json({ ok: true, subscription: stats });
    } catch (err) {
      console.error('[usage POST /active] failed:', err);
      return res.status(500).json({ error: 'Failed to toggle active', detail: err.message });
    }
  }

  // ── POST /api/usage — server-internal call log ─────────────────────────────
  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    if (!body || typeof body !== 'object') body = {};

    const { api_name, status_code, balance_remaining = null, metadata = null } = body;
    if (!VALID_APIS.includes(api_name)) {
      return res.status(400).json({ error: `api_name must be one of: ${VALID_APIS.join(', ')}` });
    }
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
