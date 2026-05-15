/**
 * api/dd-attachments.js — V78i
 *
 * Agent-only API for files attached to Due Diligence risk rows on a deal.
 *
 * Routes:
 *   GET    /api/dd-attachments?deal_id=X&dd_key=Y   list (dd_key optional)
 *   POST   /api/dd-attachments                       upload — body: { deal_id, dd_key, filename, mime_type, body_base64 }
 *   DELETE /api/dd-attachments?id=N                  delete one
 *   GET    /api/dd-attachments?id=N&action=download  stream the file
 *
 * Storage: Vercel Blob, private access. URL stored in dd_attachments.url.
 * Path scheme: dd-attachments/{deal_id}/{dd_key}/{timestamp}-{safe-filename}
 */

import { neon } from '@neondatabase/serverless';
import { put, del as blobDel, get as blobGet } from '@vercel/blob';
import { requireSession } from '../lib/auth.js';
import { getDatabaseUrl } from '../lib/db.js';
import { titleForParcel } from '../lib/parcel-title.js';

const sql = neon(getDatabaseUrl());

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const ALLOWED_MIME = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/heic',
  'image/heif',
]);
const ALLOWED_EXT = new Set(['.pdf', '.jpg', '.jpeg', '.png', '.heic', '.heif']);

function safeFilename(name) {
  return String(name || 'file')
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

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

  try {
    // ── View (HTML wrapper around the file, matches evidence-view standard) ──
    if (req.method === 'GET' && req.query?.action === 'view') {
      const id = parseInt(req.query.id, 10);
      if (!id) return res.status(400).send('id required');

      const rows = await sql`
        SELECT a.id, a.deal_id, a.dd_key, a.filename, a.mime_type, a.uploaded_at,
               d.id AS deal_id_check
        FROM dd_attachments a
        LEFT JOIN deals d ON d.id = a.deal_id
        WHERE a.id = ${id} LIMIT 1`;
      if (!rows.length) return res.status(404).send('Attachment not found');
      const att = rows[0];

      // Resolve a context heading. Try to look up the property address for the
      // deal so the header reads like "Zoning · 49 - 57 Catherine Fields Rd".
      // V78i.4 — Use the shared formatter (titleForParcel) for parcel deals
      // so this matches the deal modal / popup. Previously we read the stale
      // parcels.name snapshot.
      let propertyLabel = '';
      try {
        const dealRows = await sql`
          SELECT property_id, parcel_id FROM deals WHERE id = ${att.deal_id} LIMIT 1`;
        const d = dealRows[0];
        if (d?.parcel_id) {
          propertyLabel = await titleForParcel(sql, d.parcel_id);
        } else if (d?.property_id) {
          const pr = await sql`SELECT address, suburb FROM properties WHERE id = ${d.property_id} LIMIT 1`;
          if (pr[0]) propertyLabel = [pr[0].address, pr[0].suburb].filter(Boolean).join(', ');
        }
      } catch (_) { /* non-fatal */ }

      // Pretty-case the dd_key for the heading (e.g. "zoning" → "Zoning")
      const niceKey = att.dd_key.charAt(0).toUpperCase() + att.dd_key.slice(1);
      const contextHeading = propertyLabel
        ? `DD: ${niceKey} · ${propertyLabel}`
        : `DD: ${niceKey}`;

      const downloadUrl = `/api/dd-attachments?id=${id}&action=download`;
      const mime = String(att.mime_type || '').toLowerCase();
      const isImage = mime.startsWith('image/');
      const isPdf   = mime === 'application/pdf';

      let viewerHtml;
      if (isImage) {
        viewerHtml = `<img src="${downloadUrl}" alt="${escHtml(att.filename)}">`;
      } else if (isPdf) {
        viewerHtml = `<iframe src="${downloadUrl}#view=FitH" title="${escHtml(att.filename)}"></iframe>`;
      } else {
        viewerHtml = `
          <div class="ev-fallback">
            <p>This file type can't be previewed in the browser.</p>
            <p><a class="ev-download-btn" href="${downloadUrl}">Download ${escHtml(att.filename)}</a></p>
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
    <div style="flex:1;min-width:0">
      <div class="ev-context">${escHtml(contextHeading)}</div>
      <div class="ev-filename">${escHtml(att.filename)}</div>
    </div>
    <a class="ev-download" href="${downloadUrl}" download="${escHtml(att.filename)}">Download</a>
  </header>
  <div class="ev-viewer">${viewerHtml}</div>
</body>
</html>`;

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      return res.status(200).send(html);
    }

    // ── Download (stream a single file) ────────────────────────────────
    if (req.method === 'GET' && req.query?.action === 'download') {
      const id = parseInt(req.query.id, 10);
      if (!id) return res.status(400).json({ error: 'id required' });
      const rows = await sql`
        SELECT id, deal_id, filename, mime_type, url
        FROM dd_attachments WHERE id = ${id} LIMIT 1`;
      if (!rows.length) return res.status(404).json({ error: 'Attachment not found' });
      const att = rows[0];

      if (!process.env.BLOB_READ_WRITE_TOKEN) {
        return res.status(500).json({ error: 'BLOB_READ_WRITE_TOKEN missing' });
      }
      const result = await blobGet(att.url, { access: 'private' });
      if (!result || result.statusCode !== 200) {
        return res.status(404).json({ error: 'File not found in storage' });
      }
      res.setHeader('Content-Type', att.mime_type || result.blob?.contentType || 'application/octet-stream');
      // V78i — Content-Disposition can only contain ASCII; sanitise the filename
      // for the header. Keep the original filename in the DB/UI; just the
      // header gets the safe version. Use RFC 5987 filename* for full
      // unicode support via UTF-8 percent-encoding.
      const asciiName = att.filename
        .replace(/[^\x20-\x7e]/g, '_')   // non-printable / non-ASCII → underscore
        .replace(/["\\]/g, '_');         // quotes / backslashes
      const utf8Name  = encodeURIComponent(att.filename);
      res.setHeader('Content-Disposition',
        `inline; filename="${asciiName}"; filename*=UTF-8''${utf8Name}`);
      const len = result.blob?.size;
      if (len) res.setHeader('Content-Length', String(len));
      // V78i — @vercel/blob's get() returns a Web ReadableStream (Fetch API),
      // not a Node Readable. Buffer the body then write to res. Files are
      // capped at 10MB by upload validation so this is bounded.
      const ab = await new Response(result.stream).arrayBuffer();
      res.end(Buffer.from(ab));
      return;
    }

    // ── List ───────────────────────────────────────────────────────────
    if (req.method === 'GET') {
      const dealId = req.query?.deal_id;
      if (!dealId) return res.status(400).json({ error: 'deal_id required' });
      const ddKey = req.query?.dd_key || null;

      const rows = ddKey
        ? await sql`
            SELECT id, deal_id, dd_key, filename, mime_type, size_bytes, uploaded_at
            FROM dd_attachments
            WHERE deal_id = ${dealId} AND dd_key = ${ddKey}
            ORDER BY uploaded_at DESC`
        : await sql`
            SELECT id, deal_id, dd_key, filename, mime_type, size_bytes, uploaded_at
            FROM dd_attachments
            WHERE deal_id = ${dealId}
            ORDER BY dd_key, uploaded_at DESC`;
      return res.status(200).json(rows);
    }

    // ── Upload ─────────────────────────────────────────────────────────
    if (req.method === 'POST') {
      if (!process.env.BLOB_READ_WRITE_TOKEN) {
        return res.status(500).json({
          error: 'BLOB_READ_WRITE_TOKEN env var is missing. Connect a Vercel Blob store (private) to this project.',
        });
      }
      const body = await readJsonBody(req);
      const { deal_id, dd_key, filename, mime_type, size, body_base64 } = body || {};
      if (!deal_id || !dd_key || !filename || !mime_type || !body_base64) {
        return res.status(400).json({ error: 'deal_id, dd_key, filename, mime_type, body_base64 required' });
      }

      if (typeof size === 'number' && size > MAX_BYTES) {
        return res.status(400).json({ error: `File too large. Max 10 MB; got ${(size/1024/1024).toFixed(1)} MB.` });
      }
      if (!ALLOWED_MIME.has(String(mime_type).toLowerCase())) {
        return res.status(400).json({ error: `Unsupported file type: ${mime_type}. Allowed: PDF, JPEG, PNG, HEIC.` });
      }
      const ext = (String(filename).match(/\.[^.]+$/)?.[0] || '').toLowerCase();
      if (ext && !ALLOWED_EXT.has(ext)) {
        return res.status(400).json({ error: `Unsupported file extension: ${ext}. Allowed: .pdf, .jpg, .png, .heic.` });
      }

      // Verify deal exists (cheap check; CASCADE handles delete already)
      const dealRows = await sql`SELECT id FROM deals WHERE id = ${deal_id} LIMIT 1`;
      if (!dealRows.length) return res.status(404).json({ error: 'Deal not found' });

      let buf;
      try { buf = Buffer.from(body_base64, 'base64'); }
      catch { return res.status(400).json({ error: 'body_base64 invalid' }); }

      const ddSlug = safeFilename(dd_key);
      const pathname = `dd-attachments/${deal_id}/${ddSlug}/${Date.now()}-${safeFilename(filename)}`;
      const result = await put(pathname, buf, {
        access: 'private',
        contentType: mime_type,
        addRandomSuffix: true,
      });

      const uploadedBy = session?.contactId || null;
      const inserted = await sql`
        INSERT INTO dd_attachments
          (deal_id, dd_key, filename, mime_type, size_bytes, url, uploaded_by)
        VALUES (${deal_id}, ${dd_key}, ${filename}, ${mime_type},
                ${typeof size === 'number' ? size : null}, ${result.url}, ${uploadedBy})
        RETURNING id, deal_id, dd_key, filename, mime_type, size_bytes, uploaded_at`;
      return res.status(201).json(inserted[0]);
    }

    // ── Delete ─────────────────────────────────────────────────────────
    if (req.method === 'DELETE') {
      const id = parseInt(req.query?.id, 10);
      if (!id) return res.status(400).json({ error: 'id required' });
      const rows = await sql`SELECT id, url FROM dd_attachments WHERE id = ${id} LIMIT 1`;
      if (!rows.length) return res.status(404).json({ error: 'Attachment not found' });
      const att = rows[0];
      // Delete blob first; if it fails we leave the DB row so the user can retry.
      try { await blobDel(att.url); }
      catch (err) { console.warn('[dd-attachments DELETE] blob delete failed:', err.message); }
      await sql`DELETE FROM dd_attachments WHERE id = ${id}`;
      return res.status(200).json({ deleted: true });
    }

    res.setHeader('Allow', 'GET, POST, DELETE');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[dd-attachments] fatal:', err);
    return res.status(500).json({ error: err.message });
  }
}
