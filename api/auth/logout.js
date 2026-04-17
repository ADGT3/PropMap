/**
 * api/auth/logout.js
 * POST → clears the session cookie.
 */

import { buildSessionCookie } from '../../lib/auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  res.setHeader('Set-Cookie', buildSessionCookie(null));
  return res.status(200).json({ ok: true });
}
