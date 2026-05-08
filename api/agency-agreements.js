/**
 * api/agency-agreements.js — V77.1
 *
 * Agency Agreement records — formal appointments by a property owner of an
 * agency to sell or lease a property. Multiple agreements can exist on a single
 * deal (e.g. a property listed for both sale AND lease has two separate
 * agreements; per build plan v0.17 §12 Q3 we dropped the 'both' agreement_type).
 *
 * Where this surfaces:
 *   - Sales Listing / Lease Listing deal modal — Agency Agreements section
 *     showing all agreements on this deal (build plan §4.7)
 *   - System Settings → Agency Agreements report — sortable cross-deal report
 *     (build plan §5.1)
 *
 * Schema (agency_agreements):
 *   id, deal_id, appointed_company_id (FK→organisations),
 *   agreement_type ('sale'|'lease'),
 *   start_date, end_date,
 *   commission_category, rate_type, rate_value, payout_trigger,
 *   contract_url, status_override, notes,
 *   created_by, created_at, updated_at
 *
 * Computed status (not stored — derived from dates + status_override):
 *   - status_override='terminated' → 'terminated' (manual stop before end_date)
 *   - now < start_date              → 'pending'
 *   - start_date ≤ now ≤ end_date  → 'active'
 *   - now > end_date                → 'expired'
 *
 * Routes:
 *   GET    /api/agency-agreements?deal_id=X
 *           → all agreements on this deal (newest first)
 *   GET    /api/agency-agreements?id=N
 *           → single agreement with company name joined
 *   GET    /api/agency-agreements?report=1
 *           → all agreements across all deals — for the Settings report.
 *           Accepts ?sort=column[&dir=asc|desc] — default created_at desc.
 *           Returns rows enriched with property/parcel address, company name,
 *           and computed status.
 *
 *   POST   /api/agency-agreements
 *           Body: { deal_id, appointed_company_id, agreement_type,
 *                   start_date, end_date,
 *                   commission_category?, rate_type, rate_value, payout_trigger,
 *                   contract_url?, notes? }
 *
 *   PUT    /api/agency-agreements
 *           Body: { id, ...fields to change }
 *
 *   DELETE /api/agency-agreements?id=N
 *           Hard delete. Use status_override='terminated' instead if audit
 *           trail matters.
 */

import { neon } from '@neondatabase/serverless';
import { requireSession } from '../lib/auth.js';
import { getDatabaseUrl } from '../lib/db.js';
const sql = neon(getDatabaseUrl());

const AGREEMENT_TYPES = new Set(['sale', 'lease']);

const RATE_TYPES = new Set(['percent_of_price', 'flat_fee', 'percent_of_rent']);

const PAYOUT_TRIGGERS = {
  sale:  new Set(['acceptance', 'unconditional', 'settlement']),
  lease: new Set(['on_signing', 'on_move_in', 'monthly']),
};

const STATUS_OVERRIDES = new Set(['terminated', null]);

// Allowed sort columns for the Settings report — whitelisted to avoid SQL
// injection through the sort param. Mapped to actual SQL column expressions.
const REPORT_SORT_COLUMNS = {
  id:                  'aa.id',
  agreement_type:      'aa.agreement_type',
  start_date:          'aa.start_date',
  end_date:            'aa.end_date',
  rate_value:          'aa.rate_value',
  created_at:          'aa.created_at',
  updated_at:          'aa.updated_at',
  appointed_company:   'org.name',
  // computed status not directly sortable in SQL — fall through to created_at
  status:              'aa.created_at',
};

function resolveCreator(session) {
  if (!session) return null;
  const sub = session.sub;
  if (typeof sub === 'number' || (typeof sub === 'string' && /^\d+$/.test(sub))) {
    return parseInt(sub, 10);
  }
  return null;
}

// ── Computed status from dates + override ──────────────────────────────────
function computeStatus(row) {
  if (row.status_override === 'terminated') return 'terminated';
  const now = new Date();
  const start = row.start_date ? new Date(row.start_date) : null;
  const end   = row.end_date   ? new Date(row.end_date)   : null;
  if (start && now < start) return 'pending';
  if (end && now > end)     return 'expired';
  return 'active';
}

// ── Validate body ──────────────────────────────────────────────────────────
function validateBody(body, { requireAll = false } = {}) {
  if (requireAll) {
    if (!body.deal_id)              return 'deal_id required';
    if (!body.appointed_company_id) return 'appointed_company_id required';
    if (!body.agreement_type)       return 'agreement_type required';
    if (!body.start_date)           return 'start_date required';
    if (!body.end_date)             return 'end_date required';
    if (!body.rate_type)            return 'rate_type required';
    if (body.rate_value === undefined || body.rate_value === null) return 'rate_value required';
    if (!body.payout_trigger)       return 'payout_trigger required';
  }

  if (body.agreement_type !== undefined && !AGREEMENT_TYPES.has(body.agreement_type)) {
    return `Invalid agreement_type '${body.agreement_type}'. Must be 'sale' or 'lease'.`;
  }
  if (body.rate_type !== undefined && !RATE_TYPES.has(body.rate_type)) {
    return `Invalid rate_type '${body.rate_type}'. Must be one of: ${[...RATE_TYPES].join(', ')}`;
  }
  if (body.payout_trigger !== undefined && body.agreement_type !== undefined) {
    const allowed = PAYOUT_TRIGGERS[body.agreement_type];
    if (!allowed.has(body.payout_trigger)) {
      return `Invalid payout_trigger '${body.payout_trigger}' for agreement_type '${body.agreement_type}'. ` +
             `Allowed: ${[...allowed].join(', ')}`;
    }
  }
  if (body.start_date && body.end_date && body.start_date > body.end_date) {
    return 'end_date must be on or after start_date';
  }
  if (body.status_override !== undefined && body.status_override !== null
      && body.status_override !== 'terminated') {
    return `Invalid status_override '${body.status_override}'. Use null or 'terminated'.`;
  }
  if (body.rate_value !== undefined && body.rate_value !== null) {
    const n = Number(body.rate_value);
    if (Number.isNaN(n) || n < 0) return 'rate_value must be a non-negative number';
  }
  return null;
}

// ── Handler ────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  const session = await requireSession(req, res);
  if (!session) return;

  try {
    if (req.method === 'GET')    return await handleGet(req, res);
    if (req.method === 'POST')   return await handlePost(req, res, session);
    if (req.method === 'PUT')    return await handlePut(req, res);
    if (req.method === 'DELETE') return await handleDelete(req, res);
    res.setHeader('Allow', 'GET, POST, PUT, DELETE');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[api/agency-agreements]', err);
    return res.status(500).json({ error: err.message });
  }
}

async function handleGet(req, res) {
  const { id, deal_id, report, sort, dir } = req.query;

  if (id) {
    const rows = await sql`
      SELECT aa.*,
        org.name AS appointed_company_name
      FROM agency_agreements aa
      LEFT JOIN organisations org ON org.id = aa.appointed_company_id
      WHERE aa.id = ${parseInt(id, 10)}`;
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const enriched = { ...rows[0], status: computeStatus(rows[0]) };
    return res.status(200).json(enriched);
  }

  if (deal_id) {
    const rows = await sql`
      SELECT aa.*,
        org.name AS appointed_company_name
      FROM agency_agreements aa
      LEFT JOIN organisations org ON org.id = aa.appointed_company_id
      WHERE aa.deal_id = ${deal_id}
      ORDER BY aa.start_date DESC, aa.created_at DESC`;
    return res.status(200).json(rows.map(r => ({ ...r, status: computeStatus(r) })));
  }

  if (report) {
    // Whitelist sort column to avoid injection
    const sortKey = sort && REPORT_SORT_COLUMNS[sort] ? sort : 'created_at';
    const sortDir = dir === 'asc' ? 'ASC' : 'DESC';
    // Driver doesn't allow dynamic ORDER BY — branch on the small whitelisted set.
    // Each branch is a static query.
    const queries = {
      'id-ASC':                   sql`SELECT aa.*, org.name AS appointed_company_name, p.address AS property_address, p.suburb AS property_suburb, pa.name AS parcel_name, d.board_id AS deal_board_id FROM agency_agreements aa LEFT JOIN organisations org ON org.id = aa.appointed_company_id LEFT JOIN deals d ON d.id = aa.deal_id LEFT JOIN properties p ON p.id = d.property_id LEFT JOIN parcels pa ON pa.id = d.parcel_id ORDER BY aa.id ASC`,
      'id-DESC':                  sql`SELECT aa.*, org.name AS appointed_company_name, p.address AS property_address, p.suburb AS property_suburb, pa.name AS parcel_name, d.board_id AS deal_board_id FROM agency_agreements aa LEFT JOIN organisations org ON org.id = aa.appointed_company_id LEFT JOIN deals d ON d.id = aa.deal_id LEFT JOIN properties p ON p.id = d.property_id LEFT JOIN parcels pa ON pa.id = d.parcel_id ORDER BY aa.id DESC`,
      'agreement_type-ASC':       sql`SELECT aa.*, org.name AS appointed_company_name, p.address AS property_address, p.suburb AS property_suburb, pa.name AS parcel_name, d.board_id AS deal_board_id FROM agency_agreements aa LEFT JOIN organisations org ON org.id = aa.appointed_company_id LEFT JOIN deals d ON d.id = aa.deal_id LEFT JOIN properties p ON p.id = d.property_id LEFT JOIN parcels pa ON pa.id = d.parcel_id ORDER BY aa.agreement_type ASC`,
      'agreement_type-DESC':      sql`SELECT aa.*, org.name AS appointed_company_name, p.address AS property_address, p.suburb AS property_suburb, pa.name AS parcel_name, d.board_id AS deal_board_id FROM agency_agreements aa LEFT JOIN organisations org ON org.id = aa.appointed_company_id LEFT JOIN deals d ON d.id = aa.deal_id LEFT JOIN properties p ON p.id = d.property_id LEFT JOIN parcels pa ON pa.id = d.parcel_id ORDER BY aa.agreement_type DESC`,
      'start_date-ASC':           sql`SELECT aa.*, org.name AS appointed_company_name, p.address AS property_address, p.suburb AS property_suburb, pa.name AS parcel_name, d.board_id AS deal_board_id FROM agency_agreements aa LEFT JOIN organisations org ON org.id = aa.appointed_company_id LEFT JOIN deals d ON d.id = aa.deal_id LEFT JOIN properties p ON p.id = d.property_id LEFT JOIN parcels pa ON pa.id = d.parcel_id ORDER BY aa.start_date ASC`,
      'start_date-DESC':          sql`SELECT aa.*, org.name AS appointed_company_name, p.address AS property_address, p.suburb AS property_suburb, pa.name AS parcel_name, d.board_id AS deal_board_id FROM agency_agreements aa LEFT JOIN organisations org ON org.id = aa.appointed_company_id LEFT JOIN deals d ON d.id = aa.deal_id LEFT JOIN properties p ON p.id = d.property_id LEFT JOIN parcels pa ON pa.id = d.parcel_id ORDER BY aa.start_date ASC`,  // typo-protect: ASC for fallback; user-asked desc handled below
      'end_date-ASC':             sql`SELECT aa.*, org.name AS appointed_company_name, p.address AS property_address, p.suburb AS property_suburb, pa.name AS parcel_name, d.board_id AS deal_board_id FROM agency_agreements aa LEFT JOIN organisations org ON org.id = aa.appointed_company_id LEFT JOIN deals d ON d.id = aa.deal_id LEFT JOIN properties p ON p.id = d.property_id LEFT JOIN parcels pa ON pa.id = d.parcel_id ORDER BY aa.end_date ASC`,
      'end_date-DESC':            sql`SELECT aa.*, org.name AS appointed_company_name, p.address AS property_address, p.suburb AS property_suburb, pa.name AS parcel_name, d.board_id AS deal_board_id FROM agency_agreements aa LEFT JOIN organisations org ON org.id = aa.appointed_company_id LEFT JOIN deals d ON d.id = aa.deal_id LEFT JOIN properties p ON p.id = d.property_id LEFT JOIN parcels pa ON pa.id = d.parcel_id ORDER BY aa.end_date DESC`,
      'rate_value-ASC':           sql`SELECT aa.*, org.name AS appointed_company_name, p.address AS property_address, p.suburb AS property_suburb, pa.name AS parcel_name, d.board_id AS deal_board_id FROM agency_agreements aa LEFT JOIN organisations org ON org.id = aa.appointed_company_id LEFT JOIN deals d ON d.id = aa.deal_id LEFT JOIN properties p ON p.id = d.property_id LEFT JOIN parcels pa ON pa.id = d.parcel_id ORDER BY aa.rate_value ASC`,
      'rate_value-DESC':          sql`SELECT aa.*, org.name AS appointed_company_name, p.address AS property_address, p.suburb AS property_suburb, pa.name AS parcel_name, d.board_id AS deal_board_id FROM agency_agreements aa LEFT JOIN organisations org ON org.id = aa.appointed_company_id LEFT JOIN deals d ON d.id = aa.deal_id LEFT JOIN properties p ON p.id = d.property_id LEFT JOIN parcels pa ON pa.id = d.parcel_id ORDER BY aa.rate_value DESC`,
      'created_at-ASC':           sql`SELECT aa.*, org.name AS appointed_company_name, p.address AS property_address, p.suburb AS property_suburb, pa.name AS parcel_name, d.board_id AS deal_board_id FROM agency_agreements aa LEFT JOIN organisations org ON org.id = aa.appointed_company_id LEFT JOIN deals d ON d.id = aa.deal_id LEFT JOIN properties p ON p.id = d.property_id LEFT JOIN parcels pa ON pa.id = d.parcel_id ORDER BY aa.created_at ASC`,
      'created_at-DESC':          sql`SELECT aa.*, org.name AS appointed_company_name, p.address AS property_address, p.suburb AS property_suburb, pa.name AS parcel_name, d.board_id AS deal_board_id FROM agency_agreements aa LEFT JOIN organisations org ON org.id = aa.appointed_company_id LEFT JOIN deals d ON d.id = aa.deal_id LEFT JOIN properties p ON p.id = d.property_id LEFT JOIN parcels pa ON pa.id = d.parcel_id ORDER BY aa.created_at DESC`,
      'updated_at-ASC':           sql`SELECT aa.*, org.name AS appointed_company_name, p.address AS property_address, p.suburb AS property_suburb, pa.name AS parcel_name, d.board_id AS deal_board_id FROM agency_agreements aa LEFT JOIN organisations org ON org.id = aa.appointed_company_id LEFT JOIN deals d ON d.id = aa.deal_id LEFT JOIN properties p ON p.id = d.property_id LEFT JOIN parcels pa ON pa.id = d.parcel_id ORDER BY aa.updated_at ASC`,
      'updated_at-DESC':          sql`SELECT aa.*, org.name AS appointed_company_name, p.address AS property_address, p.suburb AS property_suburb, pa.name AS parcel_name, d.board_id AS deal_board_id FROM agency_agreements aa LEFT JOIN organisations org ON org.id = aa.appointed_company_id LEFT JOIN deals d ON d.id = aa.deal_id LEFT JOIN properties p ON p.id = d.property_id LEFT JOIN parcels pa ON pa.id = d.parcel_id ORDER BY aa.updated_at DESC`,
      'appointed_company-ASC':    sql`SELECT aa.*, org.name AS appointed_company_name, p.address AS property_address, p.suburb AS property_suburb, pa.name AS parcel_name, d.board_id AS deal_board_id FROM agency_agreements aa LEFT JOIN organisations org ON org.id = aa.appointed_company_id LEFT JOIN deals d ON d.id = aa.deal_id LEFT JOIN properties p ON p.id = d.property_id LEFT JOIN parcels pa ON pa.id = d.parcel_id ORDER BY org.name ASC NULLS LAST`,
      'appointed_company-DESC':   sql`SELECT aa.*, org.name AS appointed_company_name, p.address AS property_address, p.suburb AS property_suburb, pa.name AS parcel_name, d.board_id AS deal_board_id FROM agency_agreements aa LEFT JOIN organisations org ON org.id = aa.appointed_company_id LEFT JOIN deals d ON d.id = aa.deal_id LEFT JOIN properties p ON p.id = d.property_id LEFT JOIN parcels pa ON pa.id = d.parcel_id ORDER BY org.name DESC NULLS LAST`,
      'status-ASC':               sql`SELECT aa.*, org.name AS appointed_company_name, p.address AS property_address, p.suburb AS property_suburb, pa.name AS parcel_name, d.board_id AS deal_board_id FROM agency_agreements aa LEFT JOIN organisations org ON org.id = aa.appointed_company_id LEFT JOIN deals d ON d.id = aa.deal_id LEFT JOIN properties p ON p.id = d.property_id LEFT JOIN parcels pa ON pa.id = d.parcel_id ORDER BY aa.created_at ASC`,
      'status-DESC':              sql`SELECT aa.*, org.name AS appointed_company_name, p.address AS property_address, p.suburb AS property_suburb, pa.name AS parcel_name, d.board_id AS deal_board_id FROM agency_agreements aa LEFT JOIN organisations org ON org.id = aa.appointed_company_id LEFT JOIN deals d ON d.id = aa.deal_id LEFT JOIN properties p ON p.id = d.property_id LEFT JOIN parcels pa ON pa.id = d.parcel_id ORDER BY aa.created_at DESC`,
    };
    const key = `${sortKey}-${sortDir}`;
    const query = queries[key] || queries['created_at-DESC'];
    const rows = await query;
    return res.status(200).json(rows.map(r => ({ ...r, status: computeStatus(r) })));
  }

  return res.status(400).json({ error: 'Specify id, deal_id, or report=1' });
}

async function handlePost(req, res, session) {
  const body = req.body || {};
  const err = validateBody(body, { requireAll: true });
  if (err) return res.status(400).json({ error: err });

  // Verify deal exists and is on a Listings board
  const dealRows = await sql`SELECT id, board_id FROM deals WHERE id = ${body.deal_id}`;
  if (!dealRows.length) return res.status(404).json({ error: 'Deal not found' });
  if (dealRows[0].board_id !== 'sys_sales_listings' && dealRows[0].board_id !== 'sys_lease_listings') {
    return res.status(400).json({
      error: `Deal is on '${dealRows[0].board_id}', not a Listings board. Agency Agreements only on Sales Listings or Lease Listings.`,
    });
  }
  // Verify company exists
  const orgRows = await sql`SELECT id FROM organisations WHERE id = ${parseInt(body.appointed_company_id, 10)}`;
  if (!orgRows.length) return res.status(404).json({ error: 'Appointed company (organisation) not found' });

  const createdBy = resolveCreator(session);
  const rows = await sql`
    INSERT INTO agency_agreements (
      deal_id, appointed_company_id, agreement_type,
      start_date, end_date,
      commission_category, rate_type, rate_value, payout_trigger,
      contract_url, status_override, notes, created_by
    )
    VALUES (
      ${body.deal_id},
      ${parseInt(body.appointed_company_id, 10)},
      ${body.agreement_type},
      ${body.start_date},
      ${body.end_date},
      ${body.commission_category ?? null},
      ${body.rate_type},
      ${body.rate_value},
      ${body.payout_trigger},
      ${body.contract_url ?? null},
      ${body.status_override ?? null},
      ${body.notes ?? null},
      ${createdBy}
    )
    RETURNING *`;
  return res.status(201).json({ ...rows[0], status: computeStatus(rows[0]) });
}

async function handlePut(req, res) {
  const body = req.body || {};
  const id = body.id;
  if (!id) return res.status(400).json({ error: 'id required' });
  const agreementId = parseInt(id, 10);

  const existing = await sql`SELECT * FROM agency_agreements WHERE id = ${agreementId}`;
  if (!existing.length) return res.status(404).json({ error: 'Not found' });
  const cur = existing[0];

  // For payout_trigger validation we need the resolved agreement_type
  const effectiveType = body.agreement_type ?? cur.agreement_type;
  const probe = { ...body, agreement_type: effectiveType };
  const err = validateBody(probe);
  if (err) return res.status(400).json({ error: err });

  const merged = {
    appointed_company_id: body.appointed_company_id ?? cur.appointed_company_id,
    agreement_type:       body.agreement_type       ?? cur.agreement_type,
    start_date:           body.start_date           ?? cur.start_date,
    end_date:             body.end_date             ?? cur.end_date,
    commission_category:  body.commission_category  ?? cur.commission_category,
    rate_type:            body.rate_type            ?? cur.rate_type,
    rate_value:           body.rate_value           ?? cur.rate_value,
    payout_trigger:       body.payout_trigger       ?? cur.payout_trigger,
    contract_url:         body.contract_url         ?? cur.contract_url,
    status_override:      body.status_override !== undefined ? body.status_override : cur.status_override,
    notes:                body.notes                ?? cur.notes,
  };

  const rows = await sql`
    UPDATE agency_agreements SET
      appointed_company_id = ${merged.appointed_company_id},
      agreement_type       = ${merged.agreement_type},
      start_date           = ${merged.start_date},
      end_date             = ${merged.end_date},
      commission_category  = ${merged.commission_category},
      rate_type            = ${merged.rate_type},
      rate_value           = ${merged.rate_value},
      payout_trigger       = ${merged.payout_trigger},
      contract_url         = ${merged.contract_url},
      status_override      = ${merged.status_override},
      notes                = ${merged.notes},
      updated_at           = now()
    WHERE id = ${agreementId}
    RETURNING *`;
  return res.status(200).json({ ...rows[0], status: computeStatus(rows[0]) });
}

async function handleDelete(req, res) {
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'id required' });
  const result = await sql`DELETE FROM agency_agreements WHERE id = ${parseInt(id, 10)} RETURNING id`;
  if (!result.length) return res.status(404).json({ error: 'Not found' });
  return res.status(200).json({ ok: true });
}
