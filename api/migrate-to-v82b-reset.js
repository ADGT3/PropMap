/**
 * api/migrate-to-v82b-reset.js
 * V82.b — Clears error entries from rex_import_log so the data
 * migration can be re-run after a script fix.
 *
 * GET  → shows count of error rows that would be cleared
 * POST → deletes all error rows from rex_import_log
 */

import { neon } from '@neondatabase/serverless';
import { requireSession, requireAdmin } from '../lib/auth.js';
import { getDatabaseUrl } from '../lib/db.js';
const sql = neon(getDatabaseUrl());

export default async function handler(req, res) {
  const session = await requireSession(req, res);
  if (!session) return;
  if (!requireAdmin(session, res)) return;

  try {
    if (req.method === 'GET') {
      const counts = await sql`
        SELECT status, COUNT(*)::int AS n
        FROM rex_import_log
        GROUP BY status
        ORDER BY status`;
      return res.status(200).json({
        current_log: counts,
        note: 'POST to delete all error rows so the migration can re-run.',
      });
    }

    if (req.method === 'POST') {
      const deleted = await sql`
        DELETE FROM rex_import_log WHERE status = 'error' RETURNING id`;
      return res.status(200).json({
        deleted_error_rows: deleted.length,
        message: 'Error rows cleared. Re-run migrate-to-v82b-data to retry.',
      });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
