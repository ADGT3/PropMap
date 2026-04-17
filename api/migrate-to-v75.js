/**
 * api/migrate-to-v75.js
 * One-shot structural migration to the V75 data model.
 *
 * Separates property identity from deal lifecycle; introduces polymorphic
 * contact-entity links and a manageable roles catalogue.
 *
 * This endpoint is deliberately separate from /api/db-setup so the migration
 * must be triggered explicitly. Idempotent — tracked via the _migrations
 * table so it will not run twice. Admin-only.
 *
 * What it does (in order):
 *   1. Create _migrations tracking table if missing; bail early if v75 already ran
 *   2. Create roles, properties, deals, entity_contacts tables
 *   3. Seed system roles
 *   4. Migrate pipeline rows -> properties + deals (same id as pipeline id)
 *   5. Migrate contact_properties -> entity_contacts (split by role default_scope)
 *   6. Alter contact_notes: add entity_type column, rename pipeline_id -> entity_id
 *   7. Alter property_financials: add deal_id column keyed to same id
 *   8. Drop old pipeline and contact_properties tables
 *   9. Record completion in _migrations
 *
 * Rollback: restore Neon DB from a pre-migration branch snapshot.
 *
 * GET  /api/migrate-to-v75  -> dry-run status: show what's already done / what would run
 * POST /api/migrate-to-v75  -> execute migration (admin-only)
 */

import { neon } from '@neondatabase/serverless';
import { requireSession, requireAdmin } from '../lib/auth.js';
import { getDatabaseUrl } from '../lib/db.js';
const sql = neon(getDatabaseUrl());

const MIGRATION_ID = 'v75_structural_rebuild';

// System roles seeded on first run. See design doc for scope rationale.
const SYSTEM_ROLES = [
  { id: 'vendor',           label: 'Vendor',           scopes: ['property','deal'], default_scope: 'property', sort_order: 10 },
  { id: 'owner',            label: 'Owner',            scopes: ['property'],        default_scope: 'property', sort_order: 20 },
  { id: 'property_manager', label: 'Property Manager', scopes: ['property'],        default_scope: 'property', sort_order: 30 },
  { id: 'agent',            label: 'Agent',            scopes: ['deal'],            default_scope: 'deal',     sort_order: 40 },
  { id: 'buyers_agent',     label: "Buyer's Agent",    scopes: ['deal'],            default_scope: 'deal',     sort_order: 50 },
  { id: 'purchaser',        label: 'Purchaser',        scopes: ['deal'],            default_scope: 'deal',     sort_order: 60 },
  { id: 'referrer',         label: 'Referrer',         scopes: ['deal','property'], default_scope: 'deal',     sort_order: 70 },
  { id: 'solicitor',        label: 'Solicitor',        scopes: ['deal','property'], default_scope: 'deal',     sort_order: 80 },
];

// Legacy role strings that don't match a system role id — map to 'vendor' default
function normaliseRole(r) {
  if (!r) return 'vendor';
  const s = String(r).toLowerCase().trim();
  if (SYSTEM_ROLES.some(sr => sr.id === s)) return s;
  return 'vendor';
}

export default async function handler(req, res) {
  const session = await requireSession(req, res);
  if (!session) return;
  if (!requireAdmin(session, res)) return;

  if (req.method === 'GET') return status(res);
  if (req.method === 'POST') return execute(res);
  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
}

// ── Dry-run / status check ──────────────────────────────────────────────────
async function status(res) {
  try {
    await ensureMigrationsTable();
    const done = await isAlreadyDone();
    const tables = await listPublicTables();
    const counts = {
      pipeline:             tables.includes('pipeline')
        ? (await sql`SELECT COUNT(*)::int AS c FROM pipeline`)[0].c : null,
      contact_properties:   tables.includes('contact_properties')
        ? (await sql`SELECT COUNT(*)::int AS c FROM contact_properties`)[0].c : null,
      contact_notes:        tables.includes('contact_notes')
        ? (await sql`SELECT COUNT(*)::int AS c FROM contact_notes`)[0].c : null,
      property_financials:  tables.includes('property_financials')
        ? (await sql`SELECT COUNT(*)::int AS c FROM property_financials`)[0].c : null,
      properties:           tables.includes('properties')
        ? (await sql`SELECT COUNT(*)::int AS c FROM properties`)[0].c : null,
      deals:                tables.includes('deals')
        ? (await sql`SELECT COUNT(*)::int AS c FROM deals`)[0].c : null,
      entity_contacts:      tables.includes('entity_contacts')
        ? (await sql`SELECT COUNT(*)::int AS c FROM entity_contacts`)[0].c : null,
      roles:                tables.includes('roles')
        ? (await sql`SELECT COUNT(*)::int AS c FROM roles`)[0].c : null,
    };
    return res.status(200).json({
      migration_id: MIGRATION_ID,
      already_run:  done,
      tables,
      counts,
      next_action:  done ? 'Nothing — migration already ran' : 'POST to /api/migrate-to-v75 to execute',
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// ── Execute ─────────────────────────────────────────────────────────────────
async function execute(res) {
  const steps = [];
  const step = async (label, fn) => {
    try {
      const detail = await fn();
      steps.push({ ok: true, step: label, ...(detail || {}) });
    } catch (err) {
      steps.push({ ok: false, step: label, error: err.message });
      throw err; // abort on first failure
    }
  };

  try {
    await ensureMigrationsTable();
    if (await isAlreadyDone()) {
      return res.status(200).json({ ok: true, already_run: true, message: 'Migration v75 already completed — skipping.' });
    }

    // ── 2. Schema for new tables ──────────────────────────────────────────
    await step('CREATE TABLE roles', () => sql`
      CREATE TABLE IF NOT EXISTS roles (
        id             TEXT PRIMARY KEY,
        label          TEXT NOT NULL,
        scopes         TEXT[] NOT NULL,
        default_scope  TEXT NOT NULL,
        sort_order     INTEGER NOT NULL DEFAULT 100,
        active         BOOLEAN NOT NULL DEFAULT true,
        system         BOOLEAN NOT NULL DEFAULT false,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);

    await step('CREATE TABLE properties', () => sql`
      CREATE TABLE IF NOT EXISTS properties (
        id                    TEXT PRIMARY KEY,
        address               TEXT NOT NULL DEFAULT '',
        suburb                TEXT NOT NULL DEFAULT '',
        lat                   DOUBLE PRECISION,
        lng                   DOUBLE PRECISION,
        lot_dps               TEXT NOT NULL DEFAULT '',
        area_sqm              NUMERIC,
        parcels               JSONB NOT NULL DEFAULT '[]'::jsonb,
        property_count        INTEGER NOT NULL DEFAULT 1,
        dd                    JSONB NOT NULL DEFAULT '{}'::jsonb,
        domain_listing_id     TEXT,
        listing_url           TEXT,
        agent                 JSONB,
        not_suitable_until    TIMESTAMPTZ,
        not_suitable_reason   TEXT,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);

    await step('CREATE INDEX properties_lot_dps_idx', () => sql`
      CREATE INDEX IF NOT EXISTS properties_lot_dps_idx ON properties (lot_dps)`);
    await step('CREATE INDEX properties_domain_idx', () => sql`
      CREATE INDEX IF NOT EXISTS properties_domain_idx ON properties (domain_listing_id)`);
    await step('CREATE INDEX properties_not_suitable_idx', () => sql`
      CREATE INDEX IF NOT EXISTS properties_not_suitable_idx ON properties (not_suitable_until)`);

    await step('CREATE TABLE deals', () => sql`
      CREATE TABLE IF NOT EXISTS deals (
        id            TEXT PRIMARY KEY,
        property_id   TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
        workflow      TEXT NOT NULL,
        stage         TEXT NOT NULL,
        status        TEXT NOT NULL DEFAULT 'active',
        data          JSONB NOT NULL DEFAULT '{}'::jsonb,
        opened_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        closed_at     TIMESTAMPTZ,
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);

    await step('CREATE INDEX deals_property_idx', () => sql`
      CREATE INDEX IF NOT EXISTS deals_property_idx ON deals (property_id)`);
    await step('CREATE INDEX deals_workflow_status_idx', () => sql`
      CREATE INDEX IF NOT EXISTS deals_workflow_status_idx ON deals (workflow, status)`);
    await step('CREATE INDEX deals_property_workflow_idx', () => sql`
      CREATE INDEX IF NOT EXISTS deals_property_workflow_idx ON deals (property_id, workflow)`);

    await step('CREATE TABLE entity_contacts', () => sql`
      CREATE TABLE IF NOT EXISTS entity_contacts (
        id            BIGSERIAL PRIMARY KEY,
        contact_id    INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        entity_type   TEXT NOT NULL,
        entity_id     TEXT NOT NULL,
        role_id       TEXT NOT NULL REFERENCES roles(id),
        notes         TEXT,
        linked_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (contact_id, entity_type, entity_id, role_id)
      )`);

    await step('CREATE INDEX entity_contacts_entity_idx', () => sql`
      CREATE INDEX IF NOT EXISTS entity_contacts_entity_idx ON entity_contacts (entity_type, entity_id)`);
    await step('CREATE INDEX entity_contacts_contact_idx', () => sql`
      CREATE INDEX IF NOT EXISTS entity_contacts_contact_idx ON entity_contacts (contact_id)`);
    await step('CREATE INDEX entity_contacts_role_idx', () => sql`
      CREATE INDEX IF NOT EXISTS entity_contacts_role_idx ON entity_contacts (role_id)`);

    // ── 3. Seed system roles ──────────────────────────────────────────────
    await step('Seed system roles', async () => {
      let inserted = 0;
      for (const r of SYSTEM_ROLES) {
        const rows = await sql`
          INSERT INTO roles (id, label, scopes, default_scope, sort_order, active, system)
          VALUES (${r.id}, ${r.label}, ${r.scopes}, ${r.default_scope}, ${r.sort_order}, true, true)
          ON CONFLICT (id) DO NOTHING
          RETURNING id`;
        inserted += rows.length;
      }
      return { inserted };
    });

    // ── 4. Migrate pipeline rows -> properties + deals ────────────────────
    let pipelineRows = [];
    await step('Read pipeline rows', async () => {
      const tables = await listPublicTables();
      if (!tables.includes('pipeline')) return { rows: 0, note: 'pipeline table does not exist — fresh DB' };
      pipelineRows = await sql`SELECT id, data FROM pipeline`;
      return { rows: pipelineRows.length };
    });

    await step('Migrate pipeline -> properties + deals', async () => {
      let propsCreated = 0, dealsCreated = 0;
      for (const row of pipelineRows) {
        const id   = row.id;
        const data = row.data || {};
        const p    = data.property || {};
        const stage  = data.stage || 'shortlisted';
        const status = (stage === 'lost' || stage === 'acquired') ? stage : 'active';
        const closedAt = (status === 'lost' || status === 'acquired') ? new Date().toISOString() : null;

        // Build property payload — keep same id for backward compatibility
        const parcelsJson = JSON.stringify(p._parcels || []);
        const ddJson      = JSON.stringify(data.dd || {});
        const agentJson   = p._agent ? JSON.stringify(p._agent) : null;
        const lotDps      = (p._lotDPs || '').toString().toUpperCase();

        // Use the first parcel's lat/lng if top-level not set
        const firstParcel = Array.isArray(p._parcels) && p._parcels[0] ? p._parcels[0] : null;
        const lat = p.lat ?? firstParcel?.lat ?? null;
        const lng = p.lng ?? firstParcel?.lng ?? null;

        await sql`
          INSERT INTO properties (
            id, address, suburb, lat, lng, lot_dps, area_sqm,
            parcels, property_count, dd, domain_listing_id, listing_url, agent,
            created_at, updated_at
          ) VALUES (
            ${id},
            ${p.address || ''},
            ${p.suburb  || ''},
            ${lat},
            ${lng},
            ${lotDps},
            ${p._areaSqm || null},
            ${parcelsJson}::jsonb,
            ${p._propertyCount || 1},
            ${ddJson}::jsonb,
            ${p.domain_id || null},
            ${p._listingUrl || null},
            ${agentJson}::jsonb,
            ${data.addedAt ? new Date(data.addedAt).toISOString() : new Date().toISOString()},
            now()
          )
          ON CONFLICT (id) DO NOTHING`;
        propsCreated++;

        // Build deal payload — same id as property (keeps 1:1 for migration)
        const dealData = {
          note:    data.note    || '',
          notes:   data.notes   || [],
          addedAt: data.addedAt || Date.now(),
          terms:   data.terms   || null,
          offers:  data.offers  || [],
        };
        const dealDataJson = JSON.stringify(dealData);

        await sql`
          INSERT INTO deals (
            id, property_id, workflow, stage, status, data,
            opened_at, closed_at, updated_at
          ) VALUES (
            ${id},
            ${id},
            'acquisition',
            ${stage},
            ${status},
            ${dealDataJson}::jsonb,
            ${data.addedAt ? new Date(data.addedAt).toISOString() : new Date().toISOString()},
            ${closedAt},
            now()
          )
          ON CONFLICT (id) DO NOTHING`;
        dealsCreated++;
      }
      return { propsCreated, dealsCreated };
    });

    // ── 5. Migrate contact_properties -> entity_contacts ──────────────────
    await step('Migrate contact_properties -> entity_contacts', async () => {
      const tables = await listPublicTables();
      if (!tables.includes('contact_properties')) return { migrated: 0, note: 'contact_properties table does not exist' };

      const links = await sql`SELECT contact_id, pipeline_id, role FROM contact_properties`;

      // Build role scope lookup
      const roleRows = await sql`SELECT id, default_scope FROM roles`;
      const roleScope = {};
      roleRows.forEach(r => { roleScope[r.id] = r.default_scope; });

      let migrated = 0, skipped = 0;
      for (const l of links) {
        const roleId = normaliseRole(l.role);
        const scope  = roleScope[roleId] || 'deal';
        const entityType = scope === 'property' ? 'property' : 'deal';
        // Both property_id and deal_id == pipeline_id after migration (1:1 at this stage)
        const entityId = l.pipeline_id;
        try {
          await sql`
            INSERT INTO entity_contacts (contact_id, entity_type, entity_id, role_id, linked_at)
            VALUES (${l.contact_id}, ${entityType}, ${entityId}, ${roleId}, now())
            ON CONFLICT DO NOTHING`;
          migrated++;
        } catch (err) {
          skipped++;
          console.error('[migrate] entity_contacts insert failed for', l, err.message);
        }
      }
      return { migrated, skipped };
    });

    // ── 6. Alter contact_notes ────────────────────────────────────────────
    await step('Alter contact_notes: add entity_type + entity_id', async () => {
      const tables = await listPublicTables();
      if (!tables.includes('contact_notes')) return { note: 'contact_notes does not exist' };
      // Add new columns
      await sql`ALTER TABLE contact_notes ADD COLUMN IF NOT EXISTS entity_type TEXT`;
      await sql`ALTER TABLE contact_notes ADD COLUMN IF NOT EXISTS entity_id   TEXT`;
      // Populate from pipeline_id where that column exists
      const cols = await sql`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema='public' AND table_name='contact_notes'`;
      const colSet = new Set(cols.map(c => c.column_name));
      if (colSet.has('pipeline_id')) {
        await sql`UPDATE contact_notes SET entity_type = 'deal', entity_id = pipeline_id
                  WHERE pipeline_id IS NOT NULL AND entity_id IS NULL`;
      }
      // Make the new columns useful for querying
      await sql`CREATE INDEX IF NOT EXISTS contact_notes_entity_idx ON contact_notes (entity_type, entity_id)`;
      return { done: true };
    });

    // ── 7. Alter property_financials ──────────────────────────────────────
    await step('Alter property_financials: add deal_id', async () => {
      const tables = await listPublicTables();
      if (!tables.includes('property_financials')) return { note: 'property_financials does not exist' };
      await sql`ALTER TABLE property_financials ADD COLUMN IF NOT EXISTS deal_id TEXT`;
      // At migration time, deal_id == pipeline_id (1:1). Populate.
      await sql`UPDATE property_financials SET deal_id = pipeline_id WHERE deal_id IS NULL`;
      await sql`CREATE INDEX IF NOT EXISTS property_financials_deal_idx ON property_financials (deal_id)`;
      return { done: true };
    });

    // ── 8. Drop old tables ────────────────────────────────────────────────
    await step('Drop contact_properties', async () => {
      await sql`DROP TABLE IF EXISTS contact_properties CASCADE`;
      return { done: true };
    });
    await step('Drop pipeline', async () => {
      await sql`DROP TABLE IF EXISTS pipeline CASCADE`;
      return { done: true };
    });

    // ── 9. Record completion ──────────────────────────────────────────────
    await step('Record migration completion', () => sql`
      INSERT INTO _migrations (id, completed_at) VALUES (${MIGRATION_ID}, now())
      ON CONFLICT (id) DO NOTHING`);

    return res.status(200).json({ ok: true, already_run: false, steps });

  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: 'Migration aborted — see steps for failure point',
      steps,
      error_detail: err.message,
    });
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────
async function ensureMigrationsTable() {
  await sql`
    CREATE TABLE IF NOT EXISTS _migrations (
      id           TEXT PRIMARY KEY,
      completed_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;
}

async function isAlreadyDone() {
  const rows = await sql`SELECT id FROM _migrations WHERE id = ${MIGRATION_ID} LIMIT 1`;
  return rows.length > 0;
}

async function listPublicTables() {
  const rows = await sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema='public'`;
  return rows.map(r => r.table_name);
}
