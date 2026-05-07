/**
 * api/public/lease-offers.js — V77.2
 *
 * Token-authenticated public endpoints for the lease offer Step 1 form.
 * URL pattern (Vercel rewrite):
 *   /api/public/lease-offers/:token/:action
 *     where action ∈ { load, verify, submit-draft, submit }
 *
 * The rewrite is configured in vercel.json:
 *   { "source": "/api/public/lease-offers/:token/:action",
 *     "destination": "/api/public/lease-offers" }
 *
 * Vercel passes :token and :action through req.query.
 *
 * Endpoints:
 *   GET    /api/public/lease-offers/:token/load           → form-load context
 *                                                          (deal/property/listing terms/applicant defaults)
 *   POST   /api/public/lease-offers/:token/verify         → flip email_verified=true
 *   POST   /api/public/lease-offers/:token/submit-draft   → save in-progress (no status change)
 *   POST   /api/public/lease-offers/:token/submit         → final submit (draft → offer_received)
 *
 * Auth: lib/public-token-auth.js validates the token before any handler runs.
 *       'verify' is the only endpoint that accepts an UNverified token.
 */

import { neon } from '@neondatabase/serverless';
import { getDatabaseUrl } from '../../lib/db.js';
import { validatePublicToken } from '../../lib/public-token-auth.js';
import Email from '../../lib/email.js';
import * as receivedTpl from '../../emails/lease-offer-received-agent-notification.js';

const sql = neon(getDatabaseUrl());

export default async function handler(req, res) {
  const { token, action } = req.query || {};
  if (!token)  return res.status(400).json({ error: 'token is required in URL path' });
  if (!action) return res.status(400).json({ error: 'action is required in URL path' });

  try {
    if (action === 'verify') {
      // POST only
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ error: 'Method not allowed' });
      }
      return await verifyAction(req, res, token);
    }

    // All other actions require email_verified=true (require_step=1)
    const ctx = await validatePublicToken(token, { require_step: 1, require_verified: true });
    if (!ctx.ok) {
      return res.status(ctx.status).json({ error: ctx.message, code: ctx.code });
    }

    if (action === 'load') {
      if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET');
        return res.status(405).json({ error: 'Method not allowed' });
      }
      return await loadAction(req, res, ctx);
    }
    if (action === 'submit-draft') {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ error: 'Method not allowed' });
      }
      return await submitDraftAction(req, res, ctx);
    }
    if (action === 'submit') {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ error: 'Method not allowed' });
      }
      return await submitAction(req, res, ctx);
    }

    return res.status(404).json({ error: 'Unknown action: ' + action });
  } catch (err) {
    console.error('[public/lease-offers] error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ── verify: flip email_verified=true (idempotent) ──────────────────────────
async function verifyAction(req, res, token) {
  // Special: don't require email_verified to validate this one (we're flipping it)
  const ctx = await validatePublicToken(token, { require_step: 1, require_verified: false });
  if (!ctx.ok) {
    return res.status(ctx.status).json({ error: ctx.message, code: ctx.code });
  }
  if (ctx.token_row.email_verified) {
    return res.status(200).json({ verified: true, already: true });
  }
  // Extend expiry to verified TTL (30 days)
  const newExpires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  await sql`
    UPDATE applicant_form_tokens
       SET email_verified = true, verified_at = now(), expires_at = ${newExpires.toISOString()}
     WHERE id = ${ctx.token_row.id}`;
  return res.status(200).json({ verified: true, expires_at: newExpires.toISOString() });
}

// ── load: build the form-load context ──────────────────────────────────────
async function loadAction(req, res, ctx) {
  const application_id = ctx.application.id;
  const deal_id = ctx.application.deal_id;

  // Fetch the application + deal + property + listing terms + applicant Contact
  const rows = await sql`
    SELECT a.id, a.status, a.requested_rent, a.bond_weeks, a.lease_term_months,
           a.preferred_start_date, a.terms, a.occupants, a.pets, a.applicants_jsonb,
           d.id AS deal_id, d.data AS deal_data, d.parent_deal_id,
           p.address, p.suburb, p.state, p.postcode
    FROM applications a
    JOIN deals d        ON d.id = a.deal_id
    LEFT JOIN properties p ON p.id = d.property_id
    WHERE a.id = ${application_id}
    LIMIT 1`;
  const row = rows[0];
  if (!row) return res.status(404).json({ error: 'Application not found' });

  // Look up parent (Listing) deal's terms — that's where rent_amount, bond, term_months,
  // available_from, special_terms live (per V77.1b architecture: enquiry deals reference
  // a parent listing). If parent_deal_id is null (loose enquiry), fall back to {}.
  let listingTerms = {};
  if (row.parent_deal_id) {
    const parentRows = await sql`SELECT data FROM deals WHERE id = ${row.parent_deal_id} LIMIT 1`;
    listingTerms = parentRows[0]?.data?.terms || {};
  }

  // Look up the linked applicant Contact (created_by + token's contact_id)
  const tokenRows = await sql`
    SELECT t.contact_id, t.applicant_email,
           c.first_name, c.last_name, c.email, c.phone
    FROM applicant_form_tokens t
    LEFT JOIN contacts c ON c.id = t.contact_id
    WHERE t.id = ${ctx.token_row.id}`;
  const tokenInfo = tokenRows[0] || {};

  // Build defaults block — what the form should pre-fill if applicants_jsonb is empty
  const primaryDefault = {
    first_name: tokenInfo.first_name || '',
    last_name:  tokenInfo.last_name  || '',
    email:      tokenInfo.email      || tokenInfo.applicant_email || '',
    mobile:     tokenInfo.phone      || '',
    dob:        '',
    current_address: '',
    pets:       '', // comma-separated description, or 'none'
    smoker:     null, // boolean | null
    references_consent: false,
  };

  return res.status(200).json({
    application: {
      id: row.id,
      status: row.status,
      requested_rent: row.requested_rent,
      bond_weeks: row.bond_weeks || 4,
      lease_term_months: row.lease_term_months,
      preferred_start_date: row.preferred_start_date,
      terms: row.terms || '',
      occupants: row.occupants || null,
      pets: row.pets || null,
      applicants_jsonb: row.applicants_jsonb || null,
    },
    property: {
      address:  row.address  || '',
      suburb:   row.suburb   || '',
      state:    row.state    || '',
      postcode: row.postcode || '',
    },
    listing_terms: {
      rent_amount:    listingTerms.rent_amount || null,
      rent_period:    listingTerms.rent_period || 'weekly',
      bond:           listingTerms.bond || null,            // dollar amount (informational)
      term_months:    listingTerms.term_months || null,
      available_from: listingTerms.available_from || null,
      special_terms:  listingTerms.special_terms || '',
    },
    primary_applicant_default: primaryDefault,
    expires_at: ctx.token_row.expires_at,
  });
}

// ── submit-draft: save form in progress (no status change) ─────────────────
async function submitDraftAction(req, res, ctx) {
  const body = req.body || {};
  const application_id = ctx.application.id;

  // Only draft applications can be edited via public form. If status has progressed,
  // applicant cannot save further drafts.
  if (ctx.application.status !== 'draft') {
    return res.status(409).json({ error: 'This offer has already been submitted and cannot be edited.' });
  }

  // Sanitise input — accept only known fields. Anything else is silently dropped.
  const updates = sanitiseFormPayload(body);

  await sql`
    UPDATE applications
       SET requested_rent       = ${updates.requested_rent},
           bond_weeks           = ${updates.bond_weeks},
           lease_term_months    = ${updates.lease_term_months},
           preferred_start_date = ${updates.preferred_start_date},
           terms                = ${updates.terms},
           occupants            = ${JSON.stringify(updates.occupants)},
           applicants_jsonb     = ${JSON.stringify(updates.applicants)},
           pets                 = ${JSON.stringify(updates.pets)},
           updated_at           = now()
     WHERE id = ${application_id}`;

  return res.status(200).json({ saved: true, saved_at: new Date().toISOString() });
}

// ── submit: final submit (draft → offer_received) + agent notification ─────
async function submitAction(req, res, ctx) {
  const body = req.body || {};
  const application_id = ctx.application.id;

  if (ctx.application.status !== 'draft') {
    return res.status(409).json({ error: 'This offer has already been submitted.' });
  }

  // Validate required fields on submit
  const updates = sanitiseFormPayload(body);
  const validationErrors = validateForSubmit(updates);
  if (validationErrors.length) {
    return res.status(400).json({ error: 'Validation failed', errors: validationErrors });
  }

  // Save final form state + flip status
  await sql`
    UPDATE applications
       SET requested_rent       = ${updates.requested_rent},
           bond_weeks           = ${updates.bond_weeks},
           lease_term_months    = ${updates.lease_term_months},
           preferred_start_date = ${updates.preferred_start_date},
           terms                = ${updates.terms},
           occupants            = ${JSON.stringify(updates.occupants)},
           applicants_jsonb     = ${JSON.stringify(updates.applicants)},
           pets                 = ${JSON.stringify(updates.pets)},
           status               = 'submitted',
           submitted_at         = now(),
           updated_at           = now()
     WHERE id = ${application_id}`;

  // Fire agent notification email (V77.2 stub — logs to email_log)
  try {
    await fireAgentNotification(ctx, updates);
  } catch (err) {
    console.error('[public/lease-offers/submit] agent notification failed:', err);
    // Don't fail the submit — applicant has done their part
  }

  return res.status(200).json({
    submitted: true,
    submitted_at: new Date().toISOString(),
  });
}

async function fireAgentNotification(ctx, updates) {
  const application_id = ctx.application.id;
  const deal_id = ctx.application.deal_id;

  // Look up the deal's agent (created_by) and property
  const rows = await sql`
    SELECT d.created_by AS agent_contact_id,
           p.address, p.suburb, p.state,
           c.email AS agent_email, c.first_name AS agent_first, c.last_name AS agent_last
    FROM deals d
    LEFT JOIN properties p ON p.id = d.property_id
    LEFT JOIN contacts c   ON c.id = d.created_by
    WHERE d.id = ${deal_id}
    LIMIT 1`;
  const row = rows[0];
  if (!row || !row.agent_email) {
    console.warn('[public/lease-offers/submit] no agent email — skip notification');
    return;
  }

  const agentName = [row.agent_first, row.agent_last].filter(Boolean).join(' ').trim() || 'Agent';
  const propertyAddress = [row.address, row.suburb, row.state].filter(Boolean).join(', ');

  // Primary applicant name
  const primary = (updates.applicants && updates.applicants[0]) || {};
  const applicantName = [primary.first_name, primary.last_name].filter(Boolean).join(' ').trim() || ctx.token_row.applicant_email;

  const cfg = await Email.getConfig();
  const dealUrl = `${cfg.app_public_url}/?deal=${encodeURIComponent(deal_id)}`;

  const submittedAt = new Date().toLocaleString('en-AU', { timeZone: 'Australia/Sydney', dateStyle: 'medium', timeStyle: 'short' });
  const requestedRent = updates.requested_rent ? `$${Math.round(updates.requested_rent).toLocaleString('en-AU')}/wk` : '—';

  await Email.send({
    to: row.agent_email,
    channel: 'leasing',
    template: receivedTpl,
    template_id: 'lease-offer-received-agent-notification',
    vars: {
      agent_name:       agentName,
      applicant_name:   applicantName,
      property_address: propertyAddress,
      deal_url:         dealUrl,
      requested_rent:   requestedRent,
      submitted_at:     submittedAt,
      agency_name:      'Edan Property',
    },
    related_entity_type: 'application',
    related_entity_id:   application_id,
  });
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Sanitise the public-form payload. Returns a clean object with only the
 * fields we accept, all coerced to safe types. Anything else is dropped.
 */
function sanitiseFormPayload(body) {
  const out = {
    requested_rent:       toNumber(body.requested_rent),
    bond_weeks:           clampInt(body.bond_weeks, 4, 52, 4), // min 4, max 52, default 4
    lease_term_months:    clampInt(body.lease_term_months, 1, 240, null),
    preferred_start_date: toIsoDate(body.preferred_start_date),
    terms:                toText(body.terms, 2000),
    occupants:            sanitiseOccupants(body.occupants),
    pets:                 sanitisePets(body.pets),
    applicants:           sanitiseApplicants(body.applicants),
  };
  return out;
}

function sanitiseOccupants(o) {
  if (!o || typeof o !== 'object') return null;
  return {
    total:   clampInt(o.total, 1, 20, null),
    details: toText(o.details, 500),
  };
}

function sanitisePets(p) {
  if (!p || typeof p !== 'object') return null;
  return {
    has_pets: !!p.has_pets,
    details:  toText(p.details, 500),
  };
}

function sanitiseApplicants(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, 6).map(a => {
    if (!a || typeof a !== 'object') return null;
    return {
      first_name:      toText(a.first_name, 100),
      last_name:       toText(a.last_name, 100),
      email:           toEmail(a.email),
      mobile:          toText(a.mobile, 30),
      dob:             toIsoDate(a.dob),
      current_address: toText(a.current_address, 300),
      smoker:          a.smoker === true ? true : (a.smoker === false ? false : null),
      // Finance
      employment_status: toText(a.employment_status, 50),
      employer_name:     toText(a.employer_name, 200),
      position:          toText(a.position, 200),
      gross_weekly_income: toNumber(a.gross_weekly_income),
      length_of_employment: toText(a.length_of_employment, 100),
    };
  }).filter(Boolean);
}

function toNumber(v) {
  if (v == null || v === '') return null;
  const n = parseFloat(String(v).replace(/[^0-9.-]/g, ''));
  return isNaN(n) ? null : n;
}
function clampInt(v, lo, hi, fallback) {
  const n = parseInt(v, 10);
  if (isNaN(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}
function toText(v, maxLen) {
  if (v == null) return null;
  const s = String(v).trim().slice(0, maxLen);
  return s || null;
}
function toEmail(v) {
  if (v == null) return null;
  const s = String(v).trim().slice(0, 254);
  if (!/^\S+@\S+\.\S+$/.test(s)) return null;
  return s.toLowerCase();
}
function toIsoDate(v) {
  if (!v) return null;
  // Accept YYYY-MM-DD only
  const s = String(v).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return s;
}

/**
 * Required-field validation on submit. Returns array of {field, error}.
 */
function validateForSubmit(p) {
  const errs = [];
  if (!p.requested_rent || p.requested_rent <= 0) errs.push({ field: 'requested_rent', error: 'Rent offered is required.' });
  if (!p.bond_weeks)         errs.push({ field: 'bond_weeks', error: 'Bond is required (min 4 weeks).' });
  if (!p.preferred_start_date) errs.push({ field: 'preferred_start_date', error: 'Preferred start date is required.' });
  if (!Array.isArray(p.applicants) || !p.applicants.length) {
    errs.push({ field: 'applicants', error: 'At least one applicant is required.' });
  } else {
    p.applicants.forEach((a, i) => {
      if (!a.first_name) errs.push({ field: `applicants[${i}].first_name`, error: `Applicant ${i + 1}: first name is required.` });
      if (!a.last_name)  errs.push({ field: `applicants[${i}].last_name`,  error: `Applicant ${i + 1}: last name is required.` });
      if (!a.email)      errs.push({ field: `applicants[${i}].email`,      error: `Applicant ${i + 1}: valid email is required.` });
      if (!a.mobile)     errs.push({ field: `applicants[${i}].mobile`,     error: `Applicant ${i + 1}: mobile is required.` });
    });
  }
  if (!p.occupants || !p.occupants.total) {
    errs.push({ field: 'occupants.total', error: 'Total occupants is required.' });
  }
  return errs;
}
