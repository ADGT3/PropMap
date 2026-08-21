/**
 * emails/lease-offer-step-2-invite.js — V77.2
 *
 * Sent to applicant when agent Accepts a Step 1 offer; gives them the Step 2
 * link to upload supporting documents (100 points ID, payslips, rental
 * history evidence, etc.).
 *
 * Vars:
 *   applicant_name     — string
 *   property_address   — string
 *   form_url           — string (full https://propmap.../lease-offer/{token})
 *   agent_name         — string
 *   agency_name        — string
 *   expires_in_days    — number (default 30 — Step 2 tokens get extended TTL)
 */

import { wrapBaseHtml, wrapBaseText } from './_layout.js';

export function subject(vars) {
  return `Your offer has been accepted — please upload your documents`;
}

export function html(vars) {
  const expiresIn = vars.expires_in_days || 30;
  const inner = `
    <p>Hi ${escapeHtml(vars.applicant_name || 'there')},</p>
    <p style="font-size:18px;color:#1a1410;font-weight:600;">Great news — your lease offer has been accepted in principle.</p>
    <p>Property:</p>
    <p style="font-size:16px;font-weight:600;color:#111;background:#f7f4ec;padding:14px 18px;border-radius:6px;border-left:3px solid #c4841a;">
      ${escapeHtml(vars.property_address)}
    </p>
    <p>To finalise the application, ${escapeHtml(vars.agent_name || 'your agent')} needs supporting documents:</p>
    <ul style="margin:8px 0 16px;padding-left:22px;color:#444;">
      <li>100-points ID for each applicant</li>
      <li>Rental history evidence (current/previous tenancy agreements, rates notices if owned)</li>
      <li>Income evidence (payslips, ATO returns, bank statements)</li>
    </ul>
    <p>Click the button below to access the secure upload form. The link is valid for ${expiresIn} days.</p>
    <p style="text-align:center;margin:32px 0;">
      <a href="${escapeAttr(vars.form_url)}" style="background:#c4841a;color:#fff;text-decoration:none;padding:14px 28px;border-radius:6px;font-weight:600;display:inline-block;">
        Upload your documents
      </a>
    </p>
    <p style="font-size:13px;color:#666;">If the button doesn't work, copy and paste this link into your browser:<br>
    <a href="${escapeAttr(vars.form_url)}" style="color:#c4841a;word-break:break-all;">${escapeHtml(vars.form_url)}</a></p>
  `;
  return wrapBaseHtml({ inner, agency_name: vars.agency_name });
}

export function text(vars) {
  const expiresIn = vars.expires_in_days || 30;
  const body = `
Hi ${vars.applicant_name || 'there'},

Great news — your lease offer for the property below has been accepted in principle.

  ${vars.property_address}

To finalise the application, ${vars.agent_name || 'your agent'} needs supporting documents:
  - 100-points ID for each applicant
  - Rental history evidence
  - Income evidence (payslips, ATO returns, bank statements)

Use the link below to access the secure upload form. Valid for ${expiresIn} days.

  ${vars.form_url}
  `.trim();
  return wrapBaseText({ inner: body, agency_name: vars.agency_name });
}

function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escapeAttr(s) { return escapeHtml(s); }
