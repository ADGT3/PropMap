/**
 * api/vendor-terms.js
 * CRUD for vendor_terms. Linked to deal and property.
 *
 * GET  ?deal_id=X     → terms for that deal (newest first)
 * GET  ?property_id=X → price history for that property (newest first)
 * POST                → create a snapshot
 * DELETE ?id=N        → remove a snapshot
 */

import { neon } from '@neondatabase/serverless';
import { requireSession, requireModule } from '../lib/auth.js';
import { getDatabaseUrl } from '../lib/db.js';
const sql = neon(getDatabaseUrl());

export default async function handler(req, res) {
  const session = await requireSession(req, res);
  if (!session) return;
  if (!requireModule(session, res, 'pipeline')) return;

  try {
    if (req.method === 'GET') {
      const { deal_id, property_id } = req.query;
      let rows;
      if (deal_id) {
        rows = await sql`SELECT * FROM vendor_terms WHERE deal_id = ${deal_id} ORDER BY captured_at DESC`;
      } else if (property_id) {
        rows = await sql`SELECT * FROM vendor_terms WHERE property_id = ${property_id} ORDER BY captured_at DESC`;
      } else {
        return res.status(400).json({ error: 'deal_id or property_id required' });
      }
      // Attach deposit lines
      for (const r of rows) {
        const deps = await sql`
          SELECT amount, due, note FROM vendor_term_deposits
          WHERE vendor_term_id = ${r.id} ORDER BY sort_order`;
        r.deposits = deps;
      }
      return res.status(200).json(rows);
    }

    if (req.method === 'POST') {
      const b = req.body || {};
      if (!b.deal_id) return res.status(400).json({ error: 'deal_id required' });
      const rows = await sql`
        INSERT INTO vendor_terms (deal_id, property_id, price, settlement, agent_name, agent_agency, captured_by)
        VALUES (
          ${b.deal_id},
          ${b.property_id || null},
          ${b.price || null},
          ${b.settlement || null},
          ${b.agent_name || null},
          ${b.agent_agency || null},
          ${b.captured_by || null}
        )
        RETURNING *`;
      const term = rows[0];
      const deps = Array.isArray(b.deposits) ? b.deposits : [];
      for (let i = 0; i < deps.length; i++) {
        const d = deps[i];
        if (d.amount == null && d.due == null && !d.note) continue;
        await sql`
          INSERT INTO vendor_term_deposits (vendor_term_id, amount, due, note, sort_order)
          VALUES (${term.id}, ${d.amount || null}, ${d.due || null}, ${d.note || null}, ${i})`;
      }
      term.deposits = deps;
      return res.status(201).json(term);
    }

    if (req.method === 'DELETE') {
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: 'id required' });
      await sql`DELETE FROM vendor_terms WHERE id = ${id}`;
      return res.status(200).json({ ok: true });
    }

    res.setHeader('Allow', 'GET, POST, DELETE');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[vendor-terms]', err);
    return res.status(500).json({ error: err.message });
  }
}
