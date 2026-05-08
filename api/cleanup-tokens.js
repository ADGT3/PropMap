/**
 * api/cleanup-tokens.js — V77.2
 *
 * Discards expired/abandoned applicant_form_tokens rows.
 *
 * Per build plan §6.1.3 — hard-deletes:
 *   - applicant_form_tokens rows where email_verified=false AND created_at < now() - 7 days
 *   - The associated applications row IF it's still 'draft' AND has no other tokens
 *     (JSONB applicant data goes with it)
 *
 * Invoked by:
 *   - Vercel Cron (daily 15:00 UTC = 01:00 AEST winter, 02:00 AEDT summer)
 *   - Manual GET / POST by an admin
 *
 * Response:
 *   200 { tokens_deleted, applications_deleted, dry_run }
 */

import { neon } from '@neondatabase/serverless';
import { requireSession, requireAdmin } from '../lib/auth.js';
import { getDatabaseUrl } from '../lib/db.js';
const sql = neon(getDatabaseUrl());

export default async function handler(req, res) {
  // Vercel Cron sends `Authorization: Bearer ${CRON_SECRET}`. We check for this
  // first; if absent, fall through to standard admin-session auth.
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers['authorization'] || '';
  const isCron = cronSecret && authHeader === `Bearer ${cronSecret}`;

  if (!isCron) {
    const session = await requireSession(req, res);
    if (!session) return;
    if (!requireAdmin(session, res)) return;
  }

  const dryRun = req.query?.dry_run === '1' || req.query?.dry_run === 'true';

  try {
    // 1. Find tokens to delete (unverified, > 7 days old)
    const expiringTokens = await sql`
      SELECT id, application_id, applicant_email, created_at
      FROM applicant_form_tokens
      WHERE email_verified = false
        AND created_at < now() - INTERVAL '7 days'`;

    // 2. Find applications that would be orphaned (draft + only-tied-to-deleted-tokens)
    //    For each token, check whether the parent application has any OTHER tokens
    //    that aren't in our delete set, AND whether the application is still draft.
    const tokenIdsToDelete = expiringTokens.map(t => t.id);
    const appIdsTouched    = [...new Set(expiringTokens.map(t => t.application_id))];

    let appIdsToDelete = [];
    if (appIdsTouched.length) {
      // For each affected application, count remaining tokens AFTER the delete.
      // This is: (total tokens for app) - (tokens-in-delete-set for app)
      const remainingByApp = await sql`
        SELECT a.id AS app_id, a.status,
               COUNT(t.id)::int AS token_count
        FROM applications a
        LEFT JOIN applicant_form_tokens t ON t.application_id = a.id
                                          AND t.id <> ALL(${tokenIdsToDelete})
        WHERE a.id = ANY(${appIdsTouched})
        GROUP BY a.id, a.status`;

      appIdsToDelete = remainingByApp
        .filter(r => r.status === 'draft' && r.token_count === 0)
        .map(r => r.app_id);
    }

    if (dryRun) {
      return res.status(200).json({
        dry_run: true,
        tokens_to_delete: expiringTokens.length,
        applications_to_delete: appIdsToDelete.length,
        sample_tokens: expiringTokens.slice(0, 5),
        application_ids_to_delete: appIdsToDelete,
      });
    }

    // 3. Execute deletes (tokens first; applications cascade-delete tokens, but
    //    we delete tokens explicitly so the count matches what we computed).
    let tokensDeleted = 0;
    let appsDeleted = 0;

    if (tokenIdsToDelete.length) {
      const r = await sql`DELETE FROM applicant_form_tokens WHERE id = ANY(${tokenIdsToDelete}) RETURNING id`;
      tokensDeleted = r.length;
    }
    if (appIdsToDelete.length) {
      const r = await sql`DELETE FROM applications WHERE id = ANY(${appIdsToDelete}) RETURNING id`;
      appsDeleted = r.length;
    }

    console.log(`[cleanup-tokens] tokens_deleted=${tokensDeleted} applications_deleted=${appsDeleted}`);

    return res.status(200).json({
      dry_run: false,
      tokens_deleted: tokensDeleted,
      applications_deleted: appsDeleted,
      ran_via: isCron ? 'cron' : 'admin',
      ran_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[cleanup-tokens] error:', err);
    return res.status(500).json({ error: err.message });
  }
}
