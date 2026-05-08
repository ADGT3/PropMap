/**
 * api/roles.js
 * Role catalogue — CRUD for the roles table. Admin-only for writes.
 * New in V75. Extended in V77.1: ref_count query, delete-with-references support.
 *
 * GET    /api/roles                -> list all (ordered by sort_order)
 * GET    /api/roles?active=1       -> active only
 * GET    /api/roles?id=X           -> single role
 * GET    /api/roles?id=X&ref_count=1 -> single role with usage count for delete-with-ref UI (V77.1)
 * POST   /api/roles                -> create custom role (non-system)
 * PUT    /api/roles                -> update label/scopes/default_scope/sort_order/active
 * DELETE /api/roles?id=X           -> delete (only non-system).
 *                                     V77.1 change: refs allowed — entity_contacts.role_id FK
 *                                     is now ON DELETE SET NULL. System roles still cannot be
 *                                     deleted (only deactivated).
 */

import { neon } from '@neondatabase/serverless';
import { requireSession, requireAdmin } from '../lib/auth.js';
import { getDatabaseUrl } from '../lib/db.js';
const sql = neon(getDatabaseUrl());

const SCOPE_VALUES = new Set(['property', 'deal', 'organisation', 'listing']);

// Known default_for purposes. Code-flow callers reference these exact strings:
//   'enquiry_creation' — auto-assigned on new Enquiry deals
//   'listing_agent'    — auto-assigned on new Listing deals
// Adding a new purpose: add it here, then update the parameters UI dropdown.
function validateRoleBody(body, { requireId = false } = {}) {
  if (requireId && !body.id) return 'id required';
  if (body.scopes !== undefined) {
    if (!Array.isArray(body.scopes) || !body.scopes.length) return 'scopes must be non-empty array';
    for (const s of body.scopes) {
      if (!SCOPE_VALUES.has(s)) return `invalid scope '${s}'`;
    }
  }
  if (body.default_scope !== undefined) {
    if (!SCOPE_VALUES.has(body.default_scope)) return `invalid default_scope '${body.default_scope}'`;
    if (body.scopes && !body.scopes.includes(body.default_scope)) return 'default_scope must be in scopes';
  }
  if (body.board_ids !== undefined) {
    if (!Array.isArray(body.board_ids)) return 'board_ids must be an array';
    for (const b of body.board_ids) {
      if (typeof b !== 'string' || !b) return 'board_ids must be strings';
    }
  }
  return null;
}

// V77.2g — Sync role_boards rows to match the supplied array. Removes any
// rows for this role not in `board_ids` and inserts any missing.
async function syncRoleBoards(roleId, boardIds) {
  // Wipe + re-insert is fine for small arrays (< 20 boards typical)
  await sql`DELETE FROM role_boards WHERE role_id = ${roleId}`;
  for (const bid of boardIds) {
    await sql`
      INSERT INTO role_boards (role_id, board_id)
      VALUES (${roleId}, ${bid})
      ON CONFLICT (role_id, board_id) DO NOTHING`;
  }
}

export default async function handler(req, res) {
  const session = await requireSession(req, res);
  if (!session) return;

  try {
    switch (req.method) {

      case 'GET': {
        const { id, active, ref_count } = req.query;
        if (id) {
          const rows = await sql`SELECT * FROM roles WHERE id = ${id}`;
          if (!rows.length) return res.status(404).json({ error: 'Not found' });
          const result = rows[0];
          // V77.2g — attach board_ids array
          const boardRows = await sql`SELECT board_id FROM role_boards WHERE role_id = ${id} ORDER BY board_id`;
          result.board_ids = boardRows.map(b => b.board_id);
          // V77.1: ref_count for delete-with-warning UI in Parameters page
          if (ref_count) {
            const refs = await sql`SELECT COUNT(*)::int AS c FROM entity_contacts WHERE role_id = ${id}`;
            result.references = {
              entity_contacts: refs[0]?.c ?? 0,
              total:           refs[0]?.c ?? 0,
            };
          }
          return res.status(200).json(result);
        }
        // List view — attach board_ids per role using a single secondary fetch.
        const rows = active
          ? await sql`SELECT * FROM roles WHERE active = true ORDER BY sort_order, label`
          : await sql`SELECT * FROM roles ORDER BY sort_order, label`;
        if (!rows.length) return res.status(200).json([]);
        const allBoardRows = await sql`SELECT role_id, board_id FROM role_boards ORDER BY role_id, board_id`;
        const byRole = {};
        for (const b of allBoardRows) {
          if (!byRole[b.role_id]) byRole[b.role_id] = [];
          byRole[b.role_id].push(b.board_id);
        }
        for (const r of rows) r.board_ids = byRole[r.id] || [];
        return res.status(200).json(rows);
      }

      case 'POST': {
        if (!requireAdmin(session, res)) return;
        const body = req.body || {};
        const err = validateRoleBody(body);
        if (err) return res.status(400).json({ error: err });
        const {
          id, label, scopes, default_scope, board_ids,
          sort_order = 100, active = true,
        } = body;
        if (!id || !label || !scopes || !default_scope) {
          return res.status(400).json({ error: 'id, label, scopes, default_scope required' });
        }
        const rows = await sql`
          INSERT INTO roles (id, label, scopes, default_scope, sort_order, active, system)
          VALUES (${id}, ${label}, ${scopes}, ${default_scope}, ${sort_order}, ${active}, false)
          ON CONFLICT (id) DO NOTHING
          RETURNING *`;
        if (!rows.length) return res.status(409).json({ error: `Role id '${id}' already exists` });
        // V77.2g — sync board_ids to role_boards
        if (Array.isArray(board_ids)) await syncRoleBoards(id, board_ids);
        rows[0].board_ids = Array.isArray(board_ids) ? board_ids : [];
        return res.status(201).json(rows[0]);
      }

      case 'PUT': {
        if (!requireAdmin(session, res)) return;
        const body = req.body || {};
        const err = validateRoleBody(body, { requireId: true });
        if (err) return res.status(400).json({ error: err });
        const { id, label, scopes, default_scope, sort_order, active, board_ids } = body;

        const rows = await sql`
          UPDATE roles SET
            label         = COALESCE(${label         ?? null}, label),
            scopes        = COALESCE(${scopes        ?? null}, scopes),
            default_scope = COALESCE(${default_scope ?? null}, default_scope),
            sort_order    = COALESCE(${sort_order    ?? null}, sort_order),
            active        = COALESCE(${active        ?? null}, active),
            updated_at    = now()
          WHERE id = ${id}
          RETURNING *`;
        if (!rows.length) return res.status(404).json({ error: 'Not found' });

        // V77.2g — sync board_ids to role_boards if supplied
        if (Array.isArray(board_ids)) await syncRoleBoards(id, board_ids);
        // Always return the current board_ids
        const boardRows = await sql`SELECT board_id FROM role_boards WHERE role_id = ${id} ORDER BY board_id`;
        rows[0].board_ids = boardRows.map(b => b.board_id);
        return res.status(200).json(rows[0]);
      }

      case 'DELETE': {
        if (!requireAdmin(session, res)) return;
        const { id } = req.query;
        if (!id) return res.status(400).json({ error: 'id required' });
        // Guard: system roles cannot be deleted (only deactivated)
        const roleRows = await sql`SELECT id, system FROM roles WHERE id = ${id}`;
        if (!roleRows.length) return res.status(404).json({ error: 'Not found' });
        if (roleRows[0].system) {
          return res.status(400).json({ error: 'System roles cannot be deleted (disable instead)' });
        }
        // V77.1: refs allowed — entity_contacts.role_id FK is ON DELETE SET NULL.
        // Caller (Parameters UI) is expected to fetch ?ref_count=1 first and confirm with user
        // about how many entity_contacts will lose their role assignment.
        await sql`DELETE FROM roles WHERE id = ${id}`;
        return res.status(200).json({ ok: true });
      }

      default:
        res.setHeader('Allow', 'GET, POST, PUT, DELETE');
        return res.status(405).json({ error: 'Method not allowed' });
    }
  } catch (err) {
    console.error('[roles API]', err);
    return res.status(500).json({ error: err.message });
  }
}
