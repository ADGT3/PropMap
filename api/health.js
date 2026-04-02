import { neon } from '@neondatabase/serverless';

export default async function handler(req, res) {
  const dbUrl = process.env.pipeline_POSTGRES_URL
    || process.env.pipeline_DATABASE_URL
    || process.env.PIPELINE_POSTGRES_URL
    || process.env.PIPELINE_DATABASE_URL
    || process.env.POSTGRES_URL
    || process.env.DATABASE_URL;

  const checks = {
    timestamp: new Date().toISOString(),
    dbUrlFound: !!dbUrl,
    db: null,
    table: null,
    rowCount: null,
    error: null,
  };

  if (!dbUrl) {
    checks.error = 'No database URL found in environment variables';
    return res.status(500).json(checks);
  }

  try {
    const sql = neon(dbUrl);
    await sql`SELECT 1`;
    checks.db = 'connected';

    const tableCheck = await sql`
      SELECT COUNT(*) as count FROM information_schema.tables
      WHERE table_name = 'pipeline'
    `;
    const tableExists = parseInt(tableCheck[0].count) > 0;
    checks.table = tableExists ? 'exists' : 'not created yet';

    if (tableExists) {
      const countResult = await sql`SELECT COUNT(*) as count FROM pipeline`;
      checks.rowCount = parseInt(countResult[0].count);
    }
  } catch (err) {
    checks.db = 'FAILED';
    checks.error = err.message;
  }

  return res.status(checks.db === 'connected' ? 200 : 500).json(checks);
}
