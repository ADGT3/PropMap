/**
 * api/evidence-view.js — V77.2e
 *
 * Agent-only HTML wrapper around an evidence file. Fetches the evidence row,
 * looks up its context (category, applicant name, housing/income entry it
 * belongs to), renders a small heading above an embedded viewer.
 *
 * Routing: Vercel rewrites /api/applications/evidence/:id/view → this file.
 *   GET /api/applications/evidence/{id}/view
 *
 * Embeds the actual file via the existing /download endpoint, which authenticates
 * the same way (agent session required).
 */

import { neon } from '@neondatabase/serverless';
import { requireSession } from '../lib/auth.js';
import { getDatabaseUrl } from '../lib/db.js';

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

function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export default async function handler(req, res) {
  const session = await requireSession(req, res);
  if (!session) return;

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
             c.first_name, c.last_name
      FROM application_evidence e
      LEFT JOIN contacts c ON c.id = e.applicant_contact_id
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
    const isImage = (ev.mime_type || '').startsWith('image/');
    const isPdf   = (ev.mime_type || '') === 'application/pdf';

    let viewerHtml;
    if (isImage) {
      viewerHtml = `<img src="${downloadUrl}" alt="${escHtml(ev.filename)}">`;
    } else if (isPdf) {
      viewerHtml = `<iframe src="${downloadUrl}#view=FitH" title="${escHtml(ev.filename)}"></iframe>`;
    } else {
      // Fallback for HEIC etc — let the browser try to render or offer a link
      viewerHtml = `
        <div class="ev-fallback">
          <p>This file type can't be previewed in the browser.</p>
          <p><a class="ev-download-btn" href="${downloadUrl}">Download ${escHtml(ev.filename)}</a></p>
        </div>`;
    }

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex, nofollow">
  <title>${escHtml(contextHeading)} · PropMap</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #1a1410;
      color: #f7f4ec;
      display: flex;
      flex-direction: column;
      min-height: 100vh;
    }
    .ev-header {
      background: #2a221a;
      border-bottom: 1px solid #3d3128;
      padding: 14px 20px;
      display: flex;
      align-items: baseline;
      gap: 14px;
      flex-wrap: wrap;
    }
    .ev-context {
      font-size: 14px;
      font-weight: 600;
      color: #f7f4ec;
      flex: 1;
      min-width: 0;
    }
    .ev-filename {
      font-size: 12px;
      color: #c4841a;
      font-family: ui-monospace, 'SF Mono', Monaco, monospace;
    }
    .ev-download {
      font-size: 12px;
      color: #fff;
      background: #c4841a;
      text-decoration: none;
      padding: 5px 12px;
      border-radius: 3px;
      font-weight: 500;
    }
    .ev-download:hover { background: #a26d14; }
    .ev-viewer {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 16px;
      overflow: auto;
    }
    .ev-viewer img {
      max-width: 100%;
      max-height: calc(100vh - 80px);
      object-fit: contain;
      box-shadow: 0 4px 24px rgba(0,0,0,0.4);
      background: #fff;
    }
    .ev-viewer iframe {
      width: 100%;
      height: calc(100vh - 70px);
      border: 0;
      background: #fff;
    }
    .ev-fallback {
      text-align: center;
      padding: 40px;
    }
    .ev-download-btn {
      display: inline-block;
      background: #c4841a;
      color: #fff;
      padding: 10px 20px;
      border-radius: 4px;
      text-decoration: none;
      font-weight: 600;
      margin-top: 12px;
    }
  </style>
</head>
<body>
  <header class="ev-header">
    <div>
      <div class="ev-context">${escHtml(contextHeading)}</div>
      <div class="ev-filename">${escHtml(ev.filename)}</div>
    </div>
    <a class="ev-download" href="${downloadUrl}" download="${escHtml(ev.filename)}">Download</a>
  </header>
  <div class="ev-viewer">${viewerHtml}</div>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.status(200).send(html);
  } catch (err) {
    console.error('[evidence-view] error:', err);
    return res.status(500).send('Server error: ' + err.message);
  }
}
