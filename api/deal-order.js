/**
 * api/deal-order.js
 * Per-user card ordering within a column.
 *
 *   GET  /api/deal-order?board_id=X
 *       → returns { deal_id: column_order } for the current user in that board
 *         (only rows where the deal is in this board). Missing entries mean
 *         "use default order" (client falls back to most-recent-first).
 *
 *   PUT  /api/deal-order
 *       body: { board_id, order: [{ deal_id, column_order }] }
 *       → upserts each row for the current user. Used after a drag-reorder;
 *         the client sends the full new ordering for that column.
 *
 * Per-user — no admin check needed. Uses session userId.
 */

import { neon } from '@neondatabase/serverless';
import { requireSession } from '../lib/auth.js';
import { getDatabaseUrl } from '../lib/db.js';
const sql = neon(getDatabaseUrl());

export default async function handler(req, res) {
  const session = await requireSession(req, res);
  if (!session) return;
  // V75.6: session.sub holds the contact id — auth.js JWT payload shape.
  // Fallback admin has sub='fallback' which isn't a real contact row.
  // Coerce to int: deal_user_order.user_id is INTEGER (matches contacts.id).
  const userIdRaw = (session.sub && session.sub !== 'fallback') ? session.sub : null;
  const userId    = userIdRaw != null ? parseInt(userIdRaw, 10) : null;
  if (!userId) return res.status(400).json({ error: 'Session user id missing; deal-ordering requires a real user account' });

  try {
    if (req.method === 'GET') {
      const { board_id } = req.query;
      if (!board_id) return res.status(400).json({ error: 'board_id required' });
      const rows = await sql`
        SELECT duo.deal_id, duo.column_order
        FROM deal_user_order duo
        INNER JOIN deals d ON d.id = duo.deal_id
        WHERE duo.user_id = ${userId}
          AND d.board_id  = ${board_id}`;
      const out = {};
      for (const r of rows) out[r.deal_id] = r.column_order;
      return res.status(200).json(out);
    }

    if (req.method === 'PUT') {
      const body = req.body || {};
      const { order } = body;
      if (!Array.isArray(order)) return res.status(400).json({ error: 'order[] required' });
      for (const row of order) {
        if (!row.deal_id || typeof row.column_order !== 'number') continue;
        await sql`
          INSERT INTO deal_user_order (user_id, deal_id, column_order)
          VALUES (${userId}, ${row.deal_id}, ${row.column_order})
          ON CONFLICT (user_id, deal_id) DO UPDATE
            SET column_order = EXCLUDED.column_order,
                updated_at   = now()`;
      }
      return res.status(200).json({ ok: true, updated: order.length });
    }

    res.setHeader('Allow', 'GET, PUT');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[deal-order API]', err);
    return res.status(500).json({ error: err.message });
  }
}
