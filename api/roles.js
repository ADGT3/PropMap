/**
 * api/roles.js
 * Role catalogue — CRUD for the roles table. Admin-only for writes.
 * New in V75.
 *
 * GET    /api/roles                -> list all (ordered by sort_order)
 * GET    /api/roles?active=1       -> active only
 * GET    /api/roles?id=X           -> single role
 * POST   /api/roles                -> create custom role (non-system)
 * PUT    /api/roles                -> update label/scopes/default_scope/sort_order/active
 * DELETE /api/roles?id=X           -> delete (only non-system, only if zero entity_contacts use it)
 */

import { neon } from '@neondatabase/serverless';
import { requireSession, requireAdmin } from '../lib/auth.js';
import { getDatabaseUrl } from '../lib/db.js';
const sql = neon(getDatabaseUrl());

const SCOPE_VALUES = new Set(['property', 'deal', 'organisation', 'listing']);

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
  return null;
}

export default async function handler(req, res) {
  const session = await requireSession(req, res);
  if (!session) return;

  try {
    switch (req.method) {

      case 'GET': {
        const { id, active } = req.query;
        if (id) {
          const rows = await sql`SELECT * FROM roles WHERE id = ${id}`;
          if (!rows.length) return res.status(404).json({ error: 'Not found' });
          return res.status(200).json(rows[0]);
        }
        if (active) {
          const rows = await sql`SELECT * FROM roles WHERE active = true ORDER BY sort_order, label`;
          return res.status(200).json(rows);
        }
        const rows = await sql`SELECT * FROM roles ORDER BY sort_order, label`;
        return res.status(200).json(rows);
      }

      case 'POST': {
        if (!requireAdmin(session, res)) return;
        const body = req.body || {};
        const err = validateRoleBody(body);
        if (err) return res.status(400).json({ error: err });
        const {
          id, label, scopes, default_scope,
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
        return res.status(201).json(rows[0]);
      }

      case 'PUT': {
        if (!requireAdmin(session, res)) return;
        const body = req.body || {};
        const err = validateRoleBody(body, { requireId: true });
        if (err) return res.status(400).json({ error: err });
        const { id, label, scopes, default_scope, sort_order, active } = body;
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
        return res.status(200).json(rows[0]);
      }

      case 'DELETE': {
        if (!requireAdmin(session, res)) return;
        const { id } = req.query;
        if (!id) return res.status(400).json({ error: 'id required' });
        // Guard: system roles cannot be deleted
        const roleRows = await sql`SELECT id, system FROM roles WHERE id = ${id}`;
        if (!roleRows.length) return res.status(404).json({ error: 'Not found' });
        if (roleRows[0].system) return res.status(400).json({ error: 'System roles cannot be deleted (disable instead)' });
        // Guard: role in use
        const uses = await sql`SELECT COUNT(*)::int AS c FROM entity_contacts WHERE role_id = ${id}`;
        if (uses[0].c > 0) {
          return res.status(400).json({ error: `Role in use by ${uses[0].c} contact link(s) — reassign or disable instead` });
        }
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
