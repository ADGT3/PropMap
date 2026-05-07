/**
 * lib/blob.js — V77.2
 *
 * Vercel Blob wrapper for public-form file uploads (lease offer evidence).
 *
 * V77.2 update: uploads use access: 'private'. Files are NOT publicly accessible
 * by URL — they can only be retrieved through the agent-only download endpoint
 * (api/applications/evidence/[id]/download.js) which authenticates the agent
 * session before streaming the file.
 *
 * Path scheme: lease-offers/{application_id}/{applicant_or_token}/{category}/{filename}
 *
 * Activation:
 *   1. Vercel Dashboard → Storage → Create Blob store, set access: PRIVATE
 *   2. Connect to project — automatically populates BLOB_READ_WRITE_TOKEN env var
 */

import { put, del, list, get as blobGet } from '@vercel/blob';

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const ALLOWED_MIME = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/heic',
  'image/heif',
]);
const ALLOWED_EXT = new Set(['.pdf', '.jpg', '.jpeg', '.png', '.heic', '.heif']);

export async function upload(opts) {
  const { application_id, applicant_or_token, category, filename, mime_type, body, size } = opts || {};

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    throw new Error(
      'BLOB_READ_WRITE_TOKEN env var is missing. ' +
      'In Vercel: Dashboard → Storage → Create Blob store (set access to Private) and connect it to this project. ' +
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

  const safeBase = filename
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  const pathname = `lease-offers/${application_id}/${applicant_or_token}/${category}/${Date.now()}-${safeBase}`;

  const result = await put(pathname, body, {
    access: 'private',          // V77.2: private access
    contentType: mime_type || undefined,
    addRandomSuffix: true,      // adds extra entropy on top of our timestamp
  });

  return {
    url: result.url,            // private URL — not publicly accessible
    pathname: result.pathname,
    size: typeof size === 'number' ? size : null,
    content_type: result.contentType || mime_type || null,
    uploaded_at: new Date().toISOString(),
  };
}

/**
 * Get the contents of a private blob (for the agent-only download endpoint).
 * Returns { stream, contentType, contentLength } or null if not found.
 */
export async function download(urlOrPath) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    throw new Error('BLOB_READ_WRITE_TOKEN env var is missing.');
  }
  const result = await blobGet(urlOrPath, { access: 'private' });
  if (!result || result.statusCode !== 200) return null;
  return {
    stream:        result.stream,
    contentType:   result.blob?.contentType,
    contentLength: result.blob?.size,
    pathname:      result.blob?.pathname,
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

export async function listForApplication(application_id) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    throw new Error('BLOB_READ_WRITE_TOKEN env var is missing.');
  }
  const result = await list({ prefix: `lease-offers/${application_id}/` });
  return result.blobs;
}

export default { upload, download, remove, listForApplication, MAX_BYTES };
