/**
 * api/boards.js
 * Boards + columns CRUD.
 *
 *   GET  /api/boards
 *       → returns visible boards for the current user (system + own),
 *         each with its columns nested as `columns[]`. Sorted by sort_order.
 *
 *   GET  /api/boards?id=X
 *       → a single board (if visible), with columns.
 *
 *   POST /api/boards
 *       body: { name, is_system?, sort_order?, columns?[]: [{name, show_on_map, is_terminal, color, sort_order?}] }
 *       - is_system=true requires admin
 *       - non-admin can only create owner_id = session user
 *       - columns optional; if omitted, defaults to the 6 standard columns
 *       → returns the created board with columns
 *
 *   PUT  /api/boards
 *       body: { id, name?, sort_order?, columns?[] }
 *       - Only board owner (or admin) can modify
 *       - If columns[] supplied, replaces the entire column set (with order)
 *       - Each column: { id?, name, show_on_map, is_terminal, color, sort_order }
 *         If id is present and matches an existing column of this board → update
 *         If id is absent or unmatched → insert (generate id)
 *         Existing columns whose id isn't in the new list → delete
 *
 *   DELETE /api/boards?id=X
 *       - Only board owner (or admin) can delete
 *       - Refused if any deals still reference this board (returns 409 with count)
 *
 * Admin check is relaxed for owned boards. System boards always require admin.
 *
 * All responses 401 if no session.
 */

import { neon } from '@neondatabase/serverless';
import { requireSession, isAdmin } from '../lib/auth.js';
import { getDatabaseUrl } from '../lib/db.js';
const sql = neon(getDatabaseUrl());

export default async function handler(req, res) {
  const session = await requireSession(req, res);
  if (!session) return;
  // V75.6: session.sub holds the contact id (string) — auth.js JWT payload shape.
  // 'fallback' means the env-var fallback admin; treat that as an "admin-no-contact"
  // case so admins can still manage system boards but user boards require a real user.
  // Coerce to int — contacts.id is INTEGER in schema, and boards.owner_id matches.
  const userIdRaw = (session.sub && session.sub !== 'fallback') ? session.sub : null;
  const userId    = userIdRaw != null ? parseInt(userIdRaw, 10) : null;
  const admin     = isAdmin(session);

  try {
    if (req.method === 'GET')    return await handleGet(req, res, userId, admin);
    if (req.method === 'POST')   return await handlePost(req, res, userId, admin);
    if (req.method === 'PUT')    return await handlePut(req, res, userId, admin);
    if (req.method === 'DELETE') return await handleDelete(req, res, userId, admin);
    res.setHeader('Allow', 'GET, POST, PUT, DELETE');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[boards API]', err);
    return res.status(500).json({ error: err.message });
  }
}

// ── GET ─────────────────────────────────────────────────────────────────────
async function handleGet(req, res, userId, admin) {
  const { id } = req.query;

  if (id) {
    const rows = await sql`SELECT * FROM boards WHERE id = ${id}`;
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const board = rows[0];
    if (!canRead(board, userId, admin)) return res.status(403).json({ error: 'Forbidden' });
    const cols = await sql`SELECT * FROM board_columns WHERE board_id = ${id} ORDER BY sort_order`;
    return res.status(200).json({ ...board, columns: cols });
  }

  // List: system boards always; own boards if userId present
  let boards;
  if (userId) {
    boards = await sql`
      SELECT * FROM boards
      WHERE is_system = TRUE OR owner_id = ${userId}
      ORDER BY is_system DESC, sort_order ASC, created_at ASC`;
  } else {
    boards = await sql`
      SELECT * FROM boards WHERE is_system = TRUE
      ORDER BY sort_order ASC, created_at ASC`;
  }
  if (!boards.length) return res.status(200).json([]);
  const ids = boards.map(b => b.id);
  const cols = await sql`
    SELECT * FROM board_columns WHERE board_id = ANY(${ids}) ORDER BY board_id, sort_order`;
  const byBoard = {};
  for (const c of cols) (byBoard[c.board_id] ||= []).push(c);
  const out = boards.map(b => ({ ...b, columns: byBoard[b.id] || [] }));
  return res.status(200).json(out);
}

// ── POST (create) ───────────────────────────────────────────────────────────
async function handlePost(req, res, userId, admin) {
  const body = req.body || {};
  const { name, is_system = false, sort_order = 0, columns, board_type = 'deal' } = body;
  if (!name?.trim()) return res.status(400).json({ error: 'name required' });
  if (!['deal','action'].includes(board_type)) {
    return res.status(400).json({ error: "board_type must be 'deal' or 'action'" });
  }

  if (is_system && !admin) return res.status(403).json({ error: 'Admin required to create system boards' });
  if (!is_system && !userId) return res.status(400).json({ error: 'Session user id missing; cannot create user board' });

  const id = is_system
    ? `sys_${slugify(name)}_${Date.now()}`
    : `usr_${userId}_${Date.now()}`;

  await sql`
    INSERT INTO boards (id, name, owner_id, is_system, sort_order, board_type)
    VALUES (${id}, ${name.trim()}, ${is_system ? null : userId}, ${is_system}, ${sort_order}, ${board_type})`;

  // V75.6.2: new boards start with NO columns by default. The user adds
  // columns via "Edit Columns". Callers can still supply columns[] in the
  // POST body (used e.g. by a future "clone board" feature).
  const cols = Array.isArray(columns) ? columns : [];
  const createdCols = [];
  for (let i = 0; i < cols.length; i++) {
    const c = cols[i];
    const colId = `${id}_col_${i}`;
    await sql`
      INSERT INTO board_columns (id, board_id, name, stage_slug, sort_order, show_on_map, is_terminal, color)
      VALUES (${colId}, ${id}, ${c.name || 'Column ' + (i+1)}, ${c.stage_slug || null},
              ${c.sort_order ?? i}, ${c.show_on_map ?? true}, ${c.is_terminal ?? false}, ${c.color || null})`;
    createdCols.push(colId);
  }

  const newBoard = (await sql`SELECT * FROM boards WHERE id = ${id}`)[0];
  const newCols  = await sql`SELECT * FROM board_columns WHERE board_id = ${id} ORDER BY sort_order`;
  return res.status(201).json({ ...newBoard, columns: newCols });
}

// ── PUT (update board + replace column set) ────────────────────────────────
async function handlePut(req, res, userId, admin) {
  const body = req.body || {};
  const { id, name, sort_order, columns } = body;
  if (!id) return res.status(400).json({ error: 'id required' });

  const rows = await sql`SELECT * FROM boards WHERE id = ${id}`;
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  const board = rows[0];
  if (!canWrite(board, userId, admin)) return res.status(403).json({ error: 'Forbidden' });

  if (name !== undefined || sort_order !== undefined) {
    await sql`
      UPDATE boards SET
        name       = COALESCE(${name ?? null}, name),
        sort_order = COALESCE(${sort_order ?? null}, sort_order),
        updated_at = now()
      WHERE id = ${id}`;
  }

  if (Array.isArray(columns)) {
    // Upsert columns: keep ids that match, insert new ones, delete missing ones
    const existing = await sql`SELECT id FROM board_columns WHERE board_id = ${id}`;
    const existingIds = new Set(existing.map(r => r.id));
    const keepIds = new Set();

    for (let i = 0; i < columns.length; i++) {
      const c = columns[i];
      const colId = c.id && existingIds.has(c.id) ? c.id : `${id}_col_${Date.now()}_${i}`;
      keepIds.add(colId);
      if (existingIds.has(colId)) {
        await sql`
          UPDATE board_columns SET
            name        = ${c.name || 'Column'},
            sort_order  = ${c.sort_order ?? i},
            show_on_map = ${c.show_on_map ?? true},
            is_terminal = ${c.is_terminal ?? false},
            color       = ${c.color || null}
          WHERE id = ${colId}`;
      } else {
        await sql`
          INSERT INTO board_columns (id, board_id, name, stage_slug, sort_order, show_on_map, is_terminal, color)
          VALUES (${colId}, ${id}, ${c.name || 'Column'}, ${c.stage_slug || null},
                  ${c.sort_order ?? i}, ${c.show_on_map ?? true}, ${c.is_terminal ?? false}, ${c.color || null})`;
      }
    }
    const toDelete = [...existingIds].filter(x => !keepIds.has(x));
    if (toDelete.length) {
      // V75.7: check both deals and actions
      const dealRefs   = await sql`SELECT id FROM deals   WHERE column_id = ANY(${toDelete}) LIMIT 1`;
      const actionRefs = await sql`SELECT id FROM actions WHERE column_id = ANY(${toDelete}) LIMIT 1`;
      if (dealRefs.length || actionRefs.length) {
        return res.status(409).json({
          error: 'Cannot remove columns that still have items. Move them to another column first.',
          deals_in_removed_columns:   dealRefs.length,
          actions_in_removed_columns: actionRefs.length,
        });
      }
      await sql`DELETE FROM board_columns WHERE id = ANY(${toDelete})`;
    }
  }

  const updated = (await sql`SELECT * FROM boards WHERE id = ${id}`)[0];
  const cols = await sql`SELECT * FROM board_columns WHERE board_id = ${id} ORDER BY sort_order`;
  return res.status(200).json({ ...updated, columns: cols });
}

// ── DELETE ──────────────────────────────────────────────────────────────────
async function handleDelete(req, res, userId, admin) {
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'id required' });

  const rows = await sql`SELECT * FROM boards WHERE id = ${id}`;
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  const board = rows[0];
  if (!canWrite(board, userId, admin)) return res.status(403).json({ error: 'Forbidden' });

  // V75.7: deal boards block on deals, action boards block on actions
  if (board.board_type === 'action') {
    const acts = await sql`SELECT id FROM actions WHERE board_id = ${id} LIMIT 1`;
    if (acts.length) {
      const count = (await sql`SELECT COUNT(*)::int AS n FROM actions WHERE board_id = ${id}`)[0].n;
      return res.status(409).json({
        error: 'Cannot delete board with existing actions',
        action_count: count,
        hint: 'Move or delete actions before removing the board.',
      });
    }
  } else {
    const deals = await sql`SELECT id FROM deals WHERE board_id = ${id} LIMIT 1`;
    if (deals.length) {
      const count = (await sql`SELECT COUNT(*)::int AS n FROM deals WHERE board_id = ${id}`)[0].n;
      return res.status(409).json({
        error: 'Cannot delete board with existing deals',
        deal_count: count,
        hint: 'Move or delete deals before removing the board.',
      });
    }
  }
  await sql`DELETE FROM boards WHERE id = ${id}`;  // cascades to board_columns
  return res.status(200).json({ ok: true });
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function canRead(board, userId, admin) {
  if (board.is_system) return true;
  if (admin) return true;
  return board.owner_id === userId;
}
function canWrite(board, userId, admin) {
  if (board.is_system) return admin;
  if (admin) return true;
  return board.owner_id === userId;
}
function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
}
