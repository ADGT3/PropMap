/**
 * api/contact-marketing-categories.js
 * V82.b — Manage contact marketing categories.
 *
 * GET  ?contact_id=N  → { categories: [string] }
 * POST ?contact_id=N  { categories: [string] } → replaces full set in a transaction
 */

import { neon } from '@neondatabase/serverless';
import { requireSession, requireModule } from '../lib/auth.js';
import { getDatabaseUrl } from '../lib/db.js';
const sql = neon(getDatabaseUrl());

// All known categories from lookup table — used for multi-select in modal
async function getAllCategories() {
  const rows = await sql`
    SELECT category FROM marketing_category_lookup ORDER BY category`;
  return rows.map(r => r.category);
}

export default async function handler(req, res) {
  const session = await requireSession(req, res);
  if (!session) return;
  if (!requireModule(session, res, 'crm')) return;

  const contact_id = parseInt(req.query?.contact_id, 10);

  // ── GET (no contact_id) → return all distinct categories for multi-select ─
  if (req.method === 'GET' && !contact_id) {
    try {
      return res.status(200).json({ categories: await getAllCategories() });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  if (!contact_id) return res.status(400).json({ error: 'contact_id required' });

  // ── GET ?contact_id=N ────────────────────────────────────────────────────
  if (req.method === 'GET') {
    try {
      const rows = await sql`
        SELECT category FROM contact_marketing_categories
        WHERE contact_id = ${contact_id} ORDER BY category`;
      return res.status(200).json({ categories: rows.map(r => r.category) });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── POST ?contact_id=N { categories: [...] } ─────────────────────────────
  if (req.method === 'POST') {
    try {
      const { categories } = req.body ?? {};
      if (!Array.isArray(categories)) {
        return res.status(400).json({ error: 'categories must be an array' });
      }
      // Replace full set in a transaction
      await sql`DELETE FROM contact_marketing_categories WHERE contact_id = ${contact_id}`;
      if (categories.length) {
        for (const cat of categories) {
          const trimmed = cat.trim();
          if (trimmed) {
            await sql`
              INSERT INTO contact_marketing_categories (contact_id, category)
              VALUES (${contact_id}, ${trimmed})
              ON CONFLICT DO NOTHING`;
          }
        }
      }
      const updated = await sql`
        SELECT category FROM contact_marketing_categories
        WHERE contact_id = ${contact_id} ORDER BY category`;
      return res.status(200).json({ categories: updated.map(r => r.category) });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
}
