/**
 * api/health.js
 * Quick database connection check.
 * Visit /api/health in your browser after deploying to verify the DB is connected.
 */

import { sql } from '@vercel/postgres';

export default async function handler(req, res) {
  const checks = {
    timestamp:   new Date().toISOString(),
    env:         !!process.env.POSTGRES_URL ? 'POSTGRES_URL found' : 'POSTGRES_URL MISSING',
    db:          null,
    table:       null,
    rowCount:    null,
    error:       null,
  };

  try {
    // 1. Basic connectivity
    await sql`SELECT 1`;
    checks.db = 'connected';

    // 2. Check if pipeline table exists
    const { rows } = await sql`
      SELECT COUNT(*) as count
      FROM information_schema.tables
      WHERE table_name = 'pipeline'
    `;
    const tableExists = parseInt(rows[0].count) > 0;
    checks.table = tableExists ? 'exists' : 'not created yet (will be created on first save)';

    // 3. Row count if table exists
    if (tableExists) {
      const { rows: countRows } = await sql`SELECT COUNT(*) as count FROM pipeline`;
      checks.rowCount = parseInt(countRows[0].count);
    }

  } catch (err) {
    checks.db    = 'FAILED';
    checks.error = err.message;
  }

  const ok = checks.db === 'connected' && checks.env === 'POSTGRES_URL found';
  return res.status(ok ? 200 : 500).json(checks);
}
