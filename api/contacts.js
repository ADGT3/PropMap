/**
 * api/contacts.js
 * CRM Contacts CRUD — Neon Postgres
 *
 * Contacts
 * GET    /api/contacts                     → list all (with org, linked pipeline ids)
 * GET    /api/contacts?id=1                → single contact
 * GET    /api/contacts?search=jones        → search by name / email / org
 * GET    /api/contacts?pipeline_id=x       → contacts linked to a pipeline item
 * GET    /api/contacts?check_duplicate=1&first_name=x&last_name=y&email=z&mobile=m → duplicate check
 * POST   /api/contacts                     → create contact
 * PUT    /api/contacts                     → update contact
 * DELETE /api/contacts?id=1               → delete contact
 *
 * Link / unlink:
 * POST   /api/contacts { action:'link',   contact_id, pipeline_id, role }
 * POST   /api/contacts { action:'unlink', contact_id, pipeline_id }
 *
 * Organisations
 * GET    /api/contacts?orgs=1             → list all orgs
 * GET    /api/contacts?org_search=name    → search orgs by name
 * POST   /api/contacts { action:'create_org', name, phone, email, website }
 *
 * Notes
 * GET    /api/contacts?notes=1&contact_id=x           → notes for a contact
 * GET    /api/contacts?notes=1&pipeline_id=x          → notes for a pipeline item
 * POST   /api/contacts { action:'add_note', contact_id, pipeline_id, note_text }
 * DELETE /api/contacts?note_id=x                      → delete a note
 */

import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.POSTGRES_URL);

const CONTACT_SELECT = sql`
  SELECT c.*,
    o.name AS org_name,
    o.phone AS org_phone,
    o.email AS org_email,
    o.website AS org_website,
    COALESCE(
      json_agg(json_build_object('pipeline_id', cp.pipeline_id, 'role', cp.role))
      FILTER (WHERE cp.pipeline_id IS NOT NULL), '[]'
    ) AS properties
  FROM contacts c
  LEFT JOIN organisations o ON o.id = c.organisation_id
  LEFT JOIN contact_properties cp ON cp.contact_id = c.id`;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    switch (req.method) {

      // ── GET ──────────────────────────────────────────────────────────────────
      case 'GET': {
        const { id, search, pipeline_id, check_duplicate, orgs, org_search, notes, contact_id, all, all_orgs, contact_properties, offset, limit } = req.query;

        // All organisations with contact count
        if (all_orgs) {
          const q = org_search ? `%${org_search}%` : null;
          const rows = q
            ? await sql`
                SELECT o.*, COUNT(c.id)::int AS contact_count
                FROM organisations o
                LEFT JOIN contacts c ON c.organisation_id = o.id
                WHERE o.name ILIKE ${q}
                GROUP BY o.id ORDER BY o.name`
            : await sql`
                SELECT o.*, COUNT(c.id)::int AS contact_count
                FROM organisations o
                LEFT JOIN contacts c ON c.organisation_id = o.id
                GROUP BY o.id ORDER BY o.name`;
          return res.status(200).json(rows);
        }

        // Contacts belonging to an organisation
        if (req.query.org_contacts) {
          const orgId = parseInt(req.query.org_contacts);
          const rows = await sql`
            SELECT c.*, o.name AS org_name
            FROM contacts c
            LEFT JOIN organisations o ON o.id = c.organisation_id
            WHERE c.organisation_id = ${orgId}
            ORDER BY c.last_name, c.first_name`;
          return res.status(200).json(rows);
        }

        // All pipeline properties for note association dropdown
        if (req.query.pipeline_list) {
          try {
            const rows = await sql`
              SELECT id,
                COALESCE(data->>'address', id::text) AS address,
                COALESCE(data->>'suburb', '') AS suburb
              FROM pipeline
              ORDER BY data->>'address' NULLS LAST
              LIMIT 500`;
            return res.status(200).json(rows);
          } catch (e) {
            return res.status(200).json([]);
          }
        }

        // Properties linked to a contact
        if (contact_properties) {
          if (!contact_id) return res.status(400).json({ error: 'contact_id required' });
          const rows = await sql`
            SELECT cp.pipeline_id, cp.role,
              COALESCE(p.data->>'address', cp.pipeline_id) AS address,
              p.data->>'suburb' AS suburb
            FROM contact_properties cp
            LEFT JOIN pipeline p ON p.id = cp.pipeline_id
            WHERE cp.contact_id = ${parseInt(contact_id)}
            ORDER BY cp.created_at DESC`;
          return res.status(200).json(rows);
        }

        // List / search organisations
        if (orgs) {
          const rows = await sql`SELECT * FROM organisations ORDER BY name`;
          return res.status(200).json(rows);
        }
        if (org_search) {
          const q = `%${org_search}%`;
          const rows = await sql`
            SELECT * FROM organisations WHERE name ILIKE ${q} ORDER BY name LIMIT 20`;
          return res.status(200).json(rows);
        }

        // Notes
        if (notes) {
          const { note_id } = req.query;
          if (contact_id) {
            const rows = await sql`
              SELECT n.*, p.data->>'address' AS property_address
              FROM contact_notes n
              LEFT JOIN pipeline p ON p.id = n.pipeline_id
              WHERE n.contact_id = ${parseInt(contact_id)}
              ORDER BY n.created_at DESC`;
            return res.status(200).json(rows);
          }
          if (pipeline_id) {
            const rows = await sql`
              SELECT n.*, c.first_name, c.last_name
              FROM contact_notes n
              JOIN contacts c ON c.id = n.contact_id
              WHERE n.pipeline_id = ${pipeline_id}
              ORDER BY n.created_at DESC`;
            return res.status(200).json(rows);
          }
          return res.status(400).json({ error: 'contact_id or pipeline_id required' });
        }

        // Duplicate check
        if (check_duplicate) {
          const { first_name, last_name, email, mobile } = req.query;
          if (!email?.trim() && !mobile?.trim() && !(first_name?.trim() && last_name?.trim())) {
            return res.status(200).json([]);
          }
          // Build safe OR conditions using parameterised sub-queries
          const results = new Map();
          const addResults = (rows) => rows.forEach(r => results.set(r.id, r));
          await Promise.all([
            email?.trim() ? sql`
              SELECT c.*, o.name AS org_name FROM contacts c
              LEFT JOIN organisations o ON o.id = c.organisation_id
              WHERE c.email ILIKE ${email.trim()} LIMIT 5`.then(addResults) : null,
            mobile?.trim() ? sql`
              SELECT c.*, o.name AS org_name FROM contacts c
              LEFT JOIN organisations o ON o.id = c.organisation_id
              WHERE c.mobile ILIKE ${mobile.trim()} LIMIT 5`.then(addResults) : null,
            (first_name?.trim() && last_name?.trim()) ? sql`
              SELECT c.*, o.name AS org_name FROM contacts c
              LEFT JOIN organisations o ON o.id = c.organisation_id
              WHERE c.first_name ILIKE ${first_name.trim()} AND c.last_name ILIKE ${last_name.trim()} LIMIT 5`.then(addResults) : null,
          ].filter(Boolean));
          return res.status(200).json([...results.values()].slice(0, 5));
        }

        // Single contact
        if (id) {
          const rows = await sql`
            SELECT c.*, o.name AS org_name, o.phone AS org_phone, o.email AS org_email, o.website AS org_website,
              COALESCE(
                json_agg(json_build_object('pipeline_id', cp.pipeline_id, 'role', cp.role))
                FILTER (WHERE cp.pipeline_id IS NOT NULL), '[]'
              ) AS properties
            FROM contacts c
            LEFT JOIN organisations o ON o.id = c.organisation_id
            LEFT JOIN contact_properties cp ON cp.contact_id = c.id
            WHERE c.id = ${parseInt(id)}
            GROUP BY c.id, o.id`;
          if (!rows.length) return res.status(404).json({ error: 'Not found' });
          return res.status(200).json(rows[0]);
        }

        // Contacts linked to a pipeline item
        if (pipeline_id) {
          const rows = await sql`
            SELECT c.*, o.name AS org_name, cp.role
            FROM contacts c
            LEFT JOIN organisations o ON o.id = c.organisation_id
            JOIN contact_properties cp ON cp.contact_id = c.id
            WHERE cp.pipeline_id = ${pipeline_id}
            ORDER BY c.last_name, c.first_name`;
          return res.status(200).json(rows);
        }

        // All contacts — paginated, for CRM view
        if (all) {
          const lim = Math.min(parseInt(limit) || 30, 100);
          const off = parseInt(offset) || 0;
          if (search) {
            const q = `%${search}%`;
            const rows = await sql`
              SELECT c.*, o.name AS org_name,
                COUNT(DISTINCT cp.pipeline_id)::int AS property_count
              FROM contacts c
              LEFT JOIN organisations o ON o.id = c.organisation_id
              LEFT JOIN contact_properties cp ON cp.contact_id = c.id
              WHERE c.first_name ILIKE ${q} OR c.last_name ILIKE ${q}
                 OR c.email ILIKE ${q} OR c.mobile ILIKE ${q} OR o.name ILIKE ${q}
              GROUP BY c.id, o.id
              ORDER BY c.last_name, c.first_name`;
            const total = rows.length;
            return res.status(200).json({ contacts: rows.slice(off, off + lim), total });
          }
          const rows = await sql`
            SELECT c.*, o.name AS org_name,
              COUNT(DISTINCT cp.pipeline_id)::int AS property_count
            FROM contacts c
            LEFT JOIN organisations o ON o.id = c.organisation_id
            LEFT JOIN contact_properties cp ON cp.contact_id = c.id
            GROUP BY c.id, o.id
            ORDER BY c.last_name, c.first_name`;
          const total = rows.length;
          return res.status(200).json({ contacts: rows.slice(off, off + lim), total });
        }

        // List all (unpaginated — used by existing search/link flows)
        if (search) {
          const q = `%${search}%`;
          const rows = await sql`
            SELECT c.*, o.name AS org_name,
              COALESCE(
                json_agg(json_build_object('pipeline_id', cp.pipeline_id, 'role', cp.role))
                FILTER (WHERE cp.pipeline_id IS NOT NULL), '[]'
              ) AS properties
            FROM contacts c
            LEFT JOIN organisations o ON o.id = c.organisation_id
            LEFT JOIN contact_properties cp ON cp.contact_id = c.id
            WHERE c.first_name ILIKE ${q}
               OR c.last_name  ILIKE ${q}
               OR c.email      ILIKE ${q}
               OR c.mobile     ILIKE ${q}
               OR o.name       ILIKE ${q}
            GROUP BY c.id, o.id
            ORDER BY c.last_name, c.first_name
            LIMIT 50`;
          return res.status(200).json(rows);
        }

        // List all
        const rows = await sql`
          SELECT c.*, o.name AS org_name,
            COALESCE(
              json_agg(json_build_object('pipeline_id', cp.pipeline_id, 'role', cp.role))
              FILTER (WHERE cp.pipeline_id IS NOT NULL), '[]'
            ) AS properties
          FROM contacts c
          LEFT JOIN organisations o ON o.id = c.organisation_id
          LEFT JOIN contact_properties cp ON cp.contact_id = c.id
          GROUP BY c.id, o.id
          ORDER BY c.last_name, c.first_name`;
        return res.status(200).json(rows);
      }

      // ── POST ─────────────────────────────────────────────────────────────────
      case 'POST': {
        const body = req.body;

        // Create organisation
        if (body.action === 'create_org') {
          const { name, phone = '', email = '', website = '' } = body;
          if (!name?.trim()) return res.status(400).json({ error: 'name required' });
          const rows = await sql`
            INSERT INTO organisations (name, phone, email, website)
            VALUES (${name.trim()}, ${phone.trim()}, ${email.trim()}, ${website.trim()})
            ON CONFLICT DO NOTHING
            RETURNING *`;
          if (!rows.length) {
            const existing = await sql`SELECT * FROM organisations WHERE name ILIKE ${name.trim()} LIMIT 1`;
            return res.status(200).json(existing[0]);
          }
          return res.status(201).json(rows[0]);
        }

        // Set organisation on a contact
        if (body.action === 'set_org') {
          const { contact_id, organisation_id } = body;
          if (!contact_id) return res.status(400).json({ error: 'contact_id required' });
          const rows = await sql`
            UPDATE contacts SET organisation_id = ${organisation_id || null}, updated_at = now()
            WHERE id = ${parseInt(contact_id)} RETURNING *`;
          return res.status(200).json(rows[0]);
        }

        // Link
        if (body.action === 'link') {
          const { contact_id, pipeline_id, role = 'vendor' } = body;
          await sql`
            INSERT INTO contact_properties (contact_id, pipeline_id, role)
            VALUES (${contact_id}, ${pipeline_id}, ${role})
            ON CONFLICT (contact_id, pipeline_id) DO UPDATE SET role = EXCLUDED.role`;
          return res.status(200).json({ ok: true });
        }

        // Unlink
        if (body.action === 'unlink') {
          const { contact_id, pipeline_id } = body;
          await sql`
            DELETE FROM contact_properties
            WHERE contact_id = ${contact_id} AND pipeline_id = ${pipeline_id}`;
          return res.status(200).json({ ok: true });
        }

        // Add note
        if (body.action === 'add_note') {
          const { contact_id, pipeline_id = null, note_text } = body;
          if (!contact_id || !note_text?.trim()) return res.status(400).json({ error: 'contact_id and note_text required' });
          const rows = await sql`
            INSERT INTO contact_notes (contact_id, pipeline_id, note_text)
            VALUES (${contact_id}, ${pipeline_id}, ${note_text.trim()})
            RETURNING *`;
          return res.status(201).json(rows[0]);
        }

        // Create contact
        const { first_name, last_name = '', mobile = '', email = '', organisation_id = null, source = 'manual', domain_id = null } = body;
        if (!first_name?.trim()) return res.status(400).json({ error: 'first_name required' });
        const rows = await sql`
          INSERT INTO contacts (first_name, last_name, mobile, email, organisation_id, source, domain_id)
          VALUES (${first_name.trim()}, ${last_name.trim()}, ${mobile.trim()}, ${email.trim()}, ${organisation_id}, ${source}, ${domain_id})
          RETURNING *`;
        return res.status(201).json(rows[0]);
      }

      // ── PUT ──────────────────────────────────────────────────────────────────
      case 'PUT': {
        const { id, org_id, first_name, last_name, mobile, email, organisation_id, source, domain_id, name } = req.body;

        // Update organisation
        if (org_id) {
          if (!name?.trim()) return res.status(400).json({ error: 'name required' });
          const rows = await sql`
            UPDATE organisations SET name = ${name.trim()}
            WHERE id = ${parseInt(org_id)} RETURNING *`;
          if (!rows.length) return res.status(404).json({ error: 'Not found' });
          return res.status(200).json(rows[0]);
        }

        if (!id) return res.status(400).json({ error: 'id required' });
        const rows = await sql`
          UPDATE contacts SET
            first_name      = COALESCE(${first_name      ?? null}, first_name),
            last_name       = COALESCE(${last_name       ?? null}, last_name),
            mobile          = COALESCE(${mobile          ?? null}, mobile),
            email           = COALESCE(${email           ?? null}, email),
            organisation_id = COALESCE(${organisation_id ?? null}, organisation_id),
            source          = COALESCE(${source          ?? null}, source),
            domain_id       = COALESCE(${domain_id       ?? null}, domain_id),
            updated_at      = now()
          WHERE id = ${parseInt(id)}
          RETURNING *`;
        if (!rows.length) return res.status(404).json({ error: 'Not found' });
        return res.status(200).json(rows[0]);
      }

      // ── DELETE ───────────────────────────────────────────────────────────────
      case 'DELETE': {
        const { id, note_id, org_id } = req.query;
        if (note_id) {
          await sql`DELETE FROM contact_notes WHERE id = ${parseInt(note_id)}`;
          return res.status(200).json({ ok: true });
        }
        if (org_id) {
          await sql`DELETE FROM organisations WHERE id = ${parseInt(org_id)}`;
          return res.status(200).json({ ok: true });
        }
        if (!id) return res.status(400).json({ error: 'id required' });
        await sql`DELETE FROM contacts WHERE id = ${parseInt(id)}`;
        return res.status(200).json({ ok: true });
      }

      default:
        return res.status(405).json({ error: 'Method not allowed' });
    }
  } catch (err) {
    console.error('[contacts API]', err);
    return res.status(500).json({ error: err.message });
  }
}
