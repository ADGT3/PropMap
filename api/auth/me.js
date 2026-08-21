/**
 * api/auth/me.js
 * GET → returns the current session user, or { authenticated: false }.
 *
 * This endpoint is deliberately listed as public in middleware.js so the
 * frontend can call it on page load to decide what to show. It does NOT
 * leak any info to unauthenticated visitors — they just get
 * { authenticated: false }.
 */

import { getSessionFromReq } from '../../lib/auth.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const session = await getSessionFromReq(req);
  if (!session) return res.status(200).json({ authenticated: false });

  return res.status(200).json({
    authenticated: true,
    user: {
      id:      session.sub,
      email:   session.email,
      name:    session.name,
      isAdmin: !!session.isAdmin,
      modules: session.modules || [],
      src:     session.src || 'db',
    },
  });
}
