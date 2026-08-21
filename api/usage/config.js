/**
 * api/usage/config.js
 *
 * Fast read of the subscription configuration only — no period counts, no
 * usage stats. Used by the dashboard for an immediate first paint while the
 * heavier /api/usage call (with balance + period stats) loads in parallel.
 *
 * GET /api/usage/config
 *   Returns: { tessadem: { sub_type, sub_amount, effective_start_date,
 *                          is_active, updated_at, updated_by },
 *             domain:   { same shape } }
 *
 * Auth: any signed-in user (same as /api/usage).
 */

import { neon } from '@neondatabase/serverless';
import { requireSession } from '../../lib/auth.js';

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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const session = await requireSession(req, res);
  if (!session) return;

  let sql;
  try {
    sql = getDb();
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  try {
    // Single round-trip — both subscriptions in one query
    const rows = await sql`
      SELECT api_name, sub_type, sub_amount, effective_start_date,
             is_active, updated_at, updated_by
      FROM api_subscriptions
      WHERE api_name IN ('tessadem', 'domain')
    `;
    const out = { tessadem: null, domain: null };
    for (const r of rows) out[r.api_name] = r;
    return res.status(200).json(out);
  } catch (err) {
    console.error('[usage/config] failed:', err);
    return res.status(500).json({ error: 'Failed to fetch config', detail: err.message });
  }
}
