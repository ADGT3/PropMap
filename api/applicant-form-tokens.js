/**
 * api/applicant-form-tokens.js — V77.2
 *
 * Magic-link token management for the public-form layer.
 *
 * Endpoints:
 *   GET  /api/applicant-form-tokens?application_id=N            → list tokens for an offer
 *   POST /api/applicant-form-tokens (action='issue')            → issue Step 1 or Step 2 link
 *                                                                 (replaces existing for same step)
 *   POST /api/applicant-form-tokens (action='verify')           → mark token email_verified=true
 *                                                                 (called by /lease-offer/{token} verify-email page)
 *   POST /api/applicant-form-tokens (action='resend')           → re-send email for existing token
 *   POST /api/applicant-form-tokens (action='reissue')          → invalidate old, issue fresh + email
 *
 * Issue body shape:
 *   {
 *     action: 'issue',
 *     application_id: <number>,
 *     step: 1 | 2,
 *     contact_id: <number>          (the linked applicant Contact id; email is read from contact.email)
 *   }
 *
 * Resend / Reissue body shape:
 *   { action: 'resend' | 'reissue', token_id: <number> }
 *
 * Verify body shape (called from public verify-email page):
 *   { action: 'verify', token: '<token-string>' }
 *
 * Auth:
 *   - issue / resend / reissue / list: agent session required (requireSession)
 *   - verify: PUBLIC — no agent session, just relies on the unguessable token
 */

import { neon } from '@neondatabase/serverless';
import { requireSession } from '../lib/auth.js';
import { getDatabaseUrl } from '../lib/db.js';
import { generateToken } from '../lib/public-token-auth.js';
import Email from '../lib/email.js';
import * as step1Tpl from '../emails/lease-offer-step-1-invite.js';
import * as step2Tpl from '../emails/lease-offer-step-2-invite.js';

const sql = neon(getDatabaseUrl());

// Token TTLs (in days)
const TTL_UNVERIFIED_DAYS = 7;
const TTL_VERIFIED_DAYS   = 30;

export default async function handler(req, res) {
  try {
    if (req.method === 'GET')  return await getList(req, res);
    if (req.method === 'POST') return await postAction(req, res);
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[applicant-form-tokens] error:', err);
    return res.status(500).json({ error: err.message });
  }
}

async function getList(req, res) {
  // List tokens for an offer (agent UI uses this to render link state)
  const session = await requireSession(req, res);
  if (!session) return;

  const application_id = req.query?.application_id;
  if (!application_id) return res.status(400).json({ error: 'application_id is required' });

  const rows = await sql`
    SELECT id, application_id, step, token, applicant_email,
           email_verified, verified_at, expires_at, last_accessed_at, created_at
    FROM applicant_form_tokens
    WHERE application_id = ${application_id}
    ORDER BY step ASC, created_at DESC`;
  return res.status(200).json(rows);
}

async function postAction(req, res) {
  const body = req.body || {};
  const action = body.action;

  if (action === 'verify') return await verifyToken(req, res, body);

  // All other actions are agent-only
  const session = await requireSession(req, res);
  if (!session) return;

  if (action === 'issue')   return await issueToken(req, res, body, session);
  if (action === 'resend')  return await resendEmail(req, res, body, session);
  if (action === 'reissue') return await reissueToken(req, res, body, session);

  return res.status(400).json({ error: 'Unknown action' });
}

// ── Issue (Step 1 or Step 2) ────────────────────────────────────────────────
async function issueToken(req, res, body, session) {
  const application_id = parseInt(body.application_id, 10);
  const step = parseInt(body.step, 10);
  const contact_id = parseInt(body.contact_id, 10);
  if (!application_id || !step || ![1, 2].includes(step)) {
    return res.status(400).json({ error: 'application_id and step (1 or 2) are required' });
  }
  if (!contact_id) {
    return res.status(400).json({ error: 'contact_id is required (the linked applicant Contact)' });
  }

  // Look up application + deal + property + agent + contact
  const appRows = await sql`
    SELECT a.id, a.deal_id, a.status,
           d.board_id,
           p.address, p.suburb, p.state
    FROM applications a
    LEFT JOIN deals d      ON d.id = a.deal_id
    LEFT JOIN properties p ON p.id = d.property_id
    WHERE a.id = ${application_id}
    LIMIT 1`;
  const app = appRows[0];
  if (!app) return res.status(404).json({ error: 'Application not found' });

  // Step 2 requires status to be offer_accepted (or evidence_submitted, allows resend)
  if (step === 2 && !['offer_accepted', 'evidence_submitted'].includes(app.status)) {
    return res.status(409).json({ error: `Cannot issue Step 2 link — application status is "${app.status}". Must be offer_accepted.` });
  }

  // Look up applicant Contact
  const contactRows = await sql`
    SELECT id, first_name, last_name, email
    FROM contacts WHERE id = ${contact_id}`;
  const contact = contactRows[0];
  if (!contact) return res.status(404).json({ error: 'Contact not found' });
  if (!contact.email || !/^\S+@\S+\.\S+$/.test(contact.email)) {
    return res.status(400).json({ error: 'Contact has no valid email — edit the Contact and try again.' });
  }

  const applicantName = [contact.first_name, contact.last_name].filter(Boolean).join(' ').trim() || contact.email;
  const propertyAddress = [app.address, app.suburb, app.state].filter(Boolean).join(', ');

  // Generate fresh token; UNIQUE on (application_id, step) means we delete any
  // existing token for this offer+step first.
  await sql`DELETE FROM applicant_form_tokens WHERE application_id = ${application_id} AND step = ${step}`;

  const token = generateToken(32);
  const expiresAt = new Date(Date.now() + TTL_UNVERIFIED_DAYS * 24 * 60 * 60 * 1000);
  const triggeredBy = session.contact?.id || null;

  const tokenRows = await sql`
    INSERT INTO applicant_form_tokens (application_id, step, token, contact_id, applicant_email, expires_at, created_by)
    VALUES (${application_id}, ${step}, ${token}, ${contact_id}, ${contact.email}, ${expiresAt.toISOString()}, ${triggeredBy})
    RETURNING id, token, contact_id, applicant_email, expires_at, created_at`;
  const tokenRow = tokenRows[0];

  // Send invite email (V77.2 stub — logs to email_log)
  const formUrl = await Email.leaseOfferUrl(token);
  const tpl = step === 1 ? step1Tpl : step2Tpl;
  const tplId = step === 1 ? 'lease-offer-step-1-invite' : 'lease-offer-step-2-invite';

  const sessionName = session.name || session.email || 'Your agent';

  let emailResult = null;
  try {
    emailResult = await Email.send({
      to: contact.email,
      channel: 'leasing',
      template: tpl,
      template_id: tplId,
      vars: {
        applicant_name:   applicantName,
        property_address: propertyAddress,
        form_url:         formUrl,
        agent_name:       sessionName,
        agency_name:      'Edan Property',
        expires_in_days:  TTL_UNVERIFIED_DAYS,
      },
      related_entity_type: 'application',
      related_entity_id:   application_id,
      triggered_by:        triggeredBy,
    });
  } catch (err) {
    console.error('[applicant-form-tokens] email send failed:', err);
    // Token still issued; return note so UI can flag
  }

  return res.status(200).json({
    token: tokenRow,
    form_url: formUrl,
    email: emailResult,
  });
}

// ── Verify (PUBLIC — called from /lease-offer/{token}) ─────────────────────
async function verifyToken(req, res, body) {
  const token = body.token;
  if (!token) return res.status(400).json({ error: 'token is required' });

  const rows = await sql`
    SELECT id, application_id, step, applicant_email, email_verified, expires_at, created_at
    FROM applicant_form_tokens
    WHERE token = ${token}
    LIMIT 1`;
  const row = rows[0];
  if (!row) return res.status(404).json({ error: 'Invalid or expired link' });
  if (row.expires_at && new Date(row.expires_at) < new Date()) {
    return res.status(410).json({ error: 'This link has expired' });
  }

  // Idempotent: if already verified, just return current state
  if (row.email_verified) {
    return res.status(200).json({ verified: true, already: true, token_id: row.id, step: row.step });
  }

  // Set email_verified=true, extend expires_at to verified TTL
  const newExpires = new Date(Date.now() + TTL_VERIFIED_DAYS * 24 * 60 * 60 * 1000);
  await sql`
    UPDATE applicant_form_tokens
       SET email_verified = true,
           verified_at    = now(),
           expires_at     = ${newExpires.toISOString()}
     WHERE id = ${row.id}`;

  return res.status(200).json({
    verified: true,
    token_id: row.id,
    step: row.step,
    expires_at: newExpires.toISOString(),
  });
}

// ── Resend email (re-fire to same address, no token change) ────────────────
async function resendEmail(req, res, body, session) {
  const token_id = parseInt(body.token_id, 10);
  if (!token_id) return res.status(400).json({ error: 'token_id is required' });

  // Look up token + linked Contact + property context
  const rows = await sql`
    SELECT t.id, t.application_id, t.step, t.token, t.contact_id, t.applicant_email AS token_email, t.expires_at,
           a.deal_id, a.status AS app_status,
           p.address, p.suburb, p.state,
           c.email AS contact_email, c.first_name, c.last_name
    FROM applicant_form_tokens t
    LEFT JOIN applications a ON a.id = t.application_id
    LEFT JOIN deals d        ON d.id = a.deal_id
    LEFT JOIN properties p   ON p.id = d.property_id
    LEFT JOIN contacts c     ON c.id = t.contact_id
    WHERE t.id = ${token_id}
    LIMIT 1`;
  const row = rows[0];
  if (!row) return res.status(404).json({ error: 'Token not found' });
  if (!row.app_status) return res.status(404).json({ error: 'Linked application missing' });
  if (row.expires_at && new Date(row.expires_at) < new Date()) {
    return res.status(410).json({ error: 'Token has expired — use Reissue instead.' });
  }

  // V77.2: email comes from the linked Contact's CURRENT email. If the agent
  // edited the Contact since issue (e.g. fixed a typo), the resend goes to
  // the new address. The token row's applicant_email field is also updated to
  // stay in sync. If the Contact has been deleted/unlinked, fall back to the
  // token's stored email.
  const targetEmail = row.contact_email || row.token_email;
  if (!targetEmail || !/^\S+@\S+\.\S+$/.test(targetEmail)) {
    return res.status(400).json({ error: 'No valid email available — edit the linked Contact and try again.' });
  }
  if (row.contact_email && row.contact_email.toLowerCase() !== row.token_email.toLowerCase()) {
    // Contact email was changed since token issue — sync it
    await sql`UPDATE applicant_form_tokens SET applicant_email = ${row.contact_email} WHERE id = ${row.id}`;
  }

  const applicantName = [row.first_name, row.last_name].filter(Boolean).join(' ').trim() || targetEmail;
  const propertyAddress = [row.address, row.suburb, row.state].filter(Boolean).join(', ');

  const formUrl = await Email.leaseOfferUrl(row.token);
  const tpl = row.step === 1 ? step1Tpl : step2Tpl;
  const tplId = row.step === 1 ? 'lease-offer-step-1-invite' : 'lease-offer-step-2-invite';
  const sessionName = session.name || session.email || 'Your agent';

  // Compute remaining days until expiry
  const expiresAt = new Date(row.expires_at);
  const daysLeft = Math.max(1, Math.round((expiresAt - new Date()) / (24 * 60 * 60 * 1000)));

  const result = await Email.send({
    to: targetEmail,
    channel: 'leasing',
    template: tpl,
    template_id: tplId,
    vars: {
      applicant_name:   applicantName,
      property_address: propertyAddress,
      form_url:         formUrl,
      agent_name:       sessionName,
      agency_name:      'Edan Property',
      expires_in_days:  daysLeft,
    },
    related_entity_type: 'application',
    related_entity_id:   row.application_id,
    triggered_by:        session.contact?.id || null,
  });

  return res.status(200).json({ resent: true, email: result, sent_to: targetEmail });
}

// ── Reissue (invalidate old token, issue fresh) ─────────────────────────────
async function reissueToken(req, res, body, session) {
  const token_id = parseInt(body.token_id, 10);
  if (!token_id) return res.status(400).json({ error: 'token_id is required' });

  // Find existing token's application_id, step, and contact_id
  const rows = await sql`
    SELECT application_id, step, contact_id
    FROM applicant_form_tokens
    WHERE id = ${token_id}
    LIMIT 1`;
  const row = rows[0];
  if (!row) return res.status(404).json({ error: 'Token not found' });
  if (!row.contact_id) {
    return res.status(400).json({ error: 'Original applicant Contact is no longer linked. Edit the Contact list and use Issue.' });
  }

  // Delegate to issueToken — it deletes the existing token and creates fresh.
  // issueToken reads the Contact's CURRENT email, which is the V77.2 design:
  // agent fixes typos in the Contact, then clicks Reissue to send to new addr.
  return await issueToken(req, res, {
    application_id: row.application_id,
    step:           row.step,
    contact_id:     row.contact_id,
  }, session);
}
