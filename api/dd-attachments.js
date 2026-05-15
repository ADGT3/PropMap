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
      res.setHeader('Content-Disposition', `inline; filename="${att.filename.replace(/"/g, '')}"`);
      const len = result.blob?.size;
      if (len) res.setHeader('Content-Length', String(len));
      result.stream.pipe(res);
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
