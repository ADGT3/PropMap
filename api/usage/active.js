/**
 * api/usage/active.js
 *
 * Toggle is_active on an API subscription.
 *
 * POST /api/usage/active
 *   Body: { api_name: 'tessadem'|'domain', is_active: boolean }
 *
 * Authorisation:
 *   - api_name = 'domain'   → any signed-in user (Listings button uses this)
 *   - api_name = 'tessadem' → admin only
 *
 * Returns: { ok: true, subscription: <updated stats> }
 */

import { neon } from '@neondatabase/serverless';
import { requireSession, isAdmin } from '../../lib/auth.js';

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

// Period math (mirrored from api/usage.js so we can return fresh stats post-update)
function computeCurrentPeriod(subType, effectiveStartDate, nowDate = new Date()) {
  const start = new Date(effectiveStartDate);
  if (subType === 'total') return { period_start: start, period_end: null };
  let periodStart = new Date(start);
  let periodEnd = new Date(start);
  periodEnd.setMonth(periodEnd.getMonth() + 1);
  while (periodEnd <= nowDate) {
    periodStart = periodEnd;
    periodEnd = new Date(periodStart);
    periodEnd.setMonth(periodEnd.getMonth() + 1);
  }
  return { period_start: periodStart, period_end: periodEnd };
}

async function getStatsForApi(sql, api_name) {
  const subRows = await sql`SELECT * FROM api_subscriptions WHERE api_name = ${api_name}`;
  const sub = subRows[0];
  if (!sub) return null;

  const period = computeCurrentPeriod(sub.sub_type, sub.effective_start_date);

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

  const lastRows = await sql`
    SELECT called_at, balance_remaining FROM api_usage_log
    WHERE api_name = ${api_name}
      AND is_reset_marker = FALSE
      AND status_code = 200
    ORDER BY called_at DESC LIMIT 1
  `;

  return {
    api_name:             sub.api_name,
    sub_type:             sub.sub_type,
    sub_amount:           sub.sub_amount,
    effective_start_date: sub.effective_start_date,
    is_active:            sub.is_active,
    updated_at:           sub.updated_at,
    updated_by:           sub.updated_by,
    period_start:         period.period_start.toISOString(),
    period_end:           period.period_end ? period.period_end.toISOString() : null,
    period_calls:         periodCalls,
    this_month_calls:     periodCalls,
    balance_remaining:    Math.max(0, sub.sub_amount - periodCalls),
    last_call_at:         lastRows[0]?.called_at || null,
    last_balance:         lastRows[0]?.balance_remaining ?? null,
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

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
  // TessaDEM admin-only; Domain any signed-in user
  if (api_name === 'tessadem' && !isAdmin(session)) {
    return res.status(403).json({ error: 'Admin access required for tessadem' });
  }

  let sql;
  try {
    sql = getDb();
  } catch (err) {
    return res.status(500).json({ error: err.message });
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
    console.error('[usage/active] failed:', err);
    return res.status(500).json({ error: 'Failed to toggle active', detail: err.message });
  }
}
