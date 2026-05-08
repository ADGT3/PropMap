/**
 * api/system-settings.js — V77.2
 *
 * Admin-editable system configuration (email config, public form URL, etc.).
 * Single source of truth for settings; lib/email-config.js is a fallback for
 * local dev only (when DB is unavailable).
 *
 * Endpoints:
 *   GET  /api/system-settings              → all settings, grouped by category
 *   GET  /api/system-settings?category=X   → settings for one category
 *   PUT  /api/system-settings              → bulk update {key: value, ...}
 *
 * Auth: admin-only (requireAdmin).
 */

import { neon } from '@neondatabase/serverless';
import { requireSession, requireAdmin } from '../lib/auth.js';
import { getDatabaseUrl } from '../lib/db.js';
const sql = neon(getDatabaseUrl());

// Validation rules per setting key. Keep in sync with build plan §6.2.1.
const VALIDATION = {
  app_public_url: (v) => {
    if (!/^https?:\/\/[\w.-]+/.test(v)) return 'Must be a valid URL (http:// or https://)';
    if (v.endsWith('/')) return 'Must not have a trailing slash';
    return null;
  },
  email_sending_domain: (v) => {
    if (!/^[\w.-]+\.[a-z]{2,}$/i.test(v)) return 'Must be a valid domain (e.g. example.com)';
    return null;
  },
  email_leasing_from: (v, all) => {
    if (!/^\S+@\S+\.\S+$/.test(v)) return 'Must be a valid email address';
    const dom = (all.email_sending_domain || '').toLowerCase();
    if (dom && !v.toLowerCase().endsWith('@' + dom)) return `Must use the sending domain (@${dom})`;
    return null;
  },
  email_sales_from: (v, all) => {
    if (!/^\S+@\S+\.\S+$/.test(v)) return 'Must be a valid email address';
    const dom = (all.email_sending_domain || '').toLowerCase();
    if (dom && !v.toLowerCase().endsWith('@' + dom)) return `Must use the sending domain (@${dom})`;
    return null;
  },
  email_reply_to_handling: (v) => {
    if (!['route_to_from', 'no_reply'].includes(v)) return 'Must be "route_to_from" or "no_reply"';
    return null;
  },
};

export default async function handler(req, res) {
  const session = await requireSession(req, res);
  if (!session) return;

  try {
    if (req.method === 'GET') {
      const category = req.query.category;
      const rows = category
        ? await sql`SELECT key, value, category, label, description, updated_at
                    FROM system_settings WHERE category = ${category} ORDER BY key`
        : await sql`SELECT key, value, category, label, description, updated_at
                    FROM system_settings ORDER BY category, key`;
      return res.status(200).json(rows);
    }

    if (req.method === 'PUT') {
      if (!requireAdmin(session, res)) return;
      const body = req.body || {};
      // Body shape: { key1: value1, key2: value2, ... }
      // OR: { settings: {key1: value1, ...} } — support both for tolerance
      const updates = body.settings || body;
      if (typeof updates !== 'object' || Array.isArray(updates)) {
        return res.status(400).json({ error: 'Body must be an object: {key: value, ...}' });
      }

      // Build lookup of existing values for validation context
      const existing = await sql`SELECT key, value FROM system_settings`;
      const merged = {};
      existing.forEach(r => { merged[r.key] = r.value; });
      Object.entries(updates).forEach(([k, v]) => { merged[k] = v; });

      // Validate all updates
      const errors = {};
      for (const [key, value] of Object.entries(updates)) {
        if (typeof value !== 'string') {
          errors[key] = 'Value must be a string';
          continue;
        }
        const trimmed = value.trim();
        if (!trimmed) {
          errors[key] = 'Value cannot be empty';
          continue;
        }
        const fn = VALIDATION[key];
        if (fn) {
          const err = fn(trimmed, merged);
          if (err) errors[key] = err;
        }
      }
      if (Object.keys(errors).length) {
        return res.status(400).json({ error: 'Validation failed', errors });
      }

      // Apply updates — only existing keys can be updated (no INSERT via PUT,
      // since seed defines what keys exist).
      const updatedKeys = [];
      const updatedBy = session.contact?.id || null;
      for (const [key, value] of Object.entries(updates)) {
        const trimmed = value.trim();
        const r = await sql`
          UPDATE system_settings
             SET value      = ${trimmed},
                 updated_at = now(),
                 updated_by = ${updatedBy}
           WHERE key = ${key}
        RETURNING key`;
        if (r.length) updatedKeys.push(key);
      }

      // Return refreshed full row set
      const refreshed = await sql`
        SELECT key, value, category, label, description, updated_at
        FROM system_settings
        ORDER BY category, key`;
      return res.status(200).json({ updated: updatedKeys, settings: refreshed });
    }

    res.setHeader('Allow', 'GET, PUT');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[system-settings] error:', err);
    return res.status(500).json({ error: err.message });
  }
}
