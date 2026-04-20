/**
 * api/backfill-parcel-rings.js
 *
 * Backfill endpoint: fetches NSW Lot polygon rings for child properties
 * that were created before V75.4d (i.e. before lookupByLatLng started
 * returning rings). Needed so that clicking a parcel's pipeline star pin
 * can highlight ALL constituent property polygons.
 *
 * Strategy:
 *   - Find all properties where parcel_id IS NOT NULL AND lot_dps IS NOT NULL
 *     AND the parcels JSONB's first entry has no `rings` key
 *   - For each, query the NSW Lot layer (layer 8) by lot_dps to get rings
 *   - Update the property's parcels JSONB to include the rings
 *
 * GET = dry-run (reports candidates and what would happen).
 * POST = execute.
 *
 * Admin-only.
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
    const isExecute = req.method === 'POST';
    if (!isExecute && req.method !== 'GET') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    // Find child properties missing rings
    const candidates = await sql`
      SELECT id, address, suburb, lot_dps, parcel_id, parcels
      FROM properties
      WHERE parcel_id IS NOT NULL
        AND lot_dps IS NOT NULL
        AND lot_dps <> ''
      ORDER BY parcel_id, address`;

    const missing = candidates.filter(p => {
      const first = Array.isArray(p.parcels) && p.parcels[0];
      return first && (!first.rings || (Array.isArray(first.rings) && first.rings.length === 0));
    });

    const report = {
      total_children: candidates.length,
      missing_rings: missing.length,
      by_parcel: {},
      updates: [],
    };

    for (const p of missing) {
      try {
        const lookup = await lookupByLotDP(p.lot_dps);
        if (!lookup || !lookup.rings) {
          report.updates.push({ id: p.id, lot_dps: p.lot_dps, status: 'no-rings-from-nsw' });
          continue;
        }
        if (isExecute) {
          // Splice rings into the first entry of parcels JSONB
          const updatedParcels = [
            { ...(p.parcels[0] || {}), rings: lookup.rings },
            ...p.parcels.slice(1),
          ];
          await sql`
            UPDATE properties
            SET parcels = ${JSON.stringify(updatedParcels)}::jsonb,
                updated_at = now()
            WHERE id = ${p.id}`;
        }
        report.updates.push({
          id:       p.id,
          address:  p.address,
          lot_dps:  p.lot_dps,
          ring_pts: lookup.rings[0]?.length || 0,
          status:   isExecute ? 'updated' : 'would-update',
        });
        report.by_parcel[p.parcel_id] = (report.by_parcel[p.parcel_id] || 0) + 1;
      } catch (err) {
        report.updates.push({ id: p.id, lot_dps: p.lot_dps, status: 'error', error: err.message });
      }
    }

    return res.status(200).json({
      action: isExecute ? 'EXECUTED' : 'DRY_RUN',
      ...report,
    });
  } catch (err) {
    console.error('[backfill-parcel-rings] fatal:', err);
    return res.status(500).json({ error: err.message });
  }
}
