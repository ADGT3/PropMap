/**
 * api/migrate-to-v77-1.js
 * V77.1 migration — Sales/Lease pipeline workflow tables + Parameters infrastructure.
 *
 * Phase 2 of the V77 build (V77.0 was boards + roles only). V77.1 introduces the
 * data model that V77.1 agent-side workflow features (deal modal sections,
 * Parameters page, Settings reports) and V77.2 public-form features depend on.
 *
 * What this migration does:
 *
 *   A) NEW WORKFLOW TABLES (6)
 *      - scheduled_inspections
 *      - inspection_attendances (with 3 requested_*_at action-trigger columns)
 *      - applications (Lease Offer record with status lifecycle)
 *      - application_housing_history (with evidence + validated columns)
 *      - application_income_history (with evidence + validated columns)
 *      - agency_agreements
 *
 *   B) NEW LOOKUP TABLES (2)
 *      - contact_sources (slug-style ids, replaces CHECK constraint)
 *      - interaction_types (slug-style ids, with direction field)
 *
 *   C) V77.2 TABLE (created upfront so V77.2 doesn't need a fresh migration)
 *      - applicant_form_tokens (magic-link auth)
 *
 *   D) CONTACTS TABLE EXTENSIONS (9 new columns)
 *      - dob, current_address (+ suburb/state/postcode)
 *      - privacy_consent_at, marketing_email_consent_at,
 *        marketing_sms_consent_at, do_not_contact_at
 *
 *   E) NOTES TABLE EXTENSIONS (2 new columns + backfill)
 *      - interaction_type (FK to interaction_types, NOT NULL DEFAULT 'file_note')
 *      - source (FK to contact_sources, nullable)
 *      - Backfill: UPDATE notes SET interaction_type = 'file_note' for existing rows
 *
 *   F) SOURCE FK REWORK on contacts
 *      - Drop existing CHECK constraint on contacts.source
 *      - Map existing string values to slug ids (handles 'Open House' → 'inspection' rename)
 *      - Add FK to contact_sources(id) ON DELETE SET NULL
 *
 *   G) ENTITY_CONTACTS.ROLE_ID FK BEHAVIOUR CHANGE
 *      - Currently RESTRICT, change to SET NULL (supports delete-with-references pattern)
 *
 *   H) NEW ROLE ROWS (3)
 *      - listing_agent (sort_order 41)
 *      - leasing_agent (sort_order 42)
 *      - conjunctional_agent (sort_order 43)
 *
 *   I) EMPTY BILLING BOARD
 *      - sys_billing system board (sort_order 5, no columns seeded)
 *
 * Idempotency: each sub-step tracked individually so partial re-runs are safe.
 * Whole migration tracked via _migrations table.
 *
 * GET  → dry-run / status (admin-only)
 * POST → execute (admin-only)
 *
 * Schema docs and rationale: see V77 BUILD PLAN v0.17 §7.
 */

import { neon } from '@neondatabase/serverless';
import { requireSession, requireAdmin } from '../lib/auth.js';
import { getDatabaseUrl } from '../lib/db.js';
const sql = neon(getDatabaseUrl());

const MIGRATION_ID = 'v77_1_workflow_tables';

// ── Seed data ───────────────────────────────────────────────────────────────

// New role rows (3) — agent role types managed via Parameters
const NEW_ROLES = [
  { id: 'listing_agent',      label: 'Listing Agent',       scopes: ['property','deal'], default_scope: 'deal', sort_order: 41 },
  { id: 'leasing_agent',      label: 'Leasing Agent',       scopes: ['property','deal'], default_scope: 'deal', sort_order: 42 },
  { id: 'conjunctional_agent', label: 'Conjunctional Agent', scopes: ['property','deal'], default_scope: 'deal', sort_order: 43 },
];

// Canonical contact sources (slug-style ids replace CHECK constraint values)
// Ordering matches what users currently see in dropdowns; sort_order in steps of 10
// to allow inserting custom values between system ones via Parameters page.
const CONTACT_SOURCES = [
  { id: 'our_website',        label: 'Our Website',        sort_order: 10 },
  { id: 'realestate_com_au',  label: 'Realestate.com.au',  sort_order: 20 },
  { id: 'domain_com_au',      label: 'Domain.com.au',      sort_order: 30 },
  { id: 'instagram',          label: 'Instagram',          sort_order: 40 },
  { id: 'facebook',           label: 'Facebook',           sort_order: 50 },
  { id: 'letter_drop',        label: 'Letter Drop',        sort_order: 60 },
  { id: 'door_knocking',      label: 'Door Knocking',      sort_order: 70 },
  { id: 'inspection',         label: 'Inspection',         sort_order: 80 },  // renamed from open_house
  { id: 'walk_in',            label: 'Walk-In',            sort_order: 90 },
  { id: 'signboard',          label: 'Signboard',          sort_order: 100 },
  { id: 'cold_calling',       label: 'Cold-Calling',       sort_order: 110 },
  { id: 'referral',           label: 'Referral',           sort_order: 120 },
  { id: 'other',              label: 'Other',              sort_order: 130 },
];

// Mapping table: how to convert existing contacts.source string values to new slug ids.
// Keys are case-insensitive and match the labels users have been seeing.
// 'Open House' is the V76-and-earlier label for what we now call 'Inspection'.
const SOURCE_VALUE_MAP = {
  'our website':         'our_website',
  'realestate.com.au':   'realestate_com_au',
  'domain.com.au':       'domain_com_au',
  'instagram':           'instagram',
  'facebook':            'facebook',
  'letter drop':         'letter_drop',
  'door knocking':       'door_knocking',
  'open house':          'inspection',       // RENAME
  'inspection':          'inspection',
  'walk-in':             'walk_in',
  'walk in':             'walk_in',
  'signboard':           'signboard',
  'cold-calling':        'cold_calling',
  'cold calling':        'cold_calling',
  'referral':            'referral',
  'other':               'other',
  'manual':              'other',             // legacy default
  '':                    null,                // empty → NULL
};

// Interaction types (10 system seeds, with direction driving Note form behaviour)
const INTERACTION_TYPES = [
  { id: 'file_note',           label: 'File Note',            direction: 'internal', sort_order: 10  },
  { id: 'phone_in',            label: 'Phone In',             direction: 'inbound',  sort_order: 20  },
  { id: 'phone_out',           label: 'Phone Out',            direction: 'outbound', sort_order: 30  },
  { id: 'email_in',            label: 'Email In',             direction: 'inbound',  sort_order: 40  },
  { id: 'email_out',           label: 'Email Out',            direction: 'outbound', sort_order: 50  },
  { id: 'sms_in',              label: 'SMS In',               direction: 'inbound',  sort_order: 60  },
  { id: 'sms_out',             label: 'SMS Out',              direction: 'outbound', sort_order: 70  },
  { id: 'web_form',            label: 'Web Form',             direction: 'inbound',  sort_order: 80  },
  { id: 'meta_form',           label: 'Meta Form',            direction: 'inbound',  sort_order: 90  },
  { id: 'attended_inspection', label: 'Attended Inspection',  direction: 'inbound',  sort_order: 100 },
];

// Empty Billing board
const BILLING_BOARD = {
  id:         'sys_billing',
  name:       'Billing',
  sort_order: 5,
};

// ── Handler ─────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  const session = await requireSession(req, res);
  if (!session) return;
  if (!requireAdmin(session, res)) return;

  try {
    if (req.method === 'GET')  return await dryRun(req, res);
    if (req.method === 'POST') return await execute(req, res);
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[migrate-v77-1] fatal:', err);
    return res.status(500).json({ error: err.message, stack: err.stack });
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function tableExists(name) {
  const r = await sql`
    SELECT 1 FROM information_schema.tables
    WHERE table_schema='public' AND table_name=${name}`;
  return r.length > 0;
}

async function columnExists(table, column) {
  const r = await sql`
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name=${table} AND column_name=${column}`;
  return r.length > 0;
}

async function constraintExists(table, constraint) {
  const r = await sql`
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema='public' AND table_name=${table} AND constraint_name=${constraint}`;
  return r.length > 0;
}

async function ensureMigrationsTable() {
  await sql`
    CREATE TABLE IF NOT EXISTS _migrations (
      id     TEXT PRIMARY KEY,
      ran_at TIMESTAMPTZ DEFAULT now()
    )`;
}

async function hasMigrationRun() {
  if (!(await tableExists('_migrations'))) return false;
  const m = await sql`SELECT 1 FROM _migrations WHERE id = ${MIGRATION_ID}`;
  return m.length > 0;
}

async function recordRanStep(steps, name, fn) {
  // Run a step, capture result, and record any error without aborting subsequent steps.
  // Each step in V77.1 is independently idempotent (CREATE IF NOT EXISTS, ADD COLUMN
  // IF NOT EXISTS, INSERT ... ON CONFLICT DO NOTHING, etc.) so re-runs after a partial
  // failure are safe.
  try {
    const result = await fn();
    steps.push({ step: name, status: 'ok', result });
  } catch (err) {
    steps.push({ step: name, status: 'error', error: err.message });
    throw err;
  }
}

// ── Dry-run / status ────────────────────────────────────────────────────────

async function dryRun(req, res) {
  await ensureMigrationsTable();
  const alreadyRan = await hasMigrationRun();

  // Check current state of each thing the migration will touch
  const state = {};

  // Tables
  const tablesToCreate = [
    'scheduled_inspections',
    'inspection_attendances',
    'applications',
    'application_housing_history',
    'application_income_history',
    'agency_agreements',
    'contact_sources',
    'interaction_types',
    'applicant_form_tokens',
  ];
  state.tables = {};
  for (const t of tablesToCreate) {
    state.tables[t] = (await tableExists(t)) ? 'exists' : 'missing';
  }

  // Contacts columns
  const contactColumns = [
    'dob',
    'current_address',
    'current_address_suburb',
    'current_address_state',
    'current_address_postcode',
    'privacy_consent_at',
    'marketing_email_consent_at',
    'marketing_sms_consent_at',
    'do_not_contact_at',
  ];
  state.contact_columns = {};
  for (const c of contactColumns) {
    state.contact_columns[c] = (await columnExists('contacts', c)) ? 'exists' : 'missing';
  }

  // Notes columns
  state.notes_columns = {};
  for (const c of ['interaction_type', 'source']) {
    state.notes_columns[c] = (await columnExists('notes', c)) ? 'exists' : 'missing';
  }

  // Backfill check
  if (await columnExists('notes', 'interaction_type')) {
    const r = await sql`SELECT COUNT(*)::int AS n FROM notes WHERE interaction_type IS NULL`;
    state.notes_backfill_pending = r[0]?.n ?? 0;
  }

  // Roles
  let existingRoleIds = [];
  if (await tableExists('roles')) {
    const r = await sql`SELECT id FROM roles WHERE id = ANY(${NEW_ROLES.map(x => x.id)})`;
    existingRoleIds = r.map(x => x.id);
  }
  state.roles = NEW_ROLES.map(r => ({
    id: r.id,
    label: r.label,
    action: existingRoleIds.includes(r.id) ? 'skip (exists)' : 'insert',
  }));

  // Source FK rework — check current state of contacts.source
  state.source_fk = {
    contact_sources_table: (await tableExists('contact_sources')) ? 'exists' : 'missing',
    contacts_source_fk:    (await constraintExists('contacts', 'contacts_source_fk')) ? 'exists' : 'missing',
  };
  if (await tableExists('contacts')) {
    const distinctSources = await sql`
      SELECT DISTINCT source FROM contacts WHERE source IS NOT NULL ORDER BY source`;
    state.source_fk.distinct_existing_values = distinctSources.map(r => r.source);
  }

  // entity_contacts.role_id FK
  if (await tableExists('entity_contacts')) {
    const fkInfo = await sql`
      SELECT confdeltype FROM pg_constraint
      WHERE conrelid = 'entity_contacts'::regclass
        AND contype = 'f'
        AND conname LIKE '%role_id%'`;
    // confdeltype: 'a' = no action, 'r' = restrict, 'c' = cascade, 'n' = set null, 'd' = set default
    state.entity_contacts_role_fk = fkInfo.length
      ? { current_action: fkInfo[0].confdeltype, target: 'n (set null)' }
      : { current_action: null, note: 'no FK found' };
  }

  // Billing board
  if (await tableExists('boards')) {
    const b = await sql`SELECT id, name FROM boards WHERE id = ${BILLING_BOARD.id}`;
    state.billing_board = b.length ? 'exists' : 'missing';
  }

  return res.status(200).json({
    migration_id:  MIGRATION_ID,
    already_run:   alreadyRan,
    description:   'V77.1 — Sales/Lease pipeline workflow tables + Parameters infrastructure',
    state,
    summary: {
      tables_to_create:        tablesToCreate.filter(t => state.tables[t] === 'missing').length,
      contact_columns_to_add:  contactColumns.filter(c => state.contact_columns[c] === 'missing').length,
      notes_columns_to_add:    Object.values(state.notes_columns).filter(s => s === 'missing').length,
      roles_to_insert:         state.roles.filter(r => r.action === 'insert').length,
    },
  });
}

// ── Execute ─────────────────────────────────────────────────────────────────

async function execute(req, res) {
  await ensureMigrationsTable();

  if (await hasMigrationRun()) {
    return res.status(200).json({
      ok: true,
      already_run: true,
      message: 'Migration already executed. Individual steps are idempotent — to re-run a specific step, manually DELETE FROM _migrations WHERE id = ' + MIGRATION_ID + ' and re-POST.',
    });
  }

  const steps = [];

  // ── A) NEW WORKFLOW TABLES ────────────────────────────────────────────────

  await recordRanStep(steps, 'CREATE TABLE scheduled_inspections', async () => {
    await sql`
      CREATE TABLE IF NOT EXISTS scheduled_inspections (
        id              BIGSERIAL PRIMARY KEY,
        listing_deal_id TEXT        NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
        scheduled_date  DATE        NOT NULL,
        start_time      TIME        NOT NULL,
        end_time        TIME        NOT NULL,
        inspection_type TEXT        NOT NULL,
        status          TEXT        NOT NULL DEFAULT 'planned',
        created_by      INTEGER     REFERENCES contacts(id) ON DELETE SET NULL,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
      )`;
    await sql`CREATE INDEX IF NOT EXISTS scheduled_inspections_deal_idx ON scheduled_inspections (listing_deal_id, scheduled_date DESC)`;
    return { done: true };
  });

  await recordRanStep(steps, 'CREATE TABLE inspection_attendances', async () => {
    await sql`
      CREATE TABLE IF NOT EXISTS inspection_attendances (
        id                       BIGSERIAL PRIMARY KEY,
        scheduled_inspection_id  BIGINT      NOT NULL REFERENCES scheduled_inspections(id) ON DELETE CASCADE,
        contact_id               INTEGER     NOT NULL REFERENCES contacts(id) ON DELETE RESTRICT,
        enquiry_deal_id          TEXT        NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
        attended_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
        notes                    TEXT,
        requested_followup_at    TIMESTAMPTZ,
        requested_offer_form_at  TIMESTAMPTZ,
        requested_contract_at    TIMESTAMPTZ,
        created_by               INTEGER     REFERENCES contacts(id) ON DELETE SET NULL,
        created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (scheduled_inspection_id, contact_id)
      )`;
    await sql`CREATE INDEX IF NOT EXISTS inspection_attendances_inspection_idx ON inspection_attendances (scheduled_inspection_id)`;
    await sql`CREATE INDEX IF NOT EXISTS inspection_attendances_contact_idx ON inspection_attendances (contact_id)`;
    await sql`CREATE INDEX IF NOT EXISTS inspection_attendances_enquiry_deal_idx ON inspection_attendances (enquiry_deal_id)`;
    return { done: true };
  });

  await recordRanStep(steps, 'CREATE TABLE applications', async () => {
    await sql`
      CREATE TABLE IF NOT EXISTS applications (
        id                          BIGSERIAL PRIMARY KEY,
        deal_id                     TEXT        NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
        status                      TEXT        NOT NULL DEFAULT 'draft',
        submitted_at                TIMESTAMPTZ,
        accepted_at                 TIMESTAMPTZ,
        evidence_submitted_at       TIMESTAMPTZ,
        validated_at                TIMESTAMPTZ,
        requested_rent              NUMERIC,
        bond_weeks                  INTEGER     DEFAULT 4,
        lease_term_months           INTEGER,
        preferred_start_date        DATE,
        terms                       TEXT,
        annual_income_claimed       NUMERIC,
        credit_check_consent_at     TIMESTAMPTZ,
        tenancy_database_consent_at TIMESTAMPTZ,
        occupants                   JSONB,
        pets                        JSONB,
        applicants_jsonb            JSONB,
        notes                       TEXT,
        created_by                  INTEGER     REFERENCES contacts(id) ON DELETE SET NULL,
        created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
      )`;
    await sql`CREATE INDEX IF NOT EXISTS applications_deal_idx ON applications (deal_id, created_at DESC)`;
    await sql`CREATE INDEX IF NOT EXISTS applications_status_idx ON applications (status)`;
    return { done: true };
  });

  await recordRanStep(steps, 'CREATE TABLE application_housing_history', async () => {
    await sql`
      CREATE TABLE IF NOT EXISTS application_housing_history (
        id                       BIGSERIAL PRIMARY KEY,
        application_id           BIGINT      NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
        applicant_contact_id     INTEGER     REFERENCES contacts(id) ON DELETE CASCADE,
        housing_type             TEXT        NOT NULL,
        address                  TEXT        NOT NULL,
        monthly_amount           NUMERIC,
        term_value               INTEGER,
        term_unit                TEXT,
        term_start_date          DATE,
        term_end_date            DATE,
        landlord_lender_name     TEXT,
        landlord_lender_contact  TEXT,
        evidence_url             TEXT,
        evidence_label           TEXT,
        notes                    TEXT,
        sort_order               INTEGER     NOT NULL DEFAULT 0,
        validated                BOOLEAN     NOT NULL DEFAULT false,
        validated_at             TIMESTAMPTZ,
        validated_by             INTEGER     REFERENCES contacts(id) ON DELETE SET NULL,
        created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
      )`;
    await sql`CREATE INDEX IF NOT EXISTS app_housing_history_app_idx ON application_housing_history (application_id, sort_order)`;
    await sql`CREATE INDEX IF NOT EXISTS app_housing_history_applicant_idx ON application_housing_history (applicant_contact_id)`;
    return { done: true };
  });

  await recordRanStep(steps, 'CREATE TABLE application_income_history', async () => {
    await sql`
      CREATE TABLE IF NOT EXISTS application_income_history (
        id                       BIGSERIAL PRIMARY KEY,
        application_id           BIGINT      NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
        applicant_contact_id     INTEGER     REFERENCES contacts(id) ON DELETE CASCADE,
        income_type              TEXT        NOT NULL,
        income_source_name       TEXT        NOT NULL,
        role                     TEXT,
        annual_income            NUMERIC,
        term_value               INTEGER,
        term_unit                TEXT,
        term_start_date          DATE,
        term_end_date            DATE,
        employer_contact_name    TEXT,
        employer_contact_email   TEXT,
        employer_contact_mobile  TEXT,
        evidence_url             TEXT,
        evidence_label           TEXT,
        notes                    TEXT,
        sort_order               INTEGER     NOT NULL DEFAULT 0,
        validated                BOOLEAN     NOT NULL DEFAULT false,
        validated_at             TIMESTAMPTZ,
        validated_by             INTEGER     REFERENCES contacts(id) ON DELETE SET NULL,
        created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
      )`;
    await sql`CREATE INDEX IF NOT EXISTS app_income_history_app_idx ON application_income_history (application_id, sort_order)`;
    await sql`CREATE INDEX IF NOT EXISTS app_income_history_applicant_idx ON application_income_history (applicant_contact_id)`;
    return { done: true };
  });

  await recordRanStep(steps, 'CREATE TABLE agency_agreements', async () => {
    await sql`
      CREATE TABLE IF NOT EXISTS agency_agreements (
        id                    BIGSERIAL PRIMARY KEY,
        deal_id               TEXT        NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
        appointed_company_id  INTEGER     NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
        agreement_type        TEXT        NOT NULL,
        start_date            DATE        NOT NULL,
        end_date              DATE        NOT NULL,
        commission_category   TEXT,
        rate_type             TEXT        NOT NULL,
        rate_value            NUMERIC     NOT NULL,
        payout_trigger        TEXT        NOT NULL,
        contract_url          TEXT,
        status_override       TEXT,
        notes                 TEXT,
        created_by            INTEGER     REFERENCES contacts(id) ON DELETE SET NULL,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
      )`;
    await sql`CREATE INDEX IF NOT EXISTS agency_agreements_deal_idx ON agency_agreements (deal_id, start_date DESC)`;
    await sql`CREATE INDEX IF NOT EXISTS agency_agreements_company_idx ON agency_agreements (appointed_company_id)`;
    return { done: true };
  });

  // ── B) NEW LOOKUP TABLES ─────────────────────────────────────────────────

  await recordRanStep(steps, 'CREATE TABLE contact_sources', async () => {
    await sql`
      CREATE TABLE IF NOT EXISTS contact_sources (
        id          TEXT        PRIMARY KEY,
        label       TEXT        NOT NULL,
        sort_order  INTEGER     NOT NULL DEFAULT 0,
        active      BOOLEAN     NOT NULL DEFAULT true,
        system      BOOLEAN     NOT NULL DEFAULT false,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )`;
    return { done: true };
  });

  await recordRanStep(steps, 'SEED contact_sources', async () => {
    let inserted = 0;
    for (const s of CONTACT_SOURCES) {
      const r = await sql`
        INSERT INTO contact_sources (id, label, sort_order, active, system)
        VALUES (${s.id}, ${s.label}, ${s.sort_order}, true, true)
        ON CONFLICT (id) DO NOTHING
        RETURNING id`;
      inserted += r.length;
    }
    return { inserted, total: CONTACT_SOURCES.length };
  });

  await recordRanStep(steps, 'CREATE TABLE interaction_types', async () => {
    await sql`
      CREATE TABLE IF NOT EXISTS interaction_types (
        id          TEXT        PRIMARY KEY,
        label       TEXT        NOT NULL,
        direction   TEXT        NOT NULL,
        sort_order  INTEGER     NOT NULL DEFAULT 0,
        active      BOOLEAN     NOT NULL DEFAULT true,
        system      BOOLEAN     NOT NULL DEFAULT false,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT interaction_types_direction_check
          CHECK (direction IN ('inbound','outbound','internal'))
      )`;
    return { done: true };
  });

  await recordRanStep(steps, 'SEED interaction_types', async () => {
    let inserted = 0;
    for (const t of INTERACTION_TYPES) {
      const r = await sql`
        INSERT INTO interaction_types (id, label, direction, sort_order, active, system)
        VALUES (${t.id}, ${t.label}, ${t.direction}, ${t.sort_order}, true, true)
        ON CONFLICT (id) DO NOTHING
        RETURNING id`;
      inserted += r.length;
    }
    return { inserted, total: INTERACTION_TYPES.length };
  });

  // ── C) V77.2 TABLE (created upfront) ─────────────────────────────────────

  await recordRanStep(steps, 'CREATE TABLE applicant_form_tokens', async () => {
    await sql`
      CREATE TABLE IF NOT EXISTS applicant_form_tokens (
        id               BIGSERIAL PRIMARY KEY,
        application_id   BIGINT      NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
        step             INTEGER     NOT NULL,
        token            TEXT        NOT NULL UNIQUE,
        applicant_email  TEXT        NOT NULL,
        email_verified   BOOLEAN     NOT NULL DEFAULT false,
        verified_at      TIMESTAMPTZ,
        expires_at       TIMESTAMPTZ NOT NULL,
        last_accessed_at TIMESTAMPTZ,
        created_by       INTEGER     REFERENCES contacts(id) ON DELETE SET NULL,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (application_id, step),
        CONSTRAINT applicant_form_tokens_step_check CHECK (step IN (1,2))
      )`;
    await sql`CREATE INDEX IF NOT EXISTS applicant_form_tokens_token_idx ON applicant_form_tokens (token)`;
    await sql`CREATE INDEX IF NOT EXISTS applicant_form_tokens_app_idx ON applicant_form_tokens (application_id)`;
    return { done: true };
  });

  // ── D) CONTACTS TABLE EXTENSIONS ──────────────────────────────────────────

  await recordRanStep(steps, 'ALTER contacts: add new columns', async () => {
    await sql`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS dob DATE`;
    await sql`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS current_address TEXT`;
    await sql`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS current_address_suburb TEXT`;
    await sql`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS current_address_state TEXT`;
    await sql`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS current_address_postcode TEXT`;
    await sql`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS privacy_consent_at TIMESTAMPTZ`;
    await sql`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS marketing_email_consent_at TIMESTAMPTZ`;
    await sql`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS marketing_sms_consent_at TIMESTAMPTZ`;
    await sql`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS do_not_contact_at TIMESTAMPTZ`;
    return { done: true };
  });

  // ── E) NOTES TABLE EXTENSIONS + BACKFILL ─────────────────────────────────

  await recordRanStep(steps, 'ALTER notes: add interaction_type + source (nullable for now)', async () => {
    // Add nullable first; backfill existing rows; then enforce NOT NULL
    await sql`ALTER TABLE notes ADD COLUMN IF NOT EXISTS interaction_type TEXT`;
    await sql`ALTER TABLE notes ADD COLUMN IF NOT EXISTS source TEXT`;
    return { done: true };
  });

  await recordRanStep(steps, 'BACKFILL notes.interaction_type to file_note', async () => {
    const r = await sql`UPDATE notes SET interaction_type = 'file_note' WHERE interaction_type IS NULL`;
    return { rows_updated: r.count ?? 'unknown' };
  });

  await recordRanStep(steps, 'ALTER notes.interaction_type: NOT NULL DEFAULT file_note', async () => {
    // Verify backfill complete first (defensive)
    const r = await sql`SELECT COUNT(*)::int AS n FROM notes WHERE interaction_type IS NULL`;
    if ((r[0]?.n ?? 0) > 0) {
      throw new Error(`Cannot set NOT NULL: ${r[0].n} rows still have NULL interaction_type`);
    }
    await sql`ALTER TABLE notes ALTER COLUMN interaction_type SET DEFAULT 'file_note'`;
    await sql`ALTER TABLE notes ALTER COLUMN interaction_type SET NOT NULL`;
    return { done: true };
  });

  await recordRanStep(steps, 'ADD FK notes.interaction_type → interaction_types(id)', async () => {
    if (await constraintExists('notes', 'notes_interaction_type_fk')) {
      return { skipped: 'FK already exists' };
    }
    await sql`
      ALTER TABLE notes
      ADD CONSTRAINT notes_interaction_type_fk
      FOREIGN KEY (interaction_type)
      REFERENCES interaction_types(id) ON DELETE SET NULL`;
    return { done: true };
  });

  await recordRanStep(steps, 'ADD FK notes.source → contact_sources(id)', async () => {
    if (await constraintExists('notes', 'notes_source_fk')) {
      return { skipped: 'FK already exists' };
    }
    await sql`
      ALTER TABLE notes
      ADD CONSTRAINT notes_source_fk
      FOREIGN KEY (source)
      REFERENCES contact_sources(id) ON DELETE SET NULL`;
    return { done: true };
  });

  await recordRanStep(steps, 'CREATE INDEX notes_interaction_type_idx', async () => {
    await sql`CREATE INDEX IF NOT EXISTS notes_interaction_type_idx ON notes (interaction_type)`;
    return { done: true };
  });

  // ── F) SOURCE FK REWORK on contacts ──────────────────────────────────────

  await recordRanStep(steps, 'DROP existing CHECK constraint on contacts.source', async () => {
    // Previous CHECK constraint listed canonical sources. Find by name pattern.
    const checks = await sql`
      SELECT con.conname
      FROM pg_constraint con
      JOIN pg_class cls ON cls.oid = con.conrelid
      WHERE cls.relname = 'contacts'
        AND con.contype = 'c'
        AND pg_get_constraintdef(con.oid) ILIKE '%source%'`;
    const dropped = [];
    for (const c of checks) {
      // Direct DROP by exact name
      try {
        await sql.query(`ALTER TABLE contacts DROP CONSTRAINT IF EXISTS "${c.conname}"`);
        dropped.push(c.conname);
      } catch (err) {
        // continue — non-fatal
      }
    }
    return { dropped };
  });

  await recordRanStep(steps, 'MAP existing contacts.source values to slug ids', async () => {
    // Get distinct existing values
    const distinct = await sql`SELECT DISTINCT source FROM contacts WHERE source IS NOT NULL`;
    const updates = [];
    for (const row of distinct) {
      const oldVal = row.source;
      const key = String(oldVal).trim().toLowerCase();
      const newId = SOURCE_VALUE_MAP[key];
      if (newId === undefined) {
        // Unknown value — leave alone for now, but flag it
        updates.push({ old: oldVal, new: '(unmapped, left as-is)', count: 'unknown' });
        continue;
      }
      if (newId === oldVal) {
        // Already in slug form
        continue;
      }
      if (newId === null) {
        const r = await sql`UPDATE contacts SET source = NULL WHERE source = ${oldVal}`;
        updates.push({ old: oldVal, new: null, count: r.count ?? 'unknown' });
      } else {
        const r = await sql`UPDATE contacts SET source = ${newId} WHERE source = ${oldVal}`;
        updates.push({ old: oldVal, new: newId, count: r.count ?? 'unknown' });
      }
    }
    return { updates };
  });

  await recordRanStep(steps, 'ADD FK contacts.source → contact_sources(id)', async () => {
    if (await constraintExists('contacts', 'contacts_source_fk')) {
      return { skipped: 'FK already exists' };
    }
    // Verify all current values exist in contact_sources before adding FK
    const orphans = await sql`
      SELECT DISTINCT c.source FROM contacts c
      LEFT JOIN contact_sources cs ON cs.id = c.source
      WHERE c.source IS NOT NULL AND cs.id IS NULL`;
    if (orphans.length > 0) {
      const list = orphans.map(o => o.source).join(', ');
      throw new Error(`Cannot add FK: contacts.source has unmapped values: ${list}. Add these to contact_sources or update the SOURCE_VALUE_MAP.`);
    }
    await sql`
      ALTER TABLE contacts
      ADD CONSTRAINT contacts_source_fk
      FOREIGN KEY (source)
      REFERENCES contact_sources(id) ON DELETE SET NULL`;
    return { done: true };
  });

  // ── G) ENTITY_CONTACTS.ROLE_ID FK BEHAVIOUR CHANGE ───────────────────────

  await recordRanStep(steps, 'ALTER entity_contacts.role_id FK to ON DELETE SET NULL', async () => {
    // Find existing FK on entity_contacts.role_id
    const fks = await sql`
      SELECT con.conname, con.confdeltype
      FROM pg_constraint con
      JOIN pg_class cls ON cls.oid = con.conrelid
      JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = ANY(con.conkey)
      WHERE cls.relname = 'entity_contacts'
        AND con.contype = 'f'
        AND att.attname = 'role_id'`;
    if (fks.length === 0) {
      return { skipped: 'no role_id FK found on entity_contacts' };
    }
    if (fks[0].confdeltype === 'n') {
      return { skipped: 'FK already ON DELETE SET NULL' };
    }
    // Drop old FK
    const oldName = fks[0].conname;
    await sql.query(`ALTER TABLE entity_contacts DROP CONSTRAINT IF EXISTS "${oldName}"`);
    // Re-add with SET NULL
    // entity_contacts.role_id is currently NOT NULL — we need to allow NULL for SET NULL to work
    await sql`ALTER TABLE entity_contacts ALTER COLUMN role_id DROP NOT NULL`;
    await sql`
      ALTER TABLE entity_contacts
      ADD CONSTRAINT entity_contacts_role_id_fkey
      FOREIGN KEY (role_id)
      REFERENCES roles(id) ON DELETE SET NULL`;
    return { dropped: oldName, recreated: 'entity_contacts_role_id_fkey ON DELETE SET NULL' };
  });

  // ── H) NEW ROLE ROWS ──────────────────────────────────────────────────────

  await recordRanStep(steps, 'INSERT new roles (listing/leasing/conjunctional agent)', async () => {
    let inserted = 0;
    for (const r of NEW_ROLES) {
      const result = await sql`
        INSERT INTO roles (id, label, scopes, default_scope, sort_order, active, system)
        VALUES (${r.id}, ${r.label}, ${r.scopes}, ${r.default_scope}, ${r.sort_order}, true, true)
        ON CONFLICT (id) DO NOTHING
        RETURNING id`;
      inserted += result.length;
    }
    return { inserted, total: NEW_ROLES.length };
  });

  // ── I) EMPTY BILLING BOARD ────────────────────────────────────────────────

  await recordRanStep(steps, 'INSERT empty Billing board', async () => {
    const result = await sql`
      INSERT INTO boards (id, name, sort_order, is_system)
      VALUES (${BILLING_BOARD.id}, ${BILLING_BOARD.name}, ${BILLING_BOARD.sort_order}, true)
      ON CONFLICT (id) DO NOTHING
      RETURNING id`;
    return { inserted: result.length };
  });

  // ── Mark complete ────────────────────────────────────────────────────────

  await sql`INSERT INTO _migrations (id) VALUES (${MIGRATION_ID}) ON CONFLICT (id) DO NOTHING`;

  return res.status(200).json({
    ok: true,
    migration_id: MIGRATION_ID,
    steps_run: steps.length,
    steps,
  });
}
