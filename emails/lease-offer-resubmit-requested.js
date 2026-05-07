/**
 * emails/lease-offer-resubmit-requested.js — V77.2d
 *
 * Sent to applicant when agent has reviewed their Step 2 evidence and wants
 * them to update or add to it. Per V77.2 design, no specific reason is
 * conveyed in this email — the agent will contact the applicant separately
 * to explain what needs updating.
 *
 * Vars:
 *   applicant_name     — string
 *   property_address   — string
 *   form_url           — string (full https://propmap.../lease-offer/step-2/{token})
 *   agent_name         — string
 *   agency_name        — string
 */

import { wrapBaseHtml, wrapBaseText } from './_layout.js';

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escapeAttr(s) {
  return escapeHtml(s);
}

export function subject(vars) {
  return `Update requested — your application for ${vars.property_address || 'your offer'}`;
}

export function html(vars) {
  const inner = `
    <p>Hi ${escapeHtml(vars.applicant_name || 'there')},</p>
    <p style="font-size:16px;color:#1a1410;">${escapeHtml(vars.agent_name || 'Your agent')} has reviewed your application for <strong>${escapeHtml(vars.property_address || 'the property')}</strong> and would like you to update some of the information you provided.</p>
    <p>${escapeHtml(vars.agent_name || 'Your agent')} will be in touch shortly to explain what needs updating. In the meantime, please use the link below to log back in to your application — your existing data has been preserved, you can edit any section.</p>
    <p style="text-align:center;margin:32px 0;">
      <a href="${escapeAttr(vars.form_url)}" style="background:#c4841a;color:#fff;text-decoration:none;padding:14px 28px;border-radius:6px;font-weight:600;display:inline-block;">
        Open your application
      </a>
    </p>
    <p style="font-size:13px;color:#666;">If the button doesn't work, copy and paste this link into your browser:<br>
    <a href="${escapeAttr(vars.form_url)}" style="color:#c4841a;word-break:break-all;">${escapeHtml(vars.form_url)}</a></p>
    <p style="font-size:13px;color:#666;margin-top:18px;">Once you've made your updates, click "Submit" again and ${escapeHtml(vars.agent_name || 'your agent')} will be notified.</p>
  `;
  return wrapBaseHtml({ inner, agency_name: vars.agency_name });
}

export function text(vars) {
  const inner = `Hi ${vars.applicant_name || 'there'},

${vars.agent_name || 'Your agent'} has reviewed your application for ${vars.property_address || 'the property'} and would like you to update some of the information you provided.

${vars.agent_name || 'Your agent'} will be in touch shortly to explain what needs updating. In the meantime, please use the link below to log back in to your application — your existing data has been preserved, you can edit any section.

Open your application:
${vars.form_url}

Once you've made your updates, click "Submit" again and ${vars.agent_name || 'your agent'} will be notified.
`;
  return wrapBaseText({ inner, agency_name: vars.agency_name });
}
