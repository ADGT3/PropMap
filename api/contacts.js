/**
 * api/contacts.js  (V75)
 * CRM Contacts CRUD backed by the new entity_contacts polymorphic link table.
 *
 * Frontend compatibility: legacy query params pipeline_id / contact_properties
 * are translated to entity_type='deal' lookups so V74 frontend code keeps working
 * during stage 1 of the V75 structural cutover. A new V75.0b frontend will
 * switch to the cleaner entity_type/entity_id interface.
 *
 * ── Contacts ───────────────────────────────────────────────────────────────
 * GET    /api/contacts                         -> list all (with org + links summary)
 * GET    /api/contacts?all=1                   -> paginated all (for CRM list)
 * GET    /api/contacts?id=X                    -> single contact (includes role links grouped)
 * GET    /api/contacts?search=jones            -> search name/email/org
 * GET    /api/contacts?check_duplicate=1&...   -> duplicate check
 * POST   /api/contacts                         -> create contact
 * PUT    /api/contacts                         -> update contact
 * DELETE /api/contacts?id=X                    -> delete contact
 *
 * ── Entity linking (polymorphic) ───────────────────────────────────────────
 * Preferred (V75):
 * POST   /api/contacts { action:'link',   contact_id, entity_type, entity_id, role_id }
 * POST   /api/contacts { action:'unlink', contact_id, entity_type, entity_id, role_id }
 * GET    /api/contacts?entity_type=deal&entity_id=X   -> contacts linked to that entity
 * GET    /api/contacts?contact_entities=1&contact_id=X -> all links for a contact, per entity
 *
 * Legacy (V74, still works):
 * POST   /api/contacts { action:'link',   contact_id, pipeline_id, role }   -> treated as deal link
 * POST   /api/contacts { action:'unlink', contact_id, pipeline_id }
 * GET    /api/contacts?pipeline_id=X                  -> treated as deal entity lookup
 * GET    /api/contacts?contact_properties=1&contact_id=X  -> lists all linked deals+properties
 *
 * ── Role helper ────────────────────────────────────────────────────────────
 * GET    /api/contacts?last_role=1&contact_id=X  -> most recent role_id across entity_contacts
 *
 * ── Organisations ──────────────────────────────────────────────────────────
 * GET    /api/contacts?orgs=1                         -> list
 * GET    /api/contacts?all_orgs=1[&org_search=X]      -> list with contact_count
 * GET    /api/contacts?org_contacts=ORGID             -> contacts in an org
 * POST   /api/contacts { action:'create_org', ... }   -> create org
 * POST   /api/contacts { action:'set_org', contact_id, organisation_id }
 * PUT    /api/contacts (org_id, name, phone, email, website)  -> update org
 * DELETE /api/contacts?org_id=X                       -> delete org
 *
 * ── Notes ──────────────────────────────────────────────────────────────────
 * GET    /api/contacts?notes=1&contact_id=X           -> notes for a contact
 * GET    /api/contacts?notes=1&pipeline_id=X          -> notes for a deal (legacy)
 * GET    /api/contacts?notes=1&entity_type=deal&entity_id=X  -> preferred
 * POST   /api/contacts { action:'add_note', contact_id, pipeline_id?, entity_type?, entity_id?, note_text }
 * DELETE /api/contacts?note_id=X
 *
 * ── Deal/property list for UI dropdowns ────────────────────────────────────
 * GET    /api/contacts?pipeline_list=1   -> [{id, address, suburb}] — deals across properties
 */

import { neon } from '@neondatabase/serverless';
import { requireSession } from '../lib/auth.js';
import { getDatabaseUrl } from '../lib/db.js';
const sql = neon(getDatabaseUrl());

// ── Helpers ────────────────────────────────────────────────────────────────
// Legacy rows from the old pipeline_id path are always deal-scoped links
function legacyPipelineToEntity(pipelineId) {
  return { entity_type: 'deal', entity_id: pipelineId };
}

export default async function handler(req, res) {
  const session = await requireSession(req, res);
  if (!session) return;

  try {
    switch (req.method) {

      // ══════════════════════════════════════════════════════════════════════
      case 'GET': {
        const {
          id, search, pipeline_id, check_duplicate,
          orgs, org_search, all_orgs, org_contacts,
          notes, contact_id, all, offset, limit,
          pipeline_list, contact_properties, contact_entities,
          entity_type, entity_id, last_role,
        } = req.query;

        // ── All orgs with contact count
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

        // ── Contacts in an org
        if (org_contacts) {
          const orgId = parseInt(org_contacts);
          const rows = await sql`
            SELECT c.*, o.name AS org_name
            FROM contacts c
            LEFT JOIN organisations o ON o.id = c.organisation_id
            WHERE c.organisation_id = ${orgId}
            ORDER BY c.last_name, c.first_name`;
          return res.status(200).json(rows);
        }

        // ── Pipeline (deal) list for dropdowns — V75 uses deals+properties
        if (pipeline_list) {
          try {
            const rows = await sql`
              SELECT d.id,
                COALESCE(p.address, d.id) AS address,
                COALESCE(p.suburb, '')    AS suburb,
                d.workflow, d.status
              FROM deals d
              LEFT JOIN properties p ON p.id = d.property_id
              ORDER BY p.address NULLS LAST
              LIMIT 500`;
            return res.status(200).json(rows);
          } catch (e) {
            return res.status(200).json([]);
          }
        }

        // ── Last role helper (used by link-default UX)
        if (last_role) {
          if (!contact_id) return res.status(400).json({ error: 'contact_id required' });
          const rows = await sql`
            SELECT role_id AS role FROM entity_contacts
            WHERE contact_id = ${parseInt(contact_id)}
            ORDER BY linked_at DESC LIMIT 1`;
          return res.status(200).json({ role: rows[0]?.role || null });
        }

        // ── All entity links for a contact
        if (contact_entities || contact_properties) {
          if (!contact_id) return res.status(400).json({ error: 'contact_id required' });
          // Return a list with property address etc enriched where possible
          const rows = await sql`
            SELECT ec.entity_type, ec.entity_id, ec.role_id AS role, ec.linked_at,
              CASE
                WHEN ec.entity_type = 'deal'     THEN COALESCE(p_via_deal.address,  ec.entity_id)
                WHEN ec.entity_type = 'property' THEN COALESCE(p_direct.address,    ec.entity_id)
                ELSE ec.entity_id
              END AS address,
              CASE
                WHEN ec.entity_type = 'deal'     THEN p_via_deal.suburb
                WHEN ec.entity_type = 'property' THEN p_direct.suburb
                ELSE NULL
              END AS suburb,
              CASE
                WHEN ec.entity_type = 'deal' THEN ec.entity_id
                ELSE NULL
              END AS pipeline_id
            FROM entity_contacts ec
            LEFT JOIN deals d ON d.id = ec.entity_id AND ec.entity_type = 'deal'
            LEFT JOIN properties p_via_deal ON p_via_deal.id = d.property_id
            LEFT JOIN properties p_direct   ON p_direct.id   = ec.entity_id AND ec.entity_type = 'property'
            WHERE ec.contact_id = ${parseInt(contact_id)}
            ORDER BY ec.linked_at DESC`;
          return res.status(200).json(rows);
        }

        // ── Notes
        if (notes) {
          const { note_id } = req.query;
          if (contact_id) {
            const rows = await sql`
              SELECT n.*,
                COALESCE(n.pipeline_id, n.entity_id) AS pipeline_id,
                p.address AS property_address
              FROM contact_notes n
              LEFT JOIN deals d       ON d.id = n.entity_id AND n.entity_type = 'deal'
              LEFT JOIN properties p  ON p.id = d.property_id
              WHERE n.contact_id = ${parseInt(contact_id)}
              ORDER BY n.created_at DESC`;
            return res.status(200).json(rows);
          }
          // By pipeline_id (legacy)  or  by entity_type+entity_id (preferred)
          const eType = entity_type || (pipeline_id ? 'deal' : null);
          const eId   = entity_id   || pipeline_id;
          if (eType && eId) {
            const rows = await sql`
              SELECT n.*, c.first_name, c.last_name
              FROM contact_notes n
              JOIN contacts c ON c.id = n.contact_id
              WHERE n.entity_type = ${eType} AND n.entity_id = ${eId}
              ORDER BY n.created_at DESC`;
            return res.status(200).json(rows);
          }
          return res.status(400).json({ error: 'contact_id or pipeline_id/entity_id required' });
        }

        // ── Duplicate check
        if (check_duplicate) {
          const { first_name, last_name, email, mobile } = req.query;
          if (!email?.trim() && !mobile?.trim() && !(first_name?.trim() && last_name?.trim())) {
            return res.status(200).json([]);
          }
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

        // ── Single contact
        if (id) {
          const rows = await sql`
            SELECT c.*, o.name AS org_name, o.phone AS org_phone, o.email AS org_email, o.website AS org_website,
              COALESCE(
                (SELECT json_agg(json_build_object(
                   'entity_type', ec.entity_type,
                   'entity_id',   ec.entity_id,
                   'role_id',     ec.role_id,
                   'linked_at',   ec.linked_at
                 )) FROM entity_contacts ec WHERE ec.contact_id = c.id),
                '[]'::json
              ) AS links,
              COALESCE(
                (SELECT json_agg(json_build_object('pipeline_id', ec.entity_id, 'role', ec.role_id))
                 FROM entity_contacts ec WHERE ec.contact_id = c.id AND ec.entity_type = 'deal'),
                '[]'::json
              ) AS properties
            FROM contacts c
            LEFT JOIN organisations o ON o.id = c.organisation_id
            WHERE c.id = ${parseInt(id)}`;
          if (!rows.length) return res.status(404).json({ error: 'Not found' });
          return res.status(200).json(rows[0]);
        }

        // ── Contacts linked to a pipeline/deal/property
        if (pipeline_id || (entity_type && entity_id)) {
          const eType = entity_type || 'deal';
          const eId   = entity_id   || pipeline_id;
          const rows = await sql`
            SELECT c.*, o.name AS org_name, ec.role_id AS role, ec.entity_type, ec.entity_id
            FROM entity_contacts ec
            JOIN contacts c ON c.id = ec.contact_id
            LEFT JOIN organisations o ON o.id = c.organisation_id
            WHERE ec.entity_type = ${eType} AND ec.entity_id = ${eId}
            ORDER BY c.last_name, c.first_name`;
          return res.status(200).json(rows);
        }

        // ── Paginated all (CRM list)
        if (all) {
          const lim = Math.min(parseInt(limit) || 30, 100);
          const off = parseInt(offset) || 0;
          if (search) {
            const q = `%${search}%`;
            const rows = await sql`
              SELECT c.*, o.name AS org_name,
                (SELECT COUNT(DISTINCT ec.entity_id)
                 FROM entity_contacts ec
                 WHERE ec.contact_id = c.id AND ec.entity_type = 'deal')::int AS property_count
              FROM contacts c
              LEFT JOIN organisations o ON o.id = c.organisation_id
              WHERE c.first_name ILIKE ${q} OR c.last_name ILIKE ${q}
                 OR c.email ILIKE ${q} OR c.mobile ILIKE ${q} OR o.name ILIKE ${q}
              ORDER BY c.last_name, c.first_name`;
            return res.status(200).json({ contacts: rows.slice(off, off + lim), total: rows.length });
          }
          const rows = await sql`
            SELECT c.*, o.name AS org_name,
              (SELECT COUNT(DISTINCT ec.entity_id)
               FROM entity_contacts ec
               WHERE ec.contact_id = c.id AND ec.entity_type = 'deal')::int AS property_count
            FROM contacts c
            LEFT JOIN organisations o ON o.id = c.organisation_id
            ORDER BY c.last_name, c.first_name`;
          return res.status(200).json({ contacts: rows.slice(off, off + lim), total: rows.length });
        }

        // ── Unpaginated list / search
        if (search) {
          const q = `%${search}%`;
          const rows = await sql`
            SELECT c.*, o.name AS org_name,
              COALESCE(
                (SELECT json_agg(json_build_object('pipeline_id', ec.entity_id, 'role', ec.role_id))
                 FROM entity_contacts ec WHERE ec.contact_id = c.id AND ec.entity_type = 'deal'),
                '[]'::json
              ) AS properties
            FROM contacts c
            LEFT JOIN organisations o ON o.id = c.organisation_id
            WHERE c.first_name ILIKE ${q}
               OR c.last_name  ILIKE ${q}
               OR c.email      ILIKE ${q}
               OR c.mobile     ILIKE ${q}
               OR o.name       ILIKE ${q}
            ORDER BY c.last_name, c.first_name
            LIMIT 50`;
          return res.status(200).json(rows);
        }

        if (orgs) {
          const rows = await sql`SELECT * FROM organisations ORDER BY name`;
          return res.status(200).json(rows);
        }

        // ── Default list (legacy unpaginated)
        const rows = await sql`
          SELECT c.*, o.name AS org_name,
            COALESCE(
              (SELECT json_agg(json_build_object('pipeline_id', ec.entity_id, 'role', ec.role_id))
               FROM entity_contacts ec WHERE ec.contact_id = c.id AND ec.entity_type = 'deal'),
              '[]'::json
            ) AS properties
          FROM contacts c
          LEFT JOIN organisations o ON o.id = c.organisation_id
          ORDER BY c.last_name, c.first_name`;
        return res.status(200).json(rows);
      }

      // ══════════════════════════════════════════════════════════════════════
      case 'POST': {
        const body = req.body || {};

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

        // ── Link (polymorphic, with legacy fallback)
        // V75.0d fix: enforce one-role-per-contact-per-entity. If a link for
        // the same (contact, entity) already exists with a different role, that
        // old link is removed first so this acts as "upsert by (contact, entity)".
        if (body.action === 'link') {
          let { contact_id, role, role_id, entity_type, entity_id, pipeline_id } = body;
          const roleId = role_id || role || 'vendor';
          if (!entity_type || !entity_id) {
            if (pipeline_id) {
              const mapped = legacyPipelineToEntity(pipeline_id);
              entity_type = mapped.entity_type;
              entity_id   = mapped.entity_id;
            } else {
              return res.status(400).json({ error: 'entity_type+entity_id or pipeline_id required' });
            }
          }
          // Remove any existing link for this (contact, entity) with a different role
          await sql`
            DELETE FROM entity_contacts
            WHERE contact_id  = ${contact_id}
              AND entity_type = ${entity_type}
              AND entity_id   = ${entity_id}
              AND role_id    <> ${roleId}`;
          // Insert (or no-op if exact same role already present)
          await sql`
            INSERT INTO entity_contacts (contact_id, entity_type, entity_id, role_id, linked_at)
            VALUES (${contact_id}, ${entity_type}, ${entity_id}, ${roleId}, now())
            ON CONFLICT (contact_id, entity_type, entity_id, role_id) DO NOTHING`;
          return res.status(200).json({ ok: true });
        }

        // ── Unlink
        if (body.action === 'unlink') {
          let { contact_id, role_id, entity_type, entity_id, pipeline_id } = body;
          if (!entity_type || !entity_id) {
            if (pipeline_id) {
              const mapped = legacyPipelineToEntity(pipeline_id);
              entity_type = mapped.entity_type;
              entity_id   = mapped.entity_id;
            } else {
              return res.status(400).json({ error: 'entity_type+entity_id or pipeline_id required' });
            }
          }
          if (role_id) {
            await sql`
              DELETE FROM entity_contacts
              WHERE contact_id = ${contact_id} AND entity_type = ${entity_type} AND entity_id = ${entity_id} AND role_id = ${role_id}`;
          } else {
            // Legacy behaviour — remove all roles for this contact on this entity
            await sql`
              DELETE FROM entity_contacts
              WHERE contact_id = ${contact_id} AND entity_type = ${entity_type} AND entity_id = ${entity_id}`;
          }
          return res.status(200).json({ ok: true });
        }

        // ── Add note
        if (body.action === 'add_note') {
          let { contact_id, pipeline_id = null, entity_type, entity_id, note_text } = body;
          if (!entity_type || !entity_id) {
            if (pipeline_id) { entity_type = 'deal'; entity_id = pipeline_id; }
          }
          if (!contact_id || !note_text?.trim()) return res.status(400).json({ error: 'contact_id and note_text required' });
          // Insert — pipeline_id column still exists for back-compat during transition
          const rows = await sql`
            INSERT INTO contact_notes (contact_id, pipeline_id, entity_type, entity_id, note_text)
            VALUES (${contact_id}, ${entity_id || null}, ${entity_type || null}, ${entity_id || null}, ${note_text.trim()})
            RETURNING *`;
          return res.status(201).json(rows[0]);
        }

        // ── Create contact
        const { first_name, last_name = '', mobile = '', email = '', organisation_id = null, source = 'manual', domain_id = null } = body;
        if (!first_name?.trim()) return res.status(400).json({ error: 'first_name required' });
        const rows = await sql`
          INSERT INTO contacts (first_name, last_name, mobile, email, organisation_id, source, domain_id)
          VALUES (${first_name.trim()}, ${last_name.trim()}, ${mobile.trim()}, ${email.trim()}, ${organisation_id}, ${source}, ${domain_id})
          RETURNING *`;
        return res.status(201).json(rows[0]);
      }

      // ══════════════════════════════════════════════════════════════════════
      case 'PUT': {
        const { id, org_id, first_name, last_name, mobile, email, organisation_id, source, domain_id, name, phone, website } = req.body;

        // Update organisation
        if (org_id) {
          if (!name?.trim()) return res.status(400).json({ error: 'name required' });
          const rows = await sql`
            UPDATE organisations SET
              name       = ${name.trim()},
              phone      = COALESCE(${phone   ?? null}, phone),
              email      = COALESCE(${email   ?? null}, email),
              website    = COALESCE(${website ?? null}, website),
              updated_at = now()
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

      // ══════════════════════════════════════════════════════════════════════
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
        res.setHeader('Allow', 'GET, POST, PUT, DELETE');
        return res.status(405).json({ error: 'Method not allowed' });
    }
  } catch (err) {
    console.error('[contacts API V75]', err);
    return res.status(500).json({ error: err.message });
  }
}
