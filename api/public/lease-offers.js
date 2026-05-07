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
import { upload as blobUpload, remove as blobRemove } from '../../lib/blob.js';

const sql = neon(getDatabaseUrl());

export default async function handler(req, res) {
  const { token, action } = req.query || {};
  if (!token)  return res.status(400).json({ error: 'token is required in URL path' });
  if (!action) return res.status(400).json({ error: 'action is required in URL path' });

  try {
    if (action === 'token-info') {
      // Public: returns minimal info needed to render the verify gate
      // (masked email, no PII). Doesn't require email_verified.
      if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET');
        return res.status(405).json({ error: 'Method not allowed' });
      }
      return await tokenInfoAction(req, res, token);
    }

    if (action === 'verify') {
      // POST only — requires mobile number challenge to flip email_verified=true
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ error: 'Method not allowed' });
      }
      return await verifyAction(req, res, token);
    }

    // ── Step 2 actions (must be dispatched BEFORE Step 1 validation below) ─
    // These accept Step 2 tokens. Step 2 handlers do their own validation
    // with require_step: 2.
    if (action === 'step2-token-info' || action === 'step2-verify' || action === 'step2-load' ||
        action === 'step2-save-draft' || action === 'step2-submit' || action === 'step2-upload' ||
        action === 'step2-delete-evidence') {
      return await handleStep2(req, res, token, action);
    }

    // All other (Step 1) actions require email_verified=true (require_step=1)
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

// ── token-info: minimal public info for the verify gate ────────────────────
async function tokenInfoAction(req, res, token) {
  const ctx = await validatePublicToken(token, { require_step: 1, require_verified: false, touch_access: false });
  if (!ctx.ok) {
    return res.status(ctx.status).json({ error: ctx.message, code: ctx.code });
  }
  // Already verified? Caller still gets a response, with verified=true so the page
  // can skip the gate.
  return res.status(200).json({
    verified: !!ctx.token_row.email_verified,
    masked_email: maskEmail(ctx.token_row.applicant_email),
  });
}

// j*****n@example.com → keeps first + last char of local part, rest masked
function maskEmail(email) {
  if (!email || !email.includes('@')) return '';
  const [local, domain] = email.split('@');
  if (local.length <= 2) return local[0] + '***@' + domain;
  return local[0] + '*'.repeat(Math.max(3, local.length - 2)) + local[local.length - 1] + '@' + domain;
}

// Compare two phone numbers loosely — strip everything except digits.
function digitsOnly(s) {
  return String(s || '').replace(/\D/g, '');
}
function phonesMatch(a, b) {
  const da = digitsOnly(a);
  const db = digitsOnly(b);
  if (!da || !db) return false;
  // Allow trailing match (last 9 digits) so that "0412 345 678" matches "+61 412 345 678"
  const tailA = da.slice(-9);
  const tailB = db.slice(-9);
  return tailA === tailB && tailA.length >= 8;
}

// ── verify: requires mobile number challenge ───────────────────────────────
async function verifyAction(req, res, token) {
  const body = req.body || {};
  const submittedMobile = body.mobile;

  // Validate token (any state — we'll flip email_verified to true on success)
  const ctx = await validatePublicToken(token, { require_step: 1, require_verified: false });
  if (!ctx.ok) {
    return res.status(ctx.status).json({ error: ctx.message, code: ctx.code });
  }
  if (ctx.token_row.email_verified) {
    return res.status(200).json({ verified: true, already: true });
  }

  if (!submittedMobile) {
    return res.status(400).json({ error: 'Mobile number is required.' });
  }

  // Look up the linked Contact's phone
  const rows = await sql`
    SELECT c.mobile
    FROM applicant_form_tokens t
    LEFT JOIN contacts c ON c.id = t.contact_id
    WHERE t.id = ${ctx.token_row.id}
    LIMIT 1`;
  const contactPhone = rows[0]?.mobile;

  if (!contactPhone) {
    // Fallback — Contact was unlinked or has no phone. We can't verify.
    return res.status(409).json({ error: 'Cannot verify — please contact your agent.', code: 'no_contact_phone' });
  }

  if (!phonesMatch(submittedMobile, contactPhone)) {
    // Don't reveal that the number was wrong vs. anything else; generic message
    return res.status(401).json({ error: 'That mobile number does not match our records. Please double-check and try again.', code: 'mobile_mismatch' });
  }

  // Match! Flip email_verified=true, extend expiry to verified TTL (30 days)
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
           p.address, p.suburb, p.state
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
           c.first_name, c.last_name, c.email, c.mobile
    FROM applicant_form_tokens t
    LEFT JOIN contacts c ON c.id = t.contact_id
    WHERE t.id = ${ctx.token_row.id}`;
  const tokenInfo = tokenRows[0] || {};

  // Build defaults block — what the form should pre-fill if applicants_jsonb is empty
  const primaryDefault = {
    first_name: tokenInfo.first_name || '',
    last_name:  tokenInfo.last_name  || '',
    email:      tokenInfo.email      || tokenInfo.applicant_email || '',
    mobile:     tokenInfo.mobile     || '',
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

// Convert a gross income amount + period to an annualised value.
// Used because the DB schema stores income as annual_income only.
function grossToAnnual(amount, period) {
  if (amount == null || isNaN(amount)) return null;
  const p = String(period || 'weekly').toLowerCase();
  switch (p) {
    case 'weekly':       return Math.round(amount * 52);
    case 'fortnightly':  return Math.round(amount * 26);
    case 'monthly':      return Math.round(amount * 12);
    case 'quarterly':    return Math.round(amount * 4);
    case 'annually':     return Math.round(amount);
    case 'yearly':       return Math.round(amount);
    default:             return Math.round(amount * 52);
  }
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

// ────────────────────────────────────────────────────────────────────────────
// V77.2 — Step 2 (evidence upload) actions
// ────────────────────────────────────────────────────────────────────────────


async function handleStep2(req, res, token, action) {
  if (action === 'step2-token-info') {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return res.status(405).json({ error: 'Method not allowed' });
    }
    return await step2TokenInfo(req, res, token);
  }

  if (action === 'step2-verify') {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).json({ error: 'Method not allowed' });
    }
    return await step2Verify(req, res, token);
  }

  // All other Step 2 actions require email_verified=true on a step-2 token.
  const ctx = await validatePublicToken(token, { require_step: 2, require_verified: true });
  if (!ctx.ok) {
    return res.status(ctx.status).json({ error: ctx.message, code: ctx.code });
  }

  if (action === 'step2-load') {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return res.status(405).json({ error: 'Method not allowed' });
    }
    return await step2Load(req, res, ctx);
  }
  if (action === 'step2-save-draft') {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).json({ error: 'Method not allowed' });
    }
    return await step2SaveDraft(req, res, ctx);
  }
  if (action === 'step2-submit') {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).json({ error: 'Method not allowed' });
    }
    return await step2Submit(req, res, ctx);
  }
  if (action === 'step2-upload') {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).json({ error: 'Method not allowed' });
    }
    return await step2Upload(req, res, ctx);
  }
  if (action === 'step2-delete-evidence') {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).json({ error: 'Method not allowed' });
    }
    return await step2DeleteEvidence(req, res, ctx);
  }

  return res.status(404).json({ error: 'Unknown step2 action: ' + action });
}

async function step2TokenInfo(req, res, token) {
  const ctx = await validatePublicToken(token, { require_step: 2, require_verified: false, touch_access: false });
  if (!ctx.ok) {
    return res.status(ctx.status).json({ error: ctx.message, code: ctx.code });
  }
  return res.status(200).json({
    verified: !!ctx.token_row.email_verified,
    masked_email: maskEmail(ctx.token_row.applicant_email),
  });
}

async function step2Verify(req, res, token) {
  const body = req.body || {};
  const submittedMobile = body.mobile;

  const ctx = await validatePublicToken(token, { require_step: 2, require_verified: false });
  if (!ctx.ok) {
    return res.status(ctx.status).json({ error: ctx.message, code: ctx.code });
  }
  if (ctx.token_row.email_verified) {
    return res.status(200).json({ verified: true, already: true });
  }
  if (!submittedMobile) {
    return res.status(400).json({ error: 'Mobile number is required.' });
  }

  const rows = await sql`
    SELECT c.mobile FROM applicant_form_tokens t
    LEFT JOIN contacts c ON c.id = t.contact_id
    WHERE t.id = ${ctx.token_row.id}`;
  const contactMobile = rows[0]?.mobile;
  if (!contactMobile) {
    return res.status(409).json({ error: 'Cannot verify — please contact your agent.', code: 'no_contact_phone' });
  }
  if (!phonesMatch(submittedMobile, contactMobile)) {
    return res.status(401).json({ error: 'That mobile number does not match our records. Please double-check and try again.', code: 'mobile_mismatch' });
  }

  const newExpires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  await sql`
    UPDATE applicant_form_tokens
       SET email_verified = true, verified_at = now(), expires_at = ${newExpires.toISOString()}
     WHERE id = ${ctx.token_row.id}`;
  return res.status(200).json({ verified: true, expires_at: newExpires.toISOString() });
}

async function step2Load(req, res, ctx) {
  const application_id = ctx.application.id;

  // Fetch application + property + applicants_jsonb (for per-applicant evidence sections)
  const rows = await sql`
    SELECT a.id, a.status, a.applicants_jsonb,
           a.credit_check_consent_at, a.tenancy_database_consent_at,
           d.id AS deal_id,
           p.address, p.suburb, p.state
    FROM applications a
    JOIN deals d        ON d.id = a.deal_id
    LEFT JOIN properties p ON p.id = d.property_id
    WHERE a.id = ${application_id}`;
  const app = rows[0];
  if (!app) return res.status(404).json({ error: 'Application not found' });

  // Status check — Step 2 is meaningful only when offer_accepted (or already evidence_submitted, allows continuing)
  if (!['offer_accepted', 'evidence_submitted'].includes(app.status)) {
    return res.status(409).json({
      error: 'This form is not currently available. Please wait for your agent to accept your offer.',
      code: 'wrong_status',
    });
  }

  // Existing housing + income history (so applicant sees what they previously saved).
  // Map DB column names back to the field names the form expects.
  const housingRowsRaw = await sql`
    SELECT id, applicant_contact_id, housing_type, address, monthly_amount,
           term_value, term_unit, term_start_date, term_end_date,
           landlord_lender_name, landlord_lender_contact, notes
    FROM application_housing_history
    WHERE application_id = ${application_id}
    ORDER BY sort_order ASC, id ASC`;
  const housingRows = housingRowsRaw.map(r => ({
    id: r.id,
    applicant_contact_id: r.applicant_contact_id,
    housing_type: r.housing_type,
    address: r.address,
    monthly_amount: r.monthly_amount,
    term_value: r.term_value,
    term_unit: r.term_unit,
    started_at: r.term_start_date,
    ended_at: r.term_end_date,
    current_residence: r.term_end_date == null,
    landlord_name: r.landlord_lender_name,
    landlord_email: '',  // not separately stored; was concatenated into contact
    landlord_phone: r.landlord_lender_contact || '',
    notes: r.notes,
  }));

  const incomeRowsRaw = await sql`
    SELECT id, applicant_contact_id, income_type, income_source_name, role,
           annual_income, term_value, term_unit, term_start_date, term_end_date,
           employer_contact_name, employer_contact_email, employer_contact_mobile, notes
    FROM application_income_history
    WHERE application_id = ${application_id}
    ORDER BY sort_order ASC, id ASC`;
  const incomeRows = incomeRowsRaw.map(r => ({
    id: r.id,
    applicant_contact_id: r.applicant_contact_id,
    income_type: r.income_type,
    income_source_name: r.income_source_name,
    position: r.role,
    gross_amount: r.annual_income != null ? Math.round(r.annual_income / 52) : null,
    gross_period: 'weekly',
    started_at: r.term_start_date,
    ended_at: r.term_end_date,
    current_role: r.term_end_date == null,
    manager_name: r.employer_contact_name,
    manager_email: r.employer_contact_email,
    manager_phone: r.employer_contact_mobile,
    notes: r.notes,
  }));

  // Existing evidence files for this application
  const evidenceRows = await sql`
    SELECT id, applicant_contact_id, category, filename, mime_type, size_bytes,
           url, uploaded_at, points_value
    FROM application_evidence
    WHERE application_id = ${application_id}
    ORDER BY uploaded_at ASC`;

  return res.status(200).json({
    application: {
      id: app.id,
      status: app.status,
      applicants: app.applicants_jsonb || [],
      credit_check_consent_at: app.credit_check_consent_at,
      tenancy_database_consent_at: app.tenancy_database_consent_at,
    },
    property: {
      address: app.address || '',
      suburb:  app.suburb  || '',
      state:   app.state   || '',
    },
    housing_history: housingRows,
    income_history:  incomeRows,
    evidence:        evidenceRows,
  });
}

async function step2SaveDraft(req, res, ctx) {
  const body = req.body || {};
  const application_id = ctx.application.id;

  if (ctx.application.status !== 'offer_accepted') {
    return res.status(409).json({ error: 'Form is locked — already submitted or not yet accepted.' });
  }

  // Persist consent flags + housing/income history (full-replace semantics)
  const ccConsent = body.credit_check_consent === true     ? new Date().toISOString() : null;
  const tdConsent = body.tenancy_database_consent === true ? new Date().toISOString() : null;

  await sql`
    UPDATE applications SET
      credit_check_consent_at     = COALESCE(credit_check_consent_at, ${ccConsent}),
      tenancy_database_consent_at = COALESCE(tenancy_database_consent_at, ${tdConsent}),
      updated_at                  = now()
    WHERE id = ${application_id}`;

  // Housing history — full replace if provided
  if (Array.isArray(body.housing_history)) {
    await sql`DELETE FROM application_housing_history WHERE application_id = ${application_id}`;
    let sortOrder = 0;
    for (const h of body.housing_history) {
      // Combine separate landlord fields into the single contact text column
      const contactParts = [
        h.landlord_email ? h.landlord_email : '',
        h.landlord_phone ? h.landlord_phone : '',
      ].filter(Boolean).join(' · ');
      await sql`
        INSERT INTO application_housing_history
          (application_id, applicant_contact_id, housing_type, address, monthly_amount,
           term_value, term_unit, term_start_date, term_end_date,
           landlord_lender_name, landlord_lender_contact, notes, sort_order)
        VALUES
          (${application_id}, ${h.applicant_contact_id || null},
           ${toText(h.housing_type, 50) || 'rented'},
           ${toText(h.address, 300) || ''},
           ${toNumber(h.monthly_amount)},
           ${clampInt(h.term_value, 0, 1200, null)},
           ${toText(h.term_unit, 20)},
           ${toIsoDate(h.started_at)},
           ${h.current_residence ? null : toIsoDate(h.ended_at)},
           ${toText(h.landlord_name, 200)},
           ${toText(contactParts, 300) || null},
           ${toText(h.notes, 1000)},
           ${sortOrder++})`;
    }
  }

  // Income history — full replace if provided
  if (Array.isArray(body.income_history)) {
    await sql`DELETE FROM application_income_history WHERE application_id = ${application_id}`;
    let sortOrder = 0;
    for (const i of body.income_history) {
      // Convert gross amount/period → annual_income
      const annual = grossToAnnual(toNumber(i.gross_amount), i.gross_period);
      await sql`
        INSERT INTO application_income_history
          (application_id, applicant_contact_id, income_type, income_source_name, role,
           annual_income, term_value, term_unit, term_start_date, term_end_date,
           employer_contact_name, employer_contact_email, employer_contact_mobile, notes, sort_order)
        VALUES
          (${application_id}, ${i.applicant_contact_id || null},
           ${toText(i.income_type, 50) || 'employment'},
           ${toText(i.income_source_name, 200) || ''},
           ${toText(i.position, 200)},
           ${annual},
           ${clampInt(i.term_value, 0, 1200, null)},
           ${toText(i.term_unit, 20)},
           ${toIsoDate(i.started_at)},
           ${i.current_role ? null : toIsoDate(i.ended_at)},
           ${toText(i.manager_name, 200)},
           ${toEmail(i.manager_email)},
           ${toText(i.manager_phone, 30)},
           ${toText(i.notes, 1000)},
           ${sortOrder++})`;
    }
  }

  return res.status(200).json({ saved: true, saved_at: new Date().toISOString() });
}

async function step2Submit(req, res, ctx) {
  const application_id = ctx.application.id;

  if (ctx.application.status !== 'offer_accepted') {
    return res.status(409).json({ error: 'Form is locked — already submitted or not yet accepted.' });
  }

  // Save final form payload first
  const draftResult = await step2SaveDraft(req, { ...res, status: () => ({ json: () => null }) }, ctx);

  // Then flip status → evidence_submitted
  await sql`
    UPDATE applications SET
      status                = 'evidence_submitted',
      evidence_submitted_at = now(),
      updated_at            = now()
    WHERE id = ${application_id}`;

  // Fire agent notification email
  try {
    await fireEvidenceNotification(ctx);
  } catch (err) {
    console.error('[step2-submit] agent notification failed:', err);
  }

  return res.status(200).json({ submitted: true, submitted_at: new Date().toISOString() });
}

async function fireEvidenceNotification(ctx) {
  const application_id = ctx.application.id;
  const deal_id = ctx.application.deal_id;

  const rows = await sql`
    SELECT d.created_by AS agent_contact_id,
           p.address, p.suburb, p.state,
           c.email AS agent_email, c.first_name AS agent_first, c.last_name AS agent_last,
           a.applicants_jsonb
    FROM deals d
    LEFT JOIN properties p ON p.id = d.property_id
    LEFT JOIN contacts c   ON c.id = d.created_by
    LEFT JOIN applications a ON a.id = ${application_id}
    WHERE d.id = ${deal_id}
    LIMIT 1`;
  const row = rows[0];
  if (!row || !row.agent_email) return;

  // ID points total
  const pointsRows = await sql`
    SELECT COALESCE(SUM(points_value), 0)::int AS total
    FROM application_evidence
    WHERE application_id = ${application_id} AND category LIKE 'id-100%'`;
  const idPoints = pointsRows[0]?.total || 0;

  // Counts for evidence summary
  const countRows = await sql`
    SELECT
      (SELECT COUNT(*)::int FROM application_housing_history WHERE application_id = ${application_id}) AS housing_count,
      (SELECT COUNT(*)::int FROM application_income_history  WHERE application_id = ${application_id}) AS income_count,
      (SELECT COUNT(*)::int FROM application_evidence        WHERE application_id = ${application_id}) AS evidence_count`;
  const counts = countRows[0] || {};

  const agentName = [row.agent_first, row.agent_last].filter(Boolean).join(' ').trim() || 'Agent';
  const propertyAddress = [row.address, row.suburb, row.state].filter(Boolean).join(', ');
  const primary = (row.applicants_jsonb || [])[0] || {};
  const applicantName = [primary.first_name, primary.last_name].filter(Boolean).join(' ').trim() || ctx.token_row.applicant_email;

  const cfg = await Email.getConfig();
  const dealUrl = `${cfg.app_public_url}/?deal=${encodeURIComponent(deal_id)}`;
  const submittedAt = new Date().toLocaleString('en-AU', { timeZone: 'Australia/Sydney', dateStyle: 'medium', timeStyle: 'short' });
  const evidenceSummary = `${counts.evidence_count || 0} files · ${counts.housing_count || 0} housing entries · ${counts.income_count || 0} income entries`;

  const evidenceTpl = await import('../../emails/lease-offer-evidence-submitted-agent-notification.js');

  await Email.send({
    to: row.agent_email,
    channel: 'leasing',
    template: evidenceTpl,
    template_id: 'lease-offer-evidence-submitted-agent-notification',
    vars: {
      agent_name:       agentName,
      applicant_name:   applicantName,
      property_address: propertyAddress,
      deal_url:         dealUrl,
      id_points_total:  idPoints,
      evidence_summary: evidenceSummary,
      submitted_at:     submittedAt,
      agency_name:      'Edan Property',
    },
    related_entity_type: 'application',
    related_entity_id:   application_id,
  });
}

// ── Upload evidence file ───────────────────────────────────────────────────
// Receives multipart/form-data: { file: <File>, applicant_contact_id?, category, points_value? }
async function step2Upload(req, res, ctx) {
  const application_id = ctx.application.id;
  if (ctx.application.status !== 'offer_accepted') {
    return res.status(409).json({ error: 'Form is locked — already submitted or not yet accepted.' });
  }

  // Vercel serverless functions get raw multipart bodies — easiest path is
  // to receive base64 from the client. We define our own contract here:
  // { filename, mime_type, size, applicant_contact_id, category, points_value, body_base64 }
  const body = req.body || {};
  const { filename, mime_type, size, applicant_contact_id, category, points_value, body_base64 } = body;

  if (!filename || !mime_type || !body_base64) {
    return res.status(400).json({ error: 'filename, mime_type, body_base64 required' });
  }
  if (!category) return res.status(400).json({ error: 'category required' });

  // Decode base64 to Buffer
  let buf;
  try { buf = Buffer.from(body_base64, 'base64'); }
  catch { return res.status(400).json({ error: 'Invalid base64 body' }); }

  if (buf.length > 10 * 1024 * 1024) {
    return res.status(413).json({ error: 'File too large (max 10 MB).' });
  }

  let uploadResult;
  try {
    uploadResult = await blobUpload({
      application_id,
      applicant_or_token: applicant_contact_id || ctx.token_row.token.slice(0, 8),
      category,
      filename,
      mime_type,
      body: buf,
      size: buf.length,
    });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  // Persist evidence row
  const result = await sql`
    INSERT INTO application_evidence
      (application_id, applicant_contact_id, category, filename, mime_type, size_bytes, url, points_value)
    VALUES
      (${application_id}, ${applicant_contact_id || null}, ${category},
       ${filename}, ${mime_type}, ${buf.length},
       ${uploadResult.url}, ${parseInt(points_value, 10) || 0})
    RETURNING id, category, filename, mime_type, size_bytes, url, points_value, uploaded_at`;

  return res.status(200).json({ evidence: result[0] });
}

// Delete a single evidence file (applicant's Remove or Replace action)
async function step2DeleteEvidence(req, res, ctx) {
  const application_id = ctx.application.id;
  const body = req.body || {};
  const evidence_id = parseInt(body.evidence_id, 10);
  if (!evidence_id) return res.status(400).json({ error: 'evidence_id required' });

  if (ctx.application.status !== 'offer_accepted') {
    return res.status(409).json({ error: 'Form is locked.' });
  }

  // Confirm the evidence belongs to this application
  const rows = await sql`
    SELECT id, url FROM application_evidence
    WHERE id = ${evidence_id} AND application_id = ${application_id}
    LIMIT 1`;
  if (!rows.length) return res.status(404).json({ error: 'Evidence not found' });

  // Delete from Blob storage (best-effort — DB row is authoritative)
  try {
    await blobRemove(rows[0].url);
  } catch (err) {
    console.warn('[step2-delete-evidence] blob remove failed:', err.message);
  }

  await sql`DELETE FROM application_evidence WHERE id = ${evidence_id}`;
  return res.status(200).json({ deleted: true, id: evidence_id });
}
