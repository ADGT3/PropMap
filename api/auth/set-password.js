/**
 * api/auth/set-password.js
 * POST { contact_id, newPassword, currentPassword? }
 *
 * Rules:
 *   - Admin can set any contact's password (currentPassword not required).
 *   - Non-admin can only set their OWN password, and must supply currentPassword.
 *   - Env-var fallback cannot be changed here (rotate it in Vercel env vars).
 *   - Minimum password length: 8 chars.
 */

import { neon } from '@neondatabase/serverless';
import bcrypt from 'bcryptjs';
import { requireSession } from '../../lib/auth.js';

const sql = neon(process.env.POSTGRES_URL);
const MIN_PASSWORD_LEN = 8;
const BCRYPT_ROUNDS = 10;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const session = await requireSession(req, res);
  if (!session) return;

  try {
    const { contact_id, newPassword, currentPassword } = req.body || {};
    if (!contact_id || !newPassword) {
      return res.status(400).json({ error: 'contact_id and newPassword required' });
    }
    if (String(newPassword).length < MIN_PASSWORD_LEN) {
      return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LEN} characters` });
    }

    const targetId = parseInt(contact_id);
    if (Number.isNaN(targetId)) {
      return res.status(400).json({ error: 'Invalid contact_id' });
    }

    const isSelf = !session.isAdmin && String(session.sub) === String(targetId);
    const isAdmin = !!session.isAdmin;

    if (!isAdmin && !isSelf) {
      return res.status(403).json({ error: 'You can only change your own password' });
    }

    // Non-admins must confirm their current password
    if (!isAdmin) {
      if (!currentPassword) {
        return res.status(400).json({ error: 'currentPassword required' });
      }
      const rows = await sql`SELECT password_hash FROM contacts WHERE id = ${targetId} LIMIT 1`;
      if (!rows.length || !rows[0].password_hash) {
        return res.status(400).json({ error: 'No existing password set' });
      }
      const ok = await bcrypt.compare(currentPassword, rows[0].password_hash);
      if (!ok) return res.status(401).json({ error: 'Current password incorrect' });
    }

    const newHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    const rows = await sql`
      UPDATE contacts
         SET password_hash = ${newHash},
             updated_at    = now()
       WHERE id = ${targetId}
       RETURNING id, email`;
    if (!rows.length) return res.status(404).json({ error: 'Contact not found' });

    return res.status(200).json({ ok: true, contact_id: rows[0].id });

  } catch (err) {
    console.error('[set-password] error:', err);
    return res.status(500).json({ error: err.message || 'Failed to set password' });
  }
}
