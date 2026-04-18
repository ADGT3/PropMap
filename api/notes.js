/**
 * api/notes.js — V75.3
 *
 * Unified notes endpoint. Replaces the notes handling in api/contacts.js
 * and the deals.data.notes JSONB array manipulation in the Kanban frontend.
 *
 * Schema (notes table):
 *   id, entity_type, entity_id, tagged_contact_id, note_text,
 *   author_id, author_name, created_at
 *
 * Routes:
 *   GET    /api/notes?entity_type=deal&entity_id=X
 *     → notes attached to that entity (chronological, newest first)
 *
 *   GET    /api/notes?tagged_contact_id=N
 *     → every note tagged to that contact, across all entities (with source info)
 *
 *   GET    /api/notes?by_contact=N
 *     → combined feed for a contact's CRM modal:
 *       - notes where entity_type='contact' AND entity_id=N
 *       - notes where tagged_contact_id=N
 *       (de-duplicated by id)
 *
 *   POST   /api/notes
 *     Body: { entity_type, entity_id, note_text, tagged_contact_id? }
 *     author_id/author_name are stamped server-side from session.
 *
 *   DELETE /api/notes?id=42
 *
 * Author stamping:
 *   - session.sub is the contact id (integer) OR 'fallback' for env-var admin
 *   - If integer → author_id = that id, author_name = session.name
 *   - If 'fallback' → author_id = NULL, author_name = 'Admin (fallback)' or session.name
 */

import { neon } from '@neondatabase/serverless';
import { requireSession } from '../lib/auth.js';
import { getDatabaseUrl } from '../lib/db.js';
const sql = neon(getDatabaseUrl());

// Resolve author_id/author_name from a session object. Handles the fallback
// admin (sub='fallback') where there's no matching contacts row.
function resolveAuthor(session) {
  if (!session) return { author_id: null, author_name: 'Unknown' };
  const sub = session.sub;
  const name = session.name || session.email || null;
  if (typeof sub === 'number' || (typeof sub === 'string' && /^\d+$/.test(sub))) {
    return { author_id: parseInt(sub, 10), author_name: name };
  }
  // Fallback admin or any non-numeric sub
  return { author_id: null, author_name: name || 'Admin (fallback)' };
}

// Enrich notes with source display info when listing for a contact's combined
// feed. For entity_type='deal' / 'property' we join to look up address.
async function enrichNotes(rows) {
  if (!rows.length) return rows;
  const dealIds = [...new Set(rows.filter(r => r.entity_type === 'deal').map(r => r.entity_id))];
  const propIds = [...new Set(rows.filter(r => r.entity_type === 'property').map(r => r.entity_id))];

  const dealMap = {};
  const propMap = {};
  if (dealIds.length) {
    const dealRows = await sql`
      SELECT d.id, p.address, p.suburb
      FROM deals d LEFT JOIN properties p ON p.id = d.property_id
      WHERE d.id = ANY(${dealIds})`;
    dealRows.forEach(r => { dealMap[r.id] = { address: r.address, suburb: r.suburb }; });
  }
  if (propIds.length) {
    const propRows = await sql`SELECT id, address, suburb FROM properties WHERE id = ANY(${propIds})`;
    propRows.forEach(r => { propMap[r.id] = { address: r.address, suburb: r.suburb }; });
  }

  return rows.map(r => {
    let source_label = null;
    if (r.entity_type === 'deal') {
      const m = dealMap[r.entity_id];
      source_label = m ? `Deal — ${m.address || r.entity_id}` : `Deal — ${r.entity_id}`;
    } else if (r.entity_type === 'property') {
      const m = propMap[r.entity_id];
      source_label = m ? `Property — ${m.address || r.entity_id}` : `Property — ${r.entity_id}`;
    } else if (r.entity_type === 'contact') {
      source_label = 'Contact';
    } else {
      source_label = r.entity_type;
    }
    return { ...r, source_label };
  });
}

export default async function handler(req, res) {
  const session = await requireSession(req, res);
  if (!session) return;

  try {
    if (req.method === 'GET')    return await handleGet(req, res);
    if (req.method === 'POST')   return await handlePost(req, res, session);
    if (req.method === 'DELETE') return await handleDelete(req, res);
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[api/notes]', err);
    return res.status(500).json({ error: err.message });
  }
}

async function handleGet(req, res) {
  const { entity_type, entity_id, tagged_contact_id, by_contact } = req.query;

  // Combined CRM contact-modal feed: contact-attached notes + tagged notes
  if (by_contact) {
    const cid = parseInt(by_contact, 10);
    const rows = await sql`
      SELECT n.*
      FROM notes n
      WHERE (n.entity_type = 'contact' AND n.entity_id = ${String(cid)})
         OR (n.tagged_contact_id = ${cid})
      ORDER BY n.created_at DESC`;
    const enriched = await enrichNotes(rows);
    return res.status(200).json(enriched);
  }

  // Simple entity-attached fetch
  if (entity_type && entity_id) {
    const rows = await sql`
      SELECT n.*,
        tc.first_name AS tagged_first_name,
        tc.last_name  AS tagged_last_name
      FROM notes n
      LEFT JOIN contacts tc ON tc.id = n.tagged_contact_id
      WHERE n.entity_type = ${entity_type} AND n.entity_id = ${String(entity_id)}
      ORDER BY n.created_at DESC`;
    return res.status(200).json(rows);
  }

  // By tagged contact only
  if (tagged_contact_id) {
    const tid = parseInt(tagged_contact_id, 10);
    const rows = await sql`
      SELECT n.* FROM notes n WHERE n.tagged_contact_id = ${tid}
      ORDER BY n.created_at DESC`;
    const enriched = await enrichNotes(rows);
    return res.status(200).json(enriched);
  }

  return res.status(400).json({ error: 'Specify entity_type+entity_id, tagged_contact_id, or by_contact' });
}

async function handlePost(req, res, session) {
  const { entity_type, entity_id, note_text, tagged_contact_id } = req.body || {};
  if (!entity_type || !entity_id || !note_text) {
    return res.status(400).json({ error: 'entity_type, entity_id, note_text required' });
  }
  const text = String(note_text).trim();
  if (!text) return res.status(400).json({ error: 'note_text is empty' });

  const { author_id, author_name } = resolveAuthor(session);
  const tagged = tagged_contact_id ? parseInt(tagged_contact_id, 10) : null;

  const rows = await sql`
    INSERT INTO notes (entity_type, entity_id, tagged_contact_id, note_text, author_id, author_name)
    VALUES (${entity_type}, ${String(entity_id)}, ${tagged}, ${text}, ${author_id}, ${author_name})
    RETURNING *`;
  return res.status(201).json(rows[0]);
}

async function handleDelete(req, res) {
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'id required' });
  await sql`DELETE FROM notes WHERE id = ${parseInt(id, 10)}`;
  return res.status(200).json({ ok: true });
}
