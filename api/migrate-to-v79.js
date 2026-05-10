/**
 * api/migrate-to-v79.js
 * V79 — Marketing-preference schema cleanup on `contacts` table.
 *
 * Three changes, all on `contacts`:
 *   1. DROP privacy_consent_at — V77's "privacy consent" tickbox on the
 *      inspection check-in modal was conceptually nonsense (it conflated
 *      multiple things). The lease-offer flow's privacy consents live on
 *      the `applications` table and are unaffected.
 *   2. ADD marketing_pref_set_at TIMESTAMPTZ — distinguishes "never asked"
 *      (NULL) from "asked, opted out of all marketing channels" (set, with
 *      all marketing flags NULL). Enables future cron-driven 24-month
 *      reconfirmation flows.
 *   3. RENAME do_not_contact_at → do_not_send_marketing_at — the field's
 *      true semantic. It's a hard opt-out from marketing only; transactional
 *      contact (about a property the contact enquired on) is still allowed.
 *
 * Idempotent. Safe to re-run.
 *
 * GET  → status / dry-run
 * POST → execute
 */

import { neon } from '@neondatabase/serverless';
import { requireSession, requireAdmin } from '../lib/auth.js';
import { getDatabaseUrl } from '../lib/db.js';
const sql = neon(getDatabaseUrl());

const MIGRATION_ID = 'v79_marketing_pref_cleanup';

async function ensureMigrationsTable() {
  await sql`
    CREATE TABLE IF NOT EXISTS _migrations (
      id     TEXT PRIMARY KEY,
      ran_at TIMESTAMPTZ DEFAULT now()
    )`;
}
async function hasMigrationRun() {
  const r = await sql`SELECT 1 FROM _migrations WHERE id = ${MIGRATION_ID}`;
  return r.length > 0;
}
async function columnExists(table, col) {
  const r = await sql`
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name=${table} AND column_name=${col}`;
  return r.length > 0;
}

export default async function handler(req, res) {
  const session = await requireSession(req, res);
  if (!session) return;
  if (!requireAdmin(session, res)) return;

  try {
    if (req.method === 'GET') {
      await ensureMigrationsTable();
      return res.status(200).json({
        migration_id: MIGRATION_ID,
        already_ran: await hasMigrationRun(),
        privacy_consent_at_exists:        await columnExists('contacts', 'privacy_consent_at'),
        marketing_pref_set_at_exists:     await columnExists('contacts', 'marketing_pref_set_at'),
        do_not_contact_at_exists:         await columnExists('contacts', 'do_not_contact_at'),
        do_not_send_marketing_at_exists:  await columnExists('contacts', 'do_not_send_marketing_at'),
        note: 'POST to execute.',
      });
    }

    if (req.method === 'POST') {
      await ensureMigrationsTable();
      if (await hasMigrationRun()) {
        return res.status(200).json({ migration_id: MIGRATION_ID, already_ran: true, message: 'No-op.' });
      }

      // 1) Drop privacy_consent_at if it exists.
      if (await columnExists('contacts', 'privacy_consent_at')) {
        await sql`ALTER TABLE contacts DROP COLUMN privacy_consent_at`;
      }

      // 2) Add marketing_pref_set_at if missing.
      if (!(await columnExists('contacts', 'marketing_pref_set_at'))) {
        await sql`ALTER TABLE contacts ADD COLUMN marketing_pref_set_at TIMESTAMPTZ`;
      }

      // 3) Rename do_not_contact_at → do_not_send_marketing_at.
      // Possible states:
      //   - old name exists, new doesn't  → rename
      //   - old doesn't, new exists       → already renamed, no-op
      //   - both exist (manual partial)   → keep new, drop old (lossy but unlikely)
      //   - neither exists                → add the new name fresh
      const hasOld = await columnExists('contacts', 'do_not_contact_at');
      const hasNew = await columnExists('contacts', 'do_not_send_marketing_at');
      if (hasOld && !hasNew) {
        await sql`ALTER TABLE contacts RENAME COLUMN do_not_contact_at TO do_not_send_marketing_at`;
      } else if (hasOld && hasNew) {
        // Defensive — should not normally happen
        await sql`ALTER TABLE contacts DROP COLUMN do_not_contact_at`;
      } else if (!hasOld && !hasNew) {
        await sql`ALTER TABLE contacts ADD COLUMN do_not_send_marketing_at TIMESTAMPTZ`;
      }
      // else: hasNew && !hasOld → already correct, no-op

      await sql`INSERT INTO _migrations (id) VALUES (${MIGRATION_ID}) ON CONFLICT DO NOTHING`;
      return res.status(200).json({
        migration_id: MIGRATION_ID,
        success: true,
        privacy_consent_at_dropped:       !(await columnExists('contacts', 'privacy_consent_at')),
        marketing_pref_set_at_added:      await columnExists('contacts', 'marketing_pref_set_at'),
        do_not_send_marketing_at_present: await columnExists('contacts', 'do_not_send_marketing_at'),
      });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[migrate-v79] fatal:', err);
    return res.status(500).json({ error: err.message });
  }
}
