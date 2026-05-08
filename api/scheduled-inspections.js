/**
 * api/scheduled-inspections.js — V77.1
 *
 * CRUD for scheduled_inspections — the planned/conducted inspection events on a
 * Sales Listing or Lease Listing deal. Powers the Inspection Schedule section
 * (build plan §4.3.1) on those listing deal modals, and is read by the Enquiry
 * timeline to show which inspections an enquirer attended (cross-reference via
 * inspection_attendances).
 *
 * Schema (scheduled_inspections):
 *   id, listing_deal_id (FK→deals), scheduled_date, start_time, end_time,
 *   inspection_type, status, created_by (FK→contacts), created_at, updated_at
 *
 * Routes:
 *   GET    /api/scheduled-inspections?listing_deal_id=X
 *           → all inspections for that listing (newest first)
 *           Returns each row with attendance_count summary (the agent UI
 *           shows "3 attendees" next to each scheduled slot).
 *   GET    /api/scheduled-inspections?id=N
 *           → single inspection (with attendance_count)
 *   POST   /api/scheduled-inspections
 *           Body: { listing_deal_id, scheduled_date, start_time, end_time,
 *                   inspection_type, status? }
 *   PUT    /api/scheduled-inspections
 *           Body: { id, scheduled_date?, start_time?, end_time?, inspection_type?, status? }
 *   DELETE /api/scheduled-inspections?id=N
 *           Cascades to inspection_attendances (FK is ON DELETE CASCADE).
 *           Refuses if any attendances exist — the agent should soft-cancel
 *           via status='cancelled' instead, preserving the attendance audit trail.
 */

import { neon } from '@neondatabase/serverless';
import { requireSession } from '../lib/auth.js';
import { getDatabaseUrl } from '../lib/db.js';
const sql = neon(getDatabaseUrl());

// Inspection types — matches what the agent UI offers in the type dropdown.
// Free-text in DB, but the API validates against this set on POST/PUT to
// catch typos and keep the data clean. Add new values via this array as needs arise.
const INSPECTION_TYPES = new Set([
  'open_home',
  'private',
  'twilight',
  'auction_view',
  'final_walkthrough',
]);

// Status lifecycle for scheduled_inspections
//   planned   — created, hasn't happened yet (default)
//   conducted — happened, attendance can be recorded
//   cancelled — soft-cancelled (won't show in active list but preserves history)
const INSPECTION_STATUSES = new Set(['planned', 'conducted', 'cancelled']);

// Resolve creator id from session — same pattern as notes.js. Fallback admin
// returns NULL (created_by FK has ON DELETE SET NULL so this is fine).
function resolveCreator(session) {
  if (!session) return null;
  const sub = session.sub;
  if (typeof sub === 'number' || (typeof sub === 'string' && /^\d+$/.test(sub))) {
    return parseInt(sub, 10);
  }
  return null;
}

export default async function handler(req, res) {
  const session = await requireSession(req, res);
  if (!session) return;

  try {
    switch (req.method) {

      case 'GET': {
        const { id, listing_deal_id, date } = req.query;
        if (id) {
          const rows = await sql`
            SELECT si.*,
              (SELECT COUNT(*)::int FROM inspection_attendances a
                WHERE a.scheduled_inspection_id = si.id) AS attendance_count
            FROM scheduled_inspections si
            WHERE si.id = ${parseInt(id, 10)}`;
          if (!rows.length) return res.status(404).json({ error: 'Not found' });
          return res.status(200).json(rows[0]);
        }
        if (listing_deal_id) {
          const rows = await sql`
            SELECT si.*,
              (SELECT COUNT(*)::int FROM inspection_attendances a
                WHERE a.scheduled_inspection_id = si.id) AS attendance_count
            FROM scheduled_inspections si
            WHERE si.listing_deal_id = ${listing_deal_id}
            ORDER BY si.scheduled_date DESC, si.start_time DESC`;
          return res.status(200).json(rows);
        }
        // V78 — `?date=today` (or YYYY-MM-DD) returns inspections across all
        // listings for that date. Joins property address through the deal's
        // property/parcel relation so the mobile "Today's inspections" view
        // can show what to check in for. Read-only convenience query.
        if (date) {
          // Resolve `today` server-side so client clock skew doesn't cause off-by-one
          let dateClause;
          if (date === 'today') {
            dateClause = sql`si.scheduled_date = (now() AT TIME ZONE 'Australia/Sydney')::date`;
          } else if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            dateClause = sql`si.scheduled_date = ${date}::date`;
          } else {
            return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD or "today".' });
          }
          const rows = await sql`
            SELECT si.*,
              (SELECT COUNT(*)::int FROM inspection_attendances a
                WHERE a.scheduled_inspection_id = si.id) AS attendance_count,
              COALESCE(p.address, par.name)              AS property_address,
              p.suburb                                   AS property_suburb,
              d.id                                       AS listing_deal_id_resolved
            FROM scheduled_inspections si
            JOIN deals d  ON d.id = si.listing_deal_id
            LEFT JOIN properties p ON p.id  = d.property_id
            LEFT JOIN parcels    par ON par.id = d.parcel_id
            WHERE ${dateClause}
            ORDER BY si.start_time ASC, si.id ASC`;
          return res.status(200).json(rows);
        }
        return res.status(400).json({ error: 'Specify id or listing_deal_id or date' });
      }

      case 'POST': {
        const body = req.body || {};
        const {
          listing_deal_id, scheduled_date, start_time, end_time,
          inspection_type, status = 'planned',
        } = body;
        if (!listing_deal_id || !scheduled_date || !start_time || !end_time || !inspection_type) {
          return res.status(400).json({
            error: 'listing_deal_id, scheduled_date, start_time, end_time, inspection_type required',
          });
        }
        if (!INSPECTION_TYPES.has(inspection_type)) {
          return res.status(400).json({
            error: `Invalid inspection_type '${inspection_type}'. Allowed: ${[...INSPECTION_TYPES].join(', ')}`,
          });
        }
        if (!INSPECTION_STATUSES.has(status)) {
          return res.status(400).json({ error: `Invalid status '${status}'` });
        }
        // Sanity-check end > start
        if (start_time >= end_time) {
          return res.status(400).json({ error: 'end_time must be after start_time' });
        }
        // Verify the deal exists and is on a listing board (Sales Listings / Lease Listings)
        const dealRows = await sql`
          SELECT id, board_id FROM deals WHERE id = ${listing_deal_id}`;
        if (!dealRows.length) return res.status(404).json({ error: 'Listing deal not found' });
        const boardId = dealRows[0].board_id;
        if (boardId !== 'sys_sales_listings' && boardId !== 'sys_lease_listings') {
          return res.status(400).json({
            error: `Deal ${listing_deal_id} is on board '${boardId}', not a listing board. Inspections can only be scheduled on Sales Listings or Lease Listings.`,
          });
        }

        const createdBy = resolveCreator(session);
        const rows = await sql`
          INSERT INTO scheduled_inspections (
            listing_deal_id, scheduled_date, start_time, end_time,
            inspection_type, status, created_by
          )
          VALUES (
            ${listing_deal_id}, ${scheduled_date}, ${start_time}, ${end_time},
            ${inspection_type}, ${status}, ${createdBy}
          )
          RETURNING *`;
        return res.status(201).json({ ...rows[0], attendance_count: 0 });
      }

      case 'PUT': {
        const body = req.body || {};
        const id = body.id;
        if (!id) return res.status(400).json({ error: 'id required' });
        const inspectionId = parseInt(id, 10);

        // Validate any provided fields
        if (body.inspection_type !== undefined && !INSPECTION_TYPES.has(body.inspection_type)) {
          return res.status(400).json({ error: `Invalid inspection_type '${body.inspection_type}'` });
        }
        if (body.status !== undefined && !INSPECTION_STATUSES.has(body.status)) {
          return res.status(400).json({ error: `Invalid status '${body.status}'` });
        }

        // Fetch existing to enforce time-coherence after partial update
        const existing = await sql`SELECT * FROM scheduled_inspections WHERE id = ${inspectionId}`;
        if (!existing.length) return res.status(404).json({ error: 'Not found' });
        const cur = existing[0];

        const nextStart = body.start_time ?? cur.start_time;
        const nextEnd   = body.end_time   ?? cur.end_time;
        if (nextStart >= nextEnd) {
          return res.status(400).json({ error: 'end_time must be after start_time' });
        }

        const rows = await sql`
          UPDATE scheduled_inspections SET
            scheduled_date  = COALESCE(${body.scheduled_date  ?? null}, scheduled_date),
            start_time      = COALESCE(${body.start_time      ?? null}, start_time),
            end_time        = COALESCE(${body.end_time        ?? null}, end_time),
            inspection_type = COALESCE(${body.inspection_type ?? null}, inspection_type),
            status          = COALESCE(${body.status          ?? null}, status),
            updated_at      = now()
          WHERE id = ${inspectionId}
          RETURNING *`;
        // Add attendance_count for response shape consistency
        const count = await sql`
          SELECT COUNT(*)::int AS c FROM inspection_attendances
          WHERE scheduled_inspection_id = ${inspectionId}`;
        return res.status(200).json({ ...rows[0], attendance_count: count[0]?.c ?? 0 });
      }

      case 'DELETE': {
        const { id } = req.query;
        if (!id) return res.status(400).json({ error: 'id required' });
        const inspectionId = parseInt(id, 10);

        // Refuse delete if any attendances exist — agent should set status='cancelled' instead.
        // Preserves the audit trail: who attended what, even if the slot was later cancelled.
        const refs = await sql`
          SELECT COUNT(*)::int AS c FROM inspection_attendances
          WHERE scheduled_inspection_id = ${inspectionId}`;
        if ((refs[0]?.c ?? 0) > 0) {
          return res.status(400).json({
            error: `Inspection has ${refs[0].c} attendance record(s). Set status='cancelled' instead of deleting to preserve history.`,
          });
        }

        const result = await sql`DELETE FROM scheduled_inspections WHERE id = ${inspectionId} RETURNING id`;
        if (!result.length) return res.status(404).json({ error: 'Not found' });
        return res.status(200).json({ ok: true });
      }

      default:
        res.setHeader('Allow', 'GET, POST, PUT, DELETE');
        return res.status(405).json({ error: 'Method not allowed' });
    }
  } catch (err) {
    console.error('[api/scheduled-inspections]', err);
    return res.status(500).json({ error: err.message });
  }
}
