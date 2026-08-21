/**
 * api/repair-v75-4c.js
 * V75.4c repair — supersedes V75.4a.
 *
 * Re-populates address/suburb/lot_dps for child Property rows created by the
 * V75.4 parcel-split migration, using the authoritative NSW Land Parcel
 * Property Theme feature service at portal.spatial.nsw.gov.au. This is the
 * state-level "source of truth" for: lat/lng → Lot → Property (address).
 *
 * Why this supersedes V75.4a:
 *   V75.4a used ArcGIS World Geocoder for reverse-geocoding lat/lng → address.
 *   The geocoder returned an address based on nearest road frontage, which
 *   produced wrong results for corner lots and multi-lot holdings (e.g.
 *   returning "Wentworth Road" for a lot that's part of a "Northern Road"
 *   Property registration). V75.4c uses the official NSW Property layer
 *   directly, which knows that Lot 2/DP1280952 is part of a "1152-1160
 *   Wentworth Road" Property — matching NSW's authoritative record.
 *
 * Also migrates the schema to add a new `state_prop_id` column — a state-
 * agnostic text field that carries NSW's propid (and can carry SA/other
 * state IDs in future). Stored as TEXT for forward compatibility.
 *
 * GET  /api/repair-v75-4c → dry-run
 * POST /api/repair-v75-4c → execute
 *
 * Idempotent via `_migrations` table.
 *
 * Notes on behaviour:
 *   - Schema migration always runs (ADD COLUMN IF NOT EXISTS — idempotent)
 *   - Data repair only affects child Property rows with garbage addresses
 *     or missing lot_dps. Rows with real addresses are left alone.
 *   - Existing DB suburb is preserved as a fallback if NSW Property layer
 *     returns no suburb (e.g. off-shore points).
 *   - Parcel names with missing suburb get updated to "Name, Suburb" form.
 */

import { neon } from '@neondatabase/serverless';
import { requireSession, requireAdmin } from '../lib/auth.js';
import { getDatabaseUrl } from '../lib/db.js';
import { lookupByLatLng } from '../lib/nsw-lookup.js';
const sql = neon(getDatabaseUrl());

const MIGRATION_ID = 'v75_4c_nsw_authoritative_repair';

// Find candidate child Property rows needing repair.
async function findCandidates() {
  return await sql`
    SELECT id, address, suburb, lat, lng, lot_dps, area_sqm, parcel_id
    FROM properties
    WHERE parcel_id IS NOT NULL
      AND (address LIKE 'Lot %' OR COALESCE(lot_dps, '') = '')
      AND lat IS NOT NULL AND lng IS NOT NULL`;
}

// Ensure the state_prop_id column exists.
async function ensureSchema() {
  const cols = (await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name='properties'`).map(c => c.column_name);
  if (!cols.includes('state_prop_id')) {
    await sql`ALTER TABLE properties ADD COLUMN state_prop_id TEXT`;
    await sql`CREATE INDEX IF NOT EXISTS properties_state_prop_idx ON properties (state_prop_id)`;
    return { added: true };
  }
  return { added: false };
}

export default async function handler(req, res) {
  const session = await requireSession(req, res);
  if (!session) return;
  if (!requireAdmin(session, res)) return;
  try {
    if (req.method === 'GET')  return await dryRun(res);
    if (req.method === 'POST') return await execute(res);
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[repair-v75-4c] fatal:', err);
    return res.status(500).json({ error: err.message });
  }
}

async function dryRun(res) {
  const prior = await sql`SELECT 1 FROM _migrations WHERE id = ${MIGRATION_ID}`;
  const alreadyRan = prior.length > 0;

  const schemaCheck = await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name='properties' AND column_name='state_prop_id'`;

  const candidates = await findCandidates();
  const previews = [];
  for (const p of candidates) {
    const lookup = await lookupByLatLng(p.lat, p.lng);
    previews.push({
      id: p.id,
      parcel_id: p.parcel_id,
      lat: p.lat,
      lng: p.lng,
      current: {
        address:       p.address,
        suburb:        p.suburb,
        lot_dps:       p.lot_dps,
      },
      proposed: {
        address:       lookup?.address       || p.address,
        suburb:        lookup?.suburb        || p.suburb,
        lot_dps:       lookup?.lotidstring   || p.lot_dps,
        state_prop_id: lookup?.propid        || null,
      },
      nsw_raw: lookup ? {
        lotidstring:   lookup.lotidstring,
        raw_address:   lookup.raw_address,
        housenumber:   lookup.housenumber,
        urbanity:      lookup.urbanity,
      } : null,
      has_lookup: !!lookup,
    });
  }

  // Parcel renames (add suburb to parcel.name)
  const parcels = await sql`SELECT id, name FROM parcels`;
  const parcelProposals = [];
  for (const pa of parcels) {
    if ((pa.name || '').includes(',')) continue;
    const kids = await sql`
      SELECT suburb FROM properties
      WHERE parcel_id = ${pa.id} AND suburb IS NOT NULL AND suburb <> ''
      LIMIT 1`;
    const suburb = kids[0]?.suburb || null;
    if (!suburb) continue;
    parcelProposals.push({
      id: pa.id,
      current_name:  pa.name,
      proposed_name: `${pa.name}, ${suburb}`,
    });
  }

  return res.status(200).json({
    migration_id: MIGRATION_ID,
    already_run: alreadyRan,
    schema: {
      state_prop_id_column_exists: schemaCheck.length > 0,
      will_add: schemaCheck.length === 0,
    },
    property_repairs: previews,
    parcel_renames: parcelProposals,
    next_action: alreadyRan ? 'nothing — already run' : 'POST to /api/repair-v75-4c to execute',
  });
}

async function execute(res) {
  const prior = await sql`SELECT 1 FROM _migrations WHERE id = ${MIGRATION_ID}`;
  if (prior.length) return res.status(200).json({ ok: true, already_run: true });

  const schemaResult = await ensureSchema();

  const candidates = await findCandidates();
  const propertyUpdates = [];
  for (const p of candidates) {
    const lookup = await lookupByLatLng(p.lat, p.lng);

    const newAddress = lookup?.address     || null;
    const newSuburb  = lookup?.suburb      || null;
    const newLotDps  = lookup?.lotidstring || null;
    const newPropId  = lookup?.propid      || null;

    // Only overwrite address if it was garbage ("Lot N ..."), otherwise keep.
    const addrIsGarbage = String(p.address || '').startsWith('Lot ');
    const keepAddr = addrIsGarbage ? null : p.address;

    await sql`
      UPDATE properties SET
        address       = COALESCE(${newAddress}, ${keepAddr}, address),
        suburb        = COALESCE(${newSuburb}, suburb),
        lot_dps       = COALESCE(${newLotDps}, NULLIF(lot_dps, '')),
        state_prop_id = COALESCE(${newPropId}, state_prop_id),
        updated_at    = now()
      WHERE id = ${p.id}`;

    propertyUpdates.push({
      id: p.id,
      old_address: p.address,
      new_address: newAddress,
      new_lot_dps: newLotDps,
      new_state_prop_id: newPropId,
      had_lookup: !!lookup,
    });
  }

  // Parcel names
  const parcels = await sql`SELECT id, name FROM parcels`;
  const parcelUpdates = [];
  for (const pa of parcels) {
    if (!pa.name || pa.name.includes(',')) continue;
    const kids = await sql`
      SELECT suburb FROM properties
      WHERE parcel_id = ${pa.id} AND suburb IS NOT NULL AND suburb <> ''
      LIMIT 1`;
    const suburb = kids[0]?.suburb;
    if (!suburb) continue;
    const newName = `${pa.name}, ${suburb}`;
    await sql`UPDATE parcels SET name = ${newName}, updated_at = now() WHERE id = ${pa.id}`;
    parcelUpdates.push({ id: pa.id, old_name: pa.name, new_name: newName });
  }

  await sql`INSERT INTO _migrations (id, completed_at) VALUES (${MIGRATION_ID}, now()) ON CONFLICT (id) DO NOTHING`;

  return res.status(200).json({
    ok: true,
    already_run: false,
    summary: {
      schema_state_prop_id_added: schemaResult.added,
      properties_checked:        candidates.length,
      properties_updated:        propertyUpdates.length,
      parcels_renamed:           parcelUpdates.length,
    },
    property_updates: propertyUpdates,
    parcel_updates:   parcelUpdates,
  });
}
