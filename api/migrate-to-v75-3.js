/**
 * api/migrate-to-v75-3.js
 * V75.3 migration — unified notes + DD per-deal.
 *
 * Two independent pieces bundled into one migration endpoint:
 *
 * A) NOTES UNIFICATION
 *    - Create new `notes` table: polymorphic (entity_type, entity_id),
 *      optional tagged_contact_id, author_id + author_name, created_at.
 *    - Migrate `contact_notes` rows → notes (preserves entity_type/entity_id,
 *      sets tagged_contact_id from the old contact_id column).
 *    - Migrate `deals.data.notes[]` array entries → notes rows with
 *      entity_type='deal'. Takes note.contact_id / note.contact_name if
 *      present (old Kanban UI optionally stamped those).
 *    - Drop contact_notes table.
 *    - Strip `notes` field from each deals.data JSONB.
 *
 * B) DD PER-DEAL
 *    - For every property, copy `properties.dd` to `deals.data.dd` on every
 *      active deal for that property.
 *    - Drop the `properties.dd` column.
 *
 * Idempotency: tracked via _migrations table. Safe to call GET (dry-run) and
 * POST (execute) repeatedly; second execute is a no-op.
 *
 * GET  /api/migrate-to-v75-3  → dry-run status
 * POST /api/migrate-to-v75-3  → execute (admin-only)
 */

import { neon } from '@neondatabase/serverless';
import { requireSession, requireAdmin } from '../lib/auth.js';
import { getDatabaseUrl } from '../lib/db.js';
const sql = neon(getDatabaseUrl());

const MIGRATION_ID = 'v75_3_notes_and_dd';

export default async function handler(req, res) {
  const session = await requireSession(req, res);
  if (!session) return;
  if (!requireAdmin(session, res)) return;

  try {
    if (req.method === 'GET')  return await dryRun(req, res);
    if (req.method === 'POST') return await execute(req, res);
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[migrate-v75.3] fatal:', err);
    return res.status(500).json({ error: err.message });
  }
}

async function dryRun(req, res) {
  // _migrations table may not exist if running before any V75 migration (shouldn't happen)
  const existing = await sql`
    SELECT 1 FROM information_schema.tables
    WHERE table_schema='public' AND table_name='_migrations'`;
  let alreadyRan = false;
  if (existing.length) {
    const m = await sql`SELECT 1 FROM _migrations WHERE id = ${MIGRATION_ID}`;
    alreadyRan = m.length > 0;
  }

  const tables = (await sql`SELECT table_name FROM information_schema.tables WHERE table_schema='public'`)
    .map(r => r.table_name);

  const counts = {
    contact_notes: tables.includes('contact_notes')
      ? (await sql`SELECT COUNT(*)::int AS c FROM contact_notes`)[0].c : null,
    notes: tables.includes('notes')
      ? (await sql`SELECT COUNT(*)::int AS c FROM notes`)[0].c : null,
    deals: tables.includes('deals')
      ? (await sql`SELECT COUNT(*)::int AS c FROM deals`)[0].c : null,
  };

  // Count deals with inline notes arrays (they'll be migrated)
  let dealsWithInlineNotes = null;
  if (tables.includes('deals')) {
    const r = await sql`
      SELECT COUNT(*)::int AS c FROM deals
      WHERE jsonb_typeof(data->'notes') = 'array'
        AND jsonb_array_length(data->'notes') > 0`;
    dealsWithInlineNotes = r[0].c;
  }

  // Count properties with DD data (they'll be propagated to deals)
  let propertiesWithDd = null;
  const propsCols = tables.includes('properties')
    ? (await sql`SELECT column_name FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='properties'`).map(c => c.column_name)
    : [];
  if (propsCols.includes('dd')) {
    const r = await sql`SELECT COUNT(*)::int AS c FROM properties WHERE dd IS NOT NULL AND dd::text <> '{}'`;
    propertiesWithDd = r[0].c;
  }

  return res.status(200).json({
    migration_id: MIGRATION_ID,
    already_run: alreadyRan,
    tables,
    counts,
    deals_with_inline_notes: dealsWithInlineNotes,
    properties_with_dd: propertiesWithDd,
    properties_has_dd_column: propsCols.includes('dd'),
    next_action: alreadyRan ? 'nothing — already migrated' : 'POST to /api/migrate-to-v75-3 to execute',
  });
}

async function execute(req, res) {
  const steps = [];
  const step = async (name, fn) => {
    try {
      const result = await fn();
      steps.push({ ok: true, step: name, ...(result || {}) });
    } catch (err) {
      console.error(`[migrate-v75.3] ${name} FAILED:`, err);
      steps.push({ ok: false, step: name, error: err.message });
      throw err;
    }
  };

  try {
    // Bail if already run
    const prior = await sql`SELECT 1 FROM _migrations WHERE id = ${MIGRATION_ID}`;
    if (prior.length) {
      return res.status(200).json({ ok: true, already_run: true, steps: [] });
    }

    // ── A1. Create notes table ─────────────────────────────────────────────
    await step('CREATE TABLE notes', async () => {
      await sql`
        CREATE TABLE IF NOT EXISTS notes (
          id                BIGSERIAL PRIMARY KEY,
          entity_type       TEXT NOT NULL,
          entity_id         TEXT NOT NULL,
          tagged_contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
          note_text         TEXT NOT NULL,
          author_id         INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
          author_name       TEXT,
          created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
        )`;
      return { done: true };
    });

    await step('CREATE INDEX notes_entity_idx', async () => {
      await sql`CREATE INDEX IF NOT EXISTS notes_entity_idx ON notes (entity_type, entity_id, created_at DESC)`;
      return { done: true };
    });
    await step('CREATE INDEX notes_tagged_contact_idx', async () => {
      await sql`CREATE INDEX IF NOT EXISTS notes_tagged_contact_idx ON notes (tagged_contact_id)`;
      return { done: true };
    });
    await step('CREATE INDEX notes_author_idx', async () => {
      await sql`CREATE INDEX IF NOT EXISTS notes_author_idx ON notes (author_id)`;
      return { done: true };
    });

    // ── A2. Migrate contact_notes rows ─────────────────────────────────────
    let migratedFromContactNotes = 0;
    await step('Migrate contact_notes → notes', async () => {
      const tables = (await sql`SELECT table_name FROM information_schema.tables WHERE table_schema='public'`)
        .map(r => r.table_name);
      if (!tables.includes('contact_notes')) {
        return { migrated: 0, note: 'contact_notes does not exist (already cleaned up?)' };
      }
      // Each contact_notes row: contact_id (NOT NULL, was the attached entity),
      // pipeline_id (legacy), entity_type/entity_id (added in V75.0a), note_text, created_at.
      // Under old semantics, contact_id was the "attached contact" — we preserve that as
      // tagged_contact_id under new semantics.
      const rows = await sql`
        SELECT id, contact_id, pipeline_id, entity_type, entity_id, note_text, created_at
        FROM contact_notes`;
      for (const r of rows) {
        let etype = r.entity_type;
        let eid   = r.entity_id;
        if (!etype || !eid) {
          // Old row without entity_type — fall back:
          // If pipeline_id set → entity_type='deal', entity_id=pipeline_id (note attached to deal)
          // Otherwise → entity_type='contact', entity_id=contact_id (note attached to contact)
          if (r.pipeline_id) { etype = 'deal';    eid = String(r.pipeline_id); }
          else               { etype = 'contact'; eid = String(r.contact_id);  }
        }
        await sql`
          INSERT INTO notes (entity_type, entity_id, tagged_contact_id, note_text, author_id, author_name, created_at)
          VALUES (${etype}, ${String(eid)}, ${r.contact_id || null}, ${r.note_text}, NULL, 'Unknown', ${r.created_at})`;
        migratedFromContactNotes++;
      }
      return { migrated: migratedFromContactNotes };
    });

    // ── A3. Migrate deals.data.notes[] → notes rows ────────────────────────
    let migratedFromDeals = 0;
    await step('Migrate deals.data.notes[] → notes', async () => {
      const deals = await sql`
        SELECT id, data FROM deals
        WHERE jsonb_typeof(data->'notes') = 'array'
          AND jsonb_array_length(data->'notes') > 0`;
      for (const d of deals) {
        const arr = (d.data && Array.isArray(d.data.notes)) ? d.data.notes : [];
        for (const n of arr) {
          const text = (n.text || '').trim();
          if (!text) continue;
          // Timestamp from note.ts (ms epoch) falls back to now()
          const ts = n.ts ? new Date(Number(n.ts)) : new Date();
          await sql`
            INSERT INTO notes (entity_type, entity_id, tagged_contact_id, note_text, author_id, author_name, created_at)
            VALUES ('deal', ${String(d.id)}, ${n.contact_id || null}, ${text}, NULL, ${n.contact_name || 'Unknown'}, ${ts.toISOString()})`;
          migratedFromDeals++;
        }
      }
      return { migrated: migratedFromDeals };
    });

    // ── A4. Strip notes field from deals.data ──────────────────────────────
    await step("Strip 'notes' from deals.data JSONB", async () => {
      const r = await sql`UPDATE deals SET data = data - 'notes' WHERE data ? 'notes'`;
      return { rows_updated: r.count ?? r.length ?? 0 };
    });

    // ── A5. Drop contact_notes ─────────────────────────────────────────────
    await step('Drop contact_notes', async () => {
      await sql`DROP TABLE IF EXISTS contact_notes`;
      return { done: true };
    });

    // ── B1. Copy properties.dd → deals.data.dd ─────────────────────────────
    let ddPropagated = 0;
    await step('Propagate properties.dd → deals.data.dd', async () => {
      const propsCols = (await sql`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema='public' AND table_name='properties'`).map(c => c.column_name);
      if (!propsCols.includes('dd')) {
        return { propagated: 0, note: 'properties.dd column not present' };
      }
      // For each deal whose property has DD data, set deals.data.dd to that property's dd,
      // preserving any existing deal-level dd that might already be set (shouldn't be any yet).
      const r = await sql`
        UPDATE deals d
        SET data = jsonb_set(COALESCE(d.data, '{}'::jsonb), '{dd}', COALESCE(p.dd, '{}'::jsonb), true)
        FROM properties p
        WHERE d.property_id = p.id
          AND p.dd IS NOT NULL
          AND p.dd::text <> '{}'`;
      ddPropagated = r.count ?? r.length ?? 0;
      return { deals_updated: ddPropagated };
    });

    // ── B2. Drop properties.dd column ──────────────────────────────────────
    await step('Drop properties.dd column', async () => {
      await sql`ALTER TABLE properties DROP COLUMN IF EXISTS dd`;
      return { done: true };
    });

    // ── C. Record completion ───────────────────────────────────────────────
    await step('Record migration completion', async () => {
      await sql`
        INSERT INTO _migrations (id, completed_at) VALUES (${MIGRATION_ID}, now())
        ON CONFLICT (id) DO NOTHING`;
      return { done: true };
    });

    return res.status(200).json({
      ok: true,
      already_run: false,
      summary: {
        migrated_from_contact_notes: migratedFromContactNotes,
        migrated_from_deals_inline:  migratedFromDeals,
        dd_propagated_to_deals:      ddPropagated,
      },
      steps,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message, steps });
  }
}
