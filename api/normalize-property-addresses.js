/**
 * POST /api/normalize-property-addresses  { confirm: true }
 * GET  /api/normalize-property-addresses
 *
 * Data migration: strip suburb / state / postcode off properties.address
 * and write them into those columns only when they are empty.
 * Does not overwrite an existing suburb/state/postcode.
 * Idempotent.
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

async function columnExists(column) {
  const rows = await sql`
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='properties' AND column_name=${column}
     LIMIT 1`;
  return rows.length > 0;
}

async function statusReport() {
  const hasPc = await columnExists('postcode');
  const rows = hasPc
    ? await sql`SELECT id, address, suburb, state, postcode FROM properties`
    : await sql`SELECT id, address, suburb, state FROM properties`;
  let dirty = 0;
  for (const r of rows) {
    if (rowDirty(r, nextRow(r))) dirty++;
  }
  return { total: rows.length, would_update: dirty, postcode_column: hasPc };
}

async function run() {
  if (!(await columnExists('postcode'))) {
    await sql`ALTER TABLE properties ADD COLUMN postcode TEXT`;
  }
  const rows = await sql`SELECT id, address, suburb, state, postcode FROM properties`;
  let updated = 0;
  let unchanged = 0;
  const samples = [];
  for (const r of rows) {
    const next = nextRow(r);
    if (!rowDirty(r, next)) {
      unchanged++;
      continue;
    }
    await sql`
      UPDATE properties
         SET address    = ${next.address},
             suburb     = ${next.suburb || r.suburb},
             state      = ${next.state || r.state || 'NSW'},
             postcode   = COALESCE(${next.postcode || null}, postcode),
             updated_at = now()
       WHERE id = ${r.id}`;
    updated++;
    if (samples.length < 8) {
      samples.push({ id: r.id, from: r.address, to: next.address, suburb: next.suburb, postcode: next.postcode });
    }
  }
  return { updated, unchanged, total: rows.length, samples };
}

export default async function handler(req, res) {
  const session = await requireSession(req, res);
  if (!session) return;
  if (req.method === 'GET') {
    try {
      return res.status(200).json(await statusReport());
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }
  if (req.method === 'POST') {
    if (!requireModule(session, res, 'crm')) return;
    if ((req.body || {}).confirm !== true) {
      return res.status(400).json({ error: 'POST { confirm: true } to run' });
    }
    try {
      return res.status(200).json({ ok: true, ...(await run()) });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  }
  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
}
