/**
 * lib/db.js
 * Centralised database URL resolver.
 *
 * Neon's Vercel integration (the version installed for this project) sets
 * variables with a `pipeline_` prefix that are overridden per deployment so
 * preview deploys hit their own Neon branch. These MUST be checked first so
 * the per-deployment override takes effect — any static project-scoped
 * POSTGRES_URL / DATABASE_URL would point at `main` and silently break
 * isolation for preview branches.
 *
 * Order below: integration-managed per-environment vars first, static
 * project-scoped fallbacks last.
 */

export function getDatabaseUrl() {
  const url = process.env.pipeline_POSTGRES_URL
    || process.env.pipeline_DATABASE_URL
    || process.env.PIPELINE_POSTGRES_URL
    || process.env.PIPELINE_DATABASE_URL
    || process.env.POSTGRES_URL
    || process.env.DATABASE_URL;
  if (!url) throw new Error('No database URL found in environment variables (checked pipeline_POSTGRES_URL, pipeline_DATABASE_URL, POSTGRES_URL, DATABASE_URL)');
  return url;
}
