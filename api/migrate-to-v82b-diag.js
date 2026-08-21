/**
 * api/migrate-to-v82b-diag.js — V82.b diagnostics
 * GET ?search=X  → runs the extended search and returns count + sample
 * GET ?rex_id=X  → shows what was imported for a specific rex contact
 * GET            → shows error summary + notes/source counts
 */
import { neon } from '@neondatabase/serverless';
import { requireSession, requireAdmin } from '../lib/auth.js';
import { getDatabaseUrl } from '../lib/db.js';
const sql = neon(getDatabaseUrl());

export default async function handler(req, res) {
  const session = await requireSession(req, res);
  if (!session) return;
  if (!requireAdmin(session, res)) return;

  try {
    const { search, rex_id } = req.query;

    if (search) {
      const q = `%${search}%`;
      const catCount = await sql`
        SELECT COUNT(*)::int AS n FROM contact_marketing_categories WHERE category ILIKE ${q}`;
      const catSample = await sql`
        SELECT c.id, c.first_name, c.last_name, cmc.category
        FROM contact_marketing_categories cmc
        JOIN contacts c ON c.id = cmc.contact_id
        WHERE cmc.category ILIKE ${q} LIMIT 5`;
      const fullCount = await sql`
        SELECT COUNT(*)::int AS n FROM contacts c
        LEFT JOIN organisations o ON o.id = c.organisation_id
        WHERE c.first_name ILIKE ${q} OR c.last_name ILIKE ${q}
           OR c.email ILIKE ${q} OR c.mobile ILIKE ${q} OR o.name ILIKE ${q}
           OR c.source ILIKE ${q} OR c.discipline ILIKE ${q}
           OR EXISTS (SELECT 1 FROM entity_contacts ec3 JOIN roles r2 ON r2.id = ec3.role_id WHERE ec3.contact_id = c.id AND r2.label ILIKE ${q})
           OR EXISTS (SELECT 1 FROM contact_marketing_categories cmc2 WHERE cmc2.contact_id = c.id AND cmc2.category ILIKE ${q})`;
      return res.status(200).json({ search, category_rows: catCount[0].n, category_sample: catSample, full_search_total: fullCount[0].n });
    }

    if (rex_id) {
      const log = await sql`SELECT * FROM rex_import_log WHERE rex_id = ${rex_id} AND entity_type='contact'`;
      if (!log.length) return res.status(404).json({ error: 'not found in log' });
      const cid = log[0].propmap_id;
      const contact = cid ? (await sql`SELECT id, first_name, last_name, email, source, marketing_pref_set_at, marketing_email_consent_at, marketing_sms_consent_at FROM contacts WHERE id = ${cid}`)[0] : null;
      const notes   = cid ? await sql`SELECT id, note_text, interaction_type, source FROM notes WHERE entity_type='contact' AND entity_id = ${String(cid)}` : [];
      const cats    = cid ? await sql`SELECT category FROM contact_marketing_categories WHERE contact_id = ${cid}` : [];
      const roles   = cid ? await sql`SELECT role_id FROM entity_contacts WHERE contact_id = ${cid}` : [];
      return res.status(200).json({ log: log[0], contact, notes, categories: cats, roles });
    }

    const cat_counts = await sql`SELECT category, COUNT(*)::int AS n FROM contact_marketing_categories GROUP BY category ORDER BY n DESC LIMIT 20`;
    const errors     = await sql`SELECT detail, COUNT(*)::int AS n FROM rex_import_log WHERE status = 'error' GROUP BY detail ORDER BY n DESC LIMIT 10`;
    return res.status(200).json({ cat_counts, errors });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
