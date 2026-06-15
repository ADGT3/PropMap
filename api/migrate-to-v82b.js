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

const DISCIPLINE_SEEDS = [
  'Aboriginal Sensitivity','Accessibility','Acoustics','Architecture','Arborist','BCA',
  'Builder (Civil)','Builder (Construction)','Builder (Electrical)','Builder (Landscaping)',
  'Builder (Telco Contractor)','Builder (Water)','Building Maintenance','Civil','Council',
  'Demolition/HazMat','Dilapidation/Assessments','Ecology','Engineering - Civil/SW',
  'Engineering - Electrical','Engineering - Fire','Engineering - Hydraulic',
  'Engineering - Mechanical','Engineering - Structural','Engineering - Traffic',
  'Engineering - Vertical','Fencing','Finance','Fire Consultant','Geotechnical',
  'Hydraulics','Hygienist/Contamination','Interior Design','Labourer',
  'Landscape Architecture','Legal','Marketing','Operations Management (Childcare)',
  'Operations Management (Commercial)','Operations Management (Retail)',
  'Project Management','Property Manager','PCA','Quantity Surveyor (QS)','Sales',
  'Structural','Survey','Technology','Thermal/BASIX/Section J','Tree Clearing',
  'Valuation','Water Services/WSC',
];

async function ensureMigrationsTable() {
  await sql`CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, ran_at TIMESTAMPTZ DEFAULT now())`;
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
    await ensureMigrationsTable();

    if (req.method === 'GET') {
      const already_ran = await hasMigrationRun();
      return res.status(200).json({ migration_id: MIGRATION_ID, already_ran, note: 'POST to execute.' });
    }

    if (req.method === 'POST') {
      if (await hasMigrationRun()) {
        return res.status(200).json({ migration_id: MIGRATION_ID, already_ran: true, message: 'No-op.' });
      }

      const steps = [];

      // contacts columns
      await sql`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS last_contacted_at TIMESTAMPTZ`;
      steps.push('contacts.last_contacted_at added');
      await sql`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS discipline TEXT`;
      steps.push('contacts.discipline added');
      await sql`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS marketing_pref_set_by TEXT`;
      steps.push('contacts.marketing_pref_set_by added');

      // properties columns
      await sql`ALTER TABLE properties ADD COLUMN IF NOT EXISTS core_logic_id TEXT`;
      steps.push('properties.core_logic_id added');
      await sql`ALTER TABLE properties ADD COLUMN IF NOT EXISTS pricefinder_id TEXT`;
      steps.push('properties.pricefinder_id added');
      await sql`ALTER TABLE properties ADD COLUMN IF NOT EXISTS property_metadata JSONB NOT NULL DEFAULT '{}'::jsonb`;
      steps.push('properties.property_metadata added');

      // contact_marketing_categories
      await sql`CREATE TABLE IF NOT EXISTS contact_marketing_categories (contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE, category TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (contact_id, category))`;
      await sql`CREATE INDEX IF NOT EXISTS contact_marketing_categories_category_idx ON contact_marketing_categories (category)`;
      steps.push('contact_marketing_categories table created');

      // contact_buyer_profile
      await sql`CREATE TABLE IF NOT EXISTS contact_buyer_profile (contact_id INTEGER PRIMARY KEY REFERENCES contacts(id) ON DELETE CASCADE, listing_types TEXT[], property_types TEXT[], min_price INTEGER, max_price INTEGER, min_rent INTEGER, max_rent INTEGER, min_bedrooms SMALLINT, max_bedrooms SMALLINT, min_bathrooms SMALLINT, max_bathrooms SMALLINT, min_car_spaces SMALLINT, max_car_spaces SMALLINT, min_land_size_sqm NUMERIC, max_land_size_sqm NUMERIC, postcode_preferences TEXT[], commercial_listing_type TEXT, max_commercial_rent INTEGER, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
      steps.push('contact_buyer_profile table created');

      // contact_marketing_activity
      await sql`CREATE TABLE IF NOT EXISTS contact_marketing_activity (contact_id INTEGER PRIMARY KEY REFERENCES contacts(id) ON DELETE CASCADE, activity_score NUMERIC, email_opens INTEGER NOT NULL DEFAULT 0, email_clicks INTEGER NOT NULL DEFAULT 0, page_views INTEGER NOT NULL DEFAULT 0, last_email_open_at TIMESTAMPTZ, last_click_at TIMESTAMPTZ, last_campaign TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
      steps.push('contact_marketing_activity table created');

      // marketing_category_lookup
      await sql`CREATE TABLE IF NOT EXISTS marketing_category_lookup (category TEXT PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
      await sql`INSERT INTO marketing_category_lookup (category) SELECT DISTINCT category FROM contact_marketing_categories ON CONFLICT (category) DO NOTHING`;
      steps.push('marketing_category_lookup table created');

      // disciplines
      await sql`CREATE TABLE IF NOT EXISTS disciplines (id SERIAL PRIMARY KEY, label TEXT NOT NULL UNIQUE, rate_per_hour NUMERIC(10,2) NOT NULL DEFAULT 150.00, sort_order INTEGER NOT NULL DEFAULT 999, active BOOLEAN NOT NULL DEFAULT true, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
      steps.push('disciplines table created');
      let so = 10;
      for (const label of DISCIPLINE_SEEDS) {
        await sql`INSERT INTO disciplines (label, rate_per_hour, sort_order) VALUES (${label}, 150.00, ${so}) ON CONFLICT (label) DO NOTHING`;
        so += 10;
      }
      steps.push('disciplines seeded (' + DISCIPLINE_SEEDS.length + ' rows at $150/hr)');

      // new roles
      let rolesInserted = 0;
      for (const r of NEW_ROLES) {
        await sql`INSERT INTO roles (id, label, scopes, default_scope, sort_order, active, system) VALUES (${r.id}, ${r.label}, ${r.scopes}, ${r.default_scope}, ${r.sort_order}, true, false) ON CONFLICT (id) DO NOTHING`;
        rolesInserted++;
      }
      steps.push(rolesInserted + ' new roles inserted');

      await sql`INSERT INTO _migrations (id) VALUES (${MIGRATION_ID}) ON CONFLICT DO NOTHING`;

      return res.status(200).json({ migration_id: MIGRATION_ID, success: true, steps });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error('[migrate-v82b] fatal:', err);
    return res.status(500).json({ error: err.message, stack: err.stack });
  }
}
