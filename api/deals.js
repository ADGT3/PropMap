/**
 * api/deals.js
 * Deals CRUD — Kanban cards, workflow-scoped. New in V75.
 *
 * GET    /api/deals                                       -> all deals (lightweight)
 * GET    /api/deals?id=X                                  -> single deal, with property joined
 * GET    /api/deals?workflow=acquisition&status=active    -> filtered
 * GET    /api/deals?property_id=X                         -> all deals on a property
 * POST   /api/deals                                       -> create deal
 * PUT    /api/deals                                       -> update deal
 * DELETE /api/deals?id=X                                  -> delete deal
 * POST   /api/deals { action:'close',  id, status }       -> close (status='won'|'lost'|'archived')
 * POST   /api/deals { action:'reopen', id }               -> reopen closed deal
 * POST   /api/deals { action:'new_on_property', property_id, workflow, stage, seed_financials_from? }
 */

import { neon } from '@neondatabase/serverless';
import { requireSession } from '../lib/auth.js';
import { getDatabaseUrl } from '../lib/db.js';
const sql = neon(getDatabaseUrl());

function newDealId() {
  // Compact URL-safe id; collision-resistant enough for our scale
  return 'deal-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
}

export default async function handler(req, res) {
  const session = await requireSession(req, res);
  if (!session) return;

  try {
    switch (req.method) {

      case 'GET': {
        const { id, workflow, status, property_id, parcel_id, board_id, search } = req.query;

        // V75.4: deals can be on a property or a parcel.
        // We join both and let the frontend pick which to use based on whether
        // parcel_id or property_id is set on the deal row.
        // For parcel-scoped deals we also expand the list of properties in that parcel.

        async function fetchAndExpand(rows) {
          if (!rows.length) return rows;
          // Collect parcel ids used by any of these deals and fetch their properties
          const parcelIds = [...new Set(rows.filter(r => r.parcel_id).map(r => r.parcel_id))];
          let parcelPropsByParcel = {};
          if (parcelIds.length) {
            const pRows = await sql`
              SELECT * FROM properties WHERE parcel_id = ANY(${parcelIds}) ORDER BY address`;
            pRows.forEach(p => {
              (parcelPropsByParcel[p.parcel_id] ||= []).push(p);
            });
          }
          // V75.7: due-action flag — which deals have at least one action
          // currently in status='due' (or overdue todo/wip). Single query,
          // reused across all returned deals.
          // V76.4.2: due_action_count is the broad "needs attention today"
          // count — drives the bell badge (header + per-card pill). Includes
          // due_date AND reminder_date today-or-earlier.
          // V76.4.3: has_overdue_action is the narrower "overdue" flag —
          // drives the red left-border attention bar on cards. Same rule as
          // the action card's _isOverdue() (status active, due_date today-or-
          // earlier). Reminders DO NOT trigger the bar.
          const dealIds = rows.map(r => r.id);
          const dueCounts = new Map();    // deal_id → broad count (badge)
          const overdueSet = new Set();   // deal_id → has narrow overdue (bar)
          if (dealIds.length) {
            try {
              const dueRows = await sql`
                SELECT deal_id, COUNT(*)::int AS n
                  FROM actions
                 WHERE deal_id = ANY(${dealIds})
                   AND status NOT IN ('done','void')
                   AND (
                     status = 'due'
                     OR (due_date      IS NOT NULL AND due_date      <= CURRENT_DATE)
                     OR (reminder_date IS NOT NULL AND reminder_date <= CURRENT_DATE)
                   )
                 GROUP BY deal_id`;
              dueRows.forEach(r => { if (r.deal_id) dueCounts.set(r.deal_id, r.n); });

              // Narrow "overdue" — same rule as _isOverdue() in kanban.js
              const overdueRows = await sql`
                SELECT DISTINCT deal_id
                  FROM actions
                 WHERE deal_id = ANY(${dealIds})
                   AND status IN ('todo','wip','due')
                   AND due_date IS NOT NULL
                   AND due_date <= CURRENT_DATE`;
              overdueRows.forEach(r => { if (r.deal_id) overdueSet.add(r.deal_id); });
            } catch (err) {
              // Actions table may not exist on an older DB — fail soft so
              // the deals list still loads.
              if (!/relation .* does not exist/i.test(err.message)) throw err;
            }
          }
          return rows.map(r => ({
            ...r,
            parcel_properties:  r.parcel_id ? (parcelPropsByParcel[r.parcel_id] || []) : null,
            due_action_count:   dueCounts.get(r.id) || 0,
            has_due_action:     dueCounts.has(r.id),
            has_overdue_action: overdueSet.has(r.id),
          }));
        }

        if (id) {
          const dealRows = await sql`
            SELECT d.*,
              row_to_json(p.*)  AS property,
              row_to_json(pa.*) AS parcel
            FROM deals d
            LEFT JOIN properties p  ON p.id  = d.property_id
            LEFT JOIN parcels    pa ON pa.id = d.parcel_id
            WHERE d.id = ${id}`;
          if (!dealRows.length) return res.status(404).json({ error: 'Not found' });
          const expanded = await fetchAndExpand(dealRows);
          return res.status(200).json(expanded[0]);
        }

        // V76.2.1: search — matches deal id, property address, or parcel name.
        // Returns max 20 rows, most-recently-updated first.
        if (search) {
          const q = `%${String(search).trim()}%`;
          const rows = await sql`
            SELECT d.*,
              row_to_json(p.*)  AS property,
              row_to_json(pa.*) AS parcel
            FROM deals d
            LEFT JOIN properties p  ON p.id  = d.property_id
            LEFT JOIN parcels    pa ON pa.id = d.parcel_id
            WHERE d.id ILIKE ${q}
               OR p.address ILIKE ${q}
               OR p.suburb  ILIKE ${q}
               OR pa.name   ILIKE ${q}
            ORDER BY d.updated_at DESC
            LIMIT 20`;
          return res.status(200).json(await fetchAndExpand(rows));
        }

        // Filtered lists
        if (parcel_id) {
          const rows = await sql`
            SELECT d.*,
              row_to_json(p.*)  AS property,
              row_to_json(pa.*) AS parcel
            FROM deals d
            LEFT JOIN properties p  ON p.id  = d.property_id
            LEFT JOIN parcels    pa ON pa.id = d.parcel_id
            WHERE d.parcel_id = ${parcel_id}
            ORDER BY d.opened_at DESC`;
          return res.status(200).json(await fetchAndExpand(rows));
        }
        if (property_id) {
          const rows = await sql`
            SELECT d.*,
              row_to_json(p.*)  AS property,
              row_to_json(pa.*) AS parcel
            FROM deals d
            LEFT JOIN properties p  ON p.id  = d.property_id
            LEFT JOIN parcels    pa ON pa.id = d.parcel_id
            WHERE d.property_id = ${property_id}
            ORDER BY d.opened_at DESC`;
          return res.status(200).json(await fetchAndExpand(rows));
        }

        if (board_id) {
          const rows = await sql`
            SELECT d.*,
              row_to_json(p.*)  AS property,
              row_to_json(pa.*) AS parcel
            FROM deals d
            LEFT JOIN properties p  ON p.id  = d.property_id
            LEFT JOIN parcels    pa ON pa.id = d.parcel_id
            WHERE d.board_id = ${board_id}
            ORDER BY d.updated_at DESC`;
          return res.status(200).json(await fetchAndExpand(rows));
        }

        if (workflow && status) {
          const rows = await sql`
            SELECT d.*,
              row_to_json(p.*)  AS property,
              row_to_json(pa.*) AS parcel
            FROM deals d
            LEFT JOIN properties p  ON p.id  = d.property_id
            LEFT JOIN parcels    pa ON pa.id = d.parcel_id
            WHERE d.workflow = ${workflow} AND d.status = ${status}
            ORDER BY d.updated_at DESC`;
          return res.status(200).json(await fetchAndExpand(rows));
        }
        if (workflow) {
          const rows = await sql`
            SELECT d.*,
              row_to_json(p.*)  AS property,
              row_to_json(pa.*) AS parcel
            FROM deals d
            LEFT JOIN properties p  ON p.id  = d.property_id
            LEFT JOIN parcels    pa ON pa.id = d.parcel_id
            WHERE d.workflow = ${workflow}
            ORDER BY d.updated_at DESC`;
          return res.status(200).json(await fetchAndExpand(rows));
        }

        // Unfiltered full list
        const rows = await sql`
          SELECT d.*,
            row_to_json(p.*)  AS property,
            row_to_json(pa.*) AS parcel
          FROM deals d
          LEFT JOIN properties p  ON p.id  = d.property_id
          LEFT JOIN parcels    pa ON pa.id = d.parcel_id
          ORDER BY d.updated_at DESC`;
        return res.status(200).json(await fetchAndExpand(rows));
      }

      case 'POST': {
        const body = req.body || {};

        // Close / reopen actions
        if (body.action === 'close') {
          const { id, status = 'lost' } = body;
          if (!id) return res.status(400).json({ error: 'id required' });
          const rows = await sql`
            UPDATE deals SET status = ${status}, closed_at = now(), updated_at = now()
            WHERE id = ${id}
            RETURNING *`;
          if (!rows.length) return res.status(404).json({ error: 'Not found' });
          return res.status(200).json(rows[0]);
        }
        if (body.action === 'reopen') {
          const { id } = body;
          if (!id) return res.status(400).json({ error: 'id required' });
          const rows = await sql`
            UPDATE deals SET status='active', closed_at=NULL, updated_at=now()
            WHERE id = ${id} RETURNING *`;
          if (!rows.length) return res.status(404).json({ error: 'Not found' });
          return res.status(200).json(rows[0]);
        }

        // Start a new deal on an existing property OR parcel, optionally seeding financials
        if (body.action === 'new_on_property' || body.action === 'new_on_parcel') {
          const {
            property_id  = null,
            parcel_id    = null,
            workflow     = 'acquisition',
            stage        = 'shortlisted',
            board_id,                  // optional — derived from workflow if absent
            column_id,                 // optional — derived from board_id+stage if absent
            data         = {},
            seed_financials_from, // optional deal_id to seed from
          } = body;
          if (!property_id && !parcel_id)  return res.status(400).json({ error: 'property_id or parcel_id required' });
          if ( property_id &&  parcel_id)  return res.status(400).json({ error: 'specify exactly one of property_id or parcel_id' });

          // Verify target exists
          if (property_id) {
            const pRows = await sql`SELECT id FROM properties WHERE id = ${property_id}`;
            if (!pRows.length) return res.status(404).json({ error: 'Property not found' });
          } else {
            const pRows = await sql`SELECT id FROM parcels WHERE id = ${parcel_id}`;
            if (!pRows.length) return res.status(404).json({ error: 'Parcel not found' });
          }

          // V75.6: auto-derive board_id + column_id from workflow+stage for
          // legacy callers. The system boards are seeded as sys_{workflow}
          // with columns sys_{workflow}_{stage}.
          const boardIdFinal  = board_id  || `sys_${workflow}`;
          const columnIdFinal = column_id || `${boardIdFinal}_${stage}`;

          const id = newDealId();
          const dataJson = JSON.stringify({ addedAt: Date.now(), ...data });

          const dealRows = await sql`
            INSERT INTO deals (id, property_id, parcel_id, workflow, stage, status, data, board_id, column_id)
            VALUES (${id}, ${property_id}, ${parcel_id}, ${workflow}, ${stage}, 'active', ${dataJson}::jsonb,
                    ${boardIdFinal}, ${columnIdFinal})
            RETURNING *`;

          // Seed financials — find most recent prior deal's financial record if not specified
          let seedFrom = seed_financials_from || null;
          if (!seedFrom && property_id) {
            const prior = await sql`
              SELECT d.id FROM deals d
              JOIN property_financials pf ON pf.deal_id = d.id
              WHERE d.property_id = ${property_id} AND d.id <> ${id}
              ORDER BY d.opened_at DESC LIMIT 1`;
            if (prior.length) seedFrom = prior[0].id;
          }
          // For parcel deals, look for prior parcel-scoped financials
          if (!seedFrom && parcel_id) {
            const prior = await sql`
              SELECT d.id FROM deals d
              JOIN property_financials pf ON pf.deal_id = d.id
              WHERE d.parcel_id = ${parcel_id} AND d.id <> ${id}
              ORDER BY d.opened_at DESC LIMIT 1`;
            if (prior.length) seedFrom = prior[0].id;
          }
          let financialsSeeded = false;
          if (seedFrom) {
            const src = await sql`SELECT data FROM property_financials WHERE deal_id = ${seedFrom} LIMIT 1`;
            if (src.length) {
              const dataJson2 = JSON.stringify(src[0].data);
              await sql`
                INSERT INTO property_financials (pipeline_id, deal_id, data, updated_at)
                VALUES (${id}, ${id}, ${dataJson2}::jsonb, now())
                ON CONFLICT (pipeline_id) DO NOTHING`;
              financialsSeeded = true;
            }
          }

          return res.status(201).json({ ...dealRows[0], financials_seeded: financialsSeeded, seed_from: seedFrom });
        }

        // Plain create
        const {
          id = newDealId(),
          property_id = null,
          parcel_id   = null,
          workflow = 'acquisition',
          stage    = 'shortlisted',
          status   = 'active',
          board_id,
          column_id,
          data     = {},
        } = body;
        if (!property_id && !parcel_id) return res.status(400).json({ error: 'property_id or parcel_id required' });
        if ( property_id &&  parcel_id) return res.status(400).json({ error: 'specify exactly one of property_id or parcel_id' });
        const dataJson = JSON.stringify({ addedAt: Date.now(), ...data });
        // V75.6: derive board_id/column_id from workflow+stage if not supplied
        const boardIdFinal2  = board_id  || `sys_${workflow}`;
        const columnIdFinal2 = column_id || `${boardIdFinal2}_${stage}`;
        const rows = await sql`
          INSERT INTO deals (id, property_id, parcel_id, workflow, stage, status, data, board_id, column_id)
          VALUES (${id}, ${property_id}, ${parcel_id}, ${workflow}, ${stage}, ${status}, ${dataJson}::jsonb,
                  ${boardIdFinal2}, ${columnIdFinal2})
          ON CONFLICT (id) DO NOTHING
          RETURNING *`;
        if (!rows.length) {
          const existing = await sql`SELECT * FROM deals WHERE id = ${id}`;
          return res.status(200).json(existing[0]);
        }
        return res.status(201).json(rows[0]);
      }

      case 'PUT': {
        const body = req.body || {};
        const { id, stage, status, data, board_id, column_id } = body;
        if (!id) return res.status(400).json({ error: 'id required' });
        const dataJson = data !== undefined ? JSON.stringify(data) : null;
        const rows = await sql`
          UPDATE deals SET
            stage      = COALESCE(${stage    ?? null}, stage),
            status     = COALESCE(${status   ?? null}, status),
            data       = COALESCE(${dataJson}::jsonb, data),
            board_id   = COALESCE(${board_id ?? null}, board_id),
            column_id  = COALESCE(${column_id?? null}, column_id),
            updated_at = now()
          WHERE id = ${id}
          RETURNING *`;
        if (!rows.length) return res.status(404).json({ error: 'Not found' });
        return res.status(200).json(rows[0]);
      }

      case 'DELETE': {
        const { id } = req.query;
        if (!id) return res.status(400).json({ error: 'id required' });

        // V75.4d: before deleting the deal, check if it's on a parcel.
        // If so, and that parcel has no OTHER deals, the parcel will be
        // orphaned — so we clean it up too (which cascades to its child
        // properties via FK). A parcel that has other deals stays.
        const dealBefore = (await sql`SELECT parcel_id FROM deals WHERE id = ${id}`)[0];
        const parcelId = dealBefore?.parcel_id || null;

        await sql`DELETE FROM deals WHERE id = ${id}`;

        let parcelDeleted = false;
        let propertiesDeleted = 0;
        if (parcelId) {
          const otherDeals = await sql`SELECT 1 FROM deals WHERE parcel_id = ${parcelId} LIMIT 1`;
          if (otherDeals.length === 0) {
            // Before deleting the parcel, explicitly delete its child properties.
            // The `properties.parcel_id` FK uses ON DELETE SET NULL (not CASCADE),
            // so deleting the parcel alone would leave the children orphaned.
            const children = await sql`DELETE FROM properties WHERE parcel_id = ${parcelId} RETURNING id`;
            propertiesDeleted = children.length;
            await sql`DELETE FROM parcels WHERE id = ${parcelId}`;
            parcelDeleted = true;
          }
        }
        return res.status(200).json({
          ok: true,
          parcel_deleted: parcelDeleted,
          properties_deleted: propertiesDeleted,
        });
      }

      default:
        res.setHeader('Allow', 'GET, POST, PUT, DELETE');
        return res.status(405).json({ error: 'Method not allowed' });
    }
  } catch (err) {
    console.error('[deals API]', err);
    return res.status(500).json({ error: err.message });
  }
}
