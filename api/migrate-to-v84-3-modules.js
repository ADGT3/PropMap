/**
 * api/migrate-to-v84-3-modules.js
 *
 * V84.3 — Board kind/features + module-oriented access foundations.
 *
 *   A) boards.kind TEXT
 *   B) boards.features TEXT[]  (NULL = use kind defaults from lib/board-kinds.js)
 *   C) Seed kind on system boards
 *   D) Expand legacy access_modules {'propmap'} → all four modules
 *      (mapping, pipeline, crm, finance) so existing users keep full access
 *
 * Safe to re-run.
 */

import { neon } from '@neondatabase/serverless';
import { getDatabaseUrl } from '../lib/db.js';
import { requireSession, requireAdmin } from '../lib/auth.js';
import { BOARD_ID_TO_KIND } from '../lib/board-kinds.js';
import { APP_MODULE_IDS } from '../lib/modules.js';

const MIGRATION_ID = 'v84_3_modules_board_kinds';
const sql = neon(getDatabaseUrl());

async function columnExists(table, column) {
  const rows = await sql`
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table} AND column_name = ${column}
    LIMIT 1`;
  return rows.length > 0;
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({
      migration: MIGRATION_ID,
      description: 'Board kind/features columns + expand propmap access_modules',
    });
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const session = await requireSession(req, res);
  if (!session) return;
  if (!requireAdmin(session, res)) return;

  const results = [];
  const step = async (label, fn) => {
    try {
      const detail = await fn();
      results.push({ ok: true, step: label, detail: detail || null });
    } catch (err) {
      results.push({ ok: false, step: label, error: err.message });
    }
  };

  await step('ALTER boards ADD kind', async () => {
    if (await columnExists('boards', 'kind')) return { note: 'already present' };
    await sql`ALTER TABLE boards ADD COLUMN kind TEXT`;
    return { added: true };
  });

  await step('ALTER boards ADD features', async () => {
    if (await columnExists('boards', 'features')) return { note: 'already present' };
    await sql`ALTER TABLE boards ADD COLUMN features TEXT[]`;
    return { added: true };
  });

  await step('Seed kind on system boards', async () => {
    const updates = [];
    for (const [id, kind] of Object.entries(BOARD_ID_TO_KIND)) {
      const r = await sql`
        UPDATE boards SET kind = ${kind}
        WHERE id = ${id} AND (kind IS NULL OR kind = '')
        RETURNING id`;
      if (r.length) updates.push(id);
    }
    // Action boards
    await sql`
      UPDATE boards SET kind = 'action'
      WHERE board_type = 'action' AND (kind IS NULL OR kind = '')`;
    return { updated: updates };
  });

  await step('Expand legacy propmap access_modules', async () => {
    // contacts with only propmap (or empty with can_login) → full module set
    const mods = APP_MODULE_IDS;
    const r = await sql`
      UPDATE contacts
         SET access_modules = ${mods}
       WHERE can_login = true
         AND (
           access_modules IS NULL
           OR access_modules = ARRAY[]::text[]
           OR access_modules = ARRAY['propmap']::text[]
           OR (access_modules @> ARRAY['propmap']::text[] AND NOT access_modules @> ARRAY['mapping']::text[])
         )
       RETURNING id`;
    return { contacts_updated: r.length };
  });

  // Record migration marker in system_settings if table exists
  await step('Record migration marker', async () => {
    try {
      await sql`
        INSERT INTO system_settings (category, key, value, updated_at)
        VALUES ('migrations', ${MIGRATION_ID}, 'done', now())
        ON CONFLICT (category, key) DO UPDATE SET value = 'done', updated_at = now()`;
      return { recorded: true };
    } catch {
      return { recorded: false, note: 'system_settings unavailable' };
    }
  });

  const allOk = results.every(r => r.ok);
  return res.status(allOk ? 200 : 207).json({ migration: MIGRATION_ID, allOk, results });
}
