/**
 * api/migrate-to-v75-4.js
 * V75.4 migration — introduces Parcels as a first-class entity.
 *
 * What it does (in order):
 *   1. Create the parcels table with nullable not_suitable_until / not_suitable_reason
 *      and a minimal set of columns. No spatial data on the Parcel itself; the
 *      constituent properties carry their own polygons / lot numbers.
 *   2. Add properties.parcel_id (nullable FK → parcels.id, ON DELETE SET NULL)
 *   3. Add deals.parcel_id (nullable FK → parcels.id, ON DELETE CASCADE —
 *      if a parcel is deleted the deal goes with it; though the UI prevents
 *      deletion of parcels with deals, the DB enforces referential integrity).
 *      Also enforce a CHECK constraint so exactly one of property_id / parcel_id
 *      is set on a deal (never both, never neither).
 *   4. For each synthetic multi-parcel property row (id LIKE 'parcel-%' OR
 *      jsonb_array_length(parcels) > 1):
 *        a. Create a real parcels row with a fresh timestamp id
 *        b. Unpack each entry in the old parcels JSONB into a new properties row
 *        c. Re-point the matching deal from property_id → parcel_id
 *        d. Delete the synthetic property row
 *   5. Record completion in _migrations
 *
 * Note on entity_contacts: no schema change needed because entity_type is TEXT.
 * The API layer decides which values are accepted. See api/contacts.js for the
 * relevant update.
 *
 * GET  /api/migrate-to-v75-4 — dry-run status
 * POST /api/migrate-to-v75-4 — execute (admin-only)
 */

import { neon } from '@neondatabase/serverless';
import { requireSession, requireAdmin } from '../lib/auth.js';
import { getDatabaseUrl } from '../lib/db.js';
const sql = neon(getDatabaseUrl());

const MIGRATION_ID = 'v75_4_parcels';

export default async function handler(req, res) {
  const session = await requireSession(req, res);
  if (!session) return;
  if (!requireAdmin(session, res)) return;

  try {
    if (req.method === 'GET')  return await dryRun(req, res);
    if (req.method === 'POST') return await execute(req, res);
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[migrate-v75.4] fatal:', err);
    return res.status(500).json({ error: err.message });
  }
}

async function dryRun(req, res) {
  const tables = (await sql`SELECT table_name FROM information_schema.tables WHERE table_schema='public'`)
    .map(r => r.table_name);

  let alreadyRan = false;
  if (tables.includes('_migrations')) {
    const m = await sql`SELECT 1 FROM _migrations WHERE id = ${MIGRATION_ID}`;
    alreadyRan = m.length > 0;
  }

  // Find candidate synthetic property rows that need splitting
  let candidates = [];
  if (tables.includes('properties')) {
    candidates = await sql`
      SELECT id, address, suburb,
             jsonb_array_length(COALESCE(parcels, '[]'::jsonb)) AS parcel_count
      FROM properties
      WHERE id LIKE 'parcel-%'
         OR (parcels IS NOT NULL AND jsonb_array_length(parcels) > 1)
      ORDER BY updated_at DESC`;
  }

  const propsCols = tables.includes('properties')
    ? (await sql`SELECT column_name FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='properties'`).map(c => c.column_name)
    : [];
  const dealsCols = tables.includes('deals')
    ? (await sql`SELECT column_name FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='deals'`).map(c => c.column_name)
    : [];

  return res.status(200).json({
    migration_id: MIGRATION_ID,
    already_run: alreadyRan,
    parcels_table_exists: tables.includes('parcels'),
    properties_has_parcel_id: propsCols.includes('parcel_id'),
    deals_has_parcel_id: dealsCols.includes('parcel_id'),
    synthetic_property_rows_to_split: candidates.length,
    candidates: candidates.map(c => ({
      id: c.id,
      address: c.address,
      suburb: c.suburb,
      parcel_count: c.parcel_count,
    })),
    next_action: alreadyRan ? 'nothing — already migrated' : 'POST to /api/migrate-to-v75-4 to execute',
  });
}

async function execute(req, res) {
  const steps = [];
  const step = async (name, fn) => {
    try {
      const result = await fn();
      steps.push({ ok: true, step: name, ...(result || {}) });
    } catch (err) {
      console.error(`[migrate-v75.4] ${name} FAILED:`, err);
      steps.push({ ok: false, step: name, error: err.message });
      throw err;
    }
  };

  try {
    // Bail if already run
    const tables0 = (await sql`SELECT table_name FROM information_schema.tables WHERE table_schema='public'`)
      .map(r => r.table_name);
    if (tables0.includes('_migrations')) {
      const prior = await sql`SELECT 1 FROM _migrations WHERE id = ${MIGRATION_ID}`;
      if (prior.length) {
        return res.status(200).json({ ok: true, already_run: true, steps: [] });
      }
    }

    // ── 1. CREATE TABLE parcels ────────────────────────────────────────────
    await step('CREATE TABLE parcels', async () => {
      await sql`
        CREATE TABLE IF NOT EXISTS parcels (
          id                  TEXT PRIMARY KEY,
          name                TEXT,
          not_suitable_until  TIMESTAMPTZ,
          not_suitable_reason TEXT,
          created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
        )`;
      return { done: true };
    });

    // ── 2. Add properties.parcel_id ────────────────────────────────────────
    await step('ALTER TABLE properties ADD parcel_id', async () => {
      const propsCols = (await sql`SELECT column_name FROM information_schema.columns
          WHERE table_schema='public' AND table_name='properties'`).map(c => c.column_name);
      if (propsCols.includes('parcel_id')) return { note: 'already present' };
      await sql`ALTER TABLE properties
        ADD COLUMN parcel_id TEXT REFERENCES parcels(id) ON DELETE SET NULL`;
      await sql`CREATE INDEX IF NOT EXISTS properties_parcel_idx ON properties (parcel_id)`;
      return { done: true };
    });

    // ── 3. Add deals.parcel_id + XOR check ─────────────────────────────────
    await step('ALTER TABLE deals ADD parcel_id', async () => {
      const dealsCols = (await sql`SELECT column_name FROM information_schema.columns
          WHERE table_schema='public' AND table_name='deals'`).map(c => c.column_name);
      if (dealsCols.includes('parcel_id')) return { note: 'already present' };
      await sql`ALTER TABLE deals
        ADD COLUMN parcel_id TEXT REFERENCES parcels(id) ON DELETE CASCADE`;
      await sql`CREATE INDEX IF NOT EXISTS deals_parcel_idx ON deals (parcel_id)`;
      // Drop property_id NOT NULL if present — deals can now point at a parcel instead
      await sql`ALTER TABLE deals ALTER COLUMN property_id DROP NOT NULL`;
      return { done: true };
    });

    await step('Add deals XOR check (property_id vs parcel_id)', async () => {
      // Drop any existing check with this name, then add
      await sql`ALTER TABLE deals DROP CONSTRAINT IF EXISTS deals_target_xor`;
      await sql`ALTER TABLE deals ADD CONSTRAINT deals_target_xor
        CHECK ((property_id IS NULL) <> (parcel_id IS NULL))`;
      return { done: true };
    });

    // ── 4. Split synthetic multi-parcel property rows ──────────────────────
    let splitCount = 0;
    const splitSummaries = [];
    await step('Split synthetic multi-parcel rows', async () => {
      const candidates = await sql`
        SELECT id, address, suburb, lat, lng, lot_dps, area_sqm, parcels,
               property_count, domain_listing_id, listing_url, agent,
               not_suitable_until, not_suitable_reason
        FROM properties
        WHERE id LIKE 'parcel-%'
           OR (parcels IS NOT NULL AND jsonb_array_length(parcels) > 1)`;

      for (const oldProp of candidates) {
        const oldPropId    = oldProp.id;
        const lotsArr      = Array.isArray(oldProp.parcels) ? oldProp.parcels : [];
        if (lotsArr.length < 1) continue;

        // Create the new Parcel with a fresh timestamp id
        const newParcelId = 'parcel-' + (Date.now() + splitCount);
        await sql`
          INSERT INTO parcels (id, name, not_suitable_until, not_suitable_reason)
          VALUES (${newParcelId},
                  ${oldProp.address || null},
                  ${oldProp.not_suitable_until || null},
                  ${oldProp.not_suitable_reason || null})`;

        // Create N new Property rows, one per lot entry in the JSONB
        const newPropertyIds = [];
        let idx = 0;
        for (const lot of lotsArr) {
          idx++;
          const newPropId = `property-${Date.now()}-${splitCount}-${idx}`;
          const address   = lot.address || `Lot ${idx} ${oldProp.address || ''}`.trim();
          const suburb    = lot.suburb  || oldProp.suburb  || '';
          const lat       = lot.lat     ?? oldProp.lat     ?? null;
          const lng       = lot.lng     ?? oldProp.lng     ?? null;
          const lotDp     = lot.lot_dps || lot.lotDP       || '';
          const areaSqm   = lot.area_sqm ?? lot.areaSqm    ?? null;
          // Each new property keeps its own single-element parcels array holding
          // its own lot polygon (for map rendering)
          const selfParcelsJson = JSON.stringify([lot]);

          await sql`
            INSERT INTO properties (
              id, address, suburb, lat, lng, lot_dps, area_sqm,
              parcels, property_count, parcel_id
            ) VALUES (
              ${newPropId}, ${address}, ${suburb}, ${lat}, ${lng},
              ${String(lotDp).toUpperCase()}, ${areaSqm},
              ${selfParcelsJson}::jsonb, 1, ${newParcelId}
            )`;
          newPropertyIds.push(newPropId);
        }

        // Re-point the deal — should be exactly one deal per synthetic property row
        const dealsToRepoint = await sql`SELECT id FROM deals WHERE property_id = ${oldPropId}`;
        for (const d of dealsToRepoint) {
          // Have to clear property_id FIRST or the XOR check will fail mid-update
          // (both fields would be set briefly). Use a single UPDATE.
          await sql`
            UPDATE deals
            SET property_id = NULL, parcel_id = ${newParcelId}, updated_at = now()
            WHERE id = ${d.id}`;
        }

        // Detach any entity_contacts rows pointing at the old synthetic property
        // → re-point to the new parcel
        await sql`
          UPDATE entity_contacts
          SET entity_type = 'parcel', entity_id = ${newParcelId}
          WHERE entity_type = 'property' AND entity_id = ${oldPropId}`;

        // Also re-point any notes
        await sql`
          UPDATE notes
          SET entity_type = 'parcel', entity_id = ${newParcelId}
          WHERE entity_type = 'property' AND entity_id = ${oldPropId}`;

        // Now safe to delete the synthetic property row
        await sql`DELETE FROM properties WHERE id = ${oldPropId}`;

        splitSummaries.push({
          old_property_id: oldPropId,
          old_address:     oldProp.address,
          new_parcel_id:   newParcelId,
          new_property_ids: newPropertyIds,
          deals_repointed: dealsToRepoint.length,
        });
        splitCount++;
      }
      return { split_count: splitCount, splits: splitSummaries };
    });

    // ── 5. Record completion ───────────────────────────────────────────────
    await step('Record migration completion', async () => {
      await sql`
        INSERT INTO _migrations (id, completed_at) VALUES (${MIGRATION_ID}, now())
        ON CONFLICT (id) DO NOTHING`;
      return { done: true };
    });

    return res.status(200).json({
      ok: true,
      already_run: false,
      summary: {
        synthetic_rows_split: splitCount,
        splits: splitSummaries,
      },
      steps,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message, steps });
  }
}
