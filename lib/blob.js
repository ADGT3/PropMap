/**
 * lib/blob.js — V77.2
 *
 * Vercel Blob wrapper for public-form file uploads (lease offer evidence).
 *
 * Path scheme: lease-offers/{application_id}/{applicant_or_token}/{category}/{filename}
 *   Examples:
 *     lease-offers/123/45/id-100-points/passport-front.pdf
 *     lease-offers/123/abc12def/housing-evidence/lease-agreement.pdf
 *
 * Constraints:
 *   - 10 MB max per file
 *   - Allowed types: PDF, JPEG, PNG, HEIC
 *
 * Activation:
 *   1. Vercel Dashboard → Storage → Create Blob store
 *   2. Connect to project — automatically populates BLOB_READ_WRITE_TOKEN env var
 *   3. No further config — `put()` reads the token from env automatically
 *
 * If BLOB_READ_WRITE_TOKEN is missing, upload() throws a clear error with setup instructions.
 */

import { put, del, list } from '@vercel/blob';

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const ALLOWED_MIME = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/heic',
  'image/heif',
]);
const ALLOWED_EXT = new Set(['.pdf', '.jpg', '.jpeg', '.png', '.heic', '.heif']);

/**
 * Upload a file to Vercel Blob.
 *
 * @param {object} opts
 * @param {string} opts.application_id  — applications.id
 * @param {string|number} opts.applicant_or_token — applicant contact id OR token (Step 1 has no contact_id yet)
 * @param {string} opts.category        — e.g. 'id-100-points', 'housing-evidence', 'income-evidence'
 * @param {string} opts.filename        — original filename (sanitised before write)
 * @param {string} opts.mime_type
 * @param {Buffer|Uint8Array|Blob|ReadableStream} opts.body — file body
 * @param {number} opts.size            — file size in bytes
 * @returns {Promise<{url, pathname, size, content_type, uploaded_at}>}
 */
export async function upload(opts) {
  const { application_id, applicant_or_token, category, filename, mime_type, body, size } = opts || {};

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    throw new Error(
      'BLOB_READ_WRITE_TOKEN env var is missing. ' +
      'In Vercel: Dashboard → Storage → Create Blob store and connect it to this project. ' +
      'The token is automatically populated for all environments.'
    );
  }

  if (!application_id)      throw new Error('upload: application_id is required');
  if (!applicant_or_token)  throw new Error('upload: applicant_or_token is required');
  if (!category)            throw new Error('upload: category is required');
  if (!filename)            throw new Error('upload: filename is required');
  if (!body)                throw new Error('upload: body is required');

  if (typeof size === 'number' && size > MAX_BYTES) {
    throw new Error(`File too large. Max 10 MB; got ${(size / 1024 / 1024).toFixed(1)} MB.`);
  }

  if (mime_type && !ALLOWED_MIME.has(mime_type.toLowerCase())) {
    throw new Error(`Unsupported file type: ${mime_type}. Allowed: PDF, JPEG, PNG, HEIC.`);
  }

  const ext = (filename.match(/\.[^.]+$/)?.[0] || '').toLowerCase();
  if (ext && !ALLOWED_EXT.has(ext)) {
    throw new Error(`Unsupported file extension: ${ext}. Allowed: .pdf, .jpg, .png, .heic.`);
  }

  // Sanitise filename — keep it human-readable but URL-safe
  const safeBase = filename
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  const pathname = `lease-offers/${application_id}/${applicant_or_token}/${category}/${Date.now()}-${safeBase}`;

  const result = await put(pathname, body, {
    access: 'public',
    contentType: mime_type || undefined,
    addRandomSuffix: false, // we already include a timestamp
  });

  return {
    url: result.url,
    pathname: result.pathname,
    size: typeof size === 'number' ? size : null,
    content_type: result.contentType || mime_type || null,
    uploaded_at: new Date().toISOString(),
  };
}

/**
 * Delete a previously-uploaded blob by URL or pathname.
 */
export async function remove(urlOrPath) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    throw new Error('BLOB_READ_WRITE_TOKEN env var is missing.');
  }
  await del(urlOrPath);
  return { deleted: true };
}

/**
 * List all blobs for an application (admin/debug helper).
 */
export async function listForApplication(application_id) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    throw new Error('BLOB_READ_WRITE_TOKEN env var is missing.');
  }
  const result = await list({ prefix: `lease-offers/${application_id}/` });
  return result.blobs;
}

export default { upload, remove, listForApplication, MAX_BYTES };
