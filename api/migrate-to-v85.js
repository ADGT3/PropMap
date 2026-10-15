/**
 * api/migrate-to-v85.js
 * V85 — Vendor Terms and Offers as first-class tables.
 *
 * Creates:
 *   vendor_terms  — linked to deal AND property (price history per property)
 *   offers        — linked to deal
 *
 * Migrates any existing terms / terms_history / offers out of deals.data JSONB
 * into the new tables. Idempotent.
 *
 * GET  → status
 * POST → execute
 */

import { neon } from '@neondatabase/serverless';
import { requireSession, requireAdmin } from '../lib/auth.js';
import { getDatabaseUrl } from '../lib/db.js';
const sql = neon(getDatabaseUrl());

const MIGRATION_ID = 'v85_terms_offers_tables';

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
      const termsExists = await sql`
        SELECT 1 FROM information_schema.tables
        WHERE table_schema='public' AND table_name='vendor_terms'`;
      const offersExists = await sql`
        SELECT 1 FROM information_schema.tables
        WHERE table_schema='public' AND table_name='offers'`;
      return res.status(200).json({
        migration_id: MIGRATION_ID,
        already_ran: await hasMigrationRun(),
        vendor_terms_exists: termsExists.length > 0,
        offers_exists: offersExists.length > 0,
        note: 'POST to execute.',
      });
    }

    if (req.method === 'POST') {
      await ensureMigrationsTable();
      if (await hasMigrationRun()) {
        return res.status(200).json({ migration_id: MIGRATION_ID, already_ran: true, message: 'No-op.' });
      }

      // ── vendor_terms ──────────────────────────────────────────────────────
      await sql`
        CREATE TABLE IF NOT EXISTS vendor_terms (
          id            BIGSERIAL PRIMARY KEY,
          deal_id       TEXT NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
          property_id   TEXT REFERENCES properties(id) ON DELETE SET NULL,
          price         NUMERIC,
          settlement    INTEGER,
          deposits      JSONB NOT NULL DEFAULT '[]'::jsonb,
          agent_name    TEXT,
          agent_agency  TEXT,
          captured_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
          captured_by   TEXT,
          created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
        )`;
      await sql`CREATE INDEX IF NOT EXISTS vendor_terms_deal_idx ON vendor_terms (deal_id, captured_at DESC)`;
      await sql`CREATE INDEX IF NOT EXISTS vendor_terms_property_idx ON vendor_terms (property_id, captured_at DESC)`;

      // ── offers ────────────────────────────────────────────────────────────
      await sql`
        CREATE TABLE IF NOT EXISTS offers (
          id            BIGSERIAL PRIMARY KEY,
          deal_id       TEXT NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
          price         TEXT,
          settlement    INTEGER,
          deposits      JSONB NOT NULL DEFAULT '[]'::jsonb,
          status        TEXT NOT NULL DEFAULT 'submitted',
          created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
        )`;
      await sql`CREATE INDEX IF NOT EXISTS offers_deal_idx ON offers (deal_id, created_at DESC)`;

      // ── migrate existing JSONB data ───────────────────────────────────────
      const deals = await sql`
        SELECT id, property_id, data FROM deals
        WHERE data ? 'terms' OR data ? 'terms_history' OR data ? 'offers'`;

      for (const d of deals) {
        const data = d.data || {};
        // Current working terms → one snapshot if present
        if (data.terms && (data.terms.price || data.terms.settlement)) {
          await sql`
            INSERT INTO vendor_terms (deal_id, property_id, price, settlement, deposits, captured_at)
            VALUES (
              ${d.id},
              ${d.property_id},
              ${data.terms.price || null},
              ${data.terms.settlement || null},
              ${JSON.stringify(data.terms.deposits || [])}::jsonb,
              now()
            )`;
        }
        // Historical snapshots
        if (Array.isArray(data.terms_history)) {
          for (const h of data.terms_history) {
            await sql`
              INSERT INTO vendor_terms (deal_id, property_id, price, settlement, deposits, agent_name, agent_agency, captured_at, captured_by)
              VALUES (
                ${d.id},
                ${d.property_id},
                ${h.price || null},
                ${h.settlement || null},
                ${JSON.stringify(h.deposits || [])}::jsonb,
                ${h.agent_name || null},
                ${h.agent_agency || null},
                ${h.captured_at || new Date().toISOString()},
                ${h.captured_by || null}
              )`;
          }
        }
        // Offers
        if (Array.isArray(data.offers)) {
          for (const o of data.offers) {
            await sql`
              INSERT INTO offers (deal_id, price, settlement, deposits, status, created_at)
              VALUES (
                ${d.id},
                ${o.price || null},
                ${o.settlement || null},
                ${JSON.stringify(o.deposits || [])}::jsonb,
                ${o.status || 'submitted'},
                ${o.date || new Date().toISOString()}
              )`;
          }
        }
      }

      await sql`INSERT INTO _migrations (id) VALUES (${MIGRATION_ID}) ON CONFLICT DO NOTHING`;
      return res.status(200).json({ migration_id: MIGRATION_ID, success: true, migrated_deals: deals.length });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[migrate-v85] fatal:', err);
    return res.status(500).json({ error: err.message, stack: err.stack });
  }
}
