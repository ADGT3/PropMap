/**
 * api/notes.js — V75.3, extended in V77.1
 *
 * Unified notes endpoint. Replaces the notes handling in api/contacts.js
 * and the deals.data.notes JSONB array manipulation in the Kanban frontend.
 *
 * Schema (notes table):
 *   id, entity_type, entity_id, tagged_contact_id, note_text,
 *   interaction_type (V77.1, NOT NULL DEFAULT 'file_note', FK → interaction_types),
 *   source           (V77.1, nullable, FK → contact_sources),
 *   author_id, author_name, created_at
 *
 * V77.1 rules:
 *   - interaction_type defaults to 'file_note' on POST when not provided
 *   - source is only valid when interaction_type direction is 'inbound'
 *     (POST/PUT silently NULLs source if interaction is outbound/internal)
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
 *     Body: { entity_type, entity_id, note_text, tagged_contact_id?,
 *             interaction_type?, source? }
 *     author_id/author_name are stamped server-side from session.
 *
 *   PUT    /api/notes
 *     Body: { id, note_text?, interaction_type?, source?, tagged_contact_id? }
 *     V77.1 — added so users can edit interaction_type / source after creation.
 *
 *   DELETE /api/notes?id=42
 *
 * Author stamping:
 *   - session.sub is the contact id (integer) OR 'fallback' for env-var admin
 *   - If integer → author_id = that id, author_name = session.name
 *   - If 'fallback' → author_id = NULL, author_name = 'Admin (fallback)' or session.name
 */

import { neon } from '@neondatabase/serverless';
import { requireSession, requireAnyModule } from '../lib/auth.js';
import { getDatabaseUrl } from '../lib/db.js';
import { titleForParcel } from '../lib/parcel-title.js';
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

// V77.1 — validate and normalise the interaction_type / source pair.
// Returns { interaction_type, source, error? }.
//   - interaction_type defaults to 'file_note' if undefined or empty
//   - both ids must exist in their respective lookup tables
//   - source is silently NULLed when the resolved interaction is not 'inbound'
async function resolveInteractionAndSource(rawType, rawSource) {
  const type = (rawType && String(rawType).trim()) || 'file_note';
  const typeRow = await sql`SELECT id, direction FROM interaction_types WHERE id = ${type}`;
  if (!typeRow.length) {
    return { error: `Unknown interaction_type '${type}'` };
  }
  let source = (rawSource && String(rawSource).trim()) || null;
  if (source) {
    // Only inbound interactions carry a source — silently drop otherwise
    if (typeRow[0].direction !== 'inbound') {
      source = null;
    } else {
      const srcRow = await sql`SELECT id FROM contact_sources WHERE id = ${source}`;
      if (!srcRow.length) {
        return { error: `Unknown source '${source}'` };
      }
    }
  }
  return { interaction_type: type, source };
}

// Enrich notes with source display info when listing for a contact's combined
// feed. V75.4: now handles parcel entities and deals-on-parcels.
async function enrichNotes(rows) {
  if (!rows.length) return rows;
  const dealIds   = [...new Set(rows.filter(r => r.entity_type === 'deal').map(r => r.entity_id))];
  const propIds   = [...new Set(rows.filter(r => r.entity_type === 'property').map(r => r.entity_id))];
  const parcelIds = [...new Set(rows.filter(r => r.entity_type === 'parcel').map(r => r.entity_id))];

  const dealMap   = {};
  const propMap   = {};
  const parcelMap = {};
  if (dealIds.length) {
    // Deal row may be on a property OR a parcel; fetch both and pick whichever is set
    const dealRows = await sql`
      SELECT d.id,
             p.address  AS prop_address,  p.suburb AS prop_suburb,
             pa.name    AS parcel_name
      FROM deals d
      LEFT JOIN properties p  ON p.id  = d.property_id
      LEFT JOIN parcels    pa ON pa.id = d.parcel_id
      WHERE d.id = ANY(${dealIds})`;
    dealRows.forEach(r => {
      dealMap[r.id] = {
        address: r.prop_address || r.parcel_name,
        suburb:  r.prop_suburb  || null,
      };
    });
  }
  if (propIds.length) {
    const propRows = await sql`SELECT id, address, suburb FROM properties WHERE id = ANY(${propIds})`;
    propRows.forEach(r => { propMap[r.id] = { address: r.address, suburb: r.suburb }; });
  }
  if (parcelIds.length) {
    // V78i.4 — Use the shared formatter for parcel source labels so they
    // match the deal modal / popup display. Previously read stale parcels.name.
    const parcelRows = await sql`SELECT id FROM parcels WHERE id = ANY(${parcelIds})`;
    for (const r of parcelRows) {
      const title = await titleForParcel(sql, r.id);
      parcelMap[r.id] = { name: title };
    }
  }

  return rows.map(r => {
    let source_label = null;
    if (r.entity_type === 'deal') {
      const m = dealMap[r.entity_id];
      source_label = m ? `Deal — ${m.address || r.entity_id}` : `Deal — ${r.entity_id}`;
    } else if (r.entity_type === 'property') {
      const m = propMap[r.entity_id];
      source_label = m ? `Property — ${m.address || r.entity_id}` : `Property — ${r.entity_id}`;
    } else if (r.entity_type === 'parcel') {
      const m = parcelMap[r.entity_id];
      source_label = m ? `Parcel — ${m.name || r.entity_id}` : `Parcel — ${r.entity_id}`;
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
  if (!requireAnyModule(session, res, ['crm', 'pipeline'])) return;

  try {
    if (req.method === 'GET')    return await handleGet(req, res);
    if (req.method === 'POST')   return await handlePost(req, res, session);
    if (req.method === 'PUT')    return await handlePut(req, res);
    if (req.method === 'DELETE') return await handleDelete(req, res);
    res.setHeader('Allow', 'GET, POST, PUT, DELETE');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[api/notes]', err);
    return res.status(500).json({ error: err.message });
  }
}

async function handleGet(req, res) {
  const { entity_type, entity_id, tagged_contact_id, by_contact } = req.query;

  // V77.1 — common SELECT clause with interaction_type and source labels joined in.
  // Used by all three GET variants below.
  // Returns: all note columns + interaction_type_label, interaction_direction, source_label_text

  // Combined CRM contact-modal feed: contact-attached notes + tagged notes
  if (by_contact) {
    const cid = parseInt(by_contact, 10);
    const rows = await sql`
      SELECT n.*,
        it.label     AS interaction_type_label,
        it.direction AS interaction_direction,
        cs.label     AS source_label_text
      FROM notes n
      LEFT JOIN interaction_types it ON it.id = n.interaction_type
      LEFT JOIN contact_sources    cs ON cs.id = n.source
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
        tc.last_name  AS tagged_last_name,
        it.label      AS interaction_type_label,
        it.direction  AS interaction_direction,
        cs.label      AS source_label_text
      FROM notes n
      LEFT JOIN contacts          tc ON tc.id = n.tagged_contact_id
      LEFT JOIN interaction_types it ON it.id = n.interaction_type
      LEFT JOIN contact_sources   cs ON cs.id = n.source
      WHERE n.entity_type = ${entity_type} AND n.entity_id = ${String(entity_id)}
      ORDER BY n.created_at DESC`;
    return res.status(200).json(rows);
  }

  // By tagged contact only
  if (tagged_contact_id) {
    const tid = parseInt(tagged_contact_id, 10);
    const rows = await sql`
      SELECT n.*,
        it.label     AS interaction_type_label,
        it.direction AS interaction_direction,
        cs.label     AS source_label_text
      FROM notes n
      LEFT JOIN interaction_types it ON it.id = n.interaction_type
      LEFT JOIN contact_sources    cs ON cs.id = n.source
      WHERE n.tagged_contact_id = ${tid}
      ORDER BY n.created_at DESC`;
    const enriched = await enrichNotes(rows);
    return res.status(200).json(enriched);
  }

  return res.status(400).json({ error: 'Specify entity_type+entity_id, tagged_contact_id, or by_contact' });
}

async function handlePost(req, res, session) {
  const {
    entity_type, entity_id, note_text, tagged_contact_id,
    interaction_type, source,
  } = req.body || {};
  if (!entity_type || !entity_id || !note_text) {
    return res.status(400).json({ error: 'entity_type, entity_id, note_text required' });
  }
  const text = String(note_text).trim();
  if (!text) return res.status(400).json({ error: 'note_text is empty' });

  // V77.1 — resolve interaction_type/source pair (defaults file_note, validates lookup ids,
  // NULLs source for non-inbound interactions)
  const resolved = await resolveInteractionAndSource(interaction_type, source);
  if (resolved.error) return res.status(400).json({ error: resolved.error });

  const { author_id, author_name } = resolveAuthor(session);
  const tagged = tagged_contact_id ? parseInt(tagged_contact_id, 10) : null;

  const rows = await sql`
    INSERT INTO notes (
      entity_type, entity_id, tagged_contact_id, note_text,
      interaction_type, source,
      author_id, author_name
    )
    VALUES (
      ${entity_type}, ${String(entity_id)}, ${tagged}, ${text},
      ${resolved.interaction_type}, ${resolved.source},
      ${author_id}, ${author_name}
    )
    RETURNING *`;
  return res.status(201).json(rows[0]);
}

// V77.1 — PUT handler. Lets users edit an existing note's text, type, source,
// or tagged contact. Author/created_at remain unchanged.
//
// Approach: fetch the existing row, apply only the supplied fields in JS,
// then write back. Avoids the awkward conditional-SQL needed to make COALESCE
// work cleanly across all our optional fields.
async function handlePut(req, res) {
  const body = req.body || {};
  const id = body.id;
  if (!id) return res.status(400).json({ error: 'id required' });

  const noteId = parseInt(id, 10);
  const existing = await sql`SELECT * FROM notes WHERE id = ${noteId}`;
  if (!existing.length) return res.status(404).json({ error: 'Not found' });
  const cur = existing[0];

  // note_text
  let nextText = cur.note_text;
  if (body.note_text !== undefined) {
    nextText = String(body.note_text).trim();
    if (!nextText) return res.status(400).json({ error: 'note_text cannot be empty' });
  }

  // tagged_contact_id — accept null/undefined/integer
  let nextTagged = cur.tagged_contact_id;
  if (body.tagged_contact_id !== undefined) {
    nextTagged = body.tagged_contact_id === null
      ? null
      : parseInt(body.tagged_contact_id, 10);
  }

  // interaction_type / source — resolve as a pair if either is touched
  let nextType   = cur.interaction_type;
  let nextSource = cur.source;
  if (body.interaction_type !== undefined || body.source !== undefined) {
    const useType   = body.interaction_type !== undefined ? body.interaction_type : cur.interaction_type;
    const useSource = body.source           !== undefined ? body.source           : cur.source;
    const resolved = await resolveInteractionAndSource(useType, useSource);
    if (resolved.error) return res.status(400).json({ error: resolved.error });
    nextType   = resolved.interaction_type;
    nextSource = resolved.source;
  }

  const rows = await sql`
    UPDATE notes SET
      note_text         = ${nextText},
      tagged_contact_id = ${nextTagged},
      interaction_type  = ${nextType},
      source            = ${nextSource}
    WHERE id = ${noteId}
    RETURNING *`;
  return res.status(200).json(rows[0]);
}

async function handleDelete(req, res) {
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'id required' });
  await sql`DELETE FROM notes WHERE id = ${parseInt(id, 10)}`;
  return res.status(200).json({ ok: true });
}
