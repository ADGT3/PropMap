/**
 * api/health.js
 * DB connection health check — uses native fetch, no npm packages required.
 */

export default async function handler(req, res) {
  const dbUrl = process.env.PIPELINE_DATABASE_URL
    || process.env.PIPELINE_URL
    || process.env.PIPELINE_PRISMA_URL
    || process.env.PIPELINE_URL_NON_POOLING
    || process.env.DATABASE_URL
    || process.env.POSTGRES_URL;

  const checks = {
    timestamp: new Date().toISOString(),
    dbUrlFound: !!dbUrl,
    envKeys: Object.keys(process.env).filter(k =>
      k.includes('DATABASE') || k.includes('POSTGRES') || k.includes('NEON') || k.includes('PIPELINE')
    ),
    db: null,
    table: null,
    rowCount: null,
    error: null,
  };

  if (!dbUrl) {
    checks.db = 'FAILED — no database URL found';
    return res.status(500).json(checks);
  }

  try {
    // Use Neon's HTTP API directly — no SDK needed
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
  // Convert postgres:// connection string to Neon HTTP endpoint
  const url = new URL(connectionString);
  const host = url.hostname;
  const endpoint = `https://${host}/sql`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${url.password}`,
      'Neon-Connection-String': connectionString,
    },
    body: JSON.stringify({ query, params }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Neon HTTP error ${response.status}: ${text}`);
  }
  return response.json();
}
