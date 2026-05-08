/**
 * api/sources.js — V77.1
 *
 * Lookup CRUD for contact_sources. Powers System Settings → Parameters →
 * Sources sub-section, plus the Source dropdown in:
 *   - Contact create/edit form
 *   - Note form (when interaction_type direction is 'inbound')
 *   - Public form Step 1 (V77.2 — applicant self-identifies how they heard)
 *
 * Schema (contact_sources table):
 *   id (slug, PK), label, sort_order, active, system, created_at, updated_at
 *
 * Routes:
 *   GET    /api/sources                  -> list all (ordered by sort_order, then label)
 *   GET    /api/sources?active=1         -> active only
 *   GET    /api/sources?id=X             -> single source
 *   GET    /api/sources?id=X&ref_count=1 -> single source with usage count for delete-with-ref UI
 *   POST   /api/sources                  -> create custom source (non-system; admin-only)
 *   PUT    /api/sources                  -> update label/sort_order/active (admin-only)
 *   DELETE /api/sources?id=X             -> delete (admin-only). Allowed even with refs;
 *                                           contacts.source FK is ON DELETE SET NULL,
 *                                           notes.source FK is ON DELETE SET NULL.
 *                                           System sources cannot be deleted (deactivate instead).
 */

import { neon } from '@neondatabase/serverless';
import { requireSession, requireAdmin } from '../lib/auth.js';
import { getDatabaseUrl } from '../lib/db.js';
const sql = neon(getDatabaseUrl());

// Slug pattern matching what the migration seeds use: lowercase + underscores + digits.
// Used to validate user-created custom source ids and to auto-generate from labels.
const SLUG_PATTERN = /^[a-z][a-z0-9_]*$/;

function slugify(label) {
  return String(label || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')   // non-alphanumeric runs become single _
    .replace(/^_+|_+$/g, '')        // strip leading/trailing _
    .replace(/_{2,}/g, '_');        // collapse multiple _
}

// Count references across both tables that FK into contact_sources.
// Used by ?ref_count=1 to drive the delete-with-warning UI in Parameters.
async function countReferences(id) {
  const [contacts, notes] = await Promise.all([
    sql`SELECT COUNT(*)::int AS c FROM contacts WHERE source = ${id}`,
    sql`SELECT COUNT(*)::int AS c FROM notes    WHERE source = ${id}`,
  ]);
  return {
    contacts: contacts[0]?.c ?? 0,
    notes:    notes[0]?.c    ?? 0,
    total:    (contacts[0]?.c ?? 0) + (notes[0]?.c ?? 0),
  };
}

export default async function handler(req, res) {
  const session = await requireSession(req, res);
  if (!session) return;

  try {
    switch (req.method) {

      case 'GET': {
        const { id, active, ref_count } = req.query;
        if (id) {
          const rows = await sql`SELECT * FROM contact_sources WHERE id = ${id}`;
          if (!rows.length) return res.status(404).json({ error: 'Not found' });
          const result = rows[0];
          if (ref_count) {
            result.references = await countReferences(id);
          }
          return res.status(200).json(result);
        }
        if (active) {
          const rows = await sql`
            SELECT * FROM contact_sources
            WHERE active = true
            ORDER BY sort_order, label`;
          return res.status(200).json(rows);
        }
        const rows = await sql`
          SELECT * FROM contact_sources
          ORDER BY sort_order, label`;
        return res.status(200).json(rows);
      }

      case 'POST': {
        if (!requireAdmin(session, res)) return;
        const body = req.body || {};
        const { label, sort_order = 1000, active = true } = body;
        if (!label || !String(label).trim()) {
          return res.status(400).json({ error: 'label required' });
        }
        // Auto-generate slug id from label unless explicitly provided
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
          INSERT INTO contact_sources (id, label, sort_order, active, system)
          VALUES (${id}, ${String(label).trim()}, ${sort_order}, ${active}, false)
          ON CONFLICT (id) DO NOTHING
          RETURNING *`;
        if (!rows.length) {
          return res.status(409).json({ error: `Source id '${id}' already exists` });
        }
        return res.status(201).json(rows[0]);
      }

      case 'PUT': {
        if (!requireAdmin(session, res)) return;
        const body = req.body || {};
        const { id, label, sort_order, active } = body;
        if (!id) return res.status(400).json({ error: 'id required' });
        if (label !== undefined && !String(label).trim()) {
          return res.status(400).json({ error: 'label cannot be empty' });
        }
        const rows = await sql`
          UPDATE contact_sources SET
            label      = COALESCE(${label !== undefined ? String(label).trim() : null}, label),
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
        // Guard: system sources cannot be deleted (only deactivated)
        const rows = await sql`SELECT id, system FROM contact_sources WHERE id = ${id}`;
        if (!rows.length) return res.status(404).json({ error: 'Not found' });
        if (rows[0].system) {
          return res.status(400).json({
            error: 'System sources cannot be deleted. Set active=false to hide from new dropdowns.',
          });
        }
        // Allowed even with references — FKs are ON DELETE SET NULL.
        // Caller (Parameters UI) is expected to fetch ?ref_count=1 first and confirm with user.
        await sql`DELETE FROM contact_sources WHERE id = ${id}`;
        return res.status(200).json({ ok: true });
      }

      default:
        res.setHeader('Allow', 'GET, POST, PUT, DELETE');
        return res.status(405).json({ error: 'Method not allowed' });
    }
  } catch (err) {
    console.error('[api/sources]', err);
    return res.status(500).json({ error: err.message });
  }
}
