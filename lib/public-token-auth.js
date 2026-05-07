/**
 * lib/public-token-auth.js — V77.2
 *
 * Authentication for the public-form layer (`/lease-offer/{token}`). Replaces
 * `requireSession` for these routes — applicants don't have agent sessions.
 *
 * Validates a magic-link token from `applicant_form_tokens`:
 *   - Token exists
 *   - Not expired
 *   - For Step 2, application status must be 'offer_accepted' or 'evidence_submitted'
 *
 * Returns:
 *   { ok: true, token_row, application }    — valid
 *   { ok: false, code, status, message }    — invalid; caller sends res.status(status)
 *
 * Codes:
 *   'token_missing'        — no token provided
 *   'token_not_found'      — token doesn't exist
 *   'token_expired'        — past expires_at
 *   'token_unverified'     — exists but applicant hasn't clicked-through verify yet
 *                             (Step 1 form load can show the verify-email gate;
 *                              other endpoints reject)
 *   'wrong_step'           — Step 2 token tried on Step 1 endpoint or vice versa
 *   'wrong_status'         — Step 2 accessed before offer_accepted
 *   'application_missing'  — token's application_id no longer exists
 *
 * Also touches `last_accessed_at` on every successful validation.
 */

import { neon } from '@neondatabase/serverless';
import { getDatabaseUrl } from './db.js';
const sql = neon(getDatabaseUrl());

/**
 * Validate a token. Optional opts:
 *   require_step:    1 | 2          — assert which step this token is for
 *   require_verified: boolean       — assert email_verified=true (default true; pass false on the verify endpoint itself)
 *   touch_access:     boolean       — update last_accessed_at on hit (default true)
 */
export async function validatePublicToken(token, opts = {}) {
  const { require_step, require_verified = true, touch_access = true } = opts;

  if (!token || typeof token !== 'string' || token.length < 16) {
    return { ok: false, code: 'token_missing', status: 401, message: 'Token is missing or malformed.' };
  }

  const rows = await sql`
    SELECT t.id, t.application_id, t.step, t.token, t.applicant_email,
           t.email_verified, t.verified_at, t.expires_at, t.last_accessed_at,
           a.status   AS application_status,
           a.deal_id  AS application_deal_id
    FROM applicant_form_tokens t
    LEFT JOIN applications a ON a.id = t.application_id
    WHERE t.token = ${token}
    LIMIT 1`;

  const row = rows[0];
  if (!row) {
    return { ok: false, code: 'token_not_found', status: 404, message: 'This link is invalid or has been deactivated.' };
  }

  // Application must still exist (rare — only if hard-deleted out from under)
  if (!row.application_status) {
    return { ok: false, code: 'application_missing', status: 404, message: 'The associated lease offer no longer exists.' };
  }

  // Expiry
  if (row.expires_at && new Date(row.expires_at) < new Date()) {
    return { ok: false, code: 'token_expired', status: 410, message: 'This link has expired. Please contact your agent for a new one.' };
  }

  // Step assertion
  if (require_step && row.step !== require_step) {
    return { ok: false, code: 'wrong_step', status: 400, message: `This link is for Step ${row.step}, not Step ${require_step}.` };
  }

  // Verified-email check
  if (require_verified && !row.email_verified) {
    return { ok: false, code: 'token_unverified', status: 401, message: 'Email not verified. Please click the verify link in your email.' };
  }

  // Step 2 status check
  if (row.step === 2) {
    const ok2 = row.application_status === 'offer_accepted' ||
                row.application_status === 'evidence_submitted' ||
                row.application_status === 'evidence_resubmit_requested';
    if (!ok2) {
      return { ok: false, code: 'wrong_status', status: 409, message: 'Awaiting agent review. You will receive an email once the offer is accepted.' };
    }
  }

  // Touch last_accessed_at — fire-and-forget; don't fail the request if it errors
  if (touch_access) {
    try {
      await sql`UPDATE applicant_form_tokens SET last_accessed_at = now() WHERE id = ${row.id}`;
    } catch (err) {
      console.warn('[public-token-auth] touch_access failed:', err.message);
    }
  }

  return {
    ok: true,
    token_row: {
      id:                row.id,
      application_id:    row.application_id,
      step:              row.step,
      token:             row.token,
      applicant_email:   row.applicant_email,
      email_verified:    row.email_verified,
      verified_at:       row.verified_at,
      expires_at:        row.expires_at,
      last_accessed_at:  row.last_accessed_at,
    },
    application: {
      id:      row.application_id,
      status:  row.application_status,
      deal_id: row.application_deal_id,
    },
  };
}

/**
 * Convenience wrapper for use at the top of public API handlers. Sends the
 * appropriate HTTP error and returns null on failure; returns the validated
 * { token_row, application } on success.
 *
 * Usage:
 *   export default async function handler(req, res) {
 *     const ctx = await requireValidToken(req, res, { require_step: 1 });
 *     if (!ctx) return;  // response already sent
 *     // ... use ctx.token_row, ctx.application
 *   }
 */
export async function requireValidToken(req, res, opts = {}) {
  // Token from path param ?token=... or req.query.token (Vercel rewrites slug → query.token)
  const token = req.query?.token || req.body?.token || null;
  const result = await validatePublicToken(token, opts);
  if (!result.ok) {
    res.status(result.status).json({ error: result.message, code: result.code });
    return null;
  }
  return result;
}

/**
 * Generate a URL-safe random token. Uses Web Crypto for compatibility with
 * Edge runtime if needed.
 */
export function generateToken(length = 32) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const buf = new Uint8Array(length);
  crypto.getRandomValues(buf);
  let out = '';
  for (let i = 0; i < length; i++) out += chars[buf[i] % chars.length];
  return out;
}
