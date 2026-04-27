/**
 * api/migrate-to-v76-5-5.js
 *
 * V76.5.5 — Not-Suitable history preservation
 *
 *   Background:
 *     The previous data model used a single column (`not_suitable_until`) to
 *     track screen-out state. NULL meant "never screened" AND "was screened
 *     then reinstated" — two completely different states collapsed into one.
 *     The "Reinstate" action nulled the column, throwing away the fact that
 *     screening had ever happened. Properties screened months ago and then
 *     auto-cleared looked identical to fresh, untouched properties.
 *
 *   Fix:
 *     1. Add `properties.not_suitable_set_at TIMESTAMPTZ`. NULL = never
 *        screened. Stamped on the first set_not_suitable call. Preserved
 *        across Reinstate + re-flagging.
 *     2. Reinstate (clear_not_suitable) no longer nulls `not_suitable_until`
 *        — it sets it to now() so the row is "no longer actively screened"
 *        but its history is preserved. (Code change in api/properties.js,
 *        not in this script.)
 *     3. Backfill (this script):
 *        a. Stamp set_at = now() on every property where
 *           not_suitable_until IS NOT NULL AND set_at IS NULL.
 *        b. Recover residue: properties with domain_listing_id, no deal,
 *           not in a parcel, no current flag — these are the rows where
 *           the old code nulled the until column on Reinstate/expiry.
 *           Stamp set_at = now() and until = now() so they re-enter the
 *           "previously screened" state and the CRM filter can hide them.
 *
 *   GET  → status report
 *   POST → run migration (admin, body { confirm: true })
 *
 *   Idempotent: re-running it after success is a no-op (no candidates left).
 */

import { neon } from '@neondatabase/serverless';
import { getDatabaseUrl } from '../lib/db.js';
import { requireSession, requireAdmin } from '../lib/auth.js';

const sql = neon(getDatabaseUrl());

async function columnExists(table, column) {
  const rows = await sql`
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name=${table} AND column_name=${column}
     LIMIT 1`;
  return rows.length > 0;
}

async function statusReport() {
  const hasColumn = await columnExists('properties', 'not_suitable_set_at');
  // Count categories the script would touch.
  let withFlagNoSetAt = 0;
  if (hasColumn) {
    const r = await sql`
      SELECT COUNT(*)::int AS n FROM properties
       WHERE not_suitable_until IS NOT NULL
         AND not_suitable_set_at IS NULL`;
    withFlagNoSetAt = r[0].n;
  } else {
    const r = await sql`
      SELECT COUNT(*)::int AS n FROM properties
       WHERE not_suitable_until IS NOT NULL`;
    withFlagNoSetAt = r[0].n;
  }
  // Residue: has domain_listing_id, no deal, not in a parcel, no current flag.
  // Same heuristic the user sanity-checked.
  const residue = await sql`
    SELECT COUNT(*)::int AS n FROM properties p
     WHERE p.domain_listing_id IS NOT NULL
       AND p.parcel_id IS NULL
       AND (p.not_suitable_until IS NULL OR p.not_suitable_until <= now())
       AND NOT EXISTS (
         SELECT 1 FROM deals d WHERE d.property_id = p.id
       )`;
  return {
    set_at_column_present: hasColumn,
    rows_needing_set_at_stamp: withFlagNoSetAt,
    residue_rows_to_recover: residue[0].n,
  };
}

async function runMigration(opts = {}) {
  const log = [];
  const step = async (name, fn) => {
    try {
      const r = await fn();
      log.push({ step: name, ok: true, ...(r || {}) });
    } catch (err) {
      log.push({ step: name, ok: false, error: err.message });
      throw err;
    }
  };

  // 1. Add the column (idempotent)
  await step('add properties.not_suitable_set_at', async () => {
    if (!(await columnExists('properties', 'not_suitable_set_at'))) {
      await sql`ALTER TABLE properties ADD COLUMN not_suitable_set_at TIMESTAMPTZ`;
      return { added: true };
    }
    return { skipped: 'already exists' };
  });

  // 2. Backfill set_at for any row that has a flag set but no set_at stamp.
  //    We don't know when the flag was actually applied historically — stamp
  //    now() per the user's instruction. Future re-flags use COALESCE so this
  //    won't clobber once stamped.
  let stamped = 0;
  await step('stamp set_at on flagged rows', async () => {
    const result = await sql`
      UPDATE properties
         SET not_suitable_set_at = now(),
             updated_at          = now()
       WHERE not_suitable_until IS NOT NULL
         AND not_suitable_set_at IS NULL
       RETURNING id`;
    stamped = result.length;
    return { stamped };
  });

  // 3. Recover residue rows. These are properties where the old code nulled
  //    not_suitable_until on Reinstate/expiry, throwing away the fact that
  //    screening ever happened. The user has confirmed that all such rows
  //    in the current data set are genuinely "previously screened."
  //
  //    Heuristic: has domain_listing_id (came from a Domain listing), no
  //    deal (never progressed), not in a parcel (not aggregated elsewhere),
  //    not currently flagged (until is null or in the past).
  //
  //    Stamp set_at = now() and until = now() so these rows enter the
  //    "previously screened, no longer actively flagged" state. CRM filter
  //    then includes them by default (since until is no longer in the
  //    future) — but that means they STAY visible. Wait — that's the
  //    opposite of what we want.
  //
  // 3. Recover residue rows. These are properties where the old code nulled
  //    not_suitable_until on Reinstate/expiry, throwing away the screening
  //    history. The user has confirmed that all such rows in the current
  //    data set are genuinely "previously screened" and should be hidden.
  //
  //    Heuristic: has domain_listing_id (came from a Domain listing), no
  //    deal (never progressed), not in a parcel (not aggregated elsewhere),
  //    not currently flagged (until is null or in the past), no set_at yet.
  //
  //    The recovery sets `set_at = now()` and `until` to a future timestamp
  //    so these rows appear as currently-flagged → CRM filter hides them
  //    by default. The future window is configurable via POST body
  //    `residueDurationDays` (default 30) or `residuePermanent: true` for
  //    permanent screening (until = 'infinity').
  let recovered = 0;
  await step('recover residue (re-flag historically screened rows)', async () => {
    const days = Number.isFinite(opts.residueDurationDays) ? opts.residueDurationDays : 30;
    const intervalSql = `${days} days`;
    const result = opts.residuePermanent
      ? await sql`
          UPDATE properties p
             SET not_suitable_set_at = now(),
                 not_suitable_until  = 'infinity'::timestamptz,
                 updated_at          = now()
           WHERE p.domain_listing_id IS NOT NULL
             AND p.parcel_id IS NULL
             AND (p.not_suitable_until IS NULL OR p.not_suitable_until <= now())
             AND p.not_suitable_set_at IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM deals d WHERE d.property_id = p.id
             )
           RETURNING id, address`
      : await sql`
          UPDATE properties p
             SET not_suitable_set_at = now(),
                 not_suitable_until  = (now() + (${intervalSql})::interval),
                 updated_at          = now()
           WHERE p.domain_listing_id IS NOT NULL
             AND p.parcel_id IS NULL
             AND (p.not_suitable_until IS NULL OR p.not_suitable_until <= now())
             AND p.not_suitable_set_at IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM deals d WHERE d.property_id = p.id
             )
           RETURNING id, address`;
    recovered = result.length;
    return {
      recovered,
      mode: opts.residuePermanent ? 'permanent' : `${days} days`,
      recovered_ids: result.map(r => r.id),
    };
  });

  return { stamped, recovered, log };
}

export default async function handler(req, res) {
  const session = await requireSession(req, res);
  if (!session) return;

  if (req.method === 'GET') {
    if (req.query.check === '1') {
      try {
        const status = await statusReport();
        return res.status(200).json(status);
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    }
    return res.status(200).json({
      message: 'V76.5.5 migration. POST { confirm: true } to run. GET ?check=1 for status.',
    });
  }

  if (req.method === 'POST') {
    if (!requireAdmin(session, res)) return;
    const { confirm, residueDurationDays, residuePermanent } = req.body || {};
    if (confirm !== true) {
      return res.status(400).json({
        error: 'Migration not confirmed. POST body must include { "confirm": true }.',
      });
    }
    try {
      const result = await runMigration({ residueDurationDays, residuePermanent });
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
}
