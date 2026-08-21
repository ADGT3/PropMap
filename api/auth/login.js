/**
 * api/auth/login.js
 * POST { email, password } → sets session cookie, returns { ok, user }
 *
 * Auth priority:
 *   1. Try the contacts table where email matches, can_login = true,
 *      and password_hash verifies. On success: session has src='db'.
 *   2. If DB lookup fails or no match, try env-var fallback superuser.
 *      On success: session has src='env' and isAdmin=true.
 *
 * The fallback exists so you can never lock yourself out. If both DB
 * record and env-var exist for the same email, the DB path wins (so
 * rotating your day-to-day password doesn't require touching Vercel).
 */

import { neon } from '@neondatabase/serverless';
import { getDatabaseUrl } from '../../lib/db.js';
import bcrypt from 'bcryptjs';
import { signSession, buildSessionCookie, FALLBACK_EMAIL } from '../../lib/auth.js';

const sql = neon(getDatabaseUrl());

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { email: rawEmail, password } = req.body || {};
    const email = String(rawEmail || '').toLowerCase().trim();
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    // ── 1. Try the database ────────────────────────────────────────────────
    let user = null;
    let dbError = null;
    try {
      const rows = await sql`
        SELECT id, first_name, last_name, email, password_hash,
               COALESCE(can_login, false)  AS can_login,
               COALESCE(is_admin,  false)  AS is_admin,
               COALESCE(access_modules, ARRAY['*']) AS access_modules
        FROM contacts
        WHERE LOWER(email) = ${email}
          AND COALESCE(can_login, false) = true
          AND password_hash IS NOT NULL
        ORDER BY id ASC
        LIMIT 1`;
      const row = rows[0];
      if (row && await bcrypt.compare(password, row.password_hash)) {
        user = {
          sub:      row.id,
          email:    row.email,
          name:     [row.first_name, row.last_name].filter(Boolean).join(' ').trim(),
          isAdmin:  row.is_admin,
          modules:  row.access_modules,
          src:      'db',
        };
        // Fire-and-forget last_login_at update
        sql`UPDATE contacts SET last_login_at = now() WHERE id = ${row.id}`
          .catch(err => console.error('[login] last_login_at update failed:', err.message));
      }
    } catch (err) {
      dbError = err;
      console.error('[login] DB lookup failed, will try fallback:', err.message);
    }

    // ── 2. Fallback: env-var superuser ─────────────────────────────────────
    if (!user && FALLBACK_EMAIL && email === FALLBACK_EMAIL) {
      const fallbackHash = process.env.ADMIN_FALLBACK_PASSWORD_HASH;
      if (fallbackHash && await bcrypt.compare(password, fallbackHash)) {
        user = {
          sub:      'fallback',
          email:    FALLBACK_EMAIL,
          name:     'Admin (fallback)',
          isAdmin:  true,
          modules:  ['*'],
          src:      'env',
        };
      }
    }

    if (!user) {
      // Generic message — don't leak whether the email exists
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = await signSession(user);
    res.setHeader('Set-Cookie', buildSessionCookie(token));
    return res.status(200).json({
      ok: true,
      user: {
        id:       user.sub,
        email:    user.email,
        name:     user.name,
        isAdmin:  user.isAdmin,
        modules:  user.modules,
        src:      user.src,
      },
    });

  } catch (err) {
    console.error('[login] error:', err);
    return res.status(500).json({ error: err.message || 'Login failed' });
  }
}
