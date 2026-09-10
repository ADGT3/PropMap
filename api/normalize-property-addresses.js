/**
 * POST /api/normalize-property-addresses
 *   { confirm: true }                         → all dirty rows
 *   { confirm: true, q: "89A Kent" }          → only matching address
 *   { confirm: true, id: "prop_..." }         → one id
 *   { confirm: true, q: "89A Kent", dryRun: true }  → preview, no writes
 *
 * GET  /api/normalize-property-addresses
 * GET  /api/normalize-property-addresses?q=89A%20Kent
 *
 * Strips suburb / state / postcode off properties.address and fills those
 * columns only when they are empty. Idempotent.
 */
import { neon } from '@neondatabase/serverless';
import { getDatabaseUrl } from '../lib/db.js';
import { requireSession, requireModule } from '../lib/auth.js';
import { parsePropertyAddress } from '../lib/split-property-address.js';

const sql = neon(getDatabaseUrl());

function nextRow(r) {
  const p = parsePropertyAddress(r.address, r);
  const existingSuburb = String(r.suburb || '').replace(/\s+/g, ' ').trim();
  const existingState = String(r.state || '').trim();
  const existingPc = String(r.postcode || '').trim();
  return {
    address: p.address || String(r.address || '').replace(/\s+/g, ' ').trim(),
    suburb: existingSuburb || p.suburb || '',
    state: existingState || p.state || 'NSW',
    postcode: existingPc || p.postcode || '',
  };
}

function rowDirty(r, next) {
  const origAddr = String(r.address || '').replace(/\s+/g, ' ').trim();
  return next.address !== origAddr
    || next.suburb !== String(r.suburb || '').replace(/\s+/g, ' ').trim()
    || next.state !== String(r.state || '').trim()
    || next.postcode !== String(r.postcode || '').trim();
}

function matchesFilter(r, { id, q }) {
  if (id) return String(r.id) === String(id);
  if (q) return String(r.address || '').toLowerCase().includes(String(q).toLowerCase());
  return true;
}

async function columnExists(column) {
  const rows = await sql`
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='properties' AND column_name=${column}
     LIMIT 1`;
  return rows.length > 0;
}

async function loadRows() {
  const hasPc = await columnExists('postcode');
  const rows = hasPc
    ? await sql`SELECT id, address, suburb, state, postcode FROM properties`
    : await sql`SELECT id, address, suburb, state FROM properties`;
  return { rows, hasPc };
}

async function statusReport(filter = {}) {
  const { rows, hasPc } = await loadRows();
  const selected = rows.filter(r => matchesFilter(r, filter));
  const planned = selected
    .map(r => ({ id: r.id, from: r.address, to: nextRow(r) }))
    .filter(x => rowDirty(selected.find(r => r.id === x.id), x.to));
  return {
    total: rows.length,
    matched: selected.length,
    would_update: planned.length,
    postcode_column: hasPc,
    samples: planned.slice(0, 8),
  };
}

async function run({ id, q, dryRun } = {}) {
  if (!(await columnExists('postcode'))) {
    await sql`ALTER TABLE properties ADD COLUMN postcode TEXT`;
  }
  const rows = await sql`SELECT id, address, suburb, state, postcode FROM properties`;
  const selected = rows.filter(r => matchesFilter(r, { id, q }));
  let updated = 0;
  let unchanged = 0;
  const samples = [];
  for (const r of selected) {
    const next = nextRow(r);
    if (!rowDirty(r, next)) {
      unchanged++;
      continue;
    }
    if (!dryRun) {
      await sql`
        UPDATE properties
           SET address    = ${next.address},
               suburb     = ${next.suburb || r.suburb},
               state      = ${next.state || r.state || 'NSW'},
               postcode   = COALESCE(${next.postcode || null}, postcode),
               updated_at = now()
         WHERE id = ${r.id}`;
    }
    updated++;
    if (samples.length < 8) {
      samples.push({ id: r.id, from: r.address, to: next.address, suburb: next.suburb, postcode: next.postcode });
    }
  }
  return {
    dryRun: !!dryRun,
    matched: selected.length,
    updated,
    unchanged,
    total: rows.length,
    samples,
  };
}

export default async function handler(req, res) {
  const session = await requireSession(req, res);
  if (!session) return;
  if (req.method === 'GET') {
    try {
      return res.status(200).json(await statusReport({
        id: req.query && req.query.id,
        q: req.query && req.query.q,
      }));
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }
  if (req.method === 'POST') {
    if (!requireModule(session, res, 'crm')) return;
    const body = req.body || {};
    if (body.confirm !== true) {
      return res.status(400).json({ error: 'POST { confirm: true } to run' });
    }
    try {
      return res.status(200).json({ ok: true, ...(await run({
        id: body.id,
        q: body.q,
        dryRun: body.dryRun === true,
      })) });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  }
  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
}
