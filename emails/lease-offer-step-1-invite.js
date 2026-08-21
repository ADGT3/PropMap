/**
 * emails/lease-offer-step-1-invite.js — V77.2
 *
 * Sent to applicant when agent issues a Step 1 magic-link.
 *
 * Vars:
 *   applicant_name     — string
 *   property_address   — string ("123 Smith St, Newtown NSW")
 *   form_url           — string (full https://propmap.../lease-offer/{token})
 *   agent_name         — string (e.g. "Jane Smith")
 *   agency_name        — string (e.g. "Edan Property")
 *   expires_in_days    — number (default 7)
 */

import { wrapBaseHtml, wrapBaseText } from './_layout.js';

export function subject(vars) {
  return `Submit your lease offer for ${vars.property_address}`;
}

export function html(vars) {
  const expiresIn = vars.expires_in_days || 7;
  const inner = `
    <p>Hi ${escapeHtml(vars.applicant_name || 'there')},</p>
    <p>${escapeHtml(vars.agent_name || 'Your agent')} from ${escapeHtml(vars.agency_name || 'Edan Property')} has invited you to submit a lease offer for:</p>
    <p style="font-size:16px;font-weight:600;color:#111;background:#f7f4ec;padding:14px 18px;border-radius:6px;border-left:3px solid #c4841a;">
      ${escapeHtml(vars.property_address)}
    </p>
    <p>Click the button below to verify your email and start your offer. The link will expire in ${expiresIn} days.</p>
    <p style="text-align:center;margin:32px 0;">
      <a href="${escapeAttr(vars.form_url)}" style="background:#c4841a;color:#fff;text-decoration:none;padding:14px 28px;border-radius:6px;font-weight:600;display:inline-block;">
        Start your lease offer
      </a>
    </p>
    <p style="font-size:13px;color:#666;">If the button doesn't work, copy and paste this link into your browser:<br>
    <a href="${escapeAttr(vars.form_url)}" style="color:#c4841a;word-break:break-all;">${escapeHtml(vars.form_url)}</a></p>
    <p style="font-size:13px;color:#666;">If you weren't expecting this email, you can safely ignore it.</p>
  `;
  return wrapBaseHtml({ inner, agency_name: vars.agency_name });
}

export function text(vars) {
  const expiresIn = vars.expires_in_days || 7;
  const body = `
Hi ${vars.applicant_name || 'there'},

${vars.agent_name || 'Your agent'} from ${vars.agency_name || 'Edan Property'} has invited you to submit a lease offer for:

  ${vars.property_address}

Click the link below to verify your email and start your offer. The link will expire in ${expiresIn} days.

  ${vars.form_url}

If you weren't expecting this email, you can safely ignore it.
  `.trim();
  return wrapBaseText({ inner: body, agency_name: vars.agency_name });
}

// Local helpers
function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escapeAttr(s) {
  return escapeHtml(s);
}
