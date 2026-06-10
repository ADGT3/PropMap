/**
 * api/migrate-to-v82b-diag.js
 * V82.b — Migration diagnostics.
 * Returns sample errors from rex_import_log to diagnose import failures.
 * GET → returns first 20 contact errors + first 20 property errors
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
    const contact_errors = await sql`
      SELECT rex_id, detail
      FROM rex_import_log
      WHERE entity_type = 'contact' AND status = 'error'
      LIMIT 20`;

    const property_errors = await sql`
      SELECT rex_id, detail
      FROM rex_import_log
      WHERE entity_type = 'property' AND status = 'error'
      LIMIT 20`;

    const distinct_contact_errors = await sql`
      SELECT detail, COUNT(*)::int AS n
      FROM rex_import_log
      WHERE entity_type = 'contact' AND status = 'error'
      GROUP BY detail
      ORDER BY n DESC
      LIMIT 10`;

    const distinct_property_errors = await sql`
      SELECT detail, COUNT(*)::int AS n
      FROM rex_import_log
      WHERE entity_type = 'property' AND status = 'error'
      GROUP BY detail
      ORDER BY n DESC
      LIMIT 10`;

    return res.status(200).json({
      contact_errors: { sample: contact_errors, distinct_messages: distinct_contact_errors },
      property_errors: { sample: property_errors, distinct_messages: distinct_property_errors },
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
