/**
 * api/pipeline.js
 * Property pipeline CRUD using Neon HTTP API — no npm packages required.
 */

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const dbUrl = process.env.pipeline_POSTGRES_URL
    || process.env.pipeline_DATABASE_URL
    || process.env.PIPELINE_POSTGRES_URL
    || process.env.PIPELINE_DATABASE_URL
    || process.env.POSTGRES_URL
    || process.env.DATABASE_URL;

  if (!dbUrl) {
    return res.status(500).json({ error: 'No database URL found in environment variables' });
  }

  const sql = (query, params) => neonQuery(dbUrl, query, params);

  // Auto-create table
  try {
    await sql(`
      CREATE TABLE IF NOT EXISTS pipeline (
        id         TEXT PRIMARY KEY,
        data       JSONB NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
  } catch (err) {
    return res.status(500).json({ error: 'DB init failed', detail: err.message });
  }

  // GET — return all entries
  if (req.method === 'GET') {
    try {
      const result = await sql(`SELECT id, data FROM pipeline ORDER BY (data->>'addedAt') ASC`);
      const out = {};
      (result.rows || []).forEach(row => { out[row.id] = row.data; });
      return res.status(200).json(out);
    } catch (err) {
      return res.status(500).json({ error: 'Read failed', detail: err.message });
    }
  }

  // POST — upsert one entry
  if (req.method === 'POST') {
    const { id, data } = req.body || {};
    if (!id || !data) return res.status(400).json({ error: 'id and data required' });
    try {
      await sql(
        `INSERT INTO pipeline (id, data, updated_at)
         VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
        [id, JSON.stringify(data)]
      );
      return res.status(200).json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: 'Write failed', detail: err.message });
    }
  }

  // DELETE — remove one entry
  if (req.method === 'DELETE') {
    const id = req.query.id;
    if (!id) return res.status(400).json({ error: 'id required' });
    try {
      await sql(`DELETE FROM pipeline WHERE id = $1`, [id]);
      return res.status(200).json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: 'Delete failed', detail: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

async function neonQuery(connectionString, query, params = []) {
  const url = new URL(connectionString);
  const host = url.hostname;
  const user = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);

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
