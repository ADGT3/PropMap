/**
 * api/rebuild-parcel-by-lotdp.js
 *
 * Rebuilds a Parcel's child Properties from client-pre-resolved Lot data.
 *
 * DESIGN NOTE: Earlier versions did NSW Spatial Portal lookups server-side,
 * but Vercel→NSW was unreliable (frequent timeouts on Lot 2//DP1280952 and
 * similar). Since browser→NSW is fast and reliable, the lookups moved to
 * the client (window.NSWLookup in nsw-lookup-client.js). This endpoint now
 * accepts pre-resolved property records and writes them to the DB.
 *
 * POST /api/rebuild-parcel-by-lotdp
 *   body: {
 *     parcel_id: string,
 *     properties: [
 *       {
 *         lot_dps:       string,   // required, e.g. "17//DP1222679"
 *         address:       string,   // e.g. "1178 The Northern Road"
 *         suburb:        string?,
 *         state_prop_id: string?,  // NSW propid
 *         lat:           number,
 *         lng:           number,
 *         area_sqm:      number?,
 *         rings:         array?,   // GeoJSON-style lot polygon
 *       },
 *       ...
 *     ]
 *   }
 *
 * Returns { ok, deleted_count, created_count, created_properties: [...] }
 *
 * DESTRUCTIVE: deletes all existing child Properties of the Parcel,
 * then inserts the new ones. Refuses if any existing child has its own
 * Deal (separate from the Parcel's deal) — those deals would be orphaned.
 *
 * Admin-only.
 */

import { neon } from '@neondatabase/serverless';
import { requireSession, requireAdmin } from '../lib/auth.js';
import { getDatabaseUrl } from '../lib/db.js';
const sql = neon(getDatabaseUrl());

export default async function handler(req, res) {
  const session = await requireSession(req, res);
  if (!session) return;
  if (!requireAdmin(session, res)) return;
  try {
    if (req.method === 'POST') return await execute(req, res);
    if (req.method === 'GET')  return res.status(200).json({
      hint: 'POST with { parcel_id, properties: [{lot_dps, address, suburb, state_prop_id, lat, lng, area_sqm, rings}] }',
    });
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[rebuild-parcel-by-lotdp] fatal:', err);
    return res.status(500).json({ error: err.message });
  }
}

async function execute(req, res) {
  const body = req.body || {};
  const { parcel_id, properties } = body;
  if (!parcel_id) return res.status(400).json({ error: 'parcel_id required' });
  if (!Array.isArray(properties) || !properties.length) {
    return res.status(400).json({ error: 'properties array required (non-empty)' });
  }

  // Minimal validation
  for (const [i, p] of properties.entries()) {
    if (!p.lot_dps) return res.status(400).json({ error: `properties[${i}].lot_dps required` });
    if (typeof p.lat !== 'number' || typeof p.lng !== 'number') {
      return res.status(400).json({ error: `properties[${i}] lat/lng required as numbers` });
    }
  }

  // Verify parcel exists
  const parcel = (await sql`SELECT * FROM parcels WHERE id = ${parcel_id}`)[0];
  if (!parcel) return res.status(404).json({ error: 'Parcel not found' });

  // Refuse if any existing child has its own Deal (would orphan the deal)
  const existingChildren = await sql`SELECT id FROM properties WHERE parcel_id = ${parcel_id}`;
  const childIds = existingChildren.map(c => c.id);
  if (childIds.length) {
    const dealsOnChildren = await sql`
      SELECT id, property_id FROM deals WHERE property_id = ANY(${childIds})`;
    if (dealsOnChildren.length) {
      return res.status(409).json({
        error: 'Cannot rebuild — some existing child properties have their own deals',
        deals: dealsOnChildren,
        hint: 'Reassign deals to the parcel, or delete them, before rebuilding',
      });
    }
    // Delete existing children (cascades clear their entity_contacts / notes)
    await sql`DELETE FROM properties WHERE id = ANY(${childIds})`;
  }

  // Insert new children
  const created = [];
  const now = Date.now();
  let idx = 0;
  for (const p of properties) {
    idx++;
    const newPropId = `property-${now}-${idx}`;
    // Single-element parcels JSONB keeps the lot polygon for map rendering
    const lotPolygonEntry = {
      lat:     p.lat,
      lng:     p.lng,
      label:   `${p.address || p.lot_dps}${p.suburb ? ', ' + p.suburb : ''}`,
      lot_dps: p.lot_dps,
    };
    if (p.rings) lotPolygonEntry.rings = p.rings;
    const selfParcelsJson = JSON.stringify([lotPolygonEntry]);

    await sql`
      INSERT INTO properties (
        id, address, suburb, lat, lng, lot_dps, area_sqm,
        parcels, property_count, parcel_id, state_prop_id
      ) VALUES (
        ${newPropId},
        ${p.address || p.lot_dps},
        ${p.suburb  || null},
        ${p.lat},
        ${p.lng},
        ${p.lot_dps},
        ${p.area_sqm || null},
        ${selfParcelsJson}::jsonb,
        1,
        ${parcel_id},
        ${p.state_prop_id || null}
      )`;

    created.push({
      id:            newPropId,
      lot_dps:       p.lot_dps,
      address:       p.address,
      suburb:        p.suburb,
      state_prop_id: p.state_prop_id,
      lat:           p.lat,
      lng:           p.lng,
      area_sqm:      p.area_sqm,
    });
  }

  // Update parcel's updated_at + append suburb to name if missing
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
