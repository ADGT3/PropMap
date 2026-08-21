/**
 * api/contact-marketing-activity.js
 * V82.b — Contact marketing activity (read-only; written by marketing module).
 *
 * GET ?contact_id=N → activity row or {} if none
 */

import { neon } from '@neondatabase/serverless';
import { requireSession, requireModule } from '../lib/auth.js';
import { getDatabaseUrl } from '../lib/db.js';
const sql = neon(getDatabaseUrl());

export default async function handler(req, res) {
  const session = await requireSession(req, res);
  if (!session) return;
  if (!requireModule(session, res, 'crm')) return;

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const contact_id = parseInt(req.query?.contact_id, 10);
  if (!contact_id) return res.status(400).json({ error: 'contact_id required' });

  try {
    const rows = await sql`
      SELECT * FROM contact_marketing_activity WHERE contact_id = ${contact_id}`;
    return res.status(200).json(rows[0] ?? {});
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
