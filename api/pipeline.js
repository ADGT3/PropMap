import { neon } from '@neondatabase/serverless';

function getDb() {
  const url = process.env.pipeline_POSTGRES_URL
    || process.env.pipeline_DATABASE_URL
    || process.env.PIPELINE_POSTGRES_URL
    || process.env.PIPELINE_DATABASE_URL
    || process.env.POSTGRES_URL
    || process.env.DATABASE_URL;
  if (!url) throw new Error('No database URL found in environment variables');
  return neon(url);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  let sql;
  try {
    sql = getDb();
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  // Auto-create table
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS pipeline (
        id         TEXT PRIMARY KEY,
        data       JSONB NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;
  } catch (err) {
    return res.status(500).json({ error: 'DB init failed', detail: err.message });
  }

  // GET
  if (req.method === 'GET') {
    try {
      const rows = await sql`SELECT id, data FROM pipeline ORDER BY (data->>'addedAt') ASC`;
      const out = {};
      rows.forEach(row => { out[row.id] = row.data; });
      return res.status(200).json(out);
    } catch (err) {
      return res.status(500).json({ error: 'Read failed', detail: err.message });
    }
  }

  // POST
  if (req.method === 'POST') {
    const { id, data } = req.body || {};
    if (!id || !data) return res.status(400).json({ error: 'id and data required' });
    try {
      const dataJson = JSON.stringify(data);
      await sql`
        INSERT INTO pipeline (id, data, updated_at)
        VALUES (${id}, ${dataJson}::jsonb, NOW())
        ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()
      `;
      return res.status(200).json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: 'Write failed', detail: err.message });
    }
  }

  // DELETE
  if (req.method === 'DELETE') {
    const id = req.query.id;
    if (!id) return res.status(400).json({ error: 'id required' });
    try {
      await sql`DELETE FROM pipeline WHERE id = ${id}`;
      return res.status(200).json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: 'Delete failed', detail: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
