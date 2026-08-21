/**
 * api/contact-groups.js
 * V82.b — Returns a contact's roles and marketing categories.
 *
 * GET ?contact_id=N
 *   → { roles: [{id, label}], marketing_categories: [string] }
 *
 * Roles come from entity_contacts joined to roles table.
 * Marketing categories come from contact_marketing_categories.
 */

import { neon } from '@neondatabase/serverless';
import { requireSession, requireModule } from '../lib/auth.js';
import { getDatabaseUrl } from '../lib/db.js';
const sql = neon(getDatabaseUrl());

export default async function handler(req, res) {
  const session = await requireSession(req, res);
  if (!session) return;
  if (!requireModule(session, res, 'crm')) return;

  const contact_id = parseInt(req.query?.contact_id, 10);
  if (!contact_id) return res.status(400).json({ error: 'contact_id required' });

  // ── GET ──────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    try {
      const [roles, categories] = await Promise.all([
        sql`
          SELECT DISTINCT ec.role_id AS id, r.label
          FROM entity_contacts ec
          JOIN roles r ON r.id = ec.role_id
          WHERE ec.contact_id = ${contact_id}
          ORDER BY r.label`,
        sql`
          SELECT category
          FROM contact_marketing_categories
          WHERE contact_id = ${contact_id}
          ORDER BY category`,
      ]);
      return res.status(200).json({
        roles,
        marketing_categories: categories.map(c => c.category),
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── POST — replace contact-level roles ───────────────────────────────────
  // Saves roles as entity_type contact_role_profile (preferred) / legacy contact_import (contact-level, no entity link)
  if (req.method === 'POST') {
    try {
      const { roles } = req.body ?? {};
      if (!Array.isArray(roles)) return res.status(400).json({ error: 'roles must be an array' });
      // Delete existing contact-level roles, preserve entity-linked roles
      await sql`
        DELETE FROM entity_contacts
        WHERE contact_id = ${contact_id} AND entity_type IN ('contact_role_profile', 'contact_import')`;
      for (const role_id of roles) {
        await sql`
          INSERT INTO entity_contacts (contact_id, entity_type, entity_id, role_id)
          VALUES (${contact_id}, 'contact_role_profile', ${String(contact_id)}, ${role_id})
          ON CONFLICT (contact_id, entity_type, entity_id, role_id) DO NOTHING`;
      }
      const updated = await sql`
        SELECT DISTINCT ec.role_id AS id, r.label
        FROM entity_contacts ec
        JOIN roles r ON r.id = ec.role_id
        WHERE ec.contact_id = ${contact_id}
        ORDER BY r.label`;
      return res.status(200).json({ roles: updated });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
}
