/**
 * api/marketing-categories.js
 * V82.b — Admin CRUD for marketing categories.
 *
 * GET    → { categories: [{ category, contact_count }] } — all categories with contact counts
 * POST   { category }         → add new category (inserts into lookup table)
 * PATCH  { old_name, new_name } → rename category (updates all contact assignments)
 * DELETE ?category=X          → delete category (removes all contact assignments)
 *
 * Admin only.
 */

import { neon } from '@neondatabase/serverless';
import { requireSession, requireAdmin, requireModule } from '../lib/auth.js';
import { getDatabaseUrl } from '../lib/db.js';
const sql = neon(getDatabaseUrl());

export default async function handler(req, res) {
  const session = await requireSession(req, res);
  if (!session) return;
  if (!requireModule(session, res, 'crm')) return;
  if (!requireAdmin(session, res)) return;

  try {

    // ── GET — all categories with contact counts ──────────────────────────
    if (req.method === 'GET') {
      // Union assigned categories + lookup-only categories (created but not yet assigned)
      const rows = await sql`
        SELECT category, COUNT(DISTINCT contact_id)::int AS contact_count
        FROM contact_marketing_categories
        GROUP BY category
        UNION
        SELECT category, 0 AS contact_count
        FROM marketing_category_lookup
        WHERE category NOT IN (SELECT DISTINCT category FROM contact_marketing_categories)
        ORDER BY category`;
      return res.status(200).json({ categories: rows });
    }

    // ── POST — add new category ───────────────────────────────────────────
    if (req.method === 'POST') {
      const { category } = req.body ?? {};
      if (!category?.trim()) return res.status(400).json({ error: 'category required' });
      const trimmed = category.trim();
      // Check for duplicate
      const exists = await sql`
        SELECT 1 FROM contact_marketing_categories WHERE LOWER(category) = LOWER(${trimmed}) LIMIT 1`;
      if (exists.length) return res.status(409).json({ error: `Category "${trimmed}" already exists` });
      // Categories are contact-linked — a standalone category with no contacts
      // is stored in a separate lookup table
      await sql`
        INSERT INTO marketing_category_lookup (category) VALUES (${trimmed})
        ON CONFLICT (category) DO NOTHING`;
      return res.status(200).json({ category: trimmed });
    }

    // ── PATCH — rename category ───────────────────────────────────────────
    if (req.method === 'PATCH') {
      const { old_name, new_name } = req.body ?? {};
      if (!old_name?.trim() || !new_name?.trim()) {
        return res.status(400).json({ error: 'old_name and new_name required' });
      }
      const oldTrimmed = old_name.trim();
      const newTrimmed = new_name.trim();
      // Update all contact assignments
      await sql`
        UPDATE contact_marketing_categories
        SET category = ${newTrimmed}
        WHERE category = ${oldTrimmed}`;
      // Update lookup table if exists
      await sql`
        UPDATE marketing_category_lookup
        SET category = ${newTrimmed}
        WHERE category = ${oldTrimmed}`;
      return res.status(200).json({ old_name: oldTrimmed, new_name: newTrimmed });
    }

    // ── DELETE — remove category ──────────────────────────────────────────
    if (req.method === 'DELETE') {
      const category = req.query?.category;
      if (!category) return res.status(400).json({ error: 'category query param required' });
      await sql`DELETE FROM contact_marketing_categories WHERE category = ${category}`;
      await sql`DELETE FROM marketing_category_lookup WHERE category = ${category}`;
      return res.status(200).json({ deleted: category });
    }

    res.setHeader('Allow', 'GET, POST, PATCH, DELETE');
    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
