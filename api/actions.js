/**
 * api/actions.js — V80
 *
 * Multi-assignee Actions. An Action can have one or more assignees; the
 * shared status lives on `actions`, while each assignee's column placement
 * lives on `action_assignees(action_id, contact_id, column_id, column_order)`.
 *
 * When any assignee drags the card to a new column on their board:
 *   - That assignee's action_assignees.column_id + column_order update
 *   - The action's shared status (derived from new column's stage_slug)
 *     propagates to every other assignee, who on next refresh sees their
 *     own card in their own board's matching-stage column
 *
 * When status changes via direct PATCH (not column drag), every assignee's
 * column_id is realigned to their board's matching-stage column.
 *
 *   GET  /api/actions?assignee=me                  → My Actions board for current user
 *   GET  /api/actions?count=due                    → due count for current user (badge)
 *   GET  /api/actions?deal_id=X                    → all actions linked to a deal
 *   GET  /api/actions?contact_id=N                 → V80: actions where contact_id is an assignee
 *   GET  /api/actions?id=N                         → single action with all assignees
 *
 *   POST /api/actions
 *     Body: {
 *       description (required),
 *       assignee_ids: [N, M, ...]  (V80; array of contact ids),
 *       OR assignee_id: N          (legacy; converted to single-element array),
 *       deal_id?, effort_days?, duration_days?, due_date?, reminder_date?, status?
 *     }
 *
 *   PATCH /api/actions?id=N
 *     Body: any subset of POST fields, plus:
 *       column_id?    (interpreted as the dragger's own board column)
 *       column_order? (interpreted as personalised order for the dragger)
 *     If column_id is present, the dragger is the session user; we update
 *     their action_assignees row + recalculate shared status from column slug.
 *     If status is changed directly, every assignee's column_id is realigned.
 *
 *   DELETE /api/actions?id=N
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
const VALID_STATUSES = ['todo', 'wip', 'due', 'done', 'void'];

// ── Helpers ─────────────────────────────────────────────────────────────────
function resolveSessionUserId(session) {
  if (!session) return null;
  const sub = session.sub;
  if (typeof sub === 'number') return sub;
  if (typeof sub === 'string' && /^\d+$/.test(sub)) return parseInt(sub, 10);
  return null;
}

/**
 * Ensure the given user has a My Actions board. Creates board + 5 default
 * columns on first call. Idempotent. Returns the board with columns attached.
 */
async function ensureUserActionsBoard(userId) {
  if (!userId) throw new Error('ensureUserActionsBoard requires a real userId');

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

async function getColumnForStatus(boardId, status) {
  const rows = await sql`
    SELECT * FROM board_columns
    WHERE board_id = ${boardId} AND stage_slug = ${status}
    LIMIT 1`;
  return rows[0] || null;
}

/**
 * Resolve column-id on a specific user's My Actions board for a given status.
 * Helper used when realigning all assignees after a shared status change.
 */
async function resolveColumnForUser(userId, status) {
  const board = await ensureUserActionsBoard(userId);
  const col = await getColumnForStatus(board.id, status);
  return col?.id || null;
}

/**
 * For each (action, this user) row matching due conditions, flip status to
 * 'due' on actions table and align this user's column_id to their Due column.
 * Returns count of rows promoted.
 */
async function promoteDueActions(userId, board) {
  const dueCol = (board?.columns || []).find(c => c.stage_slug === 'due');
  if (!dueCol) return 0;

  // Find candidate action ids — for THIS user
  const candidates = await sql`
    SELECT a.id
      FROM actions a
      JOIN action_assignees aa ON aa.action_id = a.id
     WHERE aa.contact_id = ${userId}
       AND a.status IN ('todo', 'wip')
       AND a.due_date IS NOT NULL
       AND a.due_date <= CURRENT_DATE`;
  if (!candidates.length) return 0;

  const ids = candidates.map(r => r.id);

  // 1) Update shared status on those actions (lazy: only those due for ME
  //    actually flip — other assignees see propagation on their own next read)
  await sql`UPDATE actions SET status = 'due', updated_at = now()
            WHERE id = ANY(${ids})`;

  // 2) Realign every assignee's column_id on these actions to their Due column.
  //    Each assignee may be on a different board, so we have to resolve
  //    per-assignee. Single-batch: fetch all (action_id, contact_id) pairs,
  //    resolve their Due columns, update.
  const pairs = await sql`
    SELECT aa.action_id, aa.contact_id, b.id AS board_id
      FROM action_assignees aa
      JOIN boards b ON b.owner_id = aa.contact_id AND b.board_type = 'action'
     WHERE aa.action_id = ANY(${ids})`;

  const colCache = new Map(); // board_id → due_col_id
  for (const p of pairs) {
    let due = colCache.get(p.board_id);
    if (due === undefined) {
      const col = await sql`
        SELECT id FROM board_columns
         WHERE board_id = ${p.board_id} AND stage_slug = 'due' LIMIT 1`;
      due = col[0]?.id || null;
      colCache.set(p.board_id, due);
    }
    if (due) {
      await sql`
        UPDATE action_assignees
           SET column_id = ${due}
         WHERE action_id = ${p.action_id} AND contact_id = ${p.contact_id}`;
    }
  }

  return ids.length;
}

async function deriveStatusFromColumn(columnId) {
  if (!columnId) return null;
  const rows = await sql`
    SELECT stage_slug FROM board_columns WHERE id = ${columnId} LIMIT 1`;
  if (!rows.length) return null;
  const slug = rows[0].stage_slug;
  return VALID_STATUSES.includes(slug) ? slug : null;
}

/**
 * Realign every assignee's column_id on a given action to their board's
 * column matching the new shared status. Called when status changes for
 * any reason except a single user's drag (which already updates that user's
 * column_id directly).
 */
async function realignAllAssigneesToStatus(actionId, status) {
  if (!VALID_STATUSES.includes(status)) return;
  const pairs = await sql`
    SELECT aa.contact_id, b.id AS board_id
      FROM action_assignees aa
      JOIN boards b ON b.owner_id = aa.contact_id AND b.board_type = 'action'
     WHERE aa.action_id = ${actionId}`;
  for (const p of pairs) {
    const col = await sql`
      SELECT id FROM board_columns
       WHERE board_id = ${p.board_id} AND stage_slug = ${status} LIMIT 1`;
    const colId = col[0]?.id || null;
    await sql`
      UPDATE action_assignees
         SET column_id = ${colId}
       WHERE action_id = ${actionId} AND contact_id = ${p.contact_id}`;
  }
}

/**
 * Enrich rows with assignees array, creator info, deal info, plus per-viewer
 * column placement. The viewer is `viewerId`; if they're an assignee, we
 * include their column_id + column_order at the row level for backward
 * compatibility with kanban renderers.
 */
async function enrichActions(rows, viewerId = null) {
  if (!rows.length) return rows;

  const actionIds  = rows.map(r => r.id);
  const creatorIds = [...new Set(rows.map(r => r.creator_id).filter(Boolean))];
  const dealIds    = [...new Set(rows.map(r => r.deal_id).filter(Boolean))];

  // Fetch all assignees for these actions
  const assigneeRows = await sql`
    SELECT aa.action_id, aa.contact_id, aa.column_id, aa.column_order,
           c.first_name, c.last_name, c.email
      FROM action_assignees aa
      JOIN contacts c ON c.id = aa.contact_id
     WHERE aa.action_id = ANY(${actionIds})`;
  const assigneesByAction = new Map();
  for (const a of assigneeRows) {
    if (!assigneesByAction.has(a.action_id)) assigneesByAction.set(a.action_id, []);
    assigneesByAction.get(a.action_id).push({
      id:           a.contact_id,
      name:         `${a.first_name || ''} ${a.last_name || ''}`.trim(),
      email:        a.email,
      column_id:    a.column_id,
      column_order: a.column_order,
    });
  }

  // Creator names
  const contactMap = {};
  if (creatorIds.length) {
    const crows = await sql`
      SELECT id, first_name, last_name, email FROM contacts
      WHERE id = ANY(${creatorIds})`;
    crows.forEach(c => {
      contactMap[c.id] = {
        id: c.id,
        name: `${c.first_name || ''} ${c.last_name || ''}`.trim(),
        email: c.email,
      };
    });
  }

  // Deal addresses
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

  return rows.map(r => {
    const assignees = assigneesByAction.get(r.id) || [];
    const viewerRow = viewerId ? assignees.find(a => a.id === viewerId) : null;
    return {
      ...r,
      // V80 — primary multi-assignee shape:
      assignees,
      // Per-viewer placement, for kanban renderers that expect it
      column_id:    viewerRow?.column_id    ?? null,
      column_order: viewerRow?.column_order ?? 0,
      // V75-shape compat: first assignee surfaced as `assignee` so legacy UIs
      // still display something sensible
      assignee:     assignees[0] || null,
      creator:      contactMap[r.creator_id] || null,
      deal:         dealMap[r.deal_id]       || null,
    };
  });
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
  const { assignee, deal_id, contact_id, id, count } = req.query;

  // V76.4 / V76.4.2: due-count for the badge.
  if (count === 'due') {
    const userId = resolveSessionUserId(session);
    if (!userId) return res.status(200).json({ count: 0 });
    const rows = await sql`
      SELECT COUNT(*)::int AS n
        FROM actions a
        JOIN action_assignees aa ON aa.action_id = a.id
       WHERE aa.contact_id = ${userId}
         AND a.status NOT IN ('done', 'void')
         AND (
           a.status = 'due'
           OR (a.due_date      IS NOT NULL AND a.due_date      <= CURRENT_DATE)
           OR (a.reminder_date IS NOT NULL AND a.reminder_date <= CURRENT_DATE)
         )`;
    return res.status(200).json({ count: rows[0]?.n || 0 });
  }

  // Single action
  if (id) {
    const rows = await sql`SELECT * FROM actions WHERE id = ${parseInt(id, 10)}`;
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const viewer = resolveSessionUserId(session);
    const enriched = await enrichActions(rows, viewer);
    return res.status(200).json(enriched[0]);
  }

  // Actions linked to a specific deal
  if (deal_id) {
    const rows = await sql`
      SELECT * FROM actions WHERE deal_id = ${String(deal_id)}
      ORDER BY due_date NULLS LAST, created_at DESC`;
    const viewer = resolveSessionUserId(session);
    const enriched = await enrichActions(rows, viewer);
    return res.status(200).json(enriched);
  }

  // V80 — Actions where given contact is an assignee
  if (contact_id) {
    const cid = parseInt(contact_id, 10);
    if (Number.isNaN(cid)) return res.status(400).json({ error: 'contact_id must be integer' });
    const rows = await sql`
      SELECT DISTINCT a.*
        FROM actions a
        JOIN action_assignees aa ON aa.action_id = a.id
       WHERE aa.contact_id = ${cid}
       ORDER BY a.due_date NULLS LAST, a.created_at DESC`;
    const enriched = await enrichActions(rows, cid);
    return res.status(200).json(enriched);
  }

  // My Actions board
  if (assignee === 'me') {
    const userId = resolveSessionUserId(session);
    if (!userId) {
      return res.status(200).json({
        board: null,
        actions: [],
        warning: 'Fallback admin cannot own actions. Create a contacts row with matching email and set can_login=true.',
      });
    }

    const board = await ensureUserActionsBoard(userId);
    await promoteDueActions(userId, board);

    const rows = await sql`
      SELECT a.*
        FROM actions a
        JOIN action_assignees aa ON aa.action_id = a.id
       WHERE aa.contact_id = ${userId}
       ORDER BY aa.column_order ASC, a.created_at ASC`;
    const enriched = await enrichActions(rows, userId);
    return res.status(200).json({ board, actions: enriched });
  }

  return res.status(400).json({ error: 'Specify assignee=me, deal_id, contact_id, or id' });
}

// ── POST ────────────────────────────────────────────────────────────────────
async function handlePost(req, res, session) {
  const body = req.body || {};
  const {
    description, deal_id,
    effort_days, duration_days,
    due_date, reminder_date, status,
  } = body;

  if (!description || !String(description).trim()) {
    return res.status(400).json({ error: 'description required' });
  }

  // Accept assignee_ids: [n,m,...] (V80) OR legacy assignee_id: n (single).
  let assigneeIds = [];
  if (Array.isArray(body.assignee_ids)) {
    assigneeIds = body.assignee_ids.map(x => parseInt(x, 10)).filter(x => !Number.isNaN(x));
  } else if (body.assignee_id != null) {
    const a = parseInt(body.assignee_id, 10);
    if (!Number.isNaN(a)) assigneeIds = [a];
  }
  // Dedup
  assigneeIds = [...new Set(assigneeIds)];
  if (!assigneeIds.length) {
    return res.status(400).json({ error: 'assignee_ids required (or legacy assignee_id)' });
  }

  // Validate every assignee exists
  const validated = await sql`SELECT id FROM contacts WHERE id = ANY(${assigneeIds})`;
  const validIds = new Set(validated.map(r => r.id));
  const missing = assigneeIds.filter(id => !validIds.has(id));
  if (missing.length) {
    return res.status(400).json({ error: `assignee_ids not found: ${missing.join(', ')}` });
  }

  const creatorId   = resolveSessionUserId(session);
  const finalStatus = (status && VALID_STATUSES.includes(status)) ? status : 'todo';
  const effortDays   = (effort_days   != null && effort_days   !== '') ? Math.round(Number(effort_days))   : null;
  const durationDays = (duration_days != null && duration_days !== '') ? Math.round(Number(duration_days)) : null;

  // 1) Insert the action row (no per-assignee placement here)
  const inserted = await sql`
    INSERT INTO actions (
      description, creator_id, deal_id,
      effort_days, duration_days,
      due_date, reminder_date, status
    ) VALUES (
      ${String(description).trim()},
      ${creatorId},
      ${deal_id ? String(deal_id) : null},
      ${effortDays},
      ${durationDays},
      ${due_date || null},
      ${reminder_date || null},
      ${finalStatus}
    )
    RETURNING *`;
  const newAction = inserted[0];

  // 2) For each assignee, ensure their actions board exists, find the column
  //    matching status, compute their column_order, and insert action_assignees
  for (const aid of assigneeIds) {
    const board = await ensureUserActionsBoard(aid);
    const col   = await getColumnForStatus(board.id, finalStatus);
    const colId = col?.id || null;
    const maxRow = colId
      ? await sql`SELECT COALESCE(MAX(column_order), -1) + 1 AS next
                    FROM action_assignees
                   WHERE column_id = ${colId} AND contact_id = ${aid}`
      : [{ next: 0 }];
    const nextOrder = maxRow[0]?.next ?? 0;
    await sql`
      INSERT INTO action_assignees (action_id, contact_id, column_id, column_order)
      VALUES (${newAction.id}, ${aid}, ${colId}, ${nextOrder})
      ON CONFLICT (action_id, contact_id) DO NOTHING`;
  }

  const viewer = resolveSessionUserId(session);
  const enriched = await enrichActions([newAction], viewer);
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

  const body     = req.body || {};
  const viewerId = resolveSessionUserId(session);

  // Determine new shared status. If column_id is being changed, derive status
  // from the new column. Otherwise honour an explicit status field.
  let newStatus = body.status !== undefined ? body.status : undefined;
  if (body.column_id !== undefined) {
    const derived = await deriveStatusFromColumn(body.column_id);
    if (derived) newStatus = derived;
  }
  if (newStatus !== undefined && !VALID_STATUSES.includes(newStatus)) {
    return res.status(400).json({ error: 'invalid status' });
  }

  const finalStatus = newStatus !== undefined ? newStatus : row.status;
  const statusChanged = finalStatus !== row.status;

  // Update the actions row (shared fields only — no per-assignee placement)
  const merged = {
    description:    body.description    !== undefined ? String(body.description).trim() : row.description,
    deal_id:        body.deal_id        !== undefined ? (body.deal_id ? String(body.deal_id) : null) : row.deal_id,
    effort_days:    body.effort_days    !== undefined
                      ? (body.effort_days   === '' || body.effort_days   == null ? null : Math.round(Number(body.effort_days)))
                      : row.effort_days,
    duration_days:  body.duration_days  !== undefined
                      ? (body.duration_days === '' || body.duration_days == null ? null : Math.round(Number(body.duration_days)))
                      : row.duration_days,
    due_date:       body.due_date       !== undefined ? (body.due_date       || null) : row.due_date,
    reminder_date:  body.reminder_date  !== undefined ? (body.reminder_date  || null) : row.reminder_date,
    status:         finalStatus,
  };

  await sql`
    UPDATE actions SET
      description    = ${merged.description},
      deal_id        = ${merged.deal_id},
      effort_days    = ${merged.effort_days},
      duration_days  = ${merged.duration_days},
      due_date       = ${merged.due_date},
      reminder_date  = ${merged.reminder_date},
      status         = ${merged.status},
      updated_at     = now()
    WHERE id = ${actionId}`;

  // ── Per-assignee placement updates ─────────────────────────────────────────
  if (body.column_id !== undefined && viewerId) {
    // Viewer is dragging the card on their own board. Update only their row.
    const newOrder = body.column_order !== undefined ? Number(body.column_order) : 0;
    await sql`
      UPDATE action_assignees
         SET column_id    = ${body.column_id},
             column_order = ${newOrder}
       WHERE action_id  = ${actionId}
         AND contact_id = ${viewerId}`;
    // If status changed as a result, realign other assignees' column_id
    if (statusChanged) {
      const others = await sql`
        SELECT contact_id FROM action_assignees
         WHERE action_id = ${actionId} AND contact_id != ${viewerId}`;
      for (const o of others) {
        const colId = await resolveColumnForUser(o.contact_id, finalStatus);
        await sql`
          UPDATE action_assignees
             SET column_id = ${colId}
           WHERE action_id = ${actionId} AND contact_id = ${o.contact_id}`;
      }
    }
  } else if (statusChanged) {
    // Status changed via direct PATCH (not column drag). Realign every assignee.
    await realignAllAssigneesToStatus(actionId, finalStatus);
  } else if (body.column_order !== undefined && viewerId) {
    // Reorder within column on viewer's board only
    await sql`
      UPDATE action_assignees
         SET column_order = ${Number(body.column_order)}
       WHERE action_id  = ${actionId}
         AND contact_id = ${viewerId}`;
  }

  // V80 — assignee_ids change: if caller explicitly passes a new assignees
  // array, replace the join rows (delta-style: add missing, remove dropped).
  if (Array.isArray(body.assignee_ids)) {
    const newSet = new Set(body.assignee_ids.map(x => parseInt(x, 10)).filter(x => !Number.isNaN(x)));
    const cur = await sql`SELECT contact_id FROM action_assignees WHERE action_id = ${actionId}`;
    const curSet = new Set(cur.map(r => r.contact_id));
    // Add missing
    for (const aid of newSet) {
      if (!curSet.has(aid)) {
        const colId = await resolveColumnForUser(aid, finalStatus);
        const max = colId
          ? await sql`SELECT COALESCE(MAX(column_order), -1) + 1 AS next
                        FROM action_assignees
                       WHERE column_id = ${colId} AND contact_id = ${aid}`
          : [{ next: 0 }];
        await sql`
          INSERT INTO action_assignees (action_id, contact_id, column_id, column_order)
          VALUES (${actionId}, ${aid}, ${colId}, ${max[0]?.next ?? 0})
          ON CONFLICT (action_id, contact_id) DO NOTHING`;
      }
    }
    // Remove dropped
    for (const aid of curSet) {
      if (!newSet.has(aid)) {
        await sql`DELETE FROM action_assignees
                  WHERE action_id = ${actionId} AND contact_id = ${aid}`;
      }
    }
  }

  // Refetch + enrich + return
  const fresh = await sql`SELECT * FROM actions WHERE id = ${actionId} LIMIT 1`;
  const enriched = await enrichActions(fresh, viewerId);
  return res.status(200).json(enriched[0]);
}

// ── DELETE ──────────────────────────────────────────────────────────────────
async function handleDelete(req, res) {
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'id required' });
  const actionId = parseInt(id, 10);
  if (Number.isNaN(actionId)) return res.status(400).json({ error: 'id must be integer' });
  // action_assignees rows cascade-delete via FK
  await sql`DELETE FROM actions WHERE id = ${actionId}`;
  return res.status(200).json({ ok: true });
}
