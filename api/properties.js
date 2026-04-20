/**
 * api/properties.js
 * Properties CRUD — the permanent identity of a piece of land.
 * New in V75.
 *
 * GET    /api/properties                        -> list (lightweight fields)
 * GET    /api/properties?id=X                   -> single property, full detail
 * GET    /api/properties?dedup_lotdp=1&q=STR    -> find existing property by lot/DP match
 * POST   /api/properties                        -> create property
 * PUT    /api/properties                        -> update property (requires id in body)
 * DELETE /api/properties?id=X                   -> delete (cascades to deals + entity_contacts)
 * POST   /api/properties  { action: 'set_not_suitable', id, until, reason }
 * POST   /api/properties  { action: 'clear_not_suitable', id }
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
        const { id, dedup_lotdp, q } = req.query;

        // Dedup lookup by Lot/DP
        if (dedup_lotdp) {
          if (!q?.trim()) return res.status(400).json({ error: 'q (lot/DP string) required' });
          const needle = `%${q.trim().toUpperCase()}%`;
          const rows = await sql`
            SELECT id, address, suburb, lot_dps FROM properties
            WHERE lot_dps ILIKE ${needle}
            ORDER BY updated_at DESC LIMIT 10`;
          return res.status(200).json(rows);
        }

        // Single property
        if (id) {
          const rows = await sql`SELECT * FROM properties WHERE id = ${id}`;
          if (!rows.length) return res.status(404).json({ error: 'Not found' });
          return res.status(200).json(rows[0]);
        }

        // List all — used by kanban bootstrap
        // V75.3: dd column dropped; DD now lives per-deal in deals.data.dd
        // V75.4: parcel_id added for parcel membership
        // V75.4c: state_prop_id (nullable) for NSW propid cross-reference
        const rows = await sql`
          SELECT id, address, suburb, lat, lng, lot_dps, area_sqm,
                 parcels, property_count, domain_listing_id, listing_url,
                 agent, not_suitable_until, not_suitable_reason,
                 parcel_id, state_prop_id, updated_at
          FROM properties ORDER BY updated_at DESC`;
        return res.status(200).json(rows);
      }

      case 'POST': {
        const body = req.body || {};

        // Not-suitable setters
        if (body.action === 'set_not_suitable') {
          const { id, until, reason = null } = body;
          if (!id || !until) return res.status(400).json({ error: 'id and until required' });
          const untilVal = until === 'permanent' ? 'infinity' : until;
          const rows = await sql`
            UPDATE properties
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
          const rows = await sql`
            UPDATE properties SET not_suitable_until=NULL, not_suitable_reason=NULL, updated_at=now()
            WHERE id=${id}
            RETURNING id`;
          if (!rows.length) return res.status(404).json({ error: 'Not found' });
          return res.status(200).json({ ok: true });
        }

        // Create
        // V75.3: dd column dropped; DD now lives per-deal in deals.data.dd
        const {
          id, address = '', suburb = '', lat = null, lng = null,
          lot_dps = '', area_sqm = null, parcels = [], property_count = 1,
          domain_listing_id = null, listing_url = null, agent = null,
        } = body;
        if (!id) return res.status(400).json({ error: 'id required' });
        const parcelsJson = JSON.stringify(parcels);
        const agentJson   = agent ? JSON.stringify(agent) : null;
        const rows = await sql`
          INSERT INTO properties (
            id, address, suburb, lat, lng, lot_dps, area_sqm,
            parcels, property_count, domain_listing_id, listing_url, agent
          ) VALUES (
            ${id}, ${address}, ${suburb}, ${lat}, ${lng},
            ${String(lot_dps).toUpperCase()}, ${area_sqm},
            ${parcelsJson}::jsonb, ${property_count},
            ${domain_listing_id}, ${listing_url},
            ${agentJson}::jsonb
          )
          ON CONFLICT (id) DO NOTHING
          RETURNING *`;
        if (!rows.length) {
          const existing = await sql`SELECT * FROM properties WHERE id = ${id}`;
          return res.status(200).json(existing[0]);
        }
        return res.status(201).json(rows[0]);
      }

      case 'PUT': {
        const body = req.body || {};
        const { id } = body;
        if (!id) return res.status(400).json({ error: 'id required' });

        // Only update provided fields — COALESCE pattern. Agent is handled
        // separately because NULL and "unchanged" need to be distinguishable,
        // and nesting sql`` fragments inside a parent sql`` template is not
        // supported by the Neon tagged-template driver.
        // V75.3: dd column dropped; DD updates go via /api/deals with data.dd
        const parcelsJson = body.parcels !== undefined ? JSON.stringify(body.parcels) : null;

        const rows = await sql`
          UPDATE properties SET
            address            = COALESCE(${body.address        ?? null}, address),
            suburb             = COALESCE(${body.suburb         ?? null}, suburb),
            lat                = COALESCE(${body.lat            ?? null}, lat),
            lng                = COALESCE(${body.lng            ?? null}, lng),
            lot_dps            = COALESCE(${body.lot_dps ? String(body.lot_dps).toUpperCase() : null}, lot_dps),
            area_sqm           = COALESCE(${body.area_sqm       ?? null}, area_sqm),
            parcels            = COALESCE(${parcelsJson}::jsonb, parcels),
            property_count     = COALESCE(${body.property_count ?? null}, property_count),
            domain_listing_id  = COALESCE(${body.domain_listing_id ?? null}, domain_listing_id),
            listing_url        = COALESCE(${body.listing_url    ?? null}, listing_url),
            state_prop_id      = COALESCE(${body.state_prop_id  ?? null}, state_prop_id),
            updated_at         = now()
          WHERE id = ${id}
          RETURNING *`;
        if (!rows.length) return res.status(404).json({ error: 'Not found' });

        // Separate agent update — distinguishes "omit to leave unchanged"
        // from "explicitly clear to null"
        if (body.agent !== undefined) {
          const agentJson = body.agent ? JSON.stringify(body.agent) : null;
          if (agentJson === null) {
            await sql`UPDATE properties SET agent = NULL, updated_at = now() WHERE id = ${id}`;
            rows[0].agent = null;
          } else {
            const updated = await sql`UPDATE properties SET agent = ${agentJson}::jsonb, updated_at = now() WHERE id = ${id} RETURNING agent`;
            rows[0].agent = updated[0].agent;
          }
        }

        return res.status(200).json(rows[0]);
      }

      case 'DELETE': {
        const { id } = req.query;
        if (!id) return res.status(400).json({ error: 'id required' });
        await sql`DELETE FROM properties WHERE id = ${id}`;
        return res.status(200).json({ ok: true });
      }

      default:
        res.setHeader('Allow', 'GET, POST, PUT, DELETE');
        return res.status(405).json({ error: 'Method not allowed' });
    }
  } catch (err) {
    console.error('[properties API]', err);
    return res.status(500).json({ error: err.message });
  }
}
