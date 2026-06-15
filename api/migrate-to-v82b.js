/**
 * api/migrate-to-v82b.js
 * V82.b — CRM migration schema extensions.
 *
 * Adds all schema required to receive the Rex CRM data import:
 *
 *  contacts table — new columns:
 *    last_contacted_at   TIMESTAMPTZ
 *    discipline          TEXT
 *
 *  properties table — new columns:
 *    core_logic_id       TEXT
 *    pricefinder_id      TEXT
 *    property_metadata   JSONB
 *
 *  New tables:
 *    contact_marketing_categories  — campaign/project tag membership per contact
 *    contact_buyer_profile         — buyer search criteria (foundation of future matching)
 *    contact_marketing_activity    — email engagement history (foundation of future marketing module)
 *
 *  New roles (inserted into roles table):
 *    mortgage_broker, investor, developer, accountant, contractor
 *
 * All changes are additive. Idempotent. Safe to re-run.
 *
 * GET  → status / dry-run
 * POST → execute
 */

import { neon } from '@neondatabase/serverless';
import { requireSession, requireAdmin } from '../lib/auth.js';
import { getDatabaseUrl } from '../lib/db.js';
const sql = neon(getDatabaseUrl());

const MIGRATION_ID = 'v82b_crm_schema_extensions';

const NEW_ROLES = [
  { id: 'mortgage_broker', label: 'Mortgage Broker', scopes: ['deal', 'property'], default_scope: 'deal',     sort_order: 82 },
  { id: 'investor',        label: 'Investor',         scopes: ['deal', 'property'], default_scope: 'property', sort_order: 84 },
  { id: 'developer',       label: 'Developer',        scopes: ['deal', 'property'], default_scope: 'property', sort_order: 86 },
  { id: 'accountant',      label: 'Accountant',       scopes: ['deal', 'property'], default_scope: 'deal',     sort_order: 92 },
  { id: 'contractor',      label: 'Contractor',       scopes: ['deal', 'property'], default_scope: 'deal',     sort_order: 94 },
];

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

async function getStatus() {
  // Check which pieces are already in place
  const [cols] = await sql`
    SELECT
      COUNT(*) FILTER (WHERE table_name='contacts'    AND column_name='last_contacted_at') AS contacts_last_contacted,
      COUNT(*) FILTER (WHERE table_name='contacts'    AND column_name='discipline')        AS contacts_discipline,
      COUNT(*) FILTER (WHERE table_name='properties'  AND column_name='core_logic_id')     AS props_core_logic,
      COUNT(*) FILTER (WHERE table_name='properties'  AND column_name='pricefinder_id')    AS props_pricefinder,
      COUNT(*) FILTER (WHERE table_name='properties'  AND column_name='property_metadata') AS props_metadata
    FROM information_schema.columns
    WHERE table_schema = 'public'`;

  const tables = await sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN (
        'contact_marketing_categories',
        'contact_buyer_profile',
        'contact_marketing_activity'
      )`;
  const tableNames = tables.map(t => t.table_name);

  const roles = await sql`
    SELECT id FROM roles
    WHERE id IN ('mortgage_broker','investor','developer','accountant','contractor')`;
  const roleIds = roles.map(r => r.id);

  return { cols, tableNames, roleIds };
}

export default async function handler(req, res) {
  const session = await requireSession(req, res);
  if (!session) return;
  if (!requireAdmin(session, res)) return;

  try {
    await ensureMigrationsTable();

    if (req.method === 'GET') {
      const already_ran = await hasMigrationRun();
      const { cols, tableNames, roleIds } = await getStatus();
      return res.status(200).json({
        migration_id: MIGRATION_ID,
        already_ran,
        status: {
          contacts_columns: {
            last_contacted_at: cols.contacts_last_contacted > 0,
            discipline:        cols.contacts_discipline > 0,
          },
          properties_columns: {
            core_logic_id:     cols.props_core_logic > 0,
            pricefinder_id:    cols.props_pricefinder > 0,
            property_metadata: cols.props_metadata > 0,
          },
          new_tables: {
            contact_marketing_categories: tableNames.includes('contact_marketing_categories'),
            contact_buyer_profile:        tableNames.includes('contact_buyer_profile'),
            contact_marketing_activity:   tableNames.includes('contact_marketing_activity'),
          },
          new_roles: {
            mortgage_broker: roleIds.includes('mortgage_broker'),
            investor:        roleIds.includes('investor'),
            developer:       roleIds.includes('developer'),
            accountant:      roleIds.includes('accountant'),
            contractor:      roleIds.includes('contractor'),
          },
        },
        note: 'POST to execute.',
      });
    }

    if (req.method === 'POST') {
      if (await hasMigrationRun()) {
        return res.status(200).json({ migration_id: MIGRATION_ID, already_ran: true, message: 'No-op.' });
      }

      const steps = [];

      // ── 1. contacts — new columns ────────────────────────────────────────
      await sql`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS last_contacted_at TIMESTAMPTZ`;
      steps.push('contacts.last_contacted_at added');

      await sql`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS discipline TEXT`;
      steps.push('contacts.discipline added');

      await sql`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS marketing_pref_set_by TEXT`;
      steps.push('contacts.marketing_pref_set_by added');

      // ── 2. properties — new columns ──────────────────────────────────────
      await sql`ALTER TABLE properties ADD COLUMN IF NOT EXISTS core_logic_id TEXT`;
      steps.push('properties.core_logic_id added');

      await sql`ALTER TABLE properties ADD COLUMN IF NOT EXISTS pricefinder_id TEXT`;
      steps.push('properties.pricefinder_id added');

      await sql`ALTER TABLE properties ADD COLUMN IF NOT EXISTS property_metadata JSONB NOT NULL DEFAULT '{}'::jsonb`;
      steps.push('properties.property_metadata added');

      // ── 3. contact_marketing_categories ─────────────────────────────────
      await sql`
        CREATE TABLE IF NOT EXISTS contact_marketing_categories (
          contact_id  INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
          category    TEXT    NOT NULL,
          created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (contact_id, category)
        )`;
      await sql`
        CREATE INDEX IF NOT EXISTS contact_marketing_categories_category_idx
        ON contact_marketing_categories (category)`;
      steps.push('contact_marketing_categories table created');

      // ── 4. contact_buyer_profile ─────────────────────────────────────────
      await sql`
        CREATE TABLE IF NOT EXISTS contact_buyer_profile (
          contact_id              INTEGER PRIMARY KEY REFERENCES contacts(id) ON DELETE CASCADE,
          listing_types           TEXT[],
          property_types          TEXT[],
          min_price               INTEGER,
          max_price               INTEGER,
          min_rent                INTEGER,
          max_rent                INTEGER,
          min_bedrooms            SMALLINT,
          max_bedrooms            SMALLINT,
          min_bathrooms           SMALLINT,
          max_bathrooms           SMALLINT,
          min_car_spaces          SMALLINT,
          max_car_spaces          SMALLINT,
          min_land_size_sqm       NUMERIC,
          max_land_size_sqm       NUMERIC,
          postcode_preferences    TEXT[],
          commercial_listing_type TEXT,
          max_commercial_rent     INTEGER,
          updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
        )`;
      steps.push('contact_buyer_profile table created');

      // ── 5. contact_marketing_activity ────────────────────────────────────
      await sql`
        CREATE TABLE IF NOT EXISTS contact_marketing_activity (
          contact_id         INTEGER PRIMARY KEY REFERENCES contacts(id) ON DELETE CASCADE,
          activity_score     NUMERIC,
          email_opens        INTEGER NOT NULL DEFAULT 0,
          email_clicks       INTEGER NOT NULL DEFAULT 0,
          page_views         INTEGER NOT NULL DEFAULT 0,
          last_email_open_at TIMESTAMPTZ,
          last_click_at      TIMESTAMPTZ,
          last_campaign      TEXT,
          updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
        )`;
      steps.push('contact_marketing_activity table created');

      // ── 6. New roles ──────────────────────────────────────────────────────
      let rolesInserted = 0;
      for (const r of NEW_ROLES) {
        const result = await sql`
          INSERT INTO roles (id, label, scopes, default_scope, sort_order, active, system)
          VALUES (${r.id}, ${r.label}, ${r.scopes}, ${r.default_scope}, ${r.sort_order}, true, false)
          ON CONFLICT (id) DO NOTHING`;
        if (result.count > 0) rolesInserted++;
      }
      steps.push(`${rolesInserted} new roles inserted (${NEW_ROLES.map(r => r.id).join(', ')})`);

      await sql`INSERT INTO _migrations (id) VALUES (${MIGRATION_ID}) ON CONFLICT DO NOTHING`;

      return res.status(200).json({
        migration_id: MIGRATION_ID,
        success: true,
        steps,
      });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error('[migrate-v82b] fatal:', err);
    return res.status(500).json({ error: err.message, stack: err.stack });
  }
}
