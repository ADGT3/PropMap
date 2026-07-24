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
 * GET    /api/contacts?all_orgs=1                  -> all orgs, with contact_count
 * GET    /api/contacts?org_search=X                 -> orgs matching X (with contact_count)
 * GET    /api/contacts?org_contacts=ORGID             -> contacts in an org
 * POST   /api/contacts { action:'create_org', ... }   -> create org
 * POST   /api/contacts { action:'set_org', contact_id, organisation_id }
 * PUT    /api/contacts (org_id, name, phone, email, website)  -> update org
 * DELETE /api/contacts?org_id=X                       -> delete org
 *
 * ── Notes (V75.3: MOVED to /api/notes) ────────────────────────────────────
 * All note routes (?notes=1, action=add_note, ?note_id=X) return 410 Gone
 * with a redirect hint. See /api/notes.js for the replacement endpoint.
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

        // ── Org list / org search
        // V76.4: `org_search=q` alone is sufficient — it always returns
        // organisations matching `q`. `all_orgs=1` alone returns the full
        // unfiltered list. No coupling rule: each parameter does what its
        // name implies. The previous contract required `all_orgs=1` to be
        // set even for searches, which was non-obvious and caused callers
        // to fall through to the default contact list when they forgot.
        if (org_search || all_orgs) {
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
          // V75.4: now supports entity_type='parcel' links too, and deals that
          // target a parcel instead of a property. For deals-on-parcels, the
          // address is derived from the parcel's name (set at creation to the
          // merged title).
          const rows = await sql`
            SELECT ec.entity_type, ec.entity_id, ec.role_id AS role, ec.linked_at,
              CASE
                WHEN ec.entity_type = 'deal' AND d.property_id IS NOT NULL THEN COALESCE(p_via_deal.address, ec.entity_id)
                WHEN ec.entity_type = 'deal' AND d.parcel_id   IS NOT NULL THEN COALESCE(pa_via_deal.name, ec.entity_id)
                WHEN ec.entity_type = 'property' THEN COALESCE(p_direct.address, ec.entity_id)
                WHEN ec.entity_type = 'parcel'   THEN COALESCE(pa_direct.name,  ec.entity_id)
                ELSE ec.entity_id
              END AS address,
              CASE
                WHEN ec.entity_type = 'deal' AND d.property_id IS NOT NULL THEN p_via_deal.suburb
                WHEN ec.entity_type = 'property' THEN p_direct.suburb
                ELSE NULL
              END AS suburb,
              CASE
                WHEN ec.entity_type = 'deal' THEN ec.entity_id
                ELSE NULL
              END AS pipeline_id,
              d.workflow AS workflow,
              d.stage    AS stage,
              d.status   AS deal_status
            FROM entity_contacts ec
            LEFT JOIN deals d ON d.id = ec.entity_id AND ec.entity_type = 'deal'
            LEFT JOIN properties p_via_deal  ON p_via_deal.id  = d.property_id
            LEFT JOIN parcels    pa_via_deal ON pa_via_deal.id = d.parcel_id
            LEFT JOIN properties p_direct    ON p_direct.id    = ec.entity_id AND ec.entity_type = 'property'
            LEFT JOIN parcels    pa_direct   ON pa_direct.id   = ec.entity_id AND ec.entity_type = 'parcel'
            WHERE ec.contact_id = ${parseInt(contact_id)}
            ORDER BY ec.linked_at DESC`;
          return res.status(200).json(rows);
        }

        // ── Notes (V75.3: moved to /api/notes) ─────────────────────────────
        // Return 410 Gone with a hint so any lingering callers notice.
        if (notes) {
          return res.status(410).json({
            error: 'Notes moved to /api/notes in V75.3',
            hint:  'Use GET /api/notes?entity_type=X&entity_id=Y, or ?by_contact=N for a combined contact feed',
          });
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
          // V77.2g — ordered by linked_at ASC so callers that rely on
          // "the first linked contact is the enquirer/primary" (per Wave 2B's
          // creation flow) get deterministic ordering.
          const rows = await sql`
            SELECT c.*, o.name AS org_name, ec.role_id AS role, ec.entity_type, ec.entity_id, ec.linked_at
            FROM entity_contacts ec
            JOIN contacts c ON c.id = ec.contact_id
            LEFT JOIN organisations o ON o.id = c.organisation_id
            WHERE ec.entity_type = ${eType} AND ec.entity_id = ${eId}
            ORDER BY ec.linked_at ASC, c.last_name, c.first_name`;
          return res.status(200).json(rows);
        }

        // ── Paginated all (CRM list)
        if (all) {
          const lim = Math.min(parseInt(limit) || 50, 500);
          const off = parseInt(offset) || 0;
          if (search) {
            // Parse field-scoped syntax: category=edan, role=vendor, discipline=builder
            // Matches pipeline search convention. Unrecognised fields fall through to free-text.
            const fieldMatch = search.match(/^(categories?|role|discipline|org|organisation|mobile|email)\s*=\s*(.+)$/i);
            let countRows, rows;

            if (fieldMatch) {
              const field = fieldMatch[1].toLowerCase();
              const val   = fieldMatch[2].trim();
              const q = `%${val}%`;

              if (field === 'category' || field === 'categories') {
                countRows = await sql`
                  SELECT COUNT(DISTINCT c.id)::int AS total FROM contacts c
                  JOIN contact_marketing_categories cmc ON cmc.contact_id = c.id
                  WHERE cmc.category ILIKE ${q}`;
                rows = await sql`
                  SELECT c.*, o.name AS org_name,
                    (SELECT COUNT(DISTINCT ec.entity_id) FROM entity_contacts ec WHERE ec.contact_id = c.id AND ec.entity_type = 'deal')::int AS property_count,
                    (SELECT STRING_AGG(DISTINCT r.label, ', ' ORDER BY r.label) FROM entity_contacts ec2 JOIN roles r ON r.id = ec2.role_id WHERE ec2.contact_id = c.id) AS roles_label,
                    (SELECT STRING_AGG(DISTINCT cmc2.category, ', ' ORDER BY cmc2.category) FROM contact_marketing_categories cmc2 WHERE cmc2.contact_id = c.id) AS categories_label
                  FROM contacts c
                  LEFT JOIN organisations o ON o.id = c.organisation_id
                  JOIN contact_marketing_categories cmc ON cmc.contact_id = c.id
                  WHERE cmc.category ILIKE ${q}
                  GROUP BY c.id, o.name
                  ORDER BY c.last_name, c.first_name
                  LIMIT ${lim} OFFSET ${off}`;

              } else if (field === 'role') {
                countRows = await sql`
                  SELECT COUNT(DISTINCT c.id)::int AS total FROM contacts c
                  JOIN entity_contacts ec ON ec.contact_id = c.id
                  JOIN roles r ON r.id = ec.role_id
                  WHERE r.label ILIKE ${q}`;
                rows = await sql`
                  SELECT c.*, o.name AS org_name,
                    (SELECT COUNT(DISTINCT ec2.entity_id) FROM entity_contacts ec2 WHERE ec2.contact_id = c.id AND ec2.entity_type = 'deal')::int AS property_count,
                    (SELECT STRING_AGG(DISTINCT r2.label, ', ' ORDER BY r2.label) FROM entity_contacts ec3 JOIN roles r2 ON r2.id = ec3.role_id WHERE ec3.contact_id = c.id) AS roles_label,
                    (SELECT STRING_AGG(DISTINCT cmc.category, ', ' ORDER BY cmc.category) FROM contact_marketing_categories cmc WHERE cmc.contact_id = c.id) AS categories_label
                  FROM contacts c
                  LEFT JOIN organisations o ON o.id = c.organisation_id
                  JOIN entity_contacts ec ON ec.contact_id = c.id
                  JOIN roles r ON r.id = ec.role_id
                  WHERE r.label ILIKE ${q}
                  GROUP BY c.id, o.name
                  ORDER BY c.last_name, c.first_name
                  LIMIT ${lim} OFFSET ${off}`;

              } else if (field === 'discipline') {
                countRows = await sql`SELECT COUNT(*)::int AS total FROM contacts c WHERE c.discipline ILIKE ${q}`;
                rows = await sql`
                  SELECT c.*, o.name AS org_name,
                    (SELECT COUNT(DISTINCT ec.entity_id) FROM entity_contacts ec WHERE ec.contact_id = c.id AND ec.entity_type = 'deal')::int AS property_count,
                    (SELECT STRING_AGG(DISTINCT r.label, ', ' ORDER BY r.label) FROM entity_contacts ec2 JOIN roles r ON r.id = ec2.role_id WHERE ec2.contact_id = c.id) AS roles_label,
                    (SELECT STRING_AGG(DISTINCT cmc.category, ', ' ORDER BY cmc.category) FROM contact_marketing_categories cmc WHERE cmc.contact_id = c.id) AS categories_label
                  FROM contacts c LEFT JOIN organisations o ON o.id = c.organisation_id
                  WHERE c.discipline ILIKE ${q}
                  ORDER BY c.last_name, c.first_name LIMIT ${lim} OFFSET ${off}`;

              } else if (field === 'org' || field === 'organisation') {
                countRows = await sql`SELECT COUNT(DISTINCT c.id)::int AS total FROM contacts c JOIN organisations o ON o.id = c.organisation_id WHERE o.name ILIKE ${q}`;
                rows = await sql`
                  SELECT c.*, o.name AS org_name,
                    (SELECT COUNT(DISTINCT ec.entity_id) FROM entity_contacts ec WHERE ec.contact_id = c.id AND ec.entity_type = 'deal')::int AS property_count,
                    (SELECT STRING_AGG(DISTINCT r.label, ', ' ORDER BY r.label) FROM entity_contacts ec2 JOIN roles r ON r.id = ec2.role_id WHERE ec2.contact_id = c.id) AS roles_label,
                    (SELECT STRING_AGG(DISTINCT cmc.category, ', ' ORDER BY cmc.category) FROM contact_marketing_categories cmc WHERE cmc.contact_id = c.id) AS categories_label
                  FROM contacts c JOIN organisations o ON o.id = c.organisation_id
                  WHERE o.name ILIKE ${q}
                  ORDER BY c.last_name, c.first_name LIMIT ${lim} OFFSET ${off}`;

              } else {
                // mobile / email — direct column match. `field` is validated by
                // the regex above (one of a fixed set), so branch explicitly
                // rather than interpolating a column name.
                if (field === 'email') {
                  countRows = await sql`SELECT COUNT(*)::int AS total FROM contacts c WHERE c.email ILIKE ${q}`;
                  rows = await sql`
                    SELECT c.*, o.name AS org_name,
                      (SELECT COUNT(DISTINCT ec.entity_id) FROM entity_contacts ec WHERE ec.contact_id = c.id AND ec.entity_type = 'deal')::int AS property_count,
                      (SELECT STRING_AGG(DISTINCT r.label, ', ' ORDER BY r.label) FROM entity_contacts ec2 JOIN roles r ON r.id = ec2.role_id WHERE ec2.contact_id = c.id) AS roles_label,
                      (SELECT STRING_AGG(DISTINCT cmc.category, ', ' ORDER BY cmc.category) FROM contact_marketing_categories cmc WHERE cmc.contact_id = c.id) AS categories_label
                    FROM contacts c LEFT JOIN organisations o ON o.id = c.organisation_id
                    WHERE c.email ILIKE ${q}
                    ORDER BY c.last_name, c.first_name LIMIT ${lim} OFFSET ${off}`;
                } else {
                  countRows = await sql`SELECT COUNT(*)::int AS total FROM contacts c WHERE c.mobile ILIKE ${q}`;
                  rows = await sql`
                    SELECT c.*, o.name AS org_name,
                      (SELECT COUNT(DISTINCT ec.entity_id) FROM entity_contacts ec WHERE ec.contact_id = c.id AND ec.entity_type = 'deal')::int AS property_count,
                      (SELECT STRING_AGG(DISTINCT r.label, ', ' ORDER BY r.label) FROM entity_contacts ec2 JOIN roles r ON r.id = ec2.role_id WHERE ec2.contact_id = c.id) AS roles_label,
                      (SELECT STRING_AGG(DISTINCT cmc.category, ', ' ORDER BY cmc.category) FROM contact_marketing_categories cmc WHERE cmc.contact_id = c.id) AS categories_label
                    FROM contacts c LEFT JOIN organisations o ON o.id = c.organisation_id
                    WHERE c.mobile ILIKE ${q}
                    ORDER BY c.last_name, c.first_name LIMIT ${lim} OFFSET ${off}`;
                }
              }

            } else {
              // Free-text search — TOKENISED. Split the query on whitespace and
              // require EVERY token to appear somewhere in the contact's searchable
              // text (name, email, mobile, org, discipline, job title, roles,
              // categories). Makes multi-word queries like "David He" or
              // "David mojo" work. `ILIKE ALL(array)` => must match all patterns.
              const tokens   = String(search).trim().split(/\s+/).filter(Boolean);
              const patterns = tokens.length ? tokens.map(t => `%${t}%`) : ['%'];
              // Searchable text is static SQL (no user input) so it's written
              // inline; only the token patterns are bound (as a text[] param).
              countRows = await sql`
                SELECT COUNT(*)::int AS total
                FROM contacts c
                LEFT JOIN organisations o ON o.id = c.organisation_id
                WHERE concat_ws(' ',
                  c.first_name, c.last_name, c.email, c.mobile, c.discipline, c.job_title, o.name,
                  (SELECT string_agg(r.label, ' ') FROM entity_contacts ec JOIN roles r ON r.id = ec.role_id WHERE ec.contact_id = c.id),
                  (SELECT string_agg(cmc.category, ' ') FROM contact_marketing_categories cmc WHERE cmc.contact_id = c.id)
                ) ILIKE ALL(${patterns}::text[])`;
              rows = await sql`
                SELECT c.*, o.name AS org_name,
                  (SELECT COUNT(DISTINCT ec.entity_id) FROM entity_contacts ec WHERE ec.contact_id = c.id AND ec.entity_type = 'deal')::int AS property_count,
                  (SELECT STRING_AGG(DISTINCT r.label, ', ' ORDER BY r.label) FROM entity_contacts ec2 JOIN roles r ON r.id = ec2.role_id WHERE ec2.contact_id = c.id) AS roles_label,
                  (SELECT STRING_AGG(DISTINCT cmc.category, ', ' ORDER BY cmc.category) FROM contact_marketing_categories cmc WHERE cmc.contact_id = c.id) AS categories_label
                FROM contacts c
                LEFT JOIN organisations o ON o.id = c.organisation_id
                WHERE concat_ws(' ',
                  c.first_name, c.last_name, c.email, c.mobile, c.discipline, c.job_title, o.name,
                  (SELECT string_agg(r.label, ' ') FROM entity_contacts ec JOIN roles r ON r.id = ec.role_id WHERE ec.contact_id = c.id),
                  (SELECT string_agg(cmc.category, ' ') FROM contact_marketing_categories cmc WHERE cmc.contact_id = c.id)
                ) ILIKE ALL(${patterns}::text[])
                ORDER BY c.last_name, c.first_name
                LIMIT ${lim} OFFSET ${off}`;
            }

            const total = countRows[0].total;
            return res.status(200).json({ contacts: rows, total });
          }
          // Check if contact_marketing_categories exists (may not on fresh deploy before migration)
          const catsTableExists = await sql`
            SELECT 1 FROM information_schema.tables
            WHERE table_schema='public' AND table_name='contact_marketing_categories'`;
          const hasCatsTable = catsTableExists.length > 0;

          const totalRows = await sql`SELECT COUNT(*)::int AS n FROM contacts`;
          const total = totalRows[0].n;
          const rows = await sql`
            SELECT c.*, o.name AS org_name,
              (SELECT COUNT(DISTINCT ec.entity_id)
               FROM entity_contacts ec
               WHERE ec.contact_id = c.id AND ec.entity_type = 'deal')::int AS property_count,
              (SELECT STRING_AGG(DISTINCT r.label, ', ' ORDER BY r.label)
               FROM entity_contacts ec2
               JOIN roles r ON r.id = ec2.role_id
               WHERE ec2.contact_id = c.id) AS roles_label,
              (SELECT STRING_AGG(DISTINCT cmc.category, ', ' ORDER BY cmc.category)
               FROM contact_marketing_categories cmc
               WHERE cmc.contact_id = c.id) AS categories_label
            FROM contacts c
            LEFT JOIN organisations o ON o.id = c.organisation_id
            ORDER BY c.last_name, c.first_name
            LIMIT ${lim} OFFSET ${off}`;
          return res.status(200).json({ contacts: rows, total });
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
          // V77.2g — no hardcoded fallback role. Caller MUST supply role or
          // role_id; reject otherwise. Loud failure is preferable to silently
          // assigning a wrong default that has to be fixed later.
          const roleId = role_id || role;
          if (!roleId) {
            return res.status(400).json({ error: 'role_id (or role) required for link action' });
          }
          if (!entity_type || !entity_id) {
            if (pipeline_id) {
              const mapped = legacyPipelineToEntity(pipeline_id);
              entity_type = mapped.entity_type;
              entity_id   = mapped.entity_id;
            } else {
              return res.status(400).json({ error: 'entity_type+entity_id or pipeline_id required' });
            }
          }
          // V77.2g — Default Board Role invariant: the about-to-be-deleted
          // "different roles" purge below could remove the last contact holding
          // a Default Board Role. Block if so. Only applies to deals.
          if (entity_type === 'deal') {
            const dealRows = await sql`SELECT board_id FROM deals WHERE id = ${entity_id} LIMIT 1`;
            const boardId = dealRows[0]?.board_id;
            if (boardId) {
              const eligibleRoles = await sql`
                SELECT r.id, r.label
                  FROM roles r
                  JOIN role_boards rb ON rb.role_id = r.id
                 WHERE rb.board_id = ${boardId} AND r.active = true`;
              if (eligibleRoles.length) {
                const eligibleIds = eligibleRoles.map(r => r.id);
                // Roles for THIS contact on this deal that the upcoming purge would drop
                const purgeable = await sql`
                  SELECT role_id FROM entity_contacts
                   WHERE contact_id = ${contact_id} AND entity_type = 'deal' AND entity_id = ${entity_id}
                     AND role_id <> ${roleId}`;
                const willDropEligible = purgeable.map(p => p.role_id).filter(rid => eligibleIds.includes(rid));
                // If the new roleId is already an eligible role, nothing changes the
                // count of contacts-with-eligible-role, so no need to block.
                const newRoleIsEligible = eligibleIds.includes(roleId);
                if (willDropEligible.length && !newRoleIsEligible) {
                  // Count other contacts on this deal still holding any eligible role
                  const remaining = await sql`
                    SELECT COUNT(*)::int AS c FROM entity_contacts
                     WHERE entity_type = 'deal'
                       AND entity_id = ${entity_id}
                       AND contact_id <> ${contact_id}
                       AND role_id = ANY(${eligibleIds})`;
                  if ((remaining[0]?.c ?? 0) === 0) {
                    const labels = eligibleRoles.map(r => r.label).join(' or ');
                    return res.status(409).json({
                      error: `Cannot change this contact's role — they hold the only ${labels} role on this card. Add another contact with one of these roles first, then change this one.`,
                      code: 'last_default_role_contact',
                    });
                  }
                }
              }
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
          // V77.2g — Default Board Role invariant: a deal cannot end up with
          // zero contacts holding any role flagged as a Default Board Role for
          // its board. Block the unlink with a 409 if doing so would leave the
          // deal in an invalid state. Only applies to deals (other entity
          // types are unaffected).
          if (entity_type === 'deal') {
            const dealRows = await sql`SELECT board_id FROM deals WHERE id = ${entity_id} LIMIT 1`;
            const boardId = dealRows[0]?.board_id;
            if (boardId) {
              // Resolve eligible roles for this board
              const eligibleRoles = await sql`
                SELECT r.id, r.label
                  FROM roles r
                  JOIN role_boards rb ON rb.role_id = r.id
                 WHERE rb.board_id = ${boardId} AND r.active = true`;
              if (eligibleRoles.length) {
                const eligibleIds = eligibleRoles.map(r => r.id);
                // Find which of those role-links the unlink will remove for THIS contact
                let willRemoveEligibleRoles;
                if (role_id) {
                  willRemoveEligibleRoles = eligibleIds.includes(role_id) ? [role_id] : [];
                } else {
                  // Legacy "remove all roles for this contact on this deal"
                  const cur = await sql`
                    SELECT role_id FROM entity_contacts
                     WHERE contact_id = ${contact_id} AND entity_type = 'deal' AND entity_id = ${entity_id}`;
                  willRemoveEligibleRoles = cur.map(c => c.role_id).filter(rid => eligibleIds.includes(rid));
                }
                if (willRemoveEligibleRoles.length) {
                  // Count how many other contacts on this deal currently hold
                  // any eligible role (excluding the contact about to be unlinked).
                  const remaining = await sql`
                    SELECT COUNT(*)::int AS c FROM entity_contacts
                     WHERE entity_type = 'deal'
                       AND entity_id = ${entity_id}
                       AND contact_id <> ${contact_id}
                       AND role_id = ANY(${eligibleIds})`;
                  if ((remaining[0]?.c ?? 0) === 0) {
                    const labels = eligibleRoles.map(r => r.label).join(' or ');
                    return res.status(409).json({
                      error: `Cannot remove the last contact with ${labels} role. Add another contact with one of these roles first, then remove this one.`,
                      code: 'last_default_role_contact',
                    });
                  }
                }
              }
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

        // ── Add note (V75.3: moved to /api/notes) ──────────────────────────
        if (body.action === 'add_note') {
          return res.status(410).json({
            error: 'add_note moved to POST /api/notes in V75.3',
            hint:  'POST /api/notes { entity_type, entity_id, note_text, tagged_contact_id? } — author stamped server-side',
          });
        }

        // ── Create contact
        // V77.1c: source removed — it now lives only on notes.source per the
        //   build plan. Source is captured per-interaction (per-note) and not
        //   denormalised onto the contact record.
        // V77.1: dob, current_address (+ suburb/state/postcode), and consent fields
        //   all accepted on create — same tri-state convention as PUT for consents.
        const {
          first_name, last_name = '', mobile = '', email = '', organisation_id = null,
          domain_id = null,
          dob = null,
          discipline = null,
          job_title = null,
          current_address = null, current_address_suburb = null,
          current_address_state = null, current_address_postcode = null,
          // V79 — `privacy_consent` removed (column dropped in v79 migration).
          // `do_not_contact` renamed to `do_not_send_marketing` (more accurate label).
          // New `marketing_pref_set_at` is set whenever the caller signals an
          // explicit preference was recorded (true on any of marketing_email_consent,
          // marketing_sms_consent, or do_not_send_marketing).
          marketing_email_consent, marketing_sms_consent, do_not_send_marketing,
          marketing_pref_set,
        } = body;
        if (!first_name?.trim()) return res.status(400).json({ error: 'first_name required' });

        const consentField = (input) => {
          if (input === undefined) return null;
          if (input === true) return new Date().toISOString();
          return null; // false/'revoke'/null/anything else → no timestamp
        };
        const emailMktAt   = consentField(marketing_email_consent);
        const smsMktAt     = consentField(marketing_sms_consent);
        const doNotSendAt  = consentField(do_not_send_marketing);
        // marketing_pref_set_at: explicit if caller passed marketing_pref_set:true,
        // else infer from any preference being set
        const prefSetExplicit = marketing_pref_set === true;
        const prefImplied     = !!(emailMktAt || smsMktAt || doNotSendAt);
        const prefSetAt       = (prefSetExplicit || prefImplied) ? new Date().toISOString() : null;

        const rows = await sql`
          INSERT INTO contacts (
            first_name, last_name, mobile, email, organisation_id,
            domain_id,
            dob, current_address, current_address_suburb,
            current_address_state, current_address_postcode,
            job_title,
            marketing_email_consent_at, marketing_sms_consent_at,
            do_not_send_marketing_at, marketing_pref_set_at
          ) VALUES (
            ${first_name.trim()}, ${last_name.trim()}, ${mobile.trim()}, ${email.trim()}, ${organisation_id},
            ${domain_id},
            ${dob}, ${current_address}, ${current_address_suburb},
            ${current_address_state}, ${current_address_postcode},
            ${job_title},
            ${emailMktAt}, ${smsMktAt}, ${doNotSendAt}, ${prefSetAt}
          )
          RETURNING *`;
        return res.status(201).json(rows[0]);
      }

      // ══════════════════════════════════════════════════════════════════════
      case 'PUT': {
        const {
          id, org_id, first_name, last_name, mobile, email, organisation_id, domain_id,
          name, phone, website,
          // V77.1 — new columns on contacts
          dob,
          current_address, current_address_suburb, current_address_state, current_address_postcode,
          // V79 consent fields. Two acceptable input shapes:
          //   1. Boolean tri-state (legacy form):
          //        true        → stamp now() (user ticked the consent box)
          //        false       → set to NULL  (user un-ticked / revoked)
          //        undefined   → leave column untouched
          //   2. ISO timestamp string or null (new V79 forms — attendee
          //      registration + agent modal):
          //        "2026-05-09T01:23:45.000Z" → write that timestamp
          //        null                       → set to NULL
          //        undefined                  → leave column untouched
          // Both shapes accepted on the same field for backward compat.
          marketing_email_consent_at, marketing_sms_consent_at,
          do_not_send_marketing_at, marketing_pref_set_at,
          // Legacy boolean field aliases (still accepted from older callers)
          marketing_email_consent, marketing_sms_consent, do_not_send_marketing,
          // V82.b
          discipline,
          // V84
          job_title,
        } = req.body;

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

        // V79 consent helper — handles BOTH boolean tri-state AND direct
        // timestamp/null values. Returns { touch, value }:
        //   { touch: false, value: null }   → undefined (leave column alone)
        //   { touch: true,  value: ISO }    → true OR explicit ISO string
        //   { touch: true,  value: null }   → false / 'revoke' / explicit null
        const consentField = (input) => {
          if (input === undefined) return { touch: false, value: null };
          if (input === true)  return { touch: true, value: new Date().toISOString() };
          if (input === null)  return { touch: true, value: null };
          if (input === false || input === 'revoke') return { touch: true, value: null };
          // String → assume ISO timestamp
          if (typeof input === 'string' && input.length) {
            return { touch: true, value: input };
          }
          return { touch: false, value: null };
        };

        // Prefer the explicit timestamp field if present, fall back to legacy boolean.
        const cEmailMkt  = consentField(marketing_email_consent_at !== undefined ? marketing_email_consent_at : marketing_email_consent);
        const cSmsMkt    = consentField(marketing_sms_consent_at   !== undefined ? marketing_sms_consent_at   : marketing_sms_consent);
        const cDoNotSend = consentField(do_not_send_marketing_at   !== undefined ? do_not_send_marketing_at   : do_not_send_marketing);
        const cPrefSet   = consentField(marketing_pref_set_at);

        // First: fetch current row so we can preserve untouched consent timestamps
        const cur = await sql`SELECT * FROM contacts WHERE id = ${parseInt(id)}`;
        if (!cur.length) return res.status(404).json({ error: 'Not found' });
        const c = cur[0];

        // Final consent values to write — touch ones get new value, untouched keep current
        const nextEmailMkt  = cEmailMkt.touch  ? cEmailMkt.value  : c.marketing_email_consent_at;
        const nextSmsMkt    = cSmsMkt.touch    ? cSmsMkt.value    : c.marketing_sms_consent_at;
        const nextDoNotSend = cDoNotSend.touch ? cDoNotSend.value : c.do_not_send_marketing_at;
        const nextPrefSet   = cPrefSet.touch   ? cPrefSet.value   : c.marketing_pref_set_at;

        // Stamp who set the marketing preference if any consent field is being changed
        const prefIsChanging = cEmailMkt.touch || cSmsMkt.touch || cDoNotSend.touch || cPrefSet.touch;
        const nextPrefSetBy  = prefIsChanging
          ? (session.name || session.email || 'System')
          : c.marketing_pref_set_by;

        const rows = await sql`
          UPDATE contacts SET
            first_name                  = COALESCE(${first_name              ?? null}, first_name),
            last_name                   = COALESCE(${last_name               ?? null}, last_name),
            mobile                      = COALESCE(${mobile                  ?? null}, mobile),
            email                       = COALESCE(${email                   ?? null}, email),
            organisation_id             = COALESCE(${organisation_id         ?? null}, organisation_id),
            domain_id                   = COALESCE(${domain_id               ?? null}, domain_id),
            dob                         = COALESCE(${dob                     ?? null}, dob),
            current_address             = COALESCE(${current_address         ?? null}, current_address),
            current_address_suburb      = COALESCE(${current_address_suburb  ?? null}, current_address_suburb),
            current_address_state       = COALESCE(${current_address_state   ?? null}, current_address_state),
            current_address_postcode    = COALESCE(${current_address_postcode?? null}, current_address_postcode),
            discipline                  = COALESCE(${discipline                 ?? null}, discipline),
            job_title                   = COALESCE(${job_title                  ?? null}, job_title),
            marketing_email_consent_at  = ${nextEmailMkt},
            marketing_sms_consent_at    = ${nextSmsMkt},
            do_not_send_marketing_at    = ${nextDoNotSend},
            marketing_pref_set_at       = ${nextPrefSet},
            marketing_pref_set_by       = ${nextPrefSetBy ?? null},
            updated_at                  = now()
          WHERE id = ${parseInt(id)}
          RETURNING *`;
        if (!rows.length) return res.status(404).json({ error: 'Not found' });
        return res.status(200).json(rows[0]);
      }

      // ══════════════════════════════════════════════════════════════════════
      case 'DELETE': {
        const { id, note_id, org_id } = req.query;
        if (note_id) {
          return res.status(410).json({
            error: 'note_id delete moved to /api/notes in V75.3',
            hint:  'DELETE /api/notes?id=N',
          });
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
