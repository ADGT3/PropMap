/**
 * api/db-setup.js
 * One-time database schema setup endpoint.
 * Safe to re-run — all statements use IF NOT EXISTS / ADD COLUMN IF NOT EXISTS.
 */

import { neon } from '@neondatabase/serverless';

// V74 hotfix — prefer Neon integration's per-deployment pipeline_* vars first
const sql = neon(
     process.env.pipeline_POSTGRES_URL
  || process.env.pipeline_DATABASE_URL
  || process.env.PIPELINE_POSTGRES_URL
  || process.env.PIPELINE_DATABASE_URL
  || process.env.POSTGRES_URL
  || process.env.DATABASE_URL
);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'GET') {
    try {
      const tables = await sql`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' ORDER BY table_name`;
      const names = tables.map(t => t.table_name);
      // Check whether contacts table has the auth columns
      let authColsReady = false;
      if (names.includes('contacts')) {
        const cols = await sql`
          SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'contacts'`;
        const colSet = new Set(cols.map(c => c.column_name));
        authColsReady = ['can_login', 'is_admin', 'password_hash', 'last_login_at', 'access_modules']
          .every(c => colSet.has(c));
      }
      return res.status(200).json({
        tables: names,
        pipeline_ready:           names.includes('pipeline'),
        organisations_ready:      names.includes('organisations'),
        contacts_ready:           names.includes('contacts'),
        contact_properties_ready: names.includes('contact_properties'),
        contact_notes_ready:      names.includes('contact_notes'),
        contacts_auth_ready:      authColsReady,
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method === 'POST') {
    const results = [];
    const run = async (label, fn) => {
      try { await fn(); results.push({ ok: true, stmt: label }); }
      catch (err) { results.push({ ok: false, stmt: label, error: err.message }); }
    };

    await run('CREATE TABLE pipeline', () => sql`
      CREATE TABLE IF NOT EXISTS pipeline (
        id         TEXT PRIMARY KEY,
        data       JSONB NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT now()
      )`);

    await run('CREATE TABLE organisations', () => sql`
      CREATE TABLE IF NOT EXISTS organisations (
        id         SERIAL PRIMARY KEY,
        name       TEXT NOT NULL,
        phone      TEXT NOT NULL DEFAULT '',
        email      TEXT NOT NULL DEFAULT '',
        website    TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);

    await run('CREATE INDEX organisations_name_idx', () => sql`
      CREATE INDEX IF NOT EXISTS organisations_name_idx ON organisations (name)`);

    await run('CREATE TABLE contacts', () => sql`
      CREATE TABLE IF NOT EXISTS contacts (
        id              SERIAL PRIMARY KEY,
        first_name      TEXT        NOT NULL,
        last_name       TEXT        NOT NULL DEFAULT '',
        mobile          TEXT        NOT NULL DEFAULT '',
        email           TEXT        NOT NULL DEFAULT '',
        organisation_id INTEGER     REFERENCES organisations(id) ON DELETE SET NULL,
        source          TEXT        NOT NULL DEFAULT 'manual',
        domain_id       TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);

    // Add organisation_id to existing contacts table (may predate this column)
    await run('ALTER contacts: add organisation_id', () => sql`
      ALTER TABLE contacts ADD COLUMN IF NOT EXISTS organisation_id INTEGER REFERENCES organisations(id) ON DELETE SET NULL`);

    // Migrate existing company text values to organisations table
    await run('Migrate company → organisation_id', async () => {
      // Ensure company column exists (older schema had it)
      await sql`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS company TEXT`;
      const companies = await sql`
        SELECT DISTINCT company FROM contacts
        WHERE company IS NOT NULL AND company <> '' AND organisation_id IS NULL`;
      for (const row of companies) {
        const orgs = await sql`
          INSERT INTO organisations (name) VALUES (${row.company})
          ON CONFLICT DO NOTHING RETURNING id`;
        const orgId = orgs[0]?.id;
        if (orgId) {
          await sql`
            UPDATE contacts SET organisation_id = ${orgId}
            WHERE company = ${row.company} AND organisation_id IS NULL`;
        }
      }
    });

    await run('CREATE TABLE contact_properties', () => sql`
      CREATE TABLE IF NOT EXISTS contact_properties (
        contact_id  INTEGER     NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        pipeline_id TEXT        NOT NULL,
        role        TEXT        NOT NULL DEFAULT 'vendor',
        linked_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (contact_id, pipeline_id)
      )`);

    await run('CREATE TABLE contact_notes', () => sql`
      CREATE TABLE IF NOT EXISTS contact_notes (
        id          SERIAL PRIMARY KEY,
        contact_id  INTEGER     NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        pipeline_id TEXT,
        note_text   TEXT        NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);

    await run('CREATE INDEX contact_notes_contact_idx', () => sql`
      CREATE INDEX IF NOT EXISTS contact_notes_contact_idx ON contact_notes (contact_id)`);

    await run('CREATE INDEX contact_notes_pipeline_idx', () => sql`
      CREATE INDEX IF NOT EXISTS contact_notes_pipeline_idx ON contact_notes (pipeline_id)`);

    await run('CREATE INDEX contacts_name_idx', () => sql`
      CREATE INDEX IF NOT EXISTS contacts_name_idx ON contacts (last_name, first_name)`);

    await run('CREATE INDEX contacts_email_idx', () => sql`
      CREATE INDEX IF NOT EXISTS contacts_email_idx ON contacts (email)`);

    await run('CREATE INDEX contacts_org_idx', () => sql`
      CREATE INDEX IF NOT EXISTS contacts_org_idx ON contacts (organisation_id)`);

    await run('CREATE INDEX contact_properties_pipeline_idx', () => sql`
      CREATE INDEX IF NOT EXISTS contact_properties_pipeline_idx ON contact_properties (pipeline_id)`);

    // ── Auth columns on contacts (V74 — site access) ─────────────────────────
    await run('ALTER contacts: add can_login', () => sql`
      ALTER TABLE contacts ADD COLUMN IF NOT EXISTS can_login BOOLEAN NOT NULL DEFAULT false`);

    await run('ALTER contacts: add is_admin', () => sql`
      ALTER TABLE contacts ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false`);

    await run('ALTER contacts: add password_hash', () => sql`
      ALTER TABLE contacts ADD COLUMN IF NOT EXISTS password_hash TEXT`);

    await run('ALTER contacts: add last_login_at', () => sql`
      ALTER TABLE contacts ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ`);

    await run('ALTER contacts: add access_modules', () => sql`
      ALTER TABLE contacts ADD COLUMN IF NOT EXISTS access_modules TEXT[] NOT NULL DEFAULT ARRAY['*']`);

    // Index for case-insensitive email lookup during login
    await run('CREATE INDEX contacts_email_lower_idx', () => sql`
      CREATE INDEX IF NOT EXISTS contacts_email_lower_idx ON contacts (LOWER(email))`);

    // ── Source migration (V74.6) ─────────────────────────────────────────────
    // Normalise legacy source values to the new human-readable list.
    // Safe to re-run — only rewrites rows whose source isn't already in the
    // new set.
    await run("Migrate contacts.source legacy values", () => sql`
      UPDATE contacts SET source = 'Domain.com.au'
      WHERE source IN ('domain', 'domain_agent')`);

    await run("Migrate contacts.source → 'Other' for unknowns", () => sql`
      UPDATE contacts SET source = 'Other'
      WHERE source NOT IN (
        'Our Website','Realestate.com.au','Domain.com.au','Instagram',
        'Facebook','Letter Drop','Door Knocking','Walk-In','Signboard',
        'Cold-Calling','Open House','Referral','Other'
      )`);

    const allOk = results.every(r => r.ok);
    return res.status(allOk ? 200 : 207).json({ allOk, results });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
