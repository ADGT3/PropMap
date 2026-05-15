/**
 * api/migrate-to-v78g.js
 * V78g — Seed per-board default-score system settings.
 *
 * Adds one row to system_settings per existing board:
 *   key:      board_default_score_<board_id>
 *   value:    '40'
 *   category: 'boards'
 *   label:    'Default Score — <board name>'
 *   description: 'Default interest_level (0–100) for new cards added to this board.'
 *
 * Future-proofing: api/boards.js POST handler auto-seeds the matching row when
 * a new board is created (see v78g change in boards.js), and DELETE removes it.
 *
 * Idempotent — re-running adds rows only for boards that don't already have one.
 * No schema changes (system_settings table and category column already exist
 * since v77.2).
 *
 * GET  → status / dry-run summary
 * POST → execute
 */

import { neon } from '@neondatabase/serverless';
import { requireSession, requireAdmin } from '../lib/auth.js';
import { getDatabaseUrl } from '../lib/db.js';
const sql = neon(getDatabaseUrl());

const MIGRATION_ID = 'v78g_per_board_default_score_settings';
const DEFAULT_SCORE = '40';

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

export default async function handler(req, res) {
  const session = await requireSession(req, res);
  if (!session) return;
  if (!requireAdmin(session, res)) return;

  try {
    if (req.method === 'GET') {
      await ensureMigrationsTable();
      const boards = await sql`SELECT id, name FROM boards ORDER BY sort_order`;
      const existing = await sql`SELECT key FROM system_settings WHERE category = 'boards'`;
      const existingKeys = new Set(existing.map(r => r.key));
      const willSeed = boards.filter(b => !existingKeys.has(`board_default_score_${b.id}`));
      return res.status(200).json({
        migration_id: MIGRATION_ID,
        already_ran: await hasMigrationRun(),
        boards_total: boards.length,
        settings_already_present: existing.length,
        will_seed_count: willSeed.length,
        will_seed: willSeed.map(b => `board_default_score_${b.id}`),
        note: 'POST to execute.',
      });
    }

    if (req.method === 'POST') {
      await ensureMigrationsTable();

      // V78g — only filter on category='boards' for the dedup check; the
      // operation itself is ON CONFLICT DO NOTHING so re-running is safe even
      // if the migration row was deleted.
      const boards = await sql`SELECT id, name FROM boards`;
      let inserted = 0;
      for (const b of boards) {
        const key = `board_default_score_${b.id}`;
        const r = await sql`
          INSERT INTO system_settings (key, value, category, label, description)
          VALUES (${key}, ${DEFAULT_SCORE}, 'boards',
                  ${'Default Score — ' + b.name},
                  ${'Default interest_level (0\u2013100) for new cards added to this board.'})
          ON CONFLICT (key) DO NOTHING
          RETURNING key`;
        if (r.length) inserted++;
      }

      await sql`INSERT INTO _migrations (id) VALUES (${MIGRATION_ID}) ON CONFLICT DO NOTHING`;
      return res.status(200).json({
        migration_id: MIGRATION_ID,
        success: true,
        boards_processed: boards.length,
        rows_inserted: inserted,
      });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[migrate-v78g] fatal:', err);
    return res.status(500).json({ error: err.message });
  }
}
