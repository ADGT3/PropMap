/**
 * api/evidence-view.js — V81.5
 *
 * Agent-only viewer for an application/lease evidence file. Fetches the evidence
 * row, looks up its context (category, applicant name, housing/income entry it
 * belongs to) and the uploader, then renders via the single system-wide viewer
 * (lib/attachment-viewer.js) — the same renderer DD attachments use, so the page
 * and the "Uploaded by …" audit line stay identical everywhere.
 *
 * Routing: Vercel rewrites /api/applications/evidence/:id/view → this file.
 *   GET /api/applications/evidence/{id}/view
 *
 * Embeds the actual file via the existing /download endpoint, which authenticates
 * the same way (agent session required).
 */

import { neon } from '@neondatabase/serverless';
import { requireSession, requireModule } from '../lib/auth.js';
import { getDatabaseUrl } from '../lib/db.js';
import { renderAttachmentViewerPage } from '../lib/attachment-viewer.js';

const sql = neon(getDatabaseUrl());

const ID_DOC_LABELS = {
  passport:             'Passport (70 pts)',
  birth_certificate:    'Birth certificate (70 pts)',
  drivers_licence:      'Drivers licence — front (40 pts)',
  drivers_licence_back: 'Drivers licence — back (0 pts)',
  medicare:             'Medicare card (25 pts)',
  bank_statement:       'Bank statement (25 pts)',
  utility_bill:         'Utility bill (25 pts)',
  rates_notice:         'Rates notice (25 pts)',
  other:                'Other (10 pts)',
};

export default async function handler(req, res) {
  const session = await requireSession(req, res);
  if (!session) return;
  if (!requireModule(session, res, 'pipeline')) return;

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const id = parseInt(req.query?.id, 10);
  if (!id) return res.status(400).send('evidence id required');

  try {
    const rows = await sql`
      SELECT e.id, e.application_id, e.applicant_contact_id, e.category, e.doc_type,
             e.filename, e.mime_type, e.points_value,
             e.uploaded_by, e.uploaded_by_role, e.uploaded_at,
             c.first_name, c.last_name,
             NULLIF(TRIM(CONCAT_WS(' ', up.first_name, up.last_name)), '') AS uploaded_by_name
      FROM application_evidence e
      LEFT JOIN contacts c  ON c.id  = e.applicant_contact_id
      LEFT JOIN contacts up ON up.id = e.uploaded_by
      WHERE e.id = ${id}
      LIMIT 1`;
    if (!rows.length) return res.status(404).send('Evidence not found');
    const ev = rows[0];

    // Build context heading (line 1) based on category
    let contextHeading = 'Evidence';
    const cat = ev.category || '';
    if (cat.startsWith('id-')) {
      const label = ID_DOC_LABELS[ev.doc_type] || ev.doc_type || 'No type set';
      const applicantName = [ev.first_name, ev.last_name].filter(Boolean).join(' ').trim();
      contextHeading = applicantName
        ? `ID Document — ${label} · ${applicantName}`
        : `ID Document — ${label}`;
    } else if (cat.startsWith('housing-evidence:')) {
      // Look up the housing entry by client_id stashed in evidence_label
      const cid = cat.split(':')[1];
      const hRows = await sql`
        SELECT address FROM application_housing_history
        WHERE application_id = ${ev.application_id}
          AND evidence_label = ${'client_id:' + cid}
        LIMIT 1`;
      const addr = hRows[0]?.address || 'Housing entry';
      contextHeading = `Housing evidence — ${addr}`;
    } else if (cat.startsWith('income-evidence:')) {
      const cid = cat.split(':')[1];
      const iRows = await sql`
        SELECT income_source_name FROM application_income_history
        WHERE application_id = ${ev.application_id}
          AND evidence_label = ${'client_id:' + cid}
        LIMIT 1`;
      const src = iRows[0]?.income_source_name || 'Income entry';
      contextHeading = `Income evidence — ${src}`;
    } else if (cat === 'lease-doc:signed-contract') {
      contextHeading = 'Lease Document — Signed Lease Agreement';
    } else if (cat === 'lease-doc:condition-report') {
      contextHeading = 'Lease Document — Accepted Condition Report';
    }

    const downloadUrl = `/api/applications/evidence/${id}/download`;

    // ── Resolve uploader name for the audit line ──────────────────────────
    // 1. uploaded_by contact join (agent uploads + populated applicant rows)
    // 2. applicant-role rows with no uploaded_by → the applicant's own name
    // 3. otherwise "Unknown" (rendered by the shared module)
    const applicantName = [ev.first_name, ev.last_name].filter(Boolean).join(' ').trim();
    let uploadedByName = (ev.uploaded_by_name && String(ev.uploaded_by_name).trim()) || '';
    if (!uploadedByName && ev.uploaded_by_role === 'applicant' && applicantName) {
      uploadedByName = applicantName;
    }

    const html = renderAttachmentViewerPage({
      contextHeading,
      filename: ev.filename,
      mimeType: ev.mime_type,
      downloadUrl,
      uploadedByName,
      uploadedByRole: ev.uploaded_by_role,
      uploadedAt: ev.uploaded_at,
    });

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.status(200).send(html);
  } catch (err) {
    console.error('[evidence-view] error:', err);
    return res.status(500).send('Server error: ' + err.message);
  }
}
