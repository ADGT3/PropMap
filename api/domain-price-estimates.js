/**
 * api/domain-price-estimates.js
 *
 * Cache for derived price ranges on Domain listings where the agent
 * has withheld the price (displayPrice = "Contact Agent" / "MAKE AN OFFER" /
 * "Auction" etc, with priceFrom/priceTo both null).
 *
 * Derivation logic lives client-side in domain-api.js (see revealHiddenPrices);
 * this endpoint just stores/retrieves the result.
 *
 * GET    /api/domain-price-estimates?ids=123,456,789  → { "123": {from, to, derivedAt}, ... }
 * POST   /api/domain-price-estimates                  → upsert one or many
 *        body: { estimates: [{ domainId, priceFrom, priceTo }, ...] }
 * DELETE /api/domain-price-estimates?id=123           → invalidate one (used when
 *        Domain later returns a real price for that id)
 *
 * Auto-creates table on first use. Safe to re-run.
 */

import { neon } from '@neondatabase/serverless';
import { getDatabaseUrl } from '../lib/db.js';

const sql = neon(getDatabaseUrl());

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Auto-create table on first use
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS domain_price_estimates (
        domain_id   TEXT PRIMARY KEY,
        price_from  BIGINT,
        price_to    BIGINT,
        derived_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `;
  } catch (err) {
    return res.status(500).json({ error: 'DB init failed', detail: err.message });
  }

  // ─── GET: batch lookup by ids ──────────────────────────────────────────────
  if (req.method === 'GET') {
    try {
      const idsParam = (req.query.ids || '').trim();
      if (!idsParam) return res.status(200).json({});
      const ids = idsParam.split(',').map(s => s.trim()).filter(Boolean);
      if (!ids.length) return res.status(200).json({});

      const rows = await sql`
        SELECT domain_id, price_from, price_to, derived_at
        FROM domain_price_estimates
        WHERE domain_id = ANY(${ids})
      `;

      const out = {};
      rows.forEach(r => {
        out[r.domain_id] = {
          from:      r.price_from === null ? null : Number(r.price_from),
          to:        r.price_to   === null ? null : Number(r.price_to),
          derivedAt: r.derived_at,
        };
      });
      return res.status(200).json(out);
    } catch (err) {
      return res.status(500).json({ error: 'Read failed', detail: err.message });
    }
  }

  // ─── POST: bulk upsert ─────────────────────────────────────────────────────
  if (req.method === 'POST') {
    const body = req.body || {};
    const estimates = Array.isArray(body.estimates) ? body.estimates : [];
    if (!estimates.length) return res.status(400).json({ error: 'estimates array required' });

    try {
      let written = 0;
      for (const e of estimates) {
        const id = String(e.domainId || '').trim();
        if (!id) continue;
        const from = e.priceFrom === null || e.priceFrom === undefined ? null : Number(e.priceFrom);
        const to   = e.priceTo   === null || e.priceTo   === undefined ? null : Number(e.priceTo);
        await sql`
          INSERT INTO domain_price_estimates (domain_id, price_from, price_to, derived_at)
          VALUES (${id}, ${from}, ${to}, NOW())
          ON CONFLICT (domain_id) DO UPDATE
            SET price_from = EXCLUDED.price_from,
                price_to   = EXCLUDED.price_to,
                derived_at = NOW()
        `;
        written++;
      }
      return res.status(200).json({ ok: true, written });
    } catch (err) {
      return res.status(500).json({ error: 'Write failed', detail: err.message });
    }
  }

  // ─── DELETE: invalidate one (used when Domain returns a real price) ────────
  if (req.method === 'DELETE') {
    const id = (req.query.id || '').trim();
    if (!id) return res.status(400).json({ error: 'id required' });
    try {
      await sql`DELETE FROM domain_price_estimates WHERE domain_id = ${id}`;
      return res.status(200).json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: 'Delete failed', detail: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
