/**
 * lib/attachment-viewer.js — V81.5
 *
 * SINGLE system-wide renderer for the agent-facing attachment viewer page.
 * Every file-open in the system (application/lease evidence via
 * api/evidence-view.js, DD risk attachments via api/dd-attachments.js, and any
 * future file source) renders through this one function so the look, the
 * "Uploaded by … on … AEST" audit line, and the markup can never diverge.
 *
 * Callers do their own auth + data fetch (they read different tables), then
 * pass a normalised descriptor here. This module owns: HTML/CSS, the audit-line
 * formatting, and the img/iframe/fallback body selection.
 *
 * Usage:
 *   import { renderAttachmentViewerPage, buildAuditLine } from '../lib/attachment-viewer.js';
 *   const html = renderAttachmentViewerPage({
 *     contextHeading, filename, mimeType, downloadUrl,
 *     uploadedByName, uploadedByRole, uploadedAt,
 *   });
 *   res.setHeader('Content-Type', 'text/html; charset=utf-8');
 *   res.setHeader('Cache-Control', 'private, no-store');
 *   res.setHeader('X-Content-Type-Options', 'nosniff');
 *   return res.status(200).send(html);
 */

export function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Format the "Uploaded by <name>[ (agent)] on <ts> AEST" line.
 *
 * Name resolution is the caller's responsibility (it varies per source — e.g.
 * evidence files fall back to the applicant's own name). Pass the already
 * resolved name; pass '' / null only when genuinely unresolved, which renders
 * as "Unknown".
 *
 * Timestamp is rendered in Australia/Sydney; label is fixed to "AEST" per spec
 * (in summer the offset is technically AEDT/UTC+11 — the time is correct, the
 * label is constant).
 *
 * @param {object} o
 * @param {string|null} o.uploadedByName  resolved uploader name, or falsy → "Unknown"
 * @param {string|null} o.uploadedByRole  'agent' adds a "(agent)" suffix; anything else omitted
 * @param {string|Date|null} o.uploadedAt ISO timestamp / Date
 * @returns {string} plain text (NOT html-escaped — escape at render time)
 */
export function buildAuditLine({ uploadedByName, uploadedByRole, uploadedAt } = {}) {
  const name = (uploadedByName && String(uploadedByName).trim()) || 'Unknown';
  const roleSuffix = uploadedByRole === 'agent' ? ' (agent)' : '';
  let when = '';
  if (uploadedAt) {
    try {
      when = new Date(uploadedAt).toLocaleString('en-AU', {
        timeZone: 'Australia/Sydney',
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit', hour12: false,
      });
    } catch (_) { when = ''; }
  }
  return `Uploaded by ${name}${roleSuffix}` + (when ? ` on ${when} AEST` : '');
}

/**
 * Render the full viewer HTML page.
 *
 * @param {object} o
 * @param {string} o.contextHeading   line 1 heading (e.g. "Lease Document — …")
 * @param {string} o.filename         file name shown + used for download attr
 * @param {string} o.mimeType         used to pick img / iframe / fallback
 * @param {string} o.downloadUrl      href for the embedded file + Download button
 * @param {string|null} [o.uploadedByName]
 * @param {string|null} [o.uploadedByRole]
 * @param {string|Date|null} [o.uploadedAt]
 * @returns {string} complete HTML document
 */
export function renderAttachmentViewerPage({
  contextHeading,
  filename,
  mimeType,
  downloadUrl,
  uploadedByName,
  uploadedByRole,
  uploadedAt,
} = {}) {
  const auditLine = buildAuditLine({ uploadedByName, uploadedByRole, uploadedAt });

  const mime = String(mimeType || '').toLowerCase();
  const isImage = mime.startsWith('image/');
  const isPdf   = mime === 'application/pdf';

  let viewerHtml;
  if (isImage) {
    viewerHtml = `<img src="${downloadUrl}" alt="${escHtml(filename)}">`;
  } else if (isPdf) {
    viewerHtml = `<iframe src="${downloadUrl}#view=FitH" title="${escHtml(filename)}"></iframe>`;
  } else {
    // Fallback for HEIC etc — let the browser try to render or offer a link
    viewerHtml = `
        <div class="ev-fallback">
          <p>This file type can't be previewed in the browser.</p>
          <p><a class="ev-download-btn" href="${downloadUrl}">Download ${escHtml(filename)}</a></p>
        </div>`;
  }

  return `<!DOCTYPE html>
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
    .ev-audit {
      font-size: 11px;
      color: #a89a86;
      margin-top: 3px;
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
    <div style="flex:1;min-width:0">
      <div class="ev-context">${escHtml(contextHeading)}</div>
      <div class="ev-filename">${escHtml(filename)}</div>
      <div class="ev-audit">${escHtml(auditLine)}</div>
    </div>
    <a class="ev-download" href="${downloadUrl}" download="${escHtml(filename)}">Download</a>
  </header>
  <div class="ev-viewer">${viewerHtml}</div>
</body>
</html>`;
}
