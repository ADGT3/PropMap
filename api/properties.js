/**
 * api/properties.js
 * Properties CRUD — the permanent identity of a piece of land.
 * New in V75.
 *
 * GET    /api/properties                        -> list (lightweight fields)
 * GET    /api/properties?id=X                   -> single property, full detail
 * GET    /api/properties?dedup_lotdp=1&q=STR    -> find existing property by lot/DP match
 * GET    /api/properties?by_domain_listing=ID   -> single property keyed by domain_listing_id (V76.5)
 * GET    /api/properties?search=STR             -> search by address/suburb/lot-DP (V76.5)
 * POST   /api/properties                        -> create property; id auto-generated if not supplied (V76.5)
 * PUT    /api/properties                        -> update property (requires id in body)
 * DELETE /api/properties?id=X                   -> delete (cascades to deals + entity_contacts)
 * POST   /api/properties  { action: 'set_not_suitable', id, until, reason }
 * POST   /api/properties  { action: 'clear_not_suitable', id }
 * POST   /api/properties  { action: 'link_listing', property_id, domain_listing_id, listing_url } (V76.5)
 * POST   /api/properties  { action: 'unlink_listing', property_id }                              (V76.5)
 */

import { neon } from '@neondatabase/serverless';
import { requireSession } from '../lib/auth.js';
import { getDatabaseUrl } from '../lib/db.js';
const sql = neon(getDatabaseUrl());

// V76.5: id generator for properties. New format keeps property ids in their
// own keyspace, distinct from listing ids (Domain) and deal ids.
function newPropertyId() {
  return 'prop_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

export default async function handler(req, res) {
  const session = await requireSession(req, res);
  if (!session) return;

  try {
    switch (req.method) {

      case 'GET': {
        const { id, dedup_lotdp, q, by_domain_listing, search } = req.query;

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

        // V76.5: lookup by Domain listing id (returns at most one row, since we
        // enforce one-property-per-listing via unique-ish use, though no DB
        // uniqueness constraint to allow brief overlap during link migration).
        if (by_domain_listing) {
          const rows = await sql`
            SELECT * FROM properties WHERE domain_listing_id = ${String(by_domain_listing)}
            ORDER BY updated_at DESC LIMIT 1`;
          if (!rows.length) return res.status(404).json({ error: 'Not found' });
          return res.status(200).json(rows[0]);
        }

        // V76.5: text search across address/suburb/lot-DP for the
        // CRM "Attach Domain listing" search affordance.
        if (search) {
          const needle = `%${String(search).trim()}%`;
          const rows = await sql`
            SELECT id, address, suburb, lot_dps, domain_listing_id, parcel_id
              FROM properties
             WHERE address ILIKE ${needle}
                OR suburb  ILIKE ${needle}
                OR lot_dps ILIKE ${needle}
             ORDER BY updated_at DESC
             LIMIT 25`;
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

        // V76.5: link / unlink Domain listing to property. Used by the CRM
        // Property modal "Attach Domain listing" affordance. Conflict warning
        // (when the listing is already linked to a different property) is
        // detected client-side via GET ?by_domain_listing= and confirmed
        // before this is called; we accept the request as authoritative.
        if (body.action === 'link_listing') {
          const { property_id, domain_listing_id, listing_url = null } = body;
          if (!property_id || !domain_listing_id) {
            return res.status(400).json({ error: 'property_id and domain_listing_id required' });
          }
          // Clear any other property currently claiming this listing id, so
          // we never leave two properties pointing at the same Domain listing.
          const previousRows = await sql`
            SELECT id FROM properties
             WHERE domain_listing_id = ${String(domain_listing_id)}
               AND id <> ${property_id}`;
          if (previousRows.length) {
            await sql`
              UPDATE properties SET domain_listing_id = NULL, listing_url = NULL, updated_at = now()
               WHERE domain_listing_id = ${String(domain_listing_id)}
                 AND id <> ${property_id}`;
          }
          // Apply the link to the target property
          const rows = await sql`
            UPDATE properties
               SET domain_listing_id = ${String(domain_listing_id)},
                   listing_url       = COALESCE(${listing_url}, listing_url),
                   updated_at        = now()
             WHERE id = ${property_id}
             RETURNING *`;
          if (!rows.length) return res.status(404).json({ error: 'Property not found' });
          return res.status(200).json({
            property: rows[0],
            previous_property_ids: previousRows.map(r => r.id),
          });
        }
        if (body.action === 'unlink_listing') {
          const { property_id } = body;
          if (!property_id) return res.status(400).json({ error: 'property_id required' });
          const rows = await sql`
            UPDATE properties
               SET domain_listing_id = NULL,
                   listing_url       = NULL,
                   updated_at        = now()
             WHERE id = ${property_id}
             RETURNING *`;
          if (!rows.length) return res.status(404).json({ error: 'Not found' });
          return res.status(200).json(rows[0]);
        }

        // Not-suitable setters
        // V76.5.5: data model fix.
        //   - `not_suitable_set_at` records when the flag was applied. NULL
        //     means never screened. Once stamped it survives Reinstate +
        //     re-flagging so the history is preserved.
        //   - `not_suitable_until` is the expiry timestamp. The previous code
        //     nulled this on Reinstate, throwing away the fact that screening
        //     ever happened. Now Reinstate sets it to now() instead — the
        //     row is "no longer actively screened" but its history is intact.
        //   - `not_suitable_reason` is preserved across Reinstate as well
        //     (was previously wiped). Lets users see why they screened it.
        if (body.action === 'set_not_suitable') {
          const { id, until, reason = null } = body;
          if (!id || !until) return res.status(400).json({ error: 'id and until required' });
          const untilVal = until === 'permanent' ? 'infinity' : until;
          const rows = await sql`
            UPDATE properties
               SET not_suitable_set_at = COALESCE(not_suitable_set_at, now()),
                   not_suitable_until  = ${untilVal}::timestamptz,
                   not_suitable_reason = ${reason},
                   updated_at          = now()
             WHERE id = ${id}
             RETURNING id, not_suitable_set_at, not_suitable_until, not_suitable_reason`;
          if (!rows.length) return res.status(404).json({ error: 'Not found' });
          return res.status(200).json(rows[0]);
        }
        if (body.action === 'clear_not_suitable') {
          const { id } = body;
          if (!id) return res.status(400).json({ error: 'id required' });
          const rows = await sql`
            UPDATE properties
               SET not_suitable_until = now(),
                   updated_at         = now()
             WHERE id = ${id}
             RETURNING id`;
          if (!rows.length) return res.status(404).json({ error: 'Not found' });
          return res.status(200).json({ ok: true });
        }

        // Create
        // V75.3: dd column dropped; DD now lives per-deal in deals.data.dd
        // V76.5: id is now optional — auto-generated as prop_* if not supplied.
        const {
          id: bodyId, address = '', suburb = '', lat = null, lng = null,
          lot_dps = '', area_sqm = null, parcels = [], property_count = 1,
          domain_listing_id = null, listing_url = null, agent = null,
        } = body;
        const id = bodyId || newPropertyId();
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
