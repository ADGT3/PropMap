/**
 * emails/lease-offer-received-agent-notification.js — V77.2
 *
 * Sent to agent when applicant submits Step 1 (status flips draft → offer_received).
 *
 * Vars:
 *   agent_name        — string
 *   applicant_name    — string (primary applicant)
 *   property_address  — string
 *   deal_url          — string (link back to PropMap deal modal — uses /?deal=ID format)
 *   requested_rent    — string (e.g. "$650/wk")
 *   submitted_at      — string (formatted timestamp)
 *   agency_name       — string
 */

import { wrapBaseHtml, wrapBaseText } from './_layout.js';

export function subject(vars) {
  return `Lease offer received — ${vars.property_address}`;
}

export function html(vars) {
  const inner = `
    <p>Hi ${escapeHtml(vars.agent_name || 'team')},</p>
    <p>A lease offer has been submitted for:</p>
    <p style="font-size:16px;font-weight:600;color:#111;background:#f7f4ec;padding:14px 18px;border-radius:6px;border-left:3px solid #c4841a;">
      ${escapeHtml(vars.property_address)}
    </p>
    <table cellspacing="0" cellpadding="0" border="0" style="width:100%;margin:16px 0;border-collapse:collapse;">
      <tr><td style="padding:6px 0;color:#666;width:140px;">Applicant:</td><td style="padding:6px 0;font-weight:500;">${escapeHtml(vars.applicant_name || '')}</td></tr>
      <tr><td style="padding:6px 0;color:#666;">Requested rent:</td><td style="padding:6px 0;font-weight:500;">${escapeHtml(vars.requested_rent || '—')}</td></tr>
      <tr><td style="padding:6px 0;color:#666;">Submitted:</td><td style="padding:6px 0;">${escapeHtml(vars.submitted_at || '')}</td></tr>
    </table>
    <p style="text-align:center;margin:32px 0;">
      <a href="${escapeAttr(vars.deal_url)}" style="background:#c4841a;color:#fff;text-decoration:none;padding:14px 28px;border-radius:6px;font-weight:600;display:inline-block;">
        Review in PropMap
      </a>
    </p>
  `;
  return wrapBaseHtml({ inner, agency_name: vars.agency_name });
}

export function text(vars) {
  const body = `
Hi ${vars.agent_name || 'team'},

A lease offer has been submitted for ${vars.property_address}.

  Applicant:       ${vars.applicant_name || ''}
  Requested rent:  ${vars.requested_rent || '—'}
  Submitted:       ${vars.submitted_at || ''}

Review in PropMap:
  ${vars.deal_url}
  `.trim();
  return wrapBaseText({ inner: body, agency_name: vars.agency_name });
}

function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escapeAttr(s) { return escapeHtml(s); }
