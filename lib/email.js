/**
 * lib/email.js — V77.2
 *
 * Central email-sending wrapper. In V77.2 this is "stubbed" mode: every send()
 * call writes a row to email_log with status='stubbed' and never actually
 * dispatches an email. V77.3 will swap the provider call in (Resend), keeping
 * the same function signature and email_log behaviour (additional row updates
 * for status='sent' / 'failed' + provider_message_id).
 *
 * Configuration is read from the system_settings table (category='email');
 * lib/email-config.js is a fallback for environments without DB access.
 *
 * Templates live in /emails/. Each template is a JS module that exports:
 *   - subject(vars) → string
 *   - html(vars)    → string
 *   - text(vars)    → string
 *
 * Public API:
 *   await Email.send({ to, channel, template, vars, related_entity_type?, related_entity_id?, triggered_by? })
 *   await Email.getConfig()  →  { app_public_url, email_sending_domain, email_leasing_from, email_sales_from, email_reply_to_handling }
 *
 * Channel determines from-address:
 *   'leasing' → email_leasing_from
 *   'sales'   → email_sales_from
 */

import { neon } from '@neondatabase/serverless';
import { getDatabaseUrl } from './db.js';
import * as fallback from './email-config.js';

const sql = neon(getDatabaseUrl());

let _configCache = null;
let _configCachedAt = 0;
const CONFIG_TTL_MS = 60_000; // 1 minute — cheap to refetch, lets settings updates take effect quickly

async function getConfig() {
  const now = Date.now();
  if (_configCache && (now - _configCachedAt) < CONFIG_TTL_MS) return _configCache;
  try {
    const rows = await sql`
      SELECT key, value FROM system_settings WHERE category = 'email'`;
    const map = {};
    rows.forEach(r => { map[r.key] = r.value; });
    _configCache = {
      app_public_url:          map.app_public_url          || fallback.APP_PUBLIC_URL,
      email_sending_domain:    map.email_sending_domain    || fallback.EMAIL_SENDING_DOMAIN,
      email_leasing_from:      map.email_leasing_from      || fallback.EMAIL_LEASING_FROM,
      email_sales_from:        map.email_sales_from        || fallback.EMAIL_SALES_FROM,
      email_reply_to_handling: map.email_reply_to_handling || fallback.EMAIL_REPLY_TO_HANDLING,
    };
    _configCachedAt = now;
    return _configCache;
  } catch (err) {
    console.warn('[email] system_settings unavailable, using fallback constants:', err.message);
    return {
      app_public_url:          fallback.APP_PUBLIC_URL,
      email_sending_domain:    fallback.EMAIL_SENDING_DOMAIN,
      email_leasing_from:      fallback.EMAIL_LEASING_FROM,
      email_sales_from:        fallback.EMAIL_SALES_FROM,
      email_reply_to_handling: fallback.EMAIL_REPLY_TO_HANDLING,
    };
  }
}

// Forces next getConfig() to re-fetch — call after a system_settings update.
export function invalidateConfigCache() {
  _configCache = null;
  _configCachedAt = 0;
}

// Build the full public URL for a lease-offer token. Reads app_public_url from
// system_settings (with fallback). Step 1 → /lease-offer/{token},
// Step 2 → /lease-offer/step-2/{token}.
export async function leaseOfferUrl(token, step = 1) {
  const cfg = await getConfig();
  if (step === 2) return `${cfg.app_public_url}/lease-offer/step-2/${token}`;
  return `${cfg.app_public_url}/lease-offer/${token}`;
}

/**
 * Send an email. In V77.2 stub mode, this writes to email_log with
 * status='stubbed' and never calls a provider. The full HTML/text bodies
 * are saved so the agent can preview them later or replay when V77.3
 * activates Resend.
 *
 * @param {object} opts
 * @param {string} opts.to          — recipient email
 * @param {'leasing'|'sales'} opts.channel — which from-address to use
 * @param {object} opts.template    — { subject, html, text } module
 * @param {object} opts.vars        — variables passed to template functions
 * @param {string} [opts.template_id]         — identifier for the template (for log queries)
 * @param {string} [opts.related_entity_type] — e.g. 'application' or 'deal'
 * @param {string} [opts.related_entity_id]   — id of the related entity
 * @param {number} [opts.triggered_by]        — contacts.id of the agent who triggered it
 * @returns {Promise<{id, status, to, from, subject}>}
 */
export async function send(opts) {
  const { to, channel, template, vars = {}, template_id, related_entity_type, related_entity_id, triggered_by } = opts || {};
  if (!to)       throw new Error('send: to is required');
  if (!channel)  throw new Error('send: channel is required (leasing | sales)');
  if (!template) throw new Error('send: template module is required');

  const cfg = await getConfig();
  const from =
    channel === 'sales'   ? cfg.email_sales_from   :
    channel === 'leasing' ? cfg.email_leasing_from :
    null;
  if (!from) throw new Error(`send: unknown channel '${channel}'`);

  const replyTo = (cfg.email_reply_to_handling === 'no_reply') ? null : from;

  // Render template with vars
  const subject = template.subject(vars);
  const bodyHtml = template.html(vars);
  const bodyText = template.text(vars);

  // V77.2: stubbed — log only. V77.3 will add Resend dispatch + status update here.
  let status = 'stubbed';
  let providerMessageId = null;
  let errorMessage = null;

  // Insert log row
  const r = await sql`
    INSERT INTO email_log (
      to_address, from_address, reply_to, subject, body_html, body_text,
      template_id, related_entity_type, related_entity_id,
      status, provider_message_id, error_message, triggered_by
    ) VALUES (
      ${to}, ${from}, ${replyTo}, ${subject}, ${bodyHtml}, ${bodyText},
      ${template_id || null}, ${related_entity_type || null}, ${related_entity_id ? String(related_entity_id) : null},
      ${status}, ${providerMessageId}, ${errorMessage}, ${triggered_by || null}
    )
    RETURNING id, sent_at`;

  const logId = r[0]?.id;
  console.log(`[email:${status}] #${logId} to=${to} from=${from} subject="${subject.slice(0, 60)}"`);

  return {
    id: logId,
    status,
    to,
    from,
    subject,
    sent_at: r[0]?.sent_at,
  };
}

// Convenience: list recent emails for an entity (used by agent UI to show send history)
export async function listForEntity(entityType, entityId, limit = 20) {
  return await sql`
    SELECT id, to_address, from_address, subject, template_id, status,
           sent_at, delivered_at, error_message
    FROM email_log
    WHERE related_entity_type = ${entityType}
      AND related_entity_id = ${String(entityId)}
    ORDER BY sent_at DESC
    LIMIT ${limit}`;
}

export default { send, getConfig, invalidateConfigCache, leaseOfferUrl, listForEntity };
