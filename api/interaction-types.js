/**
 * api/interaction-types.js — V77.1
 *
 * Lookup CRUD for interaction_types. Powers System Settings → Parameters →
 * Interaction Types sub-section, plus the Type dropdown in the Note form
 * everywhere it appears (Enquiry timeline, contact modal, deal modal).
 *
 * The `direction` field drives Note form behaviour:
 *   - inbound  → Source dropdown shows (where did this come from)
 *   - outbound → Source dropdown hidden (we know — it's us)
 *   - internal → Source dropdown hidden (administrative)
 *
 * Schema (interaction_types table):
 *   id (slug, PK), label, direction, sort_order, active, system, created_at, updated_at
 *
 * Routes:
 *   GET    /api/interaction-types                  -> list all (sort_order, label)
 *   GET    /api/interaction-types?active=1         -> active only
 *   GET    /api/interaction-types?id=X             -> single
 *   GET    /api/interaction-types?id=X&ref_count=1 -> single with notes ref count
 *   POST   /api/interaction-types                  -> create (admin-only)
 *   PUT    /api/interaction-types                  -> update (admin-only)
 *   DELETE /api/interaction-types?id=X             -> delete (admin-only).
 *                                                     System types cannot be deleted.
 *                                                     Refs allowed (notes.interaction_type
 *                                                     FK is ON DELETE SET NULL).
 */

import { neon } from '@neondatabase/serverless';
import { requireSession, requireAdmin } from '../lib/auth.js';
import { getDatabaseUrl } from '../lib/db.js';
const sql = neon(getDatabaseUrl());

const DIRECTIONS = new Set(['inbound', 'outbound', 'internal']);
const SLUG_PATTERN = /^[a-z][a-z0-9_]*$/;

function slugify(label) {
  return String(label || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_{2,}/g, '_');
}

async function countReferences(id) {
  const r = await sql`SELECT COUNT(*)::int AS c FROM notes WHERE interaction_type = ${id}`;
  return { notes: r[0]?.c ?? 0, total: r[0]?.c ?? 0 };
}

export default async function handler(req, res) {
  const session = await requireSession(req, res);
  if (!session) return;

  try {
    switch (req.method) {

      case 'GET': {
        const { id, active, ref_count } = req.query;
        if (id) {
          const rows = await sql`SELECT * FROM interaction_types WHERE id = ${id}`;
          if (!rows.length) return res.status(404).json({ error: 'Not found' });
          const result = rows[0];
          if (ref_count) result.references = await countReferences(id);
          return res.status(200).json(result);
        }
        if (active) {
          const rows = await sql`
            SELECT * FROM interaction_types
            WHERE active = true
            ORDER BY sort_order, label`;
          return res.status(200).json(rows);
        }
        const rows = await sql`
          SELECT * FROM interaction_types
          ORDER BY sort_order, label`;
        return res.status(200).json(rows);
      }

      case 'POST': {
        if (!requireAdmin(session, res)) return;
        const body = req.body || {};
        const { label, direction, sort_order = 1000, active = true } = body;
        if (!label || !String(label).trim()) {
          return res.status(400).json({ error: 'label required' });
        }
        if (!direction || !DIRECTIONS.has(direction)) {
          return res.status(400).json({
            error: `direction required, one of: ${[...DIRECTIONS].join(', ')}`,
          });
        }
        let id = body.id;
        if (!id) {
          id = slugify(label);
          if (!id) return res.status(400).json({ error: 'Could not generate slug from label' });
        }
        if (!SLUG_PATTERN.test(id)) {
          return res.status(400).json({
            error: `Invalid id '${id}'. Must start with a letter and contain only lowercase letters, digits, and underscores.`,
          });
        }
        const rows = await sql`
          INSERT INTO interaction_types (id, label, direction, sort_order, active, system)
          VALUES (${id}, ${String(label).trim()}, ${direction}, ${sort_order}, ${active}, false)
          ON CONFLICT (id) DO NOTHING
          RETURNING *`;
        if (!rows.length) {
          return res.status(409).json({ error: `Interaction type id '${id}' already exists` });
        }
        return res.status(201).json(rows[0]);
      }

      case 'PUT': {
        if (!requireAdmin(session, res)) return;
        const body = req.body || {};
        const { id, label, direction, sort_order, active } = body;
        if (!id) return res.status(400).json({ error: 'id required' });
        if (label !== undefined && !String(label).trim()) {
          return res.status(400).json({ error: 'label cannot be empty' });
        }
        if (direction !== undefined && !DIRECTIONS.has(direction)) {
          return res.status(400).json({
            error: `Invalid direction '${direction}', must be one of: ${[...DIRECTIONS].join(', ')}`,
          });
        }
        const rows = await sql`
          UPDATE interaction_types SET
            label      = COALESCE(${label !== undefined ? String(label).trim() : null}, label),
            direction  = COALESCE(${direction  ?? null}, direction),
            sort_order = COALESCE(${sort_order ?? null}, sort_order),
            active     = COALESCE(${active     ?? null}, active),
            updated_at = now()
          WHERE id = ${id}
          RETURNING *`;
        if (!rows.length) return res.status(404).json({ error: 'Not found' });
        return res.status(200).json(rows[0]);
      }

      case 'DELETE': {
        if (!requireAdmin(session, res)) return;
        const { id } = req.query;
        if (!id) return res.status(400).json({ error: 'id required' });
        const rows = await sql`SELECT id, system FROM interaction_types WHERE id = ${id}`;
        if (!rows.length) return res.status(404).json({ error: 'Not found' });
        if (rows[0].system) {
          return res.status(400).json({
            error: 'System interaction types cannot be deleted. Set active=false to hide from new dropdowns.',
          });
        }
        // FK on notes.interaction_type is ON DELETE SET NULL — refs allowed.
        await sql`DELETE FROM interaction_types WHERE id = ${id}`;
        return res.status(200).json({ ok: true });
      }

      default:
        res.setHeader('Allow', 'GET, POST, PUT, DELETE');
        return res.status(405).json({ error: 'Method not allowed' });
    }
  } catch (err) {
    console.error('[api/interaction-types]', err);
    return res.status(500).json({ error: err.message });
  }
}
