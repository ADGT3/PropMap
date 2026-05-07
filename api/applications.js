/**
 * api/applications.js — V77.1
 *
 * Lease Offer (Application) record. One Lease Enquiry deal can have multiple
 * applications (Scenario A: revisions; Scenario C: withdrawn-then-resubmitted).
 * V77.1 builds the agent-side flow only — applications are created and edited
 * by agents on the deal modal. V77.2 adds the public form layer where applicants
 * submit Step 1 (offer details) and Step 2 (evidence) themselves.
 *
 * Schema overview:
 *
 *   applications  — top-level record
 *     id, deal_id, status, submitted_at, accepted_at, evidence_submitted_at,
 *     validated_at, requested_rent, bond_weeks, lease_term_months,
 *     preferred_start_date, terms, annual_income_claimed,
 *     credit_check_consent_at, tenancy_database_consent_at,
 *     occupants (jsonb), pets (jsonb), applicants_jsonb (jsonb),
 *     notes, created_by, created_at, updated_at
 *
 *   application_housing_history — per-applicant prior addresses with optional evidence
 *   application_income_history  — per-applicant income sources with optional evidence
 *
 * Status lifecycle (per build plan §4.4):
 *   draft → submitted → offer_accepted (or rejected) → evidence_submitted →
 *   validated → leased   (terminal)
 *   withdrawn (terminal, can happen from any non-terminal state)
 *   rejected  (terminal, can happen from submitted)
 *
 * Routes:
 *   GET    /api/applications?deal_id=X
 *           → all applications for that deal, newest first, with applicant_count summary
 *   GET    /api/applications?id=N
 *           → single application with nested housing_history + income_history arrays
 *   GET    /api/applications?id=N&with_children=1
 *           → same as above (default behaviour) — explicit flag for clarity
 *   GET    /api/applications?listing_deal_id=X
 *           → V77.1 cross-reference: all Lease Offers received across all enquirer
 *             households for this Lease Listing. Joins through Enquiry deals
 *             on the same property to find applications.
 *
 *   POST   /api/applications
 *           Body: { deal_id, status?, ...top-level fields,
 *                   housing_history?: [{...}], income_history?: [{...}] }
 *           Creates application + nested rows. Returns full record.
 *
 *   PUT    /api/applications
 *           Body: { id, ...fields to change,
 *                   housing_history?: [{...}], income_history?: [{...}] }
 *           Top-level fields update. Nested arrays REPLACE existing ones (full
 *           list semantics — easier than diff-based PUT for the agent UI).
 *           Status transitions validated against the lifecycle.
 *
 *   DELETE /api/applications?id=N
 *           Cascade-deletes housing/income children and applicant_form_tokens
 *           (FKs are ON DELETE CASCADE). Use status='withdrawn' instead when
 *           an audit trail matters.
 */

import { neon } from '@neondatabase/serverless';
import { requireSession } from '../lib/auth.js';
import { getDatabaseUrl } from '../lib/db.js';
const sql = neon(getDatabaseUrl());

// Status lifecycle — reachable transitions per build plan §4.4
const VALID_STATUSES = new Set([
  'draft', 'submitted', 'offer_accepted', 'rejected',
  'evidence_submitted', 'evidence_resubmit_requested',
  'validated', 'leased', 'withdrawn',
]);

const TERMINAL_STATUSES = new Set(['leased', 'withdrawn', 'rejected']);

const ALLOWED_TRANSITIONS = {
  draft:               new Set(['submitted', 'withdrawn']),
  submitted:           new Set(['offer_accepted', 'rejected', 'withdrawn']),
  offer_accepted:      new Set(['evidence_submitted', 'withdrawn']),
  rejected:            new Set([]),                                 // terminal
  evidence_submitted:  new Set(['validated', 'evidence_resubmit_requested', 'withdrawn']),
  evidence_resubmit_requested: new Set(['evidence_submitted', 'withdrawn']),
  validated:           new Set(['leased', 'withdrawn']),
  leased:              new Set([]),                                 // terminal
  withdrawn:           new Set([]),                                 // terminal
};

// Housing types matching what build plan §4.4.3 lists
const HOUSING_TYPES = new Set([
  'rented', 'mortgaged', 'owned_outright', 'living_with_family',
  'temporary', 'other',
]);

// Income types
const INCOME_TYPES = new Set([
  'employment', 'self_employed', 'pension', 'rental_income',
  'investments', 'savings', 'other',
]);

const TERM_UNITS = new Set(['days', 'months', 'years']);

function resolveCreator(session) {
  if (!session) return null;
  const sub = session.sub;
  if (typeof sub === 'number' || (typeof sub === 'string' && /^\d+$/.test(sub))) {
    return parseInt(sub, 10);
  }
  return null;
}

// ── Validation helpers ─────────────────────────────────────────────────────

function validateHousingEntry(h, idx) {
  if (!h.housing_type) return `housing_history[${idx}]: housing_type required`;
  if (!HOUSING_TYPES.has(h.housing_type)) return `housing_history[${idx}]: invalid housing_type '${h.housing_type}'`;
  if (!h.address) return `housing_history[${idx}]: address required`;
  if (h.term_unit !== undefined && h.term_unit !== null && !TERM_UNITS.has(h.term_unit)) {
    return `housing_history[${idx}]: invalid term_unit '${h.term_unit}'`;
  }
  return null;
}

function validateIncomeEntry(e, idx) {
  if (!e.income_type) return `income_history[${idx}]: income_type required`;
  if (!INCOME_TYPES.has(e.income_type)) return `income_history[${idx}]: invalid income_type '${e.income_type}'`;
  if (!e.income_source_name) return `income_history[${idx}]: income_source_name required`;
  if (e.term_unit !== undefined && e.term_unit !== null && !TERM_UNITS.has(e.term_unit)) {
    return `income_history[${idx}]: invalid term_unit '${e.term_unit}'`;
  }
  return null;
}

// ── Nested fetch helpers ───────────────────────────────────────────────────

async function fetchChildren(applicationId) {
  const [housing, income, evidence] = await Promise.all([
    sql`
      SELECT * FROM application_housing_history
      WHERE application_id = ${applicationId}
      ORDER BY sort_order, id`,
    sql`
      SELECT * FROM application_income_history
      WHERE application_id = ${applicationId}
      ORDER BY sort_order, id`,
    sql`
      SELECT id, applicant_contact_id, category, filename, mime_type, size_bytes,
             url, points_value, uploaded_at
      FROM application_evidence
      WHERE application_id = ${applicationId}
      ORDER BY uploaded_at`,
  ]);
  return { housing_history: housing, income_history: income, evidence };
}

async function applicationWithChildren(applicationId) {
  const rows = await sql`SELECT * FROM applications WHERE id = ${applicationId}`;
  if (!rows.length) return null;
  const children = await fetchChildren(applicationId);
  return { ...rows[0], ...children };
}

// ── Insert nested children for a fresh application ─────────────────────────

async function insertHousingHistory(applicationId, items) {
  const inserted = [];
  for (let i = 0; i < items.length; i++) {
    const h = items[i];
    const r = await sql`
      INSERT INTO application_housing_history (
        application_id, applicant_contact_id, housing_type, address,
        monthly_amount, term_value, term_unit, term_start_date, term_end_date,
        landlord_lender_name, landlord_lender_contact,
        evidence_url, evidence_label, notes, sort_order
      )
      VALUES (
        ${applicationId},
        ${h.applicant_contact_id ?? null},
        ${h.housing_type},
        ${h.address},
        ${h.monthly_amount         ?? null},
        ${h.term_value             ?? null},
        ${h.term_unit              ?? null},
        ${h.term_start_date        ?? null},
        ${h.term_end_date          ?? null},
        ${h.landlord_lender_name   ?? null},
        ${h.landlord_lender_contact?? null},
        ${h.evidence_url           ?? null},
        ${h.evidence_label         ?? null},
        ${h.notes                  ?? null},
        ${h.sort_order ?? i}
      )
      RETURNING *`;
    inserted.push(r[0]);
  }
  return inserted;
}

async function insertIncomeHistory(applicationId, items) {
  const inserted = [];
  for (let i = 0; i < items.length; i++) {
    const e = items[i];
    const r = await sql`
      INSERT INTO application_income_history (
        application_id, applicant_contact_id, income_type, income_source_name,
        role, annual_income, term_value, term_unit, term_start_date, term_end_date,
        employer_contact_name, employer_contact_email, employer_contact_mobile,
        evidence_url, evidence_label, notes, sort_order
      )
      VALUES (
        ${applicationId},
        ${e.applicant_contact_id    ?? null},
        ${e.income_type},
        ${e.income_source_name},
        ${e.role                    ?? null},
        ${e.annual_income           ?? null},
        ${e.term_value              ?? null},
        ${e.term_unit               ?? null},
        ${e.term_start_date         ?? null},
        ${e.term_end_date           ?? null},
        ${e.employer_contact_name   ?? null},
        ${e.employer_contact_email  ?? null},
        ${e.employer_contact_mobile ?? null},
        ${e.evidence_url            ?? null},
        ${e.evidence_label          ?? null},
        ${e.notes                   ?? null},
        ${e.sort_order ?? i}
      )
      RETURNING *`;
    inserted.push(r[0]);
  }
  return inserted;
}

// ── Status transition derivative timestamps ────────────────────────────────
//
// When status moves to a particular value, we also stamp the corresponding
// timestamp column. This keeps the "when did this happen" audit trail accurate
// without making the agent UI manage timestamps separately.
function timestampForStatus(status) {
  switch (status) {
    case 'submitted':           return { col: 'submitted_at',          val: 'now' };
    case 'offer_accepted':      return { col: 'accepted_at',           val: 'now' };
    case 'evidence_submitted':           return { col: 'evidence_submitted_at',  val: 'now' };
    case 'evidence_resubmit_requested':  return { col: 'resubmit_requested_at',  val: 'now' };
    case 'validated':                    return { col: 'validated_at',           val: 'now' };
    default: return null;
  }
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
    console.error('[api/applications]', err);
    return res.status(500).json({ error: err.message });
  }
}

async function handleGet(req, res) {
  const { id, deal_id, listing_deal_id } = req.query;

  // Single application with nested children
  if (id) {
    const result = await applicationWithChildren(parseInt(id, 10));
    if (!result) return res.status(404).json({ error: 'Not found' });
    return res.status(200).json(result);
  }

  // All applications for an Enquiry deal (returns shallow rows, no children)
  if (deal_id) {
    const rows = await sql`
      SELECT a.*,
        (SELECT COUNT(*)::int FROM application_housing_history h WHERE h.application_id = a.id) AS housing_count,
        (SELECT COUNT(*)::int FROM application_income_history  i WHERE i.application_id = a.id) AS income_count
      FROM applications a
      WHERE a.deal_id = ${deal_id}
      ORDER BY a.created_at DESC`;
    // V77.2d — for offers in/past evidence_submitted, hydrate housing/income/evidence
    // so the agent UI's review block has data to render. Skipped for draft/submitted/
    // offer_accepted to keep the list response light when no review data exists yet.
    const REVIEWABLE = new Set(['evidence_submitted', 'evidence_resubmit_requested', 'validated', 'leased']);
    for (const r of rows) {
      if (REVIEWABLE.has(r.status)) {
        const children = await fetchChildren(r.id);
        r.housing_history = children.housing_history;
        r.income_history  = children.income_history;
        r.evidence        = children.evidence;
      }
    }
    return res.status(200).json(rows);
  }

  // Cross-reference: all Lease Offers received across all enquirer households
  // for a given Lease Listing deal (build plan §4.5 — Lease Offers Received)
  if (listing_deal_id) {
    // Get the listing deal's property to find sibling enquiry deals
    const listing = await sql`
      SELECT id, board_id, property_id, parcel_id FROM deals WHERE id = ${listing_deal_id}`;
    if (!listing.length) return res.status(404).json({ error: 'Listing deal not found' });
    if (listing[0].board_id !== 'sys_lease_listings') {
      return res.status(400).json({ error: `Deal is on '${listing[0].board_id}', not Lease Listings` });
    }

    let enquiryRows;
    if (listing[0].property_id) {
      enquiryRows = await sql`
        SELECT id FROM deals
        WHERE board_id   = 'sys_lease_enquiry'
          AND property_id = ${listing[0].property_id}`;
    } else if (listing[0].parcel_id) {
      enquiryRows = await sql`
        SELECT id FROM deals
        WHERE board_id  = 'sys_lease_enquiry'
          AND parcel_id = ${listing[0].parcel_id}`;
    } else {
      return res.status(200).json([]);
    }
    if (!enquiryRows.length) return res.status(200).json([]);
    const enquiryIds = enquiryRows.map(r => r.id);

    const apps = await sql`
      SELECT a.*,
        (SELECT COUNT(*)::int FROM application_housing_history h WHERE h.application_id = a.id) AS housing_count,
        (SELECT COUNT(*)::int FROM application_income_history  i WHERE i.application_id = a.id) AS income_count
      FROM applications a
      WHERE a.deal_id = ANY(${enquiryIds})
      ORDER BY a.created_at DESC`;
    return res.status(200).json(apps);
  }

  return res.status(400).json({ error: 'Specify id, deal_id, or listing_deal_id' });
}

async function handlePost(req, res, session) {
  const body = req.body || {};
  const { deal_id } = body;
  if (!deal_id) return res.status(400).json({ error: 'deal_id required' });

  // Verify deal exists and is on a Lease Enquiry board
  const deal = await sql`SELECT id, board_id FROM deals WHERE id = ${deal_id}`;
  if (!deal.length) return res.status(404).json({ error: 'Deal not found' });
  if (deal[0].board_id !== 'sys_lease_enquiry') {
    return res.status(400).json({
      error: `Deal is on '${deal[0].board_id}', not Lease Enquiry — applications must be on Lease Enquiry deals`,
    });
  }

  // Validate status if provided
  const status = body.status || 'draft';
  if (!VALID_STATUSES.has(status)) {
    return res.status(400).json({ error: `Invalid status '${status}'` });
  }

  // Validate nested children if provided
  const housing = Array.isArray(body.housing_history) ? body.housing_history : [];
  const income  = Array.isArray(body.income_history)  ? body.income_history  : [];
  for (let i = 0; i < housing.length; i++) {
    const err = validateHousingEntry(housing[i], i);
    if (err) return res.status(400).json({ error: err });
  }
  for (let i = 0; i < income.length; i++) {
    const err = validateIncomeEntry(income[i], i);
    if (err) return res.status(400).json({ error: err });
  }

  const createdBy = resolveCreator(session);
  const submittedAt           = status === 'submitted'          ? new Date().toISOString() : null;
  const acceptedAt            = status === 'offer_accepted'     ? new Date().toISOString() : null;
  const evidenceSubmittedAt   = status === 'evidence_submitted' ? new Date().toISOString() : null;
  const validatedAt           = status === 'validated'          ? new Date().toISOString() : null;

  const rows = await sql`
    INSERT INTO applications (
      deal_id, status,
      submitted_at, accepted_at, evidence_submitted_at, validated_at,
      requested_rent, bond_weeks, lease_term_months, preferred_start_date,
      terms, annual_income_claimed,
      credit_check_consent_at, tenancy_database_consent_at,
      occupants, pets, applicants_jsonb,
      notes, created_by
    )
    VALUES (
      ${deal_id}, ${status},
      ${submittedAt}, ${acceptedAt}, ${evidenceSubmittedAt}, ${validatedAt},
      ${body.requested_rent      ?? null},
      ${body.bond_weeks          ?? 4},
      ${body.lease_term_months   ?? null},
      ${body.preferred_start_date?? null},
      ${body.terms               ?? null},
      ${body.annual_income_claimed ?? null},
      ${body.credit_check_consent_at      ?? null},
      ${body.tenancy_database_consent_at  ?? null},
      ${body.occupants         ? JSON.stringify(body.occupants)        : null}::jsonb,
      ${body.pets              ? JSON.stringify(body.pets)             : null}::jsonb,
      ${body.applicants_jsonb  ? JSON.stringify(body.applicants_jsonb) : null}::jsonb,
      ${body.notes ?? null},
      ${createdBy}
    )
    RETURNING *`;
  const application = rows[0];

  if (housing.length) await insertHousingHistory(application.id, housing);
  if (income.length)  await insertIncomeHistory(application.id, income);

  const result = await applicationWithChildren(application.id);
  return res.status(201).json(result);
}

async function handlePut(req, res) {
  const body = req.body || {};
  const id = body.id;
  if (!id) return res.status(400).json({ error: 'id required' });
  const applicationId = parseInt(id, 10);

  // Fetch existing for transition validation
  const existing = await sql`SELECT * FROM applications WHERE id = ${applicationId}`;
  if (!existing.length) return res.status(404).json({ error: 'Not found' });
  const cur = existing[0];

  // Validate status transition if status is changing
  let nextStatus = cur.status;
  let derivedTimestamp = null;
  if (body.status !== undefined && body.status !== cur.status) {
    if (!VALID_STATUSES.has(body.status)) {
      return res.status(400).json({ error: `Invalid status '${body.status}'` });
    }
    const allowed = ALLOWED_TRANSITIONS[cur.status] || new Set();
    if (!allowed.has(body.status)) {
      return res.status(400).json({
        error: `Invalid status transition: ${cur.status} → ${body.status}. ` +
               `Allowed from '${cur.status}': ${[...allowed].join(', ') || '(none — terminal state)'}`,
      });
    }
    nextStatus = body.status;
    const ts = timestampForStatus(nextStatus);
    if (ts) derivedTimestamp = ts;
  }

  // Validate nested children if provided
  const replaceHousing = Array.isArray(body.housing_history);
  const replaceIncome  = Array.isArray(body.income_history);
  if (replaceHousing) {
    for (let i = 0; i < body.housing_history.length; i++) {
      const err = validateHousingEntry(body.housing_history[i], i);
      if (err) return res.status(400).json({ error: err });
    }
  }
  if (replaceIncome) {
    for (let i = 0; i < body.income_history.length; i++) {
      const err = validateIncomeEntry(body.income_history[i], i);
      if (err) return res.status(400).json({ error: err });
    }
  }

  // Build the UPDATE — fetch-modify-save pattern (cleaner than chained COALESCE)
  // for the many optional fields here.
  const merged = {
    status:                       nextStatus,
    submitted_at:                 derivedTimestamp?.col === 'submitted_at'           ? new Date().toISOString() : cur.submitted_at,
    accepted_at:                  derivedTimestamp?.col === 'accepted_at'            ? new Date().toISOString() : cur.accepted_at,
    evidence_submitted_at:        derivedTimestamp?.col === 'evidence_submitted_at'  ? new Date().toISOString() : cur.evidence_submitted_at,
    resubmit_requested_at:        derivedTimestamp?.col === 'resubmit_requested_at'  ? new Date().toISOString() : cur.resubmit_requested_at,
    validated_at:                 derivedTimestamp?.col === 'validated_at'           ? new Date().toISOString() : cur.validated_at,
    requested_rent:               body.requested_rent              ?? cur.requested_rent,
    bond_weeks:                   body.bond_weeks                  ?? cur.bond_weeks,
    lease_term_months:            body.lease_term_months           ?? cur.lease_term_months,
    preferred_start_date:         body.preferred_start_date        ?? cur.preferred_start_date,
    terms:                        body.terms                       ?? cur.terms,
    annual_income_claimed:        body.annual_income_claimed       ?? cur.annual_income_claimed,
    credit_check_consent_at:      body.credit_check_consent_at     ?? cur.credit_check_consent_at,
    tenancy_database_consent_at:  body.tenancy_database_consent_at ?? cur.tenancy_database_consent_at,
    occupants:                    body.occupants !== undefined        ? body.occupants        : cur.occupants,
    pets:                         body.pets      !== undefined        ? body.pets             : cur.pets,
    applicants_jsonb:             body.applicants_jsonb !== undefined ? body.applicants_jsonb : cur.applicants_jsonb,
    validation_jsonb:             body.validation_jsonb !== undefined ? body.validation_jsonb : cur.validation_jsonb,
    notes:                        body.notes                       ?? cur.notes,
  };

  await sql`
    UPDATE applications SET
      status                       = ${merged.status},
      submitted_at                 = ${merged.submitted_at},
      accepted_at                  = ${merged.accepted_at},
      evidence_submitted_at        = ${merged.evidence_submitted_at},
      resubmit_requested_at        = ${merged.resubmit_requested_at},
      validated_at                 = ${merged.validated_at},
      requested_rent               = ${merged.requested_rent},
      bond_weeks                   = ${merged.bond_weeks},
      lease_term_months            = ${merged.lease_term_months},
      preferred_start_date         = ${merged.preferred_start_date},
      terms                        = ${merged.terms},
      annual_income_claimed        = ${merged.annual_income_claimed},
      credit_check_consent_at      = ${merged.credit_check_consent_at},
      tenancy_database_consent_at  = ${merged.tenancy_database_consent_at},
      occupants                    = ${merged.occupants        ? JSON.stringify(merged.occupants)        : null}::jsonb,
      pets                         = ${merged.pets             ? JSON.stringify(merged.pets)             : null}::jsonb,
      applicants_jsonb             = ${merged.applicants_jsonb ? JSON.stringify(merged.applicants_jsonb) : null}::jsonb,
      validation_jsonb             = ${merged.validation_jsonb ? JSON.stringify(merged.validation_jsonb) : null}::jsonb,
      notes                        = ${merged.notes},
      updated_at                   = now()
    WHERE id = ${applicationId}`;

  // Replace nested children if they were supplied — full-list semantics
  if (replaceHousing) {
    await sql`DELETE FROM application_housing_history WHERE application_id = ${applicationId}`;
    if (body.housing_history.length) await insertHousingHistory(applicationId, body.housing_history);
  }
  if (replaceIncome) {
    await sql`DELETE FROM application_income_history WHERE application_id = ${applicationId}`;
    if (body.income_history.length) await insertIncomeHistory(applicationId, body.income_history);
  }

  // V77.2 — Side effects of accept transition (submitted → offer_accepted).
  // Three steps, fail-soft: applicant normalisation, Step 2 token issue, applicant email.
  // Side-effect failures are logged but do not roll back the status change.
  if (cur.status === 'submitted' && nextStatus === 'offer_accepted') {
    try {
      await onOfferAccepted(applicationId, merged, cur.deal_id);
    } catch (err) {
      console.error('[applications/PUT] accept side-effects failed:', err);
      // Continue — agent can manually retry by clicking Send Step 2 link
    }
  }

  // V77.2d — Side effect of evidence_submitted → evidence_resubmit_requested.
  // Send applicant a generic "please review and resubmit" email. Agent will
  // contact them separately with specifics.
  if (cur.status === 'evidence_submitted' && nextStatus === 'evidence_resubmit_requested') {
    try {
      await onResubmitRequested(applicationId, cur.deal_id);
    } catch (err) {
      console.error('[applications/PUT] resubmit-requested side-effect failed:', err);
    }
  }

  const result = await applicationWithChildren(applicationId);
  return res.status(200).json(result);
}

// V77.2 — Compound side-effect when an offer is accepted.
//   1. Normalise each applicant in applicants_jsonb to a Contact (match-by-email or create new).
//   2. Link each Contact to the Lease Enquiry deal as role 'applicant'.
//   3. Issue a Step 2 magic-link token for the primary applicant.
//   4. Send the Step 2 invitation email.
async function onOfferAccepted(applicationId, mergedAppRow, dealId) {
  const applicants = Array.isArray(mergedAppRow.applicants_jsonb) ? mergedAppRow.applicants_jsonb : [];
  if (!applicants.length) {
    console.warn('[applications.accept] no applicants in jsonb — skipping normalisation');
    return;
  }

  // V77.2: compute lease_end_estimate = preferred_start_date + lease_term_months.
  // Used in V78 for retention purge scheduling.
  if (mergedAppRow.preferred_start_date && mergedAppRow.lease_term_months) {
    const start = new Date(mergedAppRow.preferred_start_date);
    if (!isNaN(start.getTime())) {
      const end = new Date(start);
      end.setMonth(end.getMonth() + Number(mergedAppRow.lease_term_months));
      const endIso = end.toISOString().slice(0, 10);
      try {
        await sql`UPDATE applications SET lease_end_estimate = ${endIso} WHERE id = ${applicationId}`;
      } catch (err) {
        console.warn('[applications.accept] could not set lease_end_estimate:', err.message);
      }
    }
  }

  // Step 1: normalise each applicant → Contact
  // V77.2: applicant-wins. The applicant just verified their own email and
  // mobile, so the values they entered are treated as the source of truth.
  // Existing Contacts matched by email get name/mobile updated to the new values.
  const normalised = [];
  for (const ap of applicants) {
    if (!ap || !ap.email) {
      normalised.push({ ...ap, contact_id: null });
      continue;
    }
    const existing = await sql`
      SELECT id FROM contacts
      WHERE LOWER(email) = LOWER(${ap.email})
      ORDER BY updated_at DESC
      LIMIT 1`;
    let contactId;
    if (existing.length) {
      contactId = existing[0].id;
      // Applicant wins — overwrite name + mobile with the values they submitted.
      // Only updates if the applicant actually provided a value (so blanks don't
      // wipe existing Contact data).
      await sql`
        UPDATE contacts
           SET first_name = CASE WHEN ${ap.first_name || ''} <> '' THEN ${ap.first_name || ''} ELSE first_name END,
               last_name  = CASE WHEN ${ap.last_name  || ''} <> '' THEN ${ap.last_name  || ''} ELSE last_name  END,
               mobile     = CASE WHEN ${ap.mobile     || ''} <> '' THEN ${ap.mobile     || ''} ELSE mobile     END,
               updated_at = now()
         WHERE id = ${contactId}`;
    } else {
      const inserted = await sql`
        INSERT INTO contacts (first_name, last_name, mobile, email, source)
        VALUES (${ap.first_name || ''}, ${ap.last_name || ''}, ${ap.mobile || ''}, ${ap.email}, 'applicant_normalisation')
        RETURNING id`;
      contactId = inserted[0].id;
    }
    normalised.push({ ...ap, contact_id: contactId });

    // Link to deal as applicant role (idempotent — UNIQUE constraint on entity_contacts)
    await sql`
      INSERT INTO entity_contacts (contact_id, entity_type, entity_id, role_id)
      VALUES (${contactId}, 'deal', ${dealId}, 'applicant')
      ON CONFLICT (contact_id, entity_type, entity_id, role_id) DO NOTHING`;
  }

  // Stash contact_ids back in applicants_jsonb so the agent UI can show them
  await sql`
    UPDATE applications
       SET applicants_jsonb = ${JSON.stringify(normalised)}::jsonb,
           updated_at       = now()
     WHERE id = ${applicationId}`;

  // Step 2: issue Step 2 token for primary applicant
  const primary = normalised[0];
  if (!primary || !primary.contact_id) {
    console.warn('[applications.accept] primary applicant missing contact_id; skipping token issuance');
    return;
  }

  // Generate a fresh token (delete any existing for this app+step first)
  const { generateToken } = await import('../lib/public-token-auth.js');
  const Email = (await import('../lib/email.js')).default;
  const step2Tpl = await import('../emails/lease-offer-step-2-invite.js');

  await sql`DELETE FROM applicant_form_tokens WHERE application_id = ${applicationId} AND step = 2`;

  const token = generateToken(32);
  const TTL_DAYS = 7;
  const expiresAt = new Date(Date.now() + TTL_DAYS * 24 * 60 * 60 * 1000);

  // Look up the Contact's current email (in case it changed since applicant submitted)
  const contactRows = await sql`
    SELECT email, first_name, last_name FROM contacts WHERE id = ${primary.contact_id}`;
  const contact = contactRows[0];
  if (!contact || !contact.email) {
    console.warn('[applications.accept] primary applicant Contact missing email; cannot send Step 2');
    return;
  }

  await sql`
    INSERT INTO applicant_form_tokens (application_id, step, token, contact_id, applicant_email, expires_at)
    VALUES (${applicationId}, 2, ${token}, ${primary.contact_id}, ${contact.email}, ${expiresAt.toISOString()})`;

  // Step 3: fire Step 2 invitation email
  const dealRows = await sql`
    SELECT d.property_id, p.address, p.suburb, p.state
    FROM deals d
    LEFT JOIN properties p ON p.id = d.property_id
    WHERE d.id = ${dealId}`;
  const deal = dealRows[0] || {};
  const propertyAddress = [deal.address, deal.suburb, deal.state].filter(Boolean).join(', ');
  const applicantName = [contact.first_name, contact.last_name].filter(Boolean).join(' ').trim() || contact.email;
  const formUrl = await Email.leaseOfferUrl(token, 2);

  await Email.send({
    to: contact.email,
    channel: 'leasing',
    template: step2Tpl,
    template_id: 'lease-offer-step-2-invite',
    vars: {
      applicant_name:   applicantName,
      property_address: propertyAddress,
      form_url:         formUrl,
      agent_name:       'Your agent',
      agency_name:      'Edan Property',
      expires_in_days:  TTL_DAYS,
    },
    related_entity_type: 'application',
    related_entity_id:   applicationId,
  });
}

// V77.2d — Side effect of evidence_submitted → evidence_resubmit_requested.
// Find the existing Step 2 token (don't issue a new one), build the same magic
// link, and send the applicant a "please review and resubmit" email.
async function onResubmitRequested(applicationId, dealId) {
  const Email = (await import('../lib/email.js')).default;
  const tpl = await import('../emails/lease-offer-resubmit-requested.js');

  // Find the Step 2 token for this application (most recent if multiple)
  const tokenRows = await sql`
    SELECT t.token, t.applicant_email, t.contact_id, c.first_name, c.last_name
    FROM applicant_form_tokens t
    LEFT JOIN contacts c ON c.id = t.contact_id
    WHERE t.application_id = ${applicationId} AND t.step = 2
    ORDER BY t.id DESC
    LIMIT 1`;
  if (!tokenRows.length) {
    console.warn('[applications.resubmit] no Step 2 token found; cannot notify applicant');
    return;
  }
  const tk = tokenRows[0];
  if (!tk.applicant_email) {
    console.warn('[applications.resubmit] token has no applicant_email');
    return;
  }

  // Property address for context in email
  const dealRows = await sql`
    SELECT d.property_id, p.address, p.suburb, p.state
    FROM deals d
    LEFT JOIN properties p ON p.id = d.property_id
    WHERE d.id = ${dealId}`;
  const deal = dealRows[0] || {};
  const propertyAddress = [deal.address, deal.suburb, deal.state].filter(Boolean).join(', ');
  const applicantName = [tk.first_name, tk.last_name].filter(Boolean).join(' ').trim() || tk.applicant_email;
  const formUrl = await Email.leaseOfferUrl(tk.token, 2);

  await Email.send({
    to: tk.applicant_email,
    channel: 'leasing',
    template: tpl,
    template_id: 'lease-offer-resubmit-requested',
    vars: {
      applicant_name:   applicantName,
      property_address: propertyAddress,
      form_url:         formUrl,
      agent_name:       'Your agent',
      agency_name:      'Edan Property',
    },
    related_entity_type: 'application',
    related_entity_id:   applicationId,
  });
}

async function handleDelete(req, res) {
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'id required' });
  const result = await sql`DELETE FROM applications WHERE id = ${parseInt(id, 10)} RETURNING id`;
  if (!result.length) return res.status(404).json({ error: 'Not found' });
  return res.status(200).json({ ok: true });
}
