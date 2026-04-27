/**
 * api/create-parcel-from-lookup.js
 *
 * Creates a new Parcel + its child Properties + (optionally) a Deal on that
 * Parcel, from client-pre-resolved NSW lookup data.
 *
 * This is the "happy path" counterpart to rebuild-parcel-by-lotdp.js:
 *   - rebuild = replace children of an EXISTING parcel
 *   - create  = make a brand new parcel with children
 *
 * Client workflow (map.js multi-select → "+ Pipeline"):
 *   1. User ⌘-clicks N points on the map
 *   2. Client calls NSWLookup.lookupByLatLng(lat, lng) for each
 *   3. Client dedupes by lot_dps (multiple clicks on the same lot = one lot)
 *   4. Client POSTs here with { properties, workflow?, stage?, data? }
 *   5. Server creates parcel, child properties, and the deal in one transaction
 *
 * POST body:
 *   {
 *     parcel_id?:    string,   // optional; generated if omitted
 *     parcel_name?:  string,   // optional; derived from child addresses if omitted
 *     properties: [
 *       {
 *         lot_dps:       string,   // required
 *         address:       string,
 *         suburb:        string?,
 *         state_prop_id: string?,
 *         lat:           number,
 *         lng:           number,
 *         area_sqm:      number?,
 *         rings:         array?,
 *       },
 *       ...  (N ≥ 1; if N == 1, will STILL be created as a Parcel for consistency
 *             — caller should use /api/create-property-from-lookup for single-prop flow)
 *     ],
 *     create_deal?:  boolean,  // default true
 *     workflow?:     string,   // default 'acquisition'
 *     stage?:        string,   // default 'shortlisted'
 *     deal_data?:    object,   // shallow-merged into deals.data
 *   }
 *
 * Returns: { ok, parcel, properties: [...], deal: {id} | null }
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
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[create-parcel-from-lookup] fatal:', err);
    return res.status(500).json({ error: err.message });
  }
}

async function execute(req, res) {
  const body = req.body || {};
  const {
    parcel_id   = `parcel-${Date.now()}`,
    parcel_name,
    properties  = [],
    create_deal = true,
    workflow    = 'acquisition',
    stage       = 'shortlisted',
    deal_data   = {},
  } = body;

  if (!Array.isArray(properties) || properties.length === 0) {
    return res.status(400).json({ error: 'properties array required (non-empty)' });
  }

  // Validate each entry
  for (const [i, p] of properties.entries()) {
    if (!p.lot_dps) return res.status(400).json({ error: `properties[${i}].lot_dps required` });
    if (typeof p.lat !== 'number' || typeof p.lng !== 'number') {
      return res.status(400).json({ error: `properties[${i}] lat/lng required as numbers` });
    }
  }

  // Derive parcel name from child addresses if not supplied.
  // Simple join: "addr1 & addr2, suburb" — caller can PUT a nicer name later.
  let finalName = parcel_name;
  if (!finalName) {
    const addresses = properties.map(p => p.address).filter(Boolean);
    const suburbs   = [...new Set(properties.map(p => p.suburb).filter(Boolean))];
    const addrPart  = addresses.length ? addresses.join(' & ') : parcel_id;
    const subPart   = suburbs.length === 1 ? `, ${suburbs[0]}` : (suburbs.length > 1 ? `, ${suburbs.join(' & ')}` : '');
    finalName = `${addrPart}${subPart}`;
  }

  // 1. Create the Parcel
  const parcelRow = (await sql`
    INSERT INTO parcels (id, name)
    VALUES (${parcel_id}, ${finalName})
    ON CONFLICT (id) DO NOTHING
    RETURNING *`)[0];
  if (!parcelRow) {
    // Already exists — refuse (caller should use rebuild for that case)
    return res.status(409).json({ error: 'Parcel with that id already exists', parcel_id });
  }

  // 2. Create N child Properties
  const createdProperties = [];
  const now = Date.now();
  let idx = 0;
  for (const p of properties) {
    idx++;
    const newPropId = `property-${now}-${idx}`;
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

    createdProperties.push({
      id:            newPropId,
      lot_dps:       p.lot_dps,
      address:       p.address,
      suburb:        p.suburb,
      state_prop_id: p.state_prop_id,
      lat:           p.lat,
      lng:           p.lng,
    });
  }

  // 3. Optionally create the Deal on the parcel
  let deal = null;
  if (create_deal) {
    // V76.5: deal id is now independent of parcel id. Generates `deal_*`,
    // matching the format used by api/deals.js newDealId() and the addToPipeline
    // path. Old convention (deal.id == parcel.id) caused id-keyspace collisions.
    const dealId = 'deal_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const dealDataObj = { addedAt: Date.now(), ...deal_data };
    const dealDataJson = JSON.stringify(dealDataObj);
    // V75.6: derive board_id/column_id from workflow+stage for system boards
    const boardIdFinal  = `sys_${workflow}`;
    const columnIdFinal = `${boardIdFinal}_${stage}`;
    const dealRow = (await sql`
      INSERT INTO deals (id, property_id, parcel_id, workflow, stage, status, data, board_id, column_id)
      VALUES (${dealId}, NULL, ${parcel_id}, ${workflow}, ${stage}, 'active', ${dealDataJson}::jsonb,
              ${boardIdFinal}, ${columnIdFinal})
      RETURNING id, stage, status`)[0];
    deal = dealRow;
  }

  return res.status(201).json({
    ok: true,
    parcel: { id: parcelRow.id, name: parcelRow.name },
    properties: createdProperties,
    deal,
  });
}
