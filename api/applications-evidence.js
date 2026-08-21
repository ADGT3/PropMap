/**
 * api/applications-evidence.js — V81.4
 *
 * Agent-only endpoint for the agent to upload additional evidence files into
 * an existing application, and to delete files the agent themselves uploaded.
 *
 * Scope (V81.4): lease document slots only —
 *   category = 'lease-doc:signed-contract' | 'lease-doc:condition-report'
 *
 * The applicant's own submissions (uploaded_by_role='applicant') are the source
 * of record. This endpoint will REFUSE to delete them. Agents can only delete
 * files they uploaded themselves (uploaded_by_role='agent').
 *
 * Editing the applicant's submission is intentionally out of scope — future
 * admin override may relax that. The contract here is: applicant files are
 * immutable from this endpoint.
 *
 * Routes:
 *   POST   /api/applications-evidence
 *            body: { application_id, category, filename, mime_type, size, body_base64 }
 *            → 201 { evidence: { id, ... } }
 *
 *   DELETE /api/applications-evidence?id=N
 *            → 200 { deleted: true, id }
 *            → 403 if the evidence row was uploaded by the applicant.
 *
 * Storage matches the existing applicant upload path scheme so all evidence
 * for an application clusters in the same Blob folder:
 *   lease-offers/{application_id}/agent-{contact_id}/{category}/{filename}
 *
 * Notes:
 *   - Uses the same private-blob lib/blob.js helpers as the applicant path,
 *     so the file is fetched by agents through the same evidence-download /
 *     evidence-view endpoints with no extra wiring.
 *   - Restricted to lease-doc:* categories for V81.4. Extend in a later build
 *     if agent uploads to other slots (ID, housing, income) are ever needed.
 */

import { neon } from '@neondatabase/serverless';
import { requireSession, requireModule } from '../lib/auth.js';
import { getDatabaseUrl } from '../lib/db.js';
import { upload as blobUpload, remove as blobRemove } from '../lib/blob.js';

const sql = neon(getDatabaseUrl());

export const config = { api: { bodyParser: { sizeLimit: '20mb' } } };

// Categories agents are allowed to upload to / delete from via this endpoint.
const ALLOWED_AGENT_CATEGORIES = new Set([
  'lease-doc:signed-contract',
  'lease-doc:condition-report',
]);

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

export default async function handler(req, res) {
  const session = await requireSession(req, res);
  if (!session) return;
  if (!requireModule(session, res, 'pipeline')) return;

  try {
    // ── Upload (agent adds a file to an application's lease-doc slot) ─────
    if (req.method === 'POST') {
      const body = await readJsonBody(req);
      const application_id = parseInt(body.application_id, 10);
      const { category, filename, mime_type, size, body_base64 } = body || {};

      if (!application_id) return res.status(400).json({ error: 'application_id required' });
      if (!category)       return res.status(400).json({ error: 'category required' });
      if (!ALLOWED_AGENT_CATEGORIES.has(category)) {
        return res.status(400).json({
          error: `Agent uploads only allowed to lease-doc slots in V81.4. Got: ${category}`,
        });
      }
      if (!filename || !mime_type || !body_base64) {
        return res.status(400).json({ error: 'filename, mime_type, body_base64 required' });
      }

      // Verify application exists
      const appRows = await sql`SELECT id FROM applications WHERE id = ${application_id} LIMIT 1`;
      if (!appRows.length) return res.status(404).json({ error: 'Application not found' });

      // Decode base64
      let buf;
      try { buf = Buffer.from(body_base64, 'base64'); }
      catch { return res.status(400).json({ error: 'Invalid base64 body' }); }

      // Size guard is also enforced inside blobUpload; keep the early check for a
      // clearer error before we hit the blob lib.
      if (buf.length > 20 * 1024 * 1024) {
        return res.status(413).json({ error: 'File too large (max 20 MB).' });
      }

      // Resolve the agent's contact id from the session for audit + blob path.
      // Session JWT payload stores the contact id in `sub` (see lib/auth.js).
      // String 'fallback' is the env-auth bootstrap user — store as NULL so we
      // don't FK-violate against contacts(id). Pattern from boards.js / deal-order.js.
      const subRaw = (session.sub && session.sub !== 'fallback') ? session.sub : null;
      const subInt = subRaw != null ? parseInt(subRaw, 10) : NaN;
      const agentContactId = Number.isFinite(subInt) ? subInt : null;

      let uploadResult;
      try {
        uploadResult = await blobUpload({
          application_id,
          applicant_or_token: `agent-${agentContactId || 'unknown'}`,
          category,
          filename,
          mime_type,
          body: buf,
          size: buf.length,
        });
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }

      // Persist evidence row — note uploaded_by_role='agent' + uploaded_by=session contact.
      // applicant_contact_id stays NULL: this isn't a per-applicant file, it's a
      // shared lease document. points_value irrelevant for lease-doc slots.
      const result = await sql`
        INSERT INTO application_evidence
          (application_id, applicant_contact_id, category, filename, mime_type,
           size_bytes, url, points_value, uploaded_by_role, uploaded_by)
        VALUES
          (${application_id}, NULL, ${category},
           ${filename}, ${mime_type}, ${buf.length},
           ${uploadResult.url}, 0, 'agent', ${agentContactId})
        RETURNING id, application_id, category, filename, mime_type, size_bytes,
                  url, uploaded_by_role, uploaded_by, uploaded_at`;

      return res.status(201).json({ evidence: result[0] });
    }

    // ── Delete (agent removes one of their own uploads) ────────────────────
    if (req.method === 'DELETE') {
      const id = parseInt(req.query?.id, 10);
      if (!id) return res.status(400).json({ error: 'id required' });

      const rows = await sql`
        SELECT id, url, category, uploaded_by_role
        FROM application_evidence
        WHERE id = ${id} LIMIT 1`;
      if (!rows.length) return res.status(404).json({ error: 'Evidence not found' });
      const ev = rows[0];

      // Source-of-record protection: applicant uploads cannot be deleted here.
      // (V81.4 scope — admin override is a future enhancement.)
      if (ev.uploaded_by_role !== 'agent') {
        return res.status(403).json({
          error: "This file was uploaded by the applicant and is the source of record. " +
                 "It can't be deleted from the agent UI.",
        });
      }

      // Only allow deletion of lease-doc files via this endpoint (consistent with
      // upload scope — keep the surface area tight).
      if (!ALLOWED_AGENT_CATEGORIES.has(ev.category)) {
        return res.status(400).json({
          error: 'This endpoint only deletes lease-doc files in V81.4.',
        });
      }

      // Delete blob (best-effort — DB row is authoritative)
      try { await blobRemove(ev.url); }
      catch (err) { console.warn('[applications-evidence DELETE] blob remove failed:', err.message); }

      await sql`DELETE FROM application_evidence WHERE id = ${id}`;
      return res.status(200).json({ deleted: true, id });
    }

    res.setHeader('Allow', 'POST, DELETE');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[applications-evidence] fatal:', err);
    return res.status(500).json({ error: err.message });
  }
}
