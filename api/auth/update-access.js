/**
 * api/auth/update-access.js
 * POST { contact_id, can_login?, is_admin?, access_modules? }
 *
 * Admin-only. Updates site-access fields on a contact.
 *
 * Safeguards:
 *   - Cannot remove the LAST admin. If this update would leave zero
 *     contacts with is_admin = true AND can_login = true, the call is
 *     rejected. (The env-var fallback is always available regardless,
 *     but we still prevent the UI from orphaning the DB admin set.)
 */

import { neon } from '@neondatabase/serverless';
import { getDatabaseUrl } from '../../lib/db.js';
import { requireSession, requireAdmin } from '../../lib/auth.js';

const sql = neon(getDatabaseUrl());

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const session = await requireSession(req, res);
  if (!session) return;
  if (!requireAdmin(session, res)) return;

  try {
    const { contact_id, can_login, is_admin, access_modules } = req.body || {};
    const targetId = parseInt(contact_id);
    if (Number.isNaN(targetId)) {
      return res.status(400).json({ error: 'Valid contact_id required' });
    }

    // Fetch current state
    const current = await sql`
      SELECT id, email,
             COALESCE(can_login, false)  AS can_login,
             COALESCE(is_admin,  false)  AS is_admin,
             COALESCE(access_modules, ARRAY['*']) AS access_modules,
             password_hash IS NOT NULL   AS has_password
      FROM contacts WHERE id = ${targetId} LIMIT 1`;
    if (!current.length) return res.status(404).json({ error: 'Contact not found' });
    const cur = current[0];

    // Resolve new values (undefined = leave unchanged)
    const newCanLogin = can_login === undefined ? cur.can_login : !!can_login;
    const newIsAdmin  = is_admin  === undefined ? cur.is_admin  : !!is_admin;
    const newModules  = Array.isArray(access_modules) ? access_modules : cur.access_modules;

    // Validate access_modules: must be array of non-empty strings
    if (!newModules.every(m => typeof m === 'string' && m.trim().length)) {
      return res.status(400).json({ error: 'access_modules must be an array of non-empty strings' });
    }

    // Safeguard: don't orphan the admin set. If this change would demote
    // someone (or revoke their login) AND leave zero active admins in the DB,
    // reject. Only check when the change actually reduces admin capability.
    const reducingAdmin =
      (cur.is_admin && !newIsAdmin) ||
      (cur.can_login && !newCanLogin && cur.is_admin);
    if (reducingAdmin) {
      const [{ count }] = await sql`
        SELECT COUNT(*)::int AS count
        FROM contacts
        WHERE COALESCE(is_admin,  false) = true
          AND COALESCE(can_login, false) = true
          AND id <> ${targetId}`;
      if (count === 0) {
        return res.status(400).json({
          error: 'Cannot remove the last admin. Grant admin/login to another contact first.',
        });
      }
    }

    // Can't enable login without a password hash set first
    if (newCanLogin && !cur.has_password) {
      return res.status(400).json({
        error: 'Set a password for this contact before enabling login',
      });
    }

    const rows = await sql`
      UPDATE contacts
         SET can_login      = ${newCanLogin},
             is_admin       = ${newIsAdmin},
             access_modules = ${newModules},
             updated_at     = now()
       WHERE id = ${targetId}
       RETURNING id, email, can_login, is_admin, access_modules, last_login_at`;

    return res.status(200).json({ ok: true, contact: rows[0] });

  } catch (err) {
    console.error('[update-access] error:', err);
    return res.status(500).json({ error: err.message || 'Failed to update access' });
  }
}
