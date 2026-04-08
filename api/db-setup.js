/**
 * api/db-setup.js
 * One-time database schema setup endpoint.
 *
 * GET /api/db-setup          → checks table status (safe to call anytime)
 * POST /api/db-setup         → creates / migrates tables
 *
 * USAGE:
 *   After deploying to Vercel, run once from the browser or curl:
 *     curl -X POST https://your-app.vercel.app/api/db-setup
 *
 *   Or open in browser: https://your-app.vercel.app/api/db-setup
 *   Then click "Run Setup" in the response page.
 *
 * Safe to re-run — all statements use IF NOT EXISTS / DO NOTHING.
 * Does NOT drop or alter existing data.
 */

import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.POSTGRES_URL);

const SCHEMA = [
  // ── Pipeline table (existing — created here for completeness) ──────────────
  `CREATE TABLE IF NOT EXISTS pipeline (
    id         TEXT PRIMARY KEY,
    data       JSONB NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT now()
  )`,

  // ── Contacts ───────────────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS contacts (
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
  )`,

  // ── Contact ↔ Pipeline junction ────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS contact_properties (
    contact_id  INTEGER     NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    pipeline_id TEXT        NOT NULL,
    role        TEXT        NOT NULL DEFAULT 'referrer',
    linked_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (contact_id, pipeline_id)
  )`,

  // ── Indexes ────────────────────────────────────────────────────────────────
  `CREATE INDEX IF NOT EXISTS contacts_name_idx
    ON contacts (last_name, first_name)`,

  `CREATE INDEX IF NOT EXISTS contacts_email_idx
    ON contacts (email)`,

  `CREATE INDEX IF NOT EXISTS contacts_company_idx
    ON contacts (company)`,

  `CREATE INDEX IF NOT EXISTS contact_properties_pipeline_idx
    ON contact_properties (pipeline_id)`,
];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  // GET — status check
  if (req.method === 'GET') {
    try {
      const tables = await sql`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
        ORDER BY table_name`;
      const names = tables.map(t => t.table_name);
      return res.status(200).json({
        tables: names,
        contacts_ready:           names.includes('contacts'),
        contact_properties_ready: names.includes('contact_properties'),
        pipeline_ready:           names.includes('pipeline'),
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // POST — run setup
  if (req.method === 'POST') {
    const results = [];
    for (const stmt of SCHEMA) {
      const label = stmt.trim().split('\n')[0].slice(0, 80);
      try {
        await sql.unsafe(stmt);
        results.push({ ok: true, stmt: label });
      } catch (err) {
        results.push({ ok: false, stmt: label, error: err.message });
      }
    }
    const allOk = results.every(r => r.ok);
    return res.status(allOk ? 200 : 207).json({ allOk, results });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
