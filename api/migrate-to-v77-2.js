/**
 * api/migrate-to-v77-2.js
 * V77.2 — Public-form layer infrastructure.
 *
 * Creates 3 new tables:
 *   1. applicant_form_tokens — magic-link auth for public lease offer form
 *   2. email_log              — record of all emails the system has dispatched
 *                                (V77.2 stub mode: writes only here; V77.3
 *                                 swaps to also call Resend)
 *   3. system_settings        — admin-editable config (email config, public URL)
 *
 * Seeds system_settings with V77.1 lib/email-config.js values as initial defaults.
 *
 * Idempotent: tracked in _migrations table.
 *
 * GET  → dry-run / status
 * POST → execute (admin-only)
 */

import { neon } from '@neondatabase/serverless';
import { requireSession, requireAdmin } from '../lib/auth.js';
import { getDatabaseUrl } from '../lib/db.js';
const sql = neon(getDatabaseUrl());

const MIGRATION_ID = 'v77_2_public_form_infrastructure';

// V77.2 system_settings seed values — match lib/email-config.js
const SETTINGS_SEED = [
  { key: 'app_public_url',         value: 'https://propmap.edanproperty.com.au', category: 'email', label: 'App public URL',        description: 'Base URL used in public-form magic links. Must be HTTPS in production.' },
  { key: 'email_sending_domain',   value: 'edanproperty.com.au',                 category: 'email', label: 'Email sending domain',  description: 'Domain configured at email provider (Resend) with verified DNS records.' },
  { key: 'email_leasing_from',     value: 'leasing@edanproperty.com.au',         category: 'email', label: 'Leasing from-address',  description: 'From-address for leasing emails (Step 1, Step 2, agent notifications). Must use sending domain.' },
  { key: 'email_sales_from',       value: 'sales@edanproperty.com.au',           category: 'email', label: 'Sales from-address',    description: 'From-address for sales emails (reserved for future Sales Offer flow). Must use sending domain.' },
  { key: 'email_reply_to_handling',value: 'route_to_from',                       category: 'email', label: 'Reply-to handling',     description: 'How replies are routed: "route_to_from" (replies go to from-address inbox) or "no_reply" (replies bounce).' },
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

async function tableExists(table) {
  const r = await sql`
    SELECT 1 FROM information_schema.tables
    WHERE table_schema='public' AND table_name=${table}`;
  return r.length > 0;
}

async function columnExists(table, column) {
  const r = await sql`
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name=${table} AND column_name=${column}`;
  return r.length > 0;
}

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
    console.error('[migrate-v77-2] fatal:', err);
    return res.status(500).json({ error: err.message, stack: err.stack });
  }
}

async function dryRun(req, res) {
  await ensureMigrationsTable();
  const ran = await hasMigrationRun();

  const checks = {
    applicant_form_tokens_exists: await tableExists('applicant_form_tokens'),
    email_log_exists:             await tableExists('email_log'),
    system_settings_exists:       await tableExists('system_settings'),
    seed_rows_present:            null,
  };

  if (checks.system_settings_exists) {
    const r = await sql`SELECT COUNT(*)::int AS n FROM system_settings WHERE category = 'email'`;
    checks.seed_rows_present = r[0]?.n || 0;
  }

  return res.status(200).json({
    migration_id: MIGRATION_ID,
    already_ran:  ran,
    pre_state:    checks,
    seed_to_insert: SETTINGS_SEED.map(s => ({ key: s.key, value: s.value })),
    note: ran ? 'Migration has already run. POST is a no-op.' : 'Run POST to execute.',
  });
}

async function execute(req, res) {
  await ensureMigrationsTable();
  if (await hasMigrationRun()) {
    return res.status(200).json({ migration_id: MIGRATION_ID, already_ran: true, message: 'No-op.' });
  }

  const steps = [];

  // ── Step 1: applicant_form_tokens ────────────────────────────────────────
  await recordRanStep(steps, 'CREATE TABLE applicant_form_tokens', async () => {
    await sql`
      CREATE TABLE IF NOT EXISTS applicant_form_tokens (
        id                BIGSERIAL PRIMARY KEY,
        application_id    BIGINT      NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
        step              INTEGER     NOT NULL CHECK (step IN (1, 2)),
        token             TEXT        NOT NULL UNIQUE,
        contact_id        INTEGER     REFERENCES contacts(id) ON DELETE SET NULL,
        applicant_email   TEXT        NOT NULL,
        email_verified    BOOLEAN     NOT NULL DEFAULT false,
        verified_at       TIMESTAMPTZ,
        expires_at        TIMESTAMPTZ NOT NULL,
        last_accessed_at  TIMESTAMPTZ,
        created_by        INTEGER     REFERENCES contacts(id) ON DELETE SET NULL,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
      )`;
    // V77.2 idempotency fix — V77.1 created this table without `contact_id`.
    // CREATE TABLE IF NOT EXISTS above is a no-op on existing tables, so we
    // explicitly ALTER to add the column (and FK) when missing.
    await sql`ALTER TABLE applicant_form_tokens ADD COLUMN IF NOT EXISTS contact_id INTEGER`;
    await sql`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'applicant_form_tokens_contact_id_fkey'
        ) THEN
          ALTER TABLE applicant_form_tokens
          ADD CONSTRAINT applicant_form_tokens_contact_id_fkey
          FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL;
        END IF;
      END $$`;
    // UNIQUE on (application_id, step) — only one valid token per offer per step.
    // Reissuing replaces the previous token (DELETE old, INSERT new in api/applicant-form-tokens.js).
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS applicant_form_tokens_app_step_uq ON applicant_form_tokens (application_id, step)`;
    await sql`CREATE INDEX IF NOT EXISTS applicant_form_tokens_token_idx ON applicant_form_tokens (token)`;
    await sql`CREATE INDEX IF NOT EXISTS applicant_form_tokens_contact_idx ON applicant_form_tokens (contact_id)`;
    await sql`CREATE INDEX IF NOT EXISTS applicant_form_tokens_expires_idx ON applicant_form_tokens (expires_at) WHERE email_verified = false`;
    return { done: true };
  });

  // ── Step 2: email_log ────────────────────────────────────────────────────
  await recordRanStep(steps, 'CREATE TABLE email_log', async () => {
    await sql`
      CREATE TABLE IF NOT EXISTS email_log (
        id                BIGSERIAL PRIMARY KEY,
        to_address        TEXT        NOT NULL,
        from_address      TEXT        NOT NULL,
        reply_to          TEXT,
        subject           TEXT        NOT NULL,
        body_html         TEXT,
        body_text         TEXT,
        template_id       TEXT,
        related_entity_type TEXT,
        related_entity_id   TEXT,
        status            TEXT        NOT NULL DEFAULT 'stubbed',
        provider_message_id TEXT,
        error_message     TEXT,
        sent_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
        delivered_at      TIMESTAMPTZ,
        triggered_by      INTEGER     REFERENCES contacts(id) ON DELETE SET NULL
      )`;
    // Index on related entity for "show me all emails for this offer/deal" lookups
    await sql`CREATE INDEX IF NOT EXISTS email_log_related_idx ON email_log (related_entity_type, related_entity_id)`;
    await sql`CREATE INDEX IF NOT EXISTS email_log_to_idx       ON email_log (to_address)`;
    await sql`CREATE INDEX IF NOT EXISTS email_log_sent_at_idx  ON email_log (sent_at DESC)`;
    return { done: true };
  });

  // ── Step 3: system_settings ──────────────────────────────────────────────
  await recordRanStep(steps, 'CREATE TABLE system_settings', async () => {
    await sql`
      CREATE TABLE IF NOT EXISTS system_settings (
        key           TEXT        PRIMARY KEY,
        value         TEXT        NOT NULL,
        category      TEXT        NOT NULL DEFAULT 'general',
        label         TEXT        NOT NULL,
        description   TEXT,
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_by    INTEGER     REFERENCES contacts(id) ON DELETE SET NULL
      )`;
    await sql`CREATE INDEX IF NOT EXISTS system_settings_category_idx ON system_settings (category)`;
    return { done: true };
  });

  // ── Step 4: seed system_settings from V77.1 lib/email-config.js values ──
  await recordRanStep(steps, 'SEED system_settings (email config defaults)', async () => {
    let inserted = 0;
    for (const s of SETTINGS_SEED) {
      const r = await sql`
        INSERT INTO system_settings (key, value, category, label, description)
        VALUES (${s.key}, ${s.value}, ${s.category}, ${s.label}, ${s.description})
        ON CONFLICT (key) DO NOTHING
        RETURNING key`;
      if (r.length) inserted++;
    }
    return { inserted, total_seed: SETTINGS_SEED.length };
  });

  // Mark migration ran
  await sql`INSERT INTO _migrations (id) VALUES (${MIGRATION_ID}) ON CONFLICT DO NOTHING`;

  return res.status(200).json({
    migration_id: MIGRATION_ID,
    success: true,
    steps,
  });
}

// Helper: run a step, capture result, append to steps[]. On error, rethrow.
async function recordRanStep(steps, name, fn) {
  const t0 = Date.now();
  try {
    const result = await fn();
    steps.push({ step: name, ms: Date.now() - t0, ...result });
  } catch (err) {
    steps.push({ step: name, ms: Date.now() - t0, error: err.message });
    throw err;
  }
}
