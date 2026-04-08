/**
 * api/db-setup.js
 * One-time database schema setup endpoint.
 *
 * GET  /api/db-setup  → check table status
 * POST /api/db-setup  → create / migrate tables
 *
 * Safe to re-run — all statements use IF NOT EXISTS.
 */

import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.POSTGRES_URL);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'GET') {
    try {
      const tables = await sql`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' ORDER BY table_name`;
      const names = tables.map(t => t.table_name);
      return res.status(200).json({
        tables: names,
        pipeline_ready:           names.includes('pipeline'),
        contacts_ready:           names.includes('contacts'),
        contact_properties_ready: names.includes('contact_properties'),
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

    await run('CREATE TABLE contacts', () => sql`
      CREATE TABLE IF NOT EXISTS contacts (
        id         SERIAL PRIMARY KEY,
        first_name TEXT        NOT NULL,
        last_name  TEXT        NOT NULL DEFAULT '',
        mobile     TEXT        NOT NULL DEFAULT '',
        email      TEXT        NOT NULL DEFAULT '',
        company    TEXT        NOT NULL DEFAULT '',
        source     TEXT        NOT NULL DEFAULT 'manual',
        domain_id  TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);

    await run('CREATE TABLE contact_properties', () => sql`
      CREATE TABLE IF NOT EXISTS contact_properties (
        contact_id  INTEGER     NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        pipeline_id TEXT        NOT NULL,
        role        TEXT        NOT NULL DEFAULT 'referrer',
        linked_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (contact_id, pipeline_id)
      )`);

    await run('CREATE INDEX contacts_name_idx', () => sql`
      CREATE INDEX IF NOT EXISTS contacts_name_idx ON contacts (last_name, first_name)`);

    await run('Create INDEX contacts_email_idx', () => sql`
      CREATE INDEX IF NOT EXISTS contacts_email_idx ON contacts (email)`);

    await run('CREATE INDEX contacts_company_idx', () => sql`
      CREATE INDEX IF NOT EXISTS contacts_company_idx ON contacts (company)`);

    await run('CREATE INDEX contact_properties_pipeline_idx', () => sql`
      CREATE INDEX IF NOT EXISTS contact_properties_pipeline_idx ON contact_properties (pipeline_id)`);

    const allOk = results.every(r => r.ok);
    return res.status(allOk ? 200 : 207).json({ allOk, results });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
