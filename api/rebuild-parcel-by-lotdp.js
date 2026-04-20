/**
 * api/rebuild-parcel-by-lotdp.js
 *
 * Rebuilds a Parcel's child Properties from an authoritative Lot/DP list.
 *
 * The V75.4 migration split synthetic multi-parcel rows into child Properties
 * by unpacking the imprecise ⌘-click lat/lng coordinates. This worked when
 * clicks landed unambiguously in a single cadastral lot, but failed when:
 *   - Two clicks fell inside the same lot (duplicate)
 *   - A click landed near a lot boundary and NSW's Property layer returned
 *     a different frontage address (the Wentworth Road vs Northern Road case)
 *
 * This endpoint bypasses lat/lng entirely. The caller supplies the list of
 * authoritative Lot/DPs for a Parcel, and we rebuild:
 *   1. Look up each Lot/DP in NSW cadastre to get polygon + centroid + address
 *   2. DELETE all existing child Properties of this Parcel
 *   3. CREATE N new child Properties, one per Lot/DP, with centroid lat/lng
 *      and authoritative address from NSW Property layer
 *
 * Note this is DESTRUCTIVE — any linked contacts, notes, or other references
 * to the deleted children are lost. Entity_contacts and notes pointing at
 * the Parcel itself are preserved (they reference parcel_id, not property_id).
 *
 * POST /api/rebuild-parcel-by-lotdp
 *   body: { parcel_id: string, lots: string[] }
 *   e.g.  { parcel_id: "parcel-1776557748108",
 *           lots: ["17//DP1222679", "18//DP1222679", "2//DP1280952"] }
 *
 * Returns { ok, deleted_count, created_count, created_properties: [...] }
 *
 * Admin-only. Not idempotent (each call deletes + recreates).
 */

import { neon } from '@neondatabase/serverless';
import { requireSession, requireAdmin } from '../lib/auth.js';
import { getDatabaseUrl } from '../lib/db.js';
import { lookupByLotDP } from '../lib/nsw-lookup.js';
const sql = neon(getDatabaseUrl());

export default async function handler(req, res) {
  const session = await requireSession(req, res);
  if (!session) return;
  if (!requireAdmin(session, res)) return;

  try {
    if (req.method === 'POST') return await execute(req, res);
    if (req.method === 'GET')  return await previewInfo(req, res);
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[rebuild-parcel-by-lotdp] fatal:', err);
    return res.status(500).json({ error: err.message });
  }
}

// GET with ?parcel_id=X&lots=17//DP1222679,18//DP1222679 → dry-run preview
async function previewInfo(req, res) {
  const { parcel_id, lots } = req.query;
  if (!parcel_id) return res.status(400).json({ error: 'parcel_id required' });
  if (!lots)      return res.status(400).json({ error: 'lots required (comma-separated)' });

  const lotList = String(lots).split(',').map(s => s.trim()).filter(Boolean);

  const parcel = (await sql`SELECT * FROM parcels WHERE id = ${parcel_id}`)[0];
  if (!parcel) return res.status(404).json({ error: 'Parcel not found' });

  const existingChildren = await sql`SELECT id, address, suburb, lot_dps FROM properties WHERE parcel_id = ${parcel_id}`;

  const lookups = [];
  for (const l of lotList) {
    const record = await lookupByLotDP(l);
    lookups.push({ input: l, result: record });
  }

  return res.status(200).json({
    action: 'DRY_RUN',
    parcel: { id: parcel.id, name: parcel.name },
    existing_children_to_delete: existingChildren,
    proposed_new_children: lookups,
    lookup_failures: lookups.filter(x => !x.result).map(x => x.input),
  });
}

async function execute(req, res) {
  const body = req.body || {};
  const { parcel_id, lots } = body;
  if (!parcel_id)          return res.status(400).json({ error: 'parcel_id required' });
  if (!Array.isArray(lots) || !lots.length) return res.status(400).json({ error: 'lots array required' });

  // Verify parcel exists
  const parcel = (await sql`SELECT * FROM parcels WHERE id = ${parcel_id}`)[0];
  if (!parcel) return res.status(404).json({ error: 'Parcel not found' });

  // Look up all lots FIRST — if any fails, we abort without touching the DB
  const lookups = [];
  for (const l of lots) {
    const record = await lookupByLotDP(l);
    if (!record) {
      return res.status(422).json({
        error: `Lot/DP '${l}' not found in NSW cadastre`,
        partial_results: lookups,
      });
    }
    lookups.push({ input: l, result: record });
  }

  // All lookups succeeded — safe to mutate.
  // 1. Delete existing child Properties (cascades via FK will drop their
  //    entity_contacts / notes on entity_type='property' — parcel-level
  //    contacts and notes are unaffected since they reference parcel_id).
  //    We have to clear parcel_id from any deals targeting these properties
  //    first… actually no: deals on the PARCEL use parcel_id; deals on
  //    properties point at specific property_ids and would be orphaned.
  //    Check and refuse if any deals reference these children directly.
  const existingChildren = await sql`SELECT id FROM properties WHERE parcel_id = ${parcel_id}`;
  const childIds = existingChildren.map(c => c.id);
  if (childIds.length) {
    const dealsOnChildren = await sql`
      SELECT id, property_id FROM deals WHERE property_id = ANY(${childIds})`;
    if (dealsOnChildren.length) {
      return res.status(409).json({
        error: 'Cannot rebuild — some child properties have their own deals',
        deals: dealsOnChildren,
        hint: 'Reassign deals to the parcel, or delete them, before rebuilding',
      });
    }
    // Safe to delete
    await sql`DELETE FROM properties WHERE id = ANY(${childIds})`;
  }

  // 2. Create new child Properties from lookup results
  const created = [];
  let idx = 0;
  const now = Date.now();
  for (const { input, result: r } of lookups) {
    idx++;
    const newPropId = `property-${now}-${idx}`;
    // The single-element parcels JSONB keeps the lot polygon for map rendering
    const lotPolygonEntry = {
      lat:   r.lat,
      lng:   r.lng,
      label: `${r.address}${r.suburb ? ', ' + r.suburb : ''}`,
      lot_dps: r.lotidstring,
    };
    if (r.rings) lotPolygonEntry.rings = r.rings;
    const selfParcelsJson = JSON.stringify([lotPolygonEntry]);

    await sql`
      INSERT INTO properties (
        id, address, suburb, lat, lng, lot_dps, area_sqm,
        parcels, property_count, parcel_id, state_prop_id
      ) VALUES (
        ${newPropId},
        ${r.address || input},
        ${r.suburb  || null},
        ${r.lat},
        ${r.lng},
        ${r.lotidstring},
        ${r.areaSqm},
        ${selfParcelsJson}::jsonb,
        1,
        ${parcel_id},
        ${r.propid}
      )`;

    created.push({
      id:            newPropId,
      lot_dps:       r.lotidstring,
      address:       r.address,
      suburb:        r.suburb,
      state_prop_id: r.propid,
      lat:           r.lat,
      lng:           r.lng,
      area_sqm:      r.areaSqm,
    });
  }

  // 3. Update the parcel's updated_at stamp + rebuild name with suburb if not set
  const needsRename = !parcel.name || !parcel.name.includes(',');
  if (needsRename && created[0]?.suburb) {
    const currentNameBase = (parcel.name || '').split(',')[0].trim();
    const newName = `${currentNameBase}, ${created[0].suburb}`;
    await sql`UPDATE parcels SET name = ${newName}, updated_at = now() WHERE id = ${parcel_id}`;
  } else {
    await sql`UPDATE parcels SET updated_at = now() WHERE id = ${parcel_id}`;
  }

  return res.status(200).json({
    ok: true,
    parcel_id,
    deleted_count: childIds.length,
    created_count: created.length,
    created_properties: created,
  });
}
