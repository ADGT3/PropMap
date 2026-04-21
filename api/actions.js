/**
 * api/actions.js — V75.7
 *
 * CRUD for Actions (tasks assigned to contacts, optionally linked to a deal).
 *
 *   GET  /api/actions?assignee=me
 *        Lists actions for the current user's own "My Actions" board.
 *        Auto-bootstraps the board + 5 default columns on first access.
 *        Auto-promotes todo/wip rows whose due_date ≤ today to status='due'.
 *        Returns: { board: {..., columns:[...]}, actions: [...] }
 *
 *   GET  /api/actions?deal_id=X
 *        Lists actions linked to a deal (regardless of assignee).
 *        Returns: [...actions]
 *
 *   GET  /api/actions?id=N
 *        Single action (joined with assignee/creator names + deal address).
 *
 *   POST /api/actions
 *        Body: {
 *          description, assignee_id, deal_id?,
 *          effort_value?, effort_unit?, duration_value?, duration_unit?,
 *          due_date?, reminder_date?, status? (default 'todo')
 *        }
 *        creator_id stamped from session.
 *        Places the action on the assignee's My Actions board, in the
 *        column matching status (creates the board if it doesn't exist yet).
 *
 *   PATCH /api/actions?id=N
 *        Body: any subset of the POST fields, plus optional { column_id, column_order }
 *        When column_id changes, the action's `status` is derived from the
 *        column's stage_slug (todo/wip/due/done/void). This is how
 *        drag-and-drop persists.
 *
 *   DELETE /api/actions?id=N
 *
 * Due promotion (server-side):
 *   Performed lazily on every GET. No cron. Rows where status IN ('todo','wip')
 *   AND due_date <= CURRENT_DATE get:
 *     - status='due'
 *     - column_id = the assignee's board's 'due' column (if found)
 *   This means: client sees correct state immediately on load, DB converges.
 */

import { neon } from '@neondatabase/serverless';
import { requireSession } from '../lib/auth.js';
import { getDatabaseUrl } from '../lib/db.js';
const sql = neon(getDatabaseUrl());

// ── Constants ───────────────────────────────────────────────────────────────
const DEFAULT_COLUMNS = [
  { stage_slug: 'todo', name: 'ToDo', color: '#64748b', show_on_map: false, is_terminal: false },
  { stage_slug: 'wip',  name: 'WIP',  color: '#2563eb', show_on_map: false, is_terminal: false },
  { stage_slug: 'due',  name: 'Due',  color: '#dc2626', show_on_map: false, is_terminal: false },
  { stage_slug: 'done', name: 'Done', color: '#16a34a', show_on_map: false, is_terminal: true  },
  { stage_slug: 'void', name: 'Void', color: '#94a3b8', show_on_map: false, is_terminal: true  },
];

// ── Helpers ─────────────────────────────────────────────────────────────────
function resolveSessionUserId(session) {
  // Mirrors notes.js / boards.js pattern. 'fallback' admin has no contacts row.
  if (!session) return null;
  const sub = session.sub;
  if (typeof sub === 'number') return sub;
  if (typeof sub === 'string' && /^\d+$/.test(sub)) return parseInt(sub, 10);
  return null;
}

/**
 * Ensure the given user has a My Actions board. Creates it + 5 default
 * columns on first call, idempotent afterwards. Returns the board row
 * with its columns attached.
 */
async function ensureUserActionsBoard(userId) {
  if (!userId) throw new Error('ensureUserActionsBoard requires a real userId');

  // Look for an existing action-type board owned by this user.
  const existing = await sql`
    SELECT * FROM boards
    WHERE owner_id = ${userId} AND board_type = 'action'
    ORDER BY created_at ASC LIMIT 1`;

  let board;
  if (existing.length) {
    board = existing[0];
  } else {
    const id = `act_${userId}_${Date.now()}`;
    await sql`
      INSERT INTO boards (id, name, owner_id, is_system, sort_order, board_type)
      VALUES (${id}, ${'My Actions'}, ${userId}, FALSE, ${0}, ${'action'})`;
    for (let i = 0; i < DEFAULT_COLUMNS.length; i++) {
      const c = DEFAULT_COLUMNS[i];
      await sql`
        INSERT INTO board_columns
          (id, board_id, name, stage_slug, sort_order, show_on_map, is_terminal, color)
        VALUES
          (${`${id}_col_${c.stage_slug}`}, ${id}, ${c.name}, ${c.stage_slug},
           ${i}, ${c.show_on_map}, ${c.is_terminal}, ${c.color})`;
    }
    board = (await sql`SELECT * FROM boards WHERE id = ${id}`)[0];
  }

  const cols = await sql`
    SELECT * FROM board_columns WHERE board_id = ${board.id} ORDER BY sort_order`;
  return { ...board, columns: cols };
}

/**
 * Server-side due promotion. For a given assignee, flips any todo/wip
 * action whose due_date is today-or-earlier to status='due', moving it
 * to the board's Due column. Returns the count of rows affected.
 */
async function promoteDueActions(assigneeId, board) {
  const dueCol = (board?.columns || []).find(c => c.stage_slug === 'due');
  if (!dueCol) return 0;
  // Single UPDATE; does nothing if no rows match.
  const result = await sql`
    UPDATE actions
       SET status     = 'due',
           column_id  = ${dueCol.id},
           updated_at = now()
     WHERE assignee_id = ${assigneeId}
       AND status IN ('todo', 'wip')
       AND due_date IS NOT NULL
       AND due_date <= CURRENT_DATE
     RETURNING id`;
  return result.length;
}

/**
 * Derive status from the column the action is dropped into. Looks up the
 * column's stage_slug; falls back to 'todo' if it can't be resolved (e.g.
 * user has renamed columns but kept stage_slug).
 */
async function deriveStatusFromColumn(columnId) {
  if (!columnId) return null;
  const rows = await sql`
    SELECT stage_slug FROM board_columns WHERE id = ${columnId} LIMIT 1`;
  if (!rows.length) return null;
  const slug = rows[0].stage_slug;
  if (['todo','wip','due','done','void'].includes(slug)) return slug;
  return null; // unknown slug → leave status unchanged
}

async function getColumnForStatus(boardId, status) {
  const rows = await sql`
    SELECT * FROM board_columns
    WHERE board_id = ${boardId} AND stage_slug = ${status}
    LIMIT 1`;
  return rows[0] || null;
}

/**
 * Enrich a set of action rows with assignee/creator/deal display info.
 */
async function enrichActions(rows) {
  if (!rows.length) return rows;

  const assigneeIds = [...new Set(rows.map(r => r.assignee_id).filter(Boolean))];
  const creatorIds  = [...new Set(rows.map(r => r.creator_id).filter(Boolean))];
  const dealIds     = [...new Set(rows.map(r => r.deal_id).filter(Boolean))];

  const contactIds = [...new Set([...assigneeIds, ...creatorIds])];
  const contactMap = {};
  if (contactIds.length) {
    const crows = await sql`
      SELECT id, first_name, last_name, email FROM contacts
      WHERE id = ANY(${contactIds})`;
    crows.forEach(c => {
      contactMap[c.id] = {
        id: c.id,
        name: `${c.first_name} ${c.last_name}`.trim(),
        email: c.email,
      };
    });
  }

  const dealMap = {};
  if (dealIds.length) {
    const drows = await sql`
      SELECT d.id,
             p.address  AS prop_address,  p.suburb AS prop_suburb,
             pa.name    AS parcel_name
        FROM deals d
        LEFT JOIN properties p  ON p.id  = d.property_id
        LEFT JOIN parcels    pa ON pa.id = d.parcel_id
       WHERE d.id = ANY(${dealIds})`;
    drows.forEach(d => {
      dealMap[d.id] = {
        id: d.id,
        label: d.prop_address || d.parcel_name || d.id,
        suburb: d.prop_suburb || null,
      };
    });
  }

  return rows.map(r => ({
    ...r,
    assignee: contactMap[r.assignee_id] || null,
    creator:  contactMap[r.creator_id]  || null,
    deal:     dealMap[r.deal_id]        || null,
  }));
}

// ── Handler ─────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  const session = await requireSession(req, res);
  if (!session) return;

  try {
    if (req.method === 'GET')    return await handleGet(req, res, session);
    if (req.method === 'POST')   return await handlePost(req, res, session);
    if (req.method === 'PATCH')  return await handlePatch(req, res, session);
    if (req.method === 'DELETE') return await handleDelete(req, res);
    res.setHeader('Allow', 'GET, POST, PATCH, DELETE');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[api/actions]', err);
    return res.status(500).json({ error: err.message });
  }
}

// ── GET ─────────────────────────────────────────────────────────────────────
async function handleGet(req, res, session) {
  const { assignee, deal_id, id } = req.query;

  // Single action
  if (id) {
    const rows = await sql`SELECT * FROM actions WHERE id = ${parseInt(id, 10)}`;
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const enriched = await enrichActions(rows);
    return res.status(200).json(enriched[0]);
  }

  // Actions linked to a specific deal
  if (deal_id) {
    const rows = await sql`
      SELECT * FROM actions WHERE deal_id = ${String(deal_id)}
      ORDER BY due_date NULLS LAST, created_at DESC`;
    const enriched = await enrichActions(rows);
    return res.status(200).json(enriched);
  }

  // My Actions kanban wall
  if (assignee === 'me') {
    const userId = resolveSessionUserId(session);
    if (!userId) {
      // Fallback admin has no contacts row → empty board
      return res.status(200).json({
        board: null,
        actions: [],
        warning: 'Fallback admin cannot own actions. Create a contacts row with matching email and set can_login=true.',
      });
    }

    const board = await ensureUserActionsBoard(userId);
    // Lazy promote before reading — so the client sees the correct state
    await promoteDueActions(userId, board);

    const rows = await sql`
      SELECT * FROM actions
      WHERE assignee_id = ${userId}
      ORDER BY column_order ASC, created_at ASC`;
    const enriched = await enrichActions(rows);
    return res.status(200).json({ board, actions: enriched });
  }

  return res.status(400).json({ error: 'Specify assignee=me, deal_id, or id' });
}

// ── POST ────────────────────────────────────────────────────────────────────
async function handlePost(req, res, session) {
  const body = req.body || {};
  const {
    description, assignee_id, deal_id,
    effort_value, effort_unit, duration_value, duration_unit,
    due_date, reminder_date, status,
  } = body;

  if (!description || !String(description).trim()) {
    return res.status(400).json({ error: 'description required' });
  }
  if (!assignee_id) {
    return res.status(400).json({ error: 'assignee_id required' });
  }

  const assignee = parseInt(assignee_id, 10);
  if (Number.isNaN(assignee)) return res.status(400).json({ error: 'assignee_id must be integer' });

  // Validate assignee exists as a contact
  const assigneeExists = await sql`SELECT id FROM contacts WHERE id = ${assignee} LIMIT 1`;
  if (!assigneeExists.length) return res.status(400).json({ error: 'assignee_id not found' });

  const creatorId = resolveSessionUserId(session); // nullable for fallback admin

  const finalStatus = (status && ['todo','wip','due','done','void'].includes(status)) ? status : 'todo';

  // Ensure assignee's actions board exists + find the matching column
  const board = await ensureUserActionsBoard(assignee);
  const col   = await getColumnForStatus(board.id, finalStatus);

  // Compute column_order = max existing + 1 in that column
  const maxRow = await sql`
    SELECT COALESCE(MAX(column_order), -1) + 1 AS next
      FROM actions WHERE column_id = ${col?.id || null}`;
  const nextOrder = maxRow[0]?.next ?? 0;

  const rows = await sql`
    INSERT INTO actions (
      description, assignee_id, creator_id, deal_id,
      effort_value, effort_unit, duration_value, duration_unit,
      due_date, reminder_date, status,
      board_id, column_id, column_order
    ) VALUES (
      ${String(description).trim()},
      ${assignee},
      ${creatorId},
      ${deal_id ? String(deal_id) : null},
      ${effort_value != null && effort_value !== '' ? Number(effort_value) : null},
      ${effort_unit || null},
      ${duration_value != null && duration_value !== '' ? Number(duration_value) : null},
      ${duration_unit || null},
      ${due_date || null},
      ${reminder_date || null},
      ${finalStatus},
      ${board.id},
      ${col?.id || null},
      ${nextOrder}
    )
    RETURNING *`;

  const enriched = await enrichActions(rows);
  return res.status(201).json(enriched[0]);
}

// ── PATCH ───────────────────────────────────────────────────────────────────
async function handlePatch(req, res, session) {
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'id required' });
  const actionId = parseInt(id, 10);
  if (Number.isNaN(actionId)) return res.status(400).json({ error: 'id must be integer' });

  const current = await sql`SELECT * FROM actions WHERE id = ${actionId} LIMIT 1`;
  if (!current.length) return res.status(404).json({ error: 'Not found' });
  const row = current[0];

  const body = req.body || {};

  // If column_id is being changed, derive status from the new column
  let newStatus = body.status !== undefined ? body.status : undefined;
  if (body.column_id !== undefined) {
    const derived = await deriveStatusFromColumn(body.column_id);
    if (derived) newStatus = derived;
  }
  // Validate status if explicitly passed
  if (newStatus !== undefined && !['todo','wip','due','done','void'].includes(newStatus)) {
    return res.status(400).json({ error: 'invalid status' });
  }

  // Validate assignee if changed
  let newAssignee = body.assignee_id !== undefined ? parseInt(body.assignee_id, 10) : undefined;
  if (newAssignee !== undefined) {
    if (Number.isNaN(newAssignee)) return res.status(400).json({ error: 'assignee_id must be integer' });
    const exists = await sql`SELECT id FROM contacts WHERE id = ${newAssignee} LIMIT 1`;
    if (!exists.length) return res.status(400).json({ error: 'assignee_id not found' });

    // If assignee changes, we need to move the action to the NEW assignee's
    // actions board, not keep it on the old one.
    if (newAssignee !== row.assignee_id) {
      const newBoard = await ensureUserActionsBoard(newAssignee);
      const statusForNewCol = newStatus || row.status;
      const col = await getColumnForStatus(newBoard.id, statusForNewCol);
      // We have to update board_id and column_id alongside assignee_id.
      // Do that now as a single UPDATE that also covers other changed fields.
      body._forceBoardId  = newBoard.id;
      body._forceColumnId = col?.id || null;
    }
  }

  // Build the UPDATE — field-by-field so untouched columns stay put.
  // Using COALESCE-style individual statements would be cleaner with Postgres,
  // but Neon's tagged-template SQL requires each value inline. Simpler:
  // fetch current row above, overlay with body, UPDATE all columns.
  const merged = {
    description:    body.description    !== undefined ? String(body.description).trim() : row.description,
    assignee_id:    newAssignee         !== undefined ? newAssignee                     : row.assignee_id,
    deal_id:        body.deal_id        !== undefined ? (body.deal_id ? String(body.deal_id) : null) : row.deal_id,
    effort_value:   body.effort_value   !== undefined ? (body.effort_value   === '' || body.effort_value   == null ? null : Number(body.effort_value))   : row.effort_value,
    effort_unit:    body.effort_unit    !== undefined ? (body.effort_unit    || null) : row.effort_unit,
    duration_value: body.duration_value !== undefined ? (body.duration_value === '' || body.duration_value == null ? null : Number(body.duration_value)) : row.duration_value,
    duration_unit:  body.duration_unit  !== undefined ? (body.duration_unit  || null) : row.duration_unit,
    due_date:       body.due_date       !== undefined ? (body.due_date       || null) : row.due_date,
    reminder_date:  body.reminder_date  !== undefined ? (body.reminder_date  || null) : row.reminder_date,
    status:         newStatus           !== undefined ? newStatus            : row.status,
    board_id:       body._forceBoardId  !== undefined ? body._forceBoardId   : row.board_id,
    column_id:      body._forceColumnId !== undefined ? body._forceColumnId
                     : (body.column_id  !== undefined ? body.column_id       : row.column_id),
    column_order:   body.column_order   !== undefined ? Number(body.column_order)      : row.column_order,
  };

  const updated = await sql`
    UPDATE actions SET
      description    = ${merged.description},
      assignee_id    = ${merged.assignee_id},
      deal_id        = ${merged.deal_id},
      effort_value   = ${merged.effort_value},
      effort_unit    = ${merged.effort_unit},
      duration_value = ${merged.duration_value},
      duration_unit  = ${merged.duration_unit},
      due_date       = ${merged.due_date},
      reminder_date  = ${merged.reminder_date},
      status         = ${merged.status},
      board_id       = ${merged.board_id},
      column_id      = ${merged.column_id},
      column_order   = ${merged.column_order},
      updated_at     = now()
    WHERE id = ${actionId}
    RETURNING *`;

  const enriched = await enrichActions(updated);
  return res.status(200).json(enriched[0]);
}

// ── DELETE ──────────────────────────────────────────────────────────────────
async function handleDelete(req, res) {
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'id required' });
  const actionId = parseInt(id, 10);
  if (Number.isNaN(actionId)) return res.status(400).json({ error: 'id must be integer' });

  await sql`DELETE FROM actions WHERE id = ${actionId}`;
  return res.status(200).json({ ok: true });
}
