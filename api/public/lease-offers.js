/**
 * api/public/lease-offers.js — V77.2 (Step 1 + Step 2)
 *
 * Token-authenticated public endpoints for the lease offer Step 1 (offer)
 * and Step 2 (evidence/100-points) forms.
 *
 * URL pattern (Vercel rewrite — see vercel.json):
 *   /api/public/lease-offers/:token/:action  →  /api/public/lease-offers
 * Vercel passes :token and :action through req.query.
 *
 * STEP 1 endpoints:
 *   GET    /api/public/lease-offers/:token/token-info     → masked email + verified flag
 *                                                          (called on page load before showing form vs verify-gate)
 *   POST   /api/public/lease-offers/:token/verify         → flip email_verified=true
 *   GET    /api/public/lease-offers/:token/load           → form-load context (deal/property/applicant defaults)
 *   POST   /api/public/lease-offers/:token/submit-draft   → autosave in-progress
 *   POST   /api/public/lease-offers/:token/submit         → final submit (draft → submitted)
 *
 * STEP 2 endpoints:
 *   GET    /api/public/lease-offers/:token/step2-token-info       → masked email + verified flag
 *   POST   /api/public/lease-offers/:token/step2-verify           → flip email_verified=true (Step 2 token)
 *   GET    /api/public/lease-offers/:token/step2-load             → load form + applicants + existing evidence
 *   POST   /api/public/lease-offers/:token/step2-upload           → upload an evidence file (base64 body)
 *   POST   /api/public/lease-offers/:token/step2-update-evidence-meta  → set doc_type/points on an evidence row
 *   POST   /api/public/lease-offers/:token/step2-delete-evidence  → delete an evidence row + blob
 *   POST   /api/public/lease-offers/:token/step2-save-draft       → autosave housing/income/consents
 *   POST   /api/public/lease-offers/:token/step2-submit           → final submit (offer_accepted → evidence_submitted)
 *
 * Auth:
 *   lib/public-token-auth.js validates the token before each handler runs.
 *   'verify', 'token-info', 'step2-verify', 'step2-token-info' accept an UNverified token.
 */

import { neon } from '@neondatabase/serverless';
import { getDatabaseUrl } from '../../lib/db.js';
import { validatePublicToken } from '../../lib/public-token-auth.js';
import * as Blob from '../../lib/blob.js';
import Email from '../../lib/email.js';
import * as receivedTpl from '../../emails/lease-offer-received-agent-notification.js';
import * as evidenceSubmittedTpl from '../../emails/lease-offer-evidence-submitted-agent-notification.js';

const sql = neon(getDatabaseUrl());

export default async function handler(req, res) {
  const { token, action } = req.query || {};
  if (!token)  return res.status(400).json({ error: 'token is required in URL path' });
  if (!action) return res.status(400).json({ error: 'action is required in URL path' });

  try {
    // ── Actions that accept unverified tokens ─────────────────────────────
    if (action === 'token-info') {
      if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET');
        return res.status(405).json({ error: 'Method not allowed' });
      }
      return await tokenInfoAction(req, res, token, 1);
    }
    if (action === 'step2-token-info') {
      if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET');
        return res.status(405).json({ error: 'Method not allowed' });
      }
      return await tokenInfoAction(req, res, token, 2);
    }
    if (action === 'verify') {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ error: 'Method not allowed' });
      }
      return await verifyAction(req, res, token, 1);
    }
    if (action === 'step2-verify') {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ error: 'Method not allowed' });
      }
      return await verifyAction(req, res, token, 2);
    }

    // ── Step 1 actions (require verified Step 1 token) ────────────────────
    if (action === 'load') {
      if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET');
        return res.status(405).json({ error: 'Method not allowed' });
      }
      const ctx = await validatePublicToken(token, { require_step: 1, require_verified: true });
      if (!ctx.ok) return res.status(ctx.status).json({ error: ctx.message, code: ctx.code });
      return await loadAction(req, res, ctx);
    }
    if (action === 'submit-draft') {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ error: 'Method not allowed' });
      }
      const ctx = await validatePublicToken(token, { require_step: 1, require_verified: true });
      if (!ctx.ok) return res.status(ctx.status).json({ error: ctx.message, code: ctx.code });
      return await submitDraftAction(req, res, ctx);
    }
    if (action === 'submit') {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ error: 'Method not allowed' });
      }
      const ctx = await validatePublicToken(token, { require_step: 1, require_verified: true });
      if (!ctx.ok) return res.status(ctx.status).json({ error: ctx.message, code: ctx.code });
      return await submitAction(req, res, ctx);
    }

    // ── Step 2 actions (require verified Step 2 token + offer_accepted) ───
    if (action === 'step2-load') {
      if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET');
        return res.status(405).json({ error: 'Method not allowed' });
      }
      const ctx = await validatePublicToken(token, { require_step: 2, require_verified: true });
      if (!ctx.ok) return res.status(ctx.status).json({ error: ctx.message, code: ctx.code });
      return await step2LoadAction(req, res, ctx);
    }
    if (action === 'step2-upload') {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ error: 'Method not allowed' });
      }
      const ctx = await validatePublicToken(token, { require_step: 2, require_verified: true });
      if (!ctx.ok) return res.status(ctx.status).json({ error: ctx.message, code: ctx.code });
      return await step2UploadAction(req, res, ctx);
    }
    if (action === 'step2-update-evidence-meta') {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ error: 'Method not allowed' });
      }
      const ctx = await validatePublicToken(token, { require_step: 2, require_verified: true });
      if (!ctx.ok) return res.status(ctx.status).json({ error: ctx.message, code: ctx.code });
      return await step2UpdateEvidenceMetaAction(req, res, ctx);
    }
    if (action === 'step2-delete-evidence') {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ error: 'Method not allowed' });
      }
      const ctx = await validatePublicToken(token, { require_step: 2, require_verified: true });
      if (!ctx.ok) return res.status(ctx.status).json({ error: ctx.message, code: ctx.code });
      return await step2DeleteEvidenceAction(req, res, ctx);
    }
    if (action === 'step2-save-draft') {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ error: 'Method not allowed' });
      }
      const ctx = await validatePublicToken(token, { require_step: 2, require_verified: true });
      if (!ctx.ok) return res.status(ctx.status).json({ error: ctx.message, code: ctx.code });
      return await step2SaveDraftAction(req, res, ctx);
    }
    if (action === 'step2-submit') {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ error: 'Method not allowed' });
      }
      const ctx = await validatePublicToken(token, { require_step: 2, require_verified: true });
      if (!ctx.ok) return res.status(ctx.status).json({ error: ctx.message, code: ctx.code });
      return await step2SubmitAction(req, res, ctx);
    }

    return res.status(404).json({ error: 'Unknown action: ' + action });
  } catch (err) {
    console.error('[public/lease-offers] error:', err);
    return res.status(500).json({ error: err.message });
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   Shared: token-info — returns masked email + verified flag
   ══════════════════════════════════════════════════════════════════════════ */
async function tokenInfoAction(req, res, token, requireStep) {
  const ctx = await validatePublicToken(token, { require_step: requireStep, require_verified: false });
  if (!ctx.ok) {
    return res.status(ctx.status).json({ error: ctx.message, code: ctx.code });
  }
  return res.status(200).json({
    verified:      !!ctx.token_row.email_verified,
    masked_email:  maskEmail(ctx.token_row.applicant_email),
    step:          ctx.token_row.step,
    expires_at:    ctx.token_row.expires_at,
  });
}

/* ══════════════════════════════════════════════════════════════════════════
   Shared: verify — flip email_verified=true (idempotent)
   ══════════════════════════════════════════════════════════════════════════ */
async function verifyAction(req, res, token, requireStep) {
  const ctx = await validatePublicToken(token, { require_step: requireStep, require_verified: false });
  if (!ctx.ok) {
    return res.status(ctx.status).json({ error: ctx.message, code: ctx.code });
  }

  // Optional: lightweight mobile-challenge check against the linked Contact.
  // The current form posts { mobile } but we don't fail on mismatch — the
  // unguessable token is the real auth. Treat the mobile as informational.
  // (Future: enforce a match if Q1 of the V77.3 plan requires it.)

  if (ctx.token_row.email_verified) {
    return res.status(200).json({ verified: true, already: true });
  }
  const newExpires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  await sql`
    UPDATE applicant_form_tokens
       SET email_verified = true,
           verified_at    = now(),
           expires_at     = ${newExpires.toISOString()}
     WHERE id = ${ctx.token_row.id}`;
  return res.status(200).json({ verified: true, expires_at: newExpires.toISOString() });
}

/* ══════════════════════════════════════════════════════════════════════════
   STEP 1 — load form context
   ══════════════════════════════════════════════════════════════════════════ */
async function loadAction(req, res, ctx) {
  const application_id = ctx.application.id;
  const deal_id = ctx.application.deal_id;

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

  let listingTerms = {};
  if (row.parent_deal_id) {
    const parentRows = await sql`SELECT data FROM deals WHERE id = ${row.parent_deal_id} LIMIT 1`;
    listingTerms = parentRows[0]?.data?.terms || {};
  }

  const tokenRows = await sql`
    SELECT t.contact_id, t.applicant_email,
           c.first_name, c.last_name, c.email, c.phone
    FROM applicant_form_tokens t
    LEFT JOIN contacts c ON c.id = t.contact_id
    WHERE t.id = ${ctx.token_row.id}`;
  const tokenInfo = tokenRows[0] || {};

  const primaryDefault = {
    first_name: tokenInfo.first_name || '',
    last_name:  tokenInfo.last_name  || '',
    email:      tokenInfo.email      || tokenInfo.applicant_email || '',
    mobile:     tokenInfo.phone      || '',
    dob:        '',
    current_address: '',
    pets:       '',
    smoker:     null,
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
      bond:           listingTerms.bond || null,
      term_months:    listingTerms.term_months || null,
      available_from: listingTerms.available_from || null,
      special_terms:  listingTerms.special_terms || '',
    },
    primary_applicant_default: primaryDefault,
    expires_at: ctx.token_row.expires_at,
  });
}

/* ══════════════════════════════════════════════════════════════════════════
   STEP 1 — autosave draft
   ══════════════════════════════════════════════════════════════════════════ */
async function submitDraftAction(req, res, ctx) {
  const body = req.body || {};
  const application_id = ctx.application.id;

  if (ctx.application.status !== 'draft') {
    return res.status(409).json({ error: 'This offer has already been submitted and cannot be edited.' });
  }

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

/* ══════════════════════════════════════════════════════════════════════════
   STEP 1 — final submit
   ══════════════════════════════════════════════════════════════════════════ */
async function submitAction(req, res, ctx) {
  const body = req.body || {};
  const application_id = ctx.application.id;

  if (ctx.application.status !== 'draft') {
    return res.status(409).json({ error: 'This offer has already been submitted.' });
  }

  const updates = sanitiseFormPayload(body);
  const validationErrors = validateForSubmit(updates);
  if (validationErrors.length) {
    return res.status(400).json({ error: 'Validation failed', errors: validationErrors });
  }

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

  try {
    await fireAgentNotification(ctx, updates);
  } catch (err) {
    console.error('[public/lease-offers/submit] agent notification failed:', err);
  }

  return res.status(200).json({
    submitted: true,
    submitted_at: new Date().toISOString(),
  });
}

async function fireAgentNotification(ctx, updates) {
  const application_id = ctx.application.id;
  const deal_id = ctx.application.deal_id;

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

/* ══════════════════════════════════════════════════════════════════════════
   STEP 2 — load (form context + applicants from accepted offer + existing evidence)
   ══════════════════════════════════════════════════════════════════════════ */
async function step2LoadAction(req, res, ctx) {
  const application_id = ctx.application.id;
  const deal_id = ctx.application.deal_id;

  const rows = await sql`
    SELECT a.id, a.status, a.applicants_jsonb,
           a.credit_check_consent_at, a.tenancy_database_consent_at, a.retention_consent_at,
           d.id AS deal_id,
           p.address, p.suburb, p.state, p.postcode
    FROM applications a
    JOIN deals d        ON d.id = a.deal_id
    LEFT JOIN properties p ON p.id = d.property_id
    WHERE a.id = ${application_id}
    LIMIT 1`;
  const row = rows[0];
  if (!row) return res.status(404).json({ error: 'Application not found' });

  // Load applicants: prefer applicants_jsonb (post-acceptance has contact_id baked in).
  // Fall back to the token's linked Contact alone.
  let applicants = Array.isArray(row.applicants_jsonb) ? row.applicants_jsonb : [];
  if (!applicants.length) {
    const tRows = await sql`
      SELECT t.contact_id, t.applicant_email,
             c.first_name, c.last_name, c.email, c.phone
      FROM applicant_form_tokens t
      LEFT JOIN contacts c ON c.id = t.contact_id
      WHERE t.id = ${ctx.token_row.id}`;
    const t = tRows[0];
    if (t) applicants = [{
      contact_id: t.contact_id, first_name: t.first_name, last_name: t.last_name,
      email: t.email || t.applicant_email, mobile: t.phone || '',
    }];
  }

  // Existing housing/income history rows
  const housingHistory = await sql`
    SELECT id, applicant_contact_id, housing_type, address, monthly_amount,
           term_value, term_unit, term_start_date, term_end_date,
           landlord_lender_name, landlord_lender_contact, notes, sort_order
    FROM application_housing_history
    WHERE application_id = ${application_id}
    ORDER BY sort_order ASC, id ASC`;

  const incomeHistory = await sql`
    SELECT id, applicant_contact_id, income_type, income_source_name, role,
           annual_income, term_value, term_unit, term_start_date, term_end_date,
           employer_contact_name, employer_contact_email, employer_contact_mobile,
           notes, sort_order
    FROM application_income_history
    WHERE application_id = ${application_id}
    ORDER BY sort_order ASC, id ASC`;

  // Existing evidence files
  const evidence = await sql`
    SELECT id, applicant_contact_id, category, filename, mime_type,
           size_bytes, url, points_value, doc_type, uploaded_at
    FROM application_evidence
    WHERE application_id = ${application_id}
    ORDER BY uploaded_at ASC, id ASC`;

  // Map DB housing/income rows to the shape the form expects
  const housingForForm = housingHistory.map(h => ({
    server_id:     h.id,
    client_id:     'srv' + h.id,                       // stable mapping back
    applicant_contact_id: h.applicant_contact_id,
    housing_type:  h.housing_type || 'rented',
    address:       h.address || '',
    monthly_amount: h.monthly_amount,
    term_value:    h.term_value,
    term_unit:     h.term_unit || 'months',
    started_at:    h.term_start_date,
    ended_at:      h.term_end_date,
    current_residence: !h.term_end_date,
    landlord_name: h.landlord_lender_name || '',
    landlord_email: '',                                // not stored as separate column — see landlord_lender_contact
    landlord_phone: h.landlord_lender_contact || '',
    notes:         h.notes || '',
  }));

  const incomeForForm = incomeHistory.map(i => ({
    server_id:     i.id,
    client_id:     'srv' + i.id,
    applicant_contact_id: i.applicant_contact_id,
    income_type:   i.income_type || 'employment',
    income_source_name: i.income_source_name || '',
    position:      i.role || '',
    gross_amount:  i.annual_income,
    gross_period:  i.term_unit || 'weekly',
    started_at:    i.term_start_date,
    ended_at:      i.term_end_date,
    current_role:  !i.term_end_date,
    manager_name:  i.employer_contact_name || '',
    manager_email: i.employer_contact_email || '',
    manager_phone: i.employer_contact_mobile || '',
    notes:         i.notes || '',
  }));

  return res.status(200).json({
    application: {
      id: row.id,
      status: row.status,
      applicants: applicants,
      credit_check_consent_at:    row.credit_check_consent_at,
      tenancy_database_consent_at: row.tenancy_database_consent_at,
      retention_consent_at:       row.retention_consent_at,
    },
    property: {
      address:  row.address  || '',
      suburb:   row.suburb   || '',
      state:    row.state    || '',
      postcode: row.postcode || '',
    },
    housing_history: housingForForm,
    income_history:  incomeForForm,
    evidence:        evidence,
    expires_at:      ctx.token_row.expires_at,
  });
}

/* ══════════════════════════════════════════════════════════════════════════
   STEP 2 — upload evidence file (multipart-as-base64)
   Body: { filename, mime_type, size, applicant_contact_id, category,
           points_value, body_base64 }
   ══════════════════════════════════════════════════════════════════════════ */
async function step2UploadAction(req, res, ctx) {
  const body = req.body || {};
  const application_id = ctx.application.id;

  const filename = toText(body.filename, 255);
  const mime_type = toText(body.mime_type, 100) || 'application/octet-stream';
  const size = parseInt(body.size, 10) || 0;
  const applicant_contact_id = body.applicant_contact_id ? parseInt(body.applicant_contact_id, 10) : null;
  const category = toText(body.category, 100);
  const points_value = parseInt(body.points_value, 10) || 0;
  const body_base64 = body.body_base64;

  if (!filename) return res.status(400).json({ error: 'filename is required' });
  if (!category) return res.status(400).json({ error: 'category is required' });
  if (!body_base64 || typeof body_base64 !== 'string') {
    return res.status(400).json({ error: 'body_base64 is required' });
  }

  if (size > 10 * 1024 * 1024) {
    return res.status(413).json({ error: 'File too large. Maximum 10 MB per file.' });
  }

  let buffer;
  try {
    buffer = Buffer.from(body_base64, 'base64');
  } catch (err) {
    return res.status(400).json({ error: 'Invalid base64 body' });
  }

  // Upload to Vercel Blob (private)
  let uploaded;
  try {
    uploaded = await Blob.upload({
      application_id,
      applicant_or_token: applicant_contact_id ? `applicant-${applicant_contact_id}` : `token-${ctx.token_row.id}`,
      category,
      filename,
      mime_type,
      body: buffer,
      size,
    });
  } catch (err) {
    console.error('[step2-upload] blob upload failed:', err);
    return res.status(500).json({ error: 'File storage failed: ' + err.message });
  }

  // Insert evidence row
  const inserted = await sql`
    INSERT INTO application_evidence
      (application_id, applicant_contact_id, category, filename, mime_type,
       size_bytes, url, points_value)
    VALUES
      (${application_id}, ${applicant_contact_id}, ${category}, ${filename}, ${mime_type},
       ${size}, ${uploaded.url}, ${points_value})
    RETURNING id, application_id, applicant_contact_id, category, filename,
              mime_type, size_bytes, url, points_value, uploaded_at`;

  return res.status(200).json({ evidence: inserted[0] });
}

/* ══════════════════════════════════════════════════════════════════════════
   STEP 2 — update evidence row metadata (doc_type + points_value)
   ══════════════════════════════════════════════════════════════════════════ */
async function step2UpdateEvidenceMetaAction(req, res, ctx) {
  const body = req.body || {};
  const application_id = ctx.application.id;
  const evidence_id = parseInt(body.evidence_id, 10);
  const doc_type = toText(body.doc_type, 50);
  const points_value = parseInt(body.points_value, 10) || 0;

  if (!evidence_id) return res.status(400).json({ error: 'evidence_id is required' });

  // Scope check — must belong to this application
  const owns = await sql`
    SELECT id FROM application_evidence
    WHERE id = ${evidence_id} AND application_id = ${application_id}
    LIMIT 1`;
  if (!owns.length) return res.status(404).json({ error: 'Evidence not found' });

  await sql`
    UPDATE application_evidence
       SET doc_type     = ${doc_type},
           points_value = ${points_value}
     WHERE id = ${evidence_id}`;

  return res.status(200).json({ updated: true });
}

/* ══════════════════════════════════════════════════════════════════════════
   STEP 2 — delete evidence row + blob
   ══════════════════════════════════════════════════════════════════════════ */
async function step2DeleteEvidenceAction(req, res, ctx) {
  const body = req.body || {};
  const application_id = ctx.application.id;
  const evidence_id = parseInt(body.evidence_id, 10);

  if (!evidence_id) return res.status(400).json({ error: 'evidence_id is required' });

  // Scope check + grab URL for blob deletion
  const rows = await sql`
    SELECT id, url FROM application_evidence
    WHERE id = ${evidence_id} AND application_id = ${application_id}
    LIMIT 1`;
  if (!rows.length) return res.status(404).json({ error: 'Evidence not found' });

  const url = rows[0].url;

  // Best-effort blob delete — if it fails (already gone), keep going
  try {
    await Blob.remove(url);
  } catch (err) {
    console.warn('[step2-delete-evidence] blob remove failed (continuing):', err.message);
  }

  await sql`DELETE FROM application_evidence WHERE id = ${evidence_id}`;
  return res.status(200).json({ deleted: true });
}

/* ══════════════════════════════════════════════════════════════════════════
   STEP 2 — autosave (replace housing_history + income_history + consents)
   ══════════════════════════════════════════════════════════════════════════ */
async function step2SaveDraftAction(req, res, ctx) {
  const body = req.body || {};
  const application_id = ctx.application.id;

  if (!isStep2Editable(ctx.application.status)) {
    return res.status(409).json({ error: 'This evidence has already been submitted.' });
  }

  await persistStep2Payload(application_id, body, /* finalSubmit */ false);

  return res.status(200).json({ saved: true, saved_at: new Date().toISOString() });
}

/* ══════════════════════════════════════════════════════════════════════════
   STEP 2 — final submit (offer_accepted → evidence_submitted + agent email)
   ══════════════════════════════════════════════════════════════════════════ */
async function step2SubmitAction(req, res, ctx) {
  const body = req.body || {};
  const application_id = ctx.application.id;

  if (!isStep2Editable(ctx.application.status)) {
    return res.status(409).json({ error: 'This evidence has already been submitted.' });
  }

  // Server-side validation: required consents + 100 ID points per applicant
  const errs = await validateStep2Submit(application_id, body);
  if (errs.length) {
    return res.status(400).json({ error: 'Validation failed', errors: errs });
  }

  await persistStep2Payload(application_id, body, /* finalSubmit */ true);

  // Status flip
  await sql`
    UPDATE applications
       SET status                  = 'evidence_submitted',
           evidence_submitted_at   = now(),
           updated_at              = now()
     WHERE id = ${application_id}`;

  try {
    await fireEvidenceSubmittedNotification(ctx);
  } catch (err) {
    console.error('[public/lease-offers/step2-submit] agent notification failed:', err);
  }

  return res.status(200).json({
    submitted: true,
    submitted_at: new Date().toISOString(),
  });
}

async function fireEvidenceSubmittedNotification(ctx) {
  const application_id = ctx.application.id;
  const deal_id = ctx.application.deal_id;

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
    console.warn('[public/lease-offers/step2-submit] no agent email — skip notification');
    return;
  }

  const agentName = [row.agent_first, row.agent_last].filter(Boolean).join(' ').trim() || 'Agent';
  const propertyAddress = [row.address, row.suburb, row.state].filter(Boolean).join(', ');

  // Applicant name from the application
  const appRows = await sql`
    SELECT applicants_jsonb FROM applications WHERE id = ${application_id} LIMIT 1`;
  const applicants = appRows[0]?.applicants_jsonb || [];
  const primary = applicants[0] || {};
  const applicantName = [primary.first_name, primary.last_name].filter(Boolean).join(' ').trim() || ctx.token_row.applicant_email;

  const cfg = await Email.getConfig();
  const dealUrl = `${cfg.app_public_url}/?deal=${encodeURIComponent(deal_id)}`;

  await Email.send({
    to: row.agent_email,
    channel: 'leasing',
    template: evidenceSubmittedTpl,
    template_id: 'lease-offer-evidence-submitted-agent-notification',
    vars: {
      agent_name:       agentName,
      applicant_name:   applicantName,
      property_address: propertyAddress,
      deal_url:         dealUrl,
      submitted_at:     new Date().toLocaleString('en-AU', { timeZone: 'Australia/Sydney', dateStyle: 'medium', timeStyle: 'short' }),
      agency_name:      'Edan Property',
    },
    related_entity_type: 'application',
    related_entity_id:   application_id,
  });
}

/* ══════════════════════════════════════════════════════════════════════════
   STEP 2 helpers — persist payload, validate submit
   ══════════════════════════════════════════════════════════════════════════ */
function isStep2Editable(status) {
  return status === 'offer_accepted'
      || status === 'evidence_resubmit_requested';
  // 'evidence_submitted' = locked; 'validated' = locked; 'leased' = locked
}

async function persistStep2Payload(application_id, body, finalSubmit) {
  // Consents — record timestamps on the application row.
  // For autosave, only flip a stored timestamp on first 'true'; don't unset.
  const credit    = !!body.credit_check_consent;
  const tenancy   = !!body.tenancy_database_consent;
  const retention = !!body.retention_consent;

  // For final submit, also require the reference consent — but that's
  // checked in validateStep2Submit. Reference consent is currently bundled
  // with the application as 'credit_check_consent_at' in some prior
  // designs; per the schema we only persist the three columns above.
  await sql`
    UPDATE applications
       SET credit_check_consent_at      = CASE WHEN ${credit}    AND credit_check_consent_at      IS NULL THEN now() ELSE credit_check_consent_at      END,
           tenancy_database_consent_at  = CASE WHEN ${tenancy}   AND tenancy_database_consent_at  IS NULL THEN now() ELSE tenancy_database_consent_at  END,
           retention_consent_at         = CASE WHEN ${retention} AND retention_consent_at         IS NULL THEN now() ELSE retention_consent_at         END,
           updated_at                   = now()
     WHERE id = ${application_id}`;

  // Housing history — replace strategy:
  // Wipe all existing rows for this application, then insert what came in.
  // Simpler than diffing client_id ↔ server_id and matches the form's
  // autosave-every-blur cadence.
  const housing = Array.isArray(body.housing_history) ? body.housing_history : [];
  await sql`DELETE FROM application_housing_history WHERE application_id = ${application_id}`;
  let sortOrder = 0;
  for (const h of housing) {
    if (!h || (typeof h !== 'object')) continue;
    sortOrder += 1;
    await sql`
      INSERT INTO application_housing_history
        (application_id, applicant_contact_id, housing_type, address,
         monthly_amount, term_value, term_unit, term_start_date, term_end_date,
         landlord_lender_name, landlord_lender_contact, notes, sort_order)
      VALUES
        (${application_id},
         ${h.applicant_contact_id ? parseInt(h.applicant_contact_id, 10) : null},
         ${toText(h.housing_type, 30) || 'rented'},
         ${toText(h.address, 300) || ''},
         ${toNumber(h.monthly_amount)},
         ${h.term_value ? parseInt(h.term_value, 10) : null},
         ${toText(h.term_unit, 20)},
         ${toIsoDate(h.started_at)},
         ${h.current_residence ? null : toIsoDate(h.ended_at)},
         ${toText(h.landlord_name, 200)},
         ${toText(h.landlord_phone, 100) || toText(h.landlord_email, 200)},
         ${toText(h.notes, 1000)},
         ${sortOrder})`;
  }

  // Income history — same replace strategy
  const income = Array.isArray(body.income_history) ? body.income_history : [];
  await sql`DELETE FROM application_income_history WHERE application_id = ${application_id}`;
  sortOrder = 0;
  for (const i of income) {
    if (!i || (typeof i !== 'object')) continue;
    sortOrder += 1;
    await sql`
      INSERT INTO application_income_history
        (application_id, applicant_contact_id, income_type, income_source_name, role,
         annual_income, term_value, term_unit, term_start_date, term_end_date,
         employer_contact_name, employer_contact_email, employer_contact_mobile,
         notes, sort_order)
      VALUES
        (${application_id},
         ${i.applicant_contact_id ? parseInt(i.applicant_contact_id, 10) : null},
         ${toText(i.income_type, 30) || 'employment'},
         ${toText(i.income_source_name, 200) || ''},
         ${toText(i.position, 200)},
         ${toNumber(i.gross_amount)},
         ${i.term_value ? parseInt(i.term_value, 10) : null},
         ${toText(i.gross_period, 20)},
         ${toIsoDate(i.started_at)},
         ${i.current_role ? null : toIsoDate(i.ended_at)},
         ${toText(i.manager_name, 200)},
         ${toText(i.manager_email, 200)},
         ${toText(i.manager_phone, 50)},
         ${toText(i.notes, 1000)},
         ${sortOrder})`;
  }
}

async function validateStep2Submit(application_id, body) {
  const errs = [];

  if (!body.reference_consent)  errs.push({ field: 'reference_consent',  error: 'You must agree to allow reference checks.' });
  if (!body.retention_consent)  errs.push({ field: 'retention_consent',  error: 'You must agree to the records retention policy.' });

  // 100-points-per-applicant check from application_evidence rows
  const appRows = await sql`SELECT applicants_jsonb FROM applications WHERE id = ${application_id} LIMIT 1`;
  const applicants = appRows[0]?.applicants_jsonb || [];

  const idRows = await sql`
    SELECT applicant_contact_id, COALESCE(SUM(points_value), 0) AS total_points
    FROM application_evidence
    WHERE application_id = ${application_id} AND category = 'id-100-points'
    GROUP BY applicant_contact_id`;
  const totalsByContact = new Map();
  for (const r of idRows) {
    totalsByContact.set(r.applicant_contact_id || null, parseInt(r.total_points, 10) || 0);
  }

  applicants.forEach((a, i) => {
    const total = totalsByContact.get(a.contact_id || null) || 0;
    if (total < 100) {
      const name = [a.first_name, a.last_name].filter(Boolean).join(' ') || `Applicant ${i + 1}`;
      errs.push({ field: `id_points[${i}]`, error: `${name}: only ${total} ID points uploaded — 100 needed.` });
    }
  });

  // Doc-type required on every ID file
  const untyped = await sql`
    SELECT id, filename FROM application_evidence
    WHERE application_id = ${application_id}
      AND category = 'id-100-points'
      AND (doc_type IS NULL OR doc_type = '')`;
  for (const u of untyped) {
    errs.push({ field: 'doc_type', error: `File "${u.filename}" needs a document type selected.` });
  }

  return errs;
}

/* ══════════════════════════════════════════════════════════════════════════
   Step 1 sanitisers / validators (unchanged from prior version)
   ══════════════════════════════════════════════════════════════════════════ */
function sanitiseFormPayload(body) {
  return {
    requested_rent:       toNumber(body.requested_rent),
    bond_weeks:           clampInt(body.bond_weeks, 4, 52, 4),
    lease_term_months:    clampInt(body.lease_term_months, 1, 240, null),
    preferred_start_date: toIsoDate(body.preferred_start_date),
    terms:                toText(body.terms, 2000),
    occupants:            sanitiseOccupants(body.occupants),
    pets:                 sanitisePets(body.pets),
    applicants:           sanitiseApplicants(body.applicants),
  };
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
      first_name:           toText(a.first_name, 100),
      last_name:            toText(a.last_name, 100),
      email:                toEmail(a.email),
      mobile:               toText(a.mobile, 30),
      dob:                  toIsoDate(a.dob),
      current_address:      toText(a.current_address, 300),
      smoker:               a.smoker === true ? true : (a.smoker === false ? false : null),
      employment_status:    toText(a.employment_status, 50),
      employer_name:        toText(a.employer_name, 200),
      position:             toText(a.position, 200),
      gross_weekly_income:  toNumber(a.gross_weekly_income),
      length_of_employment: toText(a.length_of_employment, 100),
    };
  }).filter(Boolean);
}

function validateForSubmit(p) {
  const errs = [];
  if (!p.requested_rent || p.requested_rent <= 0) errs.push({ field: 'requested_rent', error: 'Rent offered is required.' });
  if (!p.bond_weeks)           errs.push({ field: 'bond_weeks', error: 'Bond is required (min 4 weeks).' });
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

/* ══════════════════════════════════════════════════════════════════════════
   Generic sanitisers
   ══════════════════════════════════════════════════════════════════════════ */
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
  const s = String(v).trim();
  // Accept YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS… — slice the date portion
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function maskEmail(email) {
  if (!email || typeof email !== 'string') return '';
  const at = email.indexOf('@');
  if (at < 0) return email;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const maskedLocal = local.length <= 2
    ? local[0] + '•'
    : local[0] + '•'.repeat(Math.max(1, local.length - 2)) + local[local.length - 1];
  const dot = domain.indexOf('.');
  const maskedDomain = dot < 0
    ? domain[0] + '•••'
    : domain[0] + '•••' + domain.slice(dot);
  return maskedLocal + '@' + maskedDomain;
}
