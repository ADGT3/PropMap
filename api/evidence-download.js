/**
 * api/evidence-download.js — V77.2
 *
 * Agent-only endpoint to fetch a private Blob file. The applicant uploaded it
 * via /api/public/lease-offers/{token}/step2-upload (private storage). Agents
 * retrieve it here.
 *
 * Routing: Vercel rewrites /api/applications/evidence/:id/download → this file.
 *   GET /api/applications/evidence/{id}/download
 *
 * Access control:
 *   - Agent session required (requireSession).
 *   - The agent is authorised to read any evidence row in this CRM (single-tenant).
 *     If multi-tenant is added later, scope by deal/board ownership here.
 *
 * Streams the file body with the correct content-type. The response is NOT cached
 * by Vercel CDN since cookies are involved (auth headers).
 */

import { neon } from '@neondatabase/serverless';
import { requireSession, requireModule } from '../lib/auth.js';
import { getDatabaseUrl } from '../lib/db.js';
import { download as blobDownload } from '../lib/blob.js';

const sql = neon(getDatabaseUrl());

export default async function handler(req, res) {
  const session = await requireSession(req, res);
  if (!session) return;
  if (!requireModule(session, res, 'pipeline')) return;

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const id = parseInt(req.query?.id, 10);
  if (!id) return res.status(400).json({ error: 'evidence id required in URL' });

  try {
    const rows = await sql`
      SELECT id, application_id, filename, mime_type, url, size_bytes
      FROM application_evidence
      WHERE id = ${id}
      LIMIT 1`;
    if (!rows.length) return res.status(404).json({ error: 'Evidence not found' });
    const ev = rows[0];

    const result = await blobDownload(ev.url);
    if (!result) return res.status(404).json({ error: 'File not found in storage' });

    // Set headers
    res.setHeader('Content-Type', result.contentType || ev.mime_type || 'application/octet-stream');
    if (result.contentLength || ev.size_bytes) {
      res.setHeader('Content-Length', String(result.contentLength || ev.size_bytes));
    }
    // Hint to browser to display inline (PDFs, images) when possible
    const filename = (ev.filename || 'file').replace(/"/g, '');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');

    // Stream to client
    const reader = result.stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    return res.end();
  } catch (err) {
    console.error('[evidence-download] error:', err);
    return res.status(500).json({ error: err.message });
  }
}
