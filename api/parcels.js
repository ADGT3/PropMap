/**
 * api/parcels.js — V75.4
 *
 * CRUD for Parcel entities. A Parcel aggregates 2+ properties into a single
 * deal-level record for multi-property acquisitions.
 *
 * Routes:
 *   GET    /api/parcels                 → all parcels
 *   GET    /api/parcels?id=X            → single parcel
 *   GET    /api/parcels?id=X&expand=properties
 *                                       → single parcel + its properties array
 *   POST   /api/parcels { id?, name?, property_ids: [...] }
 *                                       → create a new parcel; sets properties.parcel_id
 *                                         on each id in property_ids (reassigning from
 *                                         any prior parcel they belonged to)
 *   POST   /api/parcels { action:'set_not_suitable', id, until, reason? }
 *   POST   /api/parcels { action:'clear_not_suitable', id }
 *   POST   /api/parcels { action:'add_property', id, property_id }
 *   POST   /api/parcels { action:'remove_property', id, property_id }
 *   PUT    /api/parcels { id, name }    → rename the parcel
 *   DELETE /api/parcels?id=X            → delete parcel (refused if any deals exist)
 *
 * Semantics:
 *   - A parcel ID is caller-supplied (e.g. `parcel-<timestamp>`) so the same
 *     ids can be generated client-side for new parcel creation.
 *   - Removing a property just clears its parcel_id; the property row persists.
 *   - Delete of a parcel is refused if any deal references it. No cascade.
 */

import { neon } from '@neondatabase/serverless';
import { requireSession } from '../lib/auth.js';
import { getDatabaseUrl } from '../lib/db.js';
const sql = neon(getDatabaseUrl());

export default async function handler(req, res) {
  const session = await requireSession(req, res);
  if (!session) return;

  try {
    switch (req.method) {

      case 'GET': {
        const { id, expand } = req.query;

        if (id) {
          const rows = await sql`SELECT * FROM parcels WHERE id = ${id}`;
          if (!rows.length) return res.status(404).json({ error: 'Not found' });
          const parcel = rows[0];
          if (expand === 'properties') {
            parcel.properties = await sql`
              SELECT * FROM properties WHERE parcel_id = ${id} ORDER BY address`;
          }
          return res.status(200).json(parcel);
        }

        // List all. Include a property_count for convenience.
        const rows = await sql`
          SELECT pa.*,
            (SELECT COUNT(*)::int FROM properties pr WHERE pr.parcel_id = pa.id) AS property_count
          FROM parcels pa ORDER BY pa.updated_at DESC`;
        return res.status(200).json(rows);
      }

      case 'POST': {
        const body = req.body || {};

        if (body.action === 'set_not_suitable') {
          const { id, until, reason = null } = body;
          if (!id || !until) return res.status(400).json({ error: 'id and until required' });
          const untilVal = until === 'permanent' ? 'infinity' : until;
          const rows = await sql`
            UPDATE parcels
               SET not_suitable_until  = ${untilVal}::timestamptz,
                   not_suitable_reason = ${reason},
                   updated_at          = now()
             WHERE id = ${id}
             RETURNING id, not_suitable_until, not_suitable_reason`;
          if (!rows.length) return res.status(404).json({ error: 'Not found' });
          return res.status(200).json(rows[0]);
        }
        if (body.action === 'clear_not_suitable') {
          const { id } = body;
          if (!id) return res.status(400).json({ error: 'id required' });
          await sql`UPDATE parcels SET not_suitable_until=NULL, not_suitable_reason=NULL, updated_at=now()
                    WHERE id=${id}`;
          return res.status(200).json({ ok: true });
        }

        if (body.action === 'add_property') {
          const { id, property_id } = body;
          if (!id || !property_id) return res.status(400).json({ error: 'id and property_id required' });
          const rows = await sql`
            UPDATE properties SET parcel_id = ${id}, updated_at = now()
            WHERE id = ${property_id}
            RETURNING id, parcel_id`;
          if (!rows.length) return res.status(404).json({ error: 'Property not found' });
          await sql`UPDATE parcels SET updated_at = now() WHERE id = ${id}`;
          return res.status(200).json(rows[0]);
        }

        if (body.action === 'remove_property') {
          const { id, property_id } = body;
          if (!id || !property_id) return res.status(400).json({ error: 'id and property_id required' });
          const rows = await sql`
            UPDATE properties SET parcel_id = NULL, updated_at = now()
            WHERE id = ${property_id} AND parcel_id = ${id}
            RETURNING id`;
          if (!rows.length) return res.status(404).json({ error: 'Property not found in this parcel' });
          await sql`UPDATE parcels SET updated_at = now() WHERE id = ${id}`;
          return res.status(200).json({ ok: true });
        }

        // Create
        const { id, name = null, property_ids = [] } = body;
        if (!id)  return res.status(400).json({ error: 'id required (caller-supplied)' });

        const rows = await sql`
          INSERT INTO parcels (id, name)
          VALUES (${id}, ${name})
          ON CONFLICT (id) DO NOTHING
          RETURNING *`;
        if (!rows.length) {
          const existing = await sql`SELECT * FROM parcels WHERE id = ${id}`;
          return res.status(200).json(existing[0]);
        }

        // Assign property_ids to this parcel (if any supplied)
        if (Array.isArray(property_ids) && property_ids.length) {
          await sql`
            UPDATE properties SET parcel_id = ${id}, updated_at = now()
            WHERE id = ANY(${property_ids})`;
        }
        return res.status(201).json(rows[0]);
      }

      case 'PUT': {
        const { id, name } = req.body || {};
        if (!id) return res.status(400).json({ error: 'id required' });
        const rows = await sql`
          UPDATE parcels SET name = ${name ?? null}, updated_at = now()
          WHERE id = ${id}
          RETURNING *`;
        if (!rows.length) return res.status(404).json({ error: 'Not found' });
        return res.status(200).json(rows[0]);
      }

      case 'DELETE': {
        const { id } = req.query;
        if (!id) return res.status(400).json({ error: 'id required' });
        // Refuse if any deals reference this parcel
        const deals = await sql`SELECT id FROM deals WHERE parcel_id = ${id}`;
        if (deals.length) {
          return res.status(409).json({
            error: 'Cannot delete parcel with existing deals',
            deal_count: deals.length,
            hint: 'Close or reassign deals before deleting the parcel',
          });
        }
        // V75.4d: delete child properties first. The `properties.parcel_id` FK
        // is ON DELETE SET NULL so deleting the parcel alone would leave
        // properties orphaned (parcel_id cleared, but rows still exist). We
        // want them gone when the parcel goes.
        const children = await sql`DELETE FROM properties WHERE parcel_id = ${id} RETURNING id`;
        await sql`DELETE FROM parcels WHERE id = ${id}`;
        return res.status(200).json({ ok: true, properties_deleted: children.length });
      }

      default:
        res.setHeader('Allow', 'GET, POST, PUT, DELETE');
        return res.status(405).json({ error: 'Method not allowed' });
    }
  } catch (err) {
    console.error('[api/parcels]', err);
    return res.status(500).json({ error: err.message });
  }
}
