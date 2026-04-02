/**
 * api/health.js
 * DB connection health check using Neon HTTP API.
 */

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
    checks.error = 'No database URL found';
    return res.status(500).json(checks);
  }

  try {
    const result = await neonQuery(dbUrl, 'SELECT 1 as ok');
    checks.db = 'connected';

    const tableResult = await neonQuery(dbUrl,
      `SELECT COUNT(*) as count FROM information_schema.tables WHERE table_name = 'pipeline'`
    );
    const tableExists = parseInt(tableResult.rows[0].count) > 0;
    checks.table = tableExists ? 'exists' : 'not created yet';

    if (tableExists) {
      const countResult = await neonQuery(dbUrl, 'SELECT COUNT(*) as count FROM pipeline');
      checks.rowCount = parseInt(countResult.rows[0].count);
    }
  } catch (err) {
    checks.db = 'FAILED';
    checks.error = err.message;
  }

  return res.status(checks.db === 'connected' ? 200 : 500).json(checks);
}

async function neonQuery(connectionString, query, params = []) {
  // Parse the connection string: postgres://user:password@host/dbname
  const url = new URL(connectionString);
  const host = url.hostname;
  const user = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);

  // Neon HTTP API endpoint
  const endpoint = `https://${host}/sql`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Basic ${btoa(user + ':' + password)}`,
      'Neon-Pool-Opt-In': 'true',
    },
    body: JSON.stringify({ query, params }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Neon HTTP ${response.status}: ${text}`);
  }
  return response.json();
}
