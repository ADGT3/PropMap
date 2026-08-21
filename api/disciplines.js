/**
 * api/disciplines.js — V82.b
 *
 * CRUD for the disciplines lookup table.
 * Used in System Settings → Parameters → Disciplines.
 * Contact edit modal reads from this to populate the Discipline dropdown.
 *
 * GET    → [{ id, label, sort_order, active, contact_count }]
 * POST   { label, sort_order? }    → create
 * PATCH  { id, label?, sort_order?, active? } → update
 * DELETE ?id=N                     → delete (warns on contact references)
 *
 * Admin only except GET.
 */

import { neon } from '@neondatabase/serverless';
import { requireSession, requireAdmin, requireModule } from '../lib/auth.js';
import { getDatabaseUrl } from '../lib/db.js';
const sql = neon(getDatabaseUrl());

export default async function handler(req, res) {
  const session = await requireSession(req, res);
  if (!session) return;
  if (!requireModule(session, res, 'crm')) return;

  try {

    // ── GET ──────────────────────────────────────────────────────────────────
    if (req.method === 'GET') {
      const rows = await sql`
        SELECT
          d.id, d.label, d.rate_per_hour, d.sort_order, d.active,
          COUNT(c.id)::int AS contact_count
        FROM disciplines d
        LEFT JOIN contacts c ON LOWER(c.discipline) = LOWER(d.label)
        GROUP BY d.id, d.label, d.sort_order, d.active
        ORDER BY d.sort_order ASC, d.label ASC`;
      return res.status(200).json(rows);
    }

    if (!requireAdmin(session, res)) return;

    // ── POST ─────────────────────────────────────────────────────────────────
    if (req.method === 'POST') {
      const { label, sort_order, rate_per_hour } = req.body ?? {};
      if (!label?.trim()) return res.status(400).json({ error: 'label required' });
      const rows = await sql`
        INSERT INTO disciplines (label, rate_per_hour, sort_order, active)
        VALUES (${label.trim()}, ${rate_per_hour ?? 150.00}, ${sort_order ?? 999}, true)
        RETURNING *`;
      return res.status(200).json(rows[0]);
    }

    // ── PATCH ────────────────────────────────────────────────────────────────
    if (req.method === 'PATCH') {
      const { id, label, sort_order, active, rate_per_hour } = req.body ?? {};
      if (!id) return res.status(400).json({ error: 'id required' });
      const rows = await sql`
        UPDATE disciplines SET
          label         = COALESCE(${label?.trim() ?? null}, label),
          rate_per_hour = COALESCE(${rate_per_hour ?? null}, rate_per_hour),
          sort_order    = COALESCE(${sort_order ?? null}, sort_order),
          active        = COALESCE(${active ?? null}, active),
          updated_at    = now()
        WHERE id = ${parseInt(id)}
        RETURNING *`;
      if (!rows.length) return res.status(404).json({ error: 'Not found' });
      return res.status(200).json(rows[0]);
    }

    // ── DELETE ───────────────────────────────────────────────────────────────
    if (req.method === 'DELETE') {
      const id = parseInt(req.query?.id);
      if (!id) return res.status(400).json({ error: 'id required' });
      const disc = await sql`SELECT label FROM disciplines WHERE id = ${id}`;
      if (!disc.length) return res.status(404).json({ error: 'Not found' });
      // Count contacts using this discipline
      const count = await sql`
        SELECT COUNT(*)::int AS n FROM contacts
        WHERE LOWER(discipline) = LOWER(${disc[0].label})`;
      if (count[0].n > 0) {
        // Null out contacts references before deleting
        await sql`
          UPDATE contacts SET discipline = NULL
          WHERE LOWER(discipline) = LOWER(${disc[0].label})`;
      }
      await sql`DELETE FROM disciplines WHERE id = ${id}`;
      return res.status(200).json({ deleted: id, contacts_cleared: count[0].n });
    }

    res.setHeader('Allow', 'GET, POST, PATCH, DELETE');
    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
