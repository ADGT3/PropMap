/**
 * api/contacts.js
 * CRM Contacts CRUD — Neon Postgres
 *
 * GET    /api/contacts              → list all contacts (with linked pipeline ids)
 * GET    /api/contacts?id=1         → single contact
 * GET    /api/contacts?search=jones → search by name / company / email
 * GET    /api/contacts?pipeline_id=x → contacts linked to a pipeline item
 * POST   /api/contacts              → create contact  { first_name, last_name, mobile, email, company, source, domain_id }
 * PUT    /api/contacts              → update contact  { id, ...fields }
 * DELETE /api/contacts?id=1         → delete contact (cascades junction rows)
 *
 * Link / unlink:
 * POST   /api/contacts  { action:'link',   contact_id, pipeline_id, role }
 * POST   /api/contacts  { action:'unlink', contact_id, pipeline_id }
 */

import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.POSTGRES_URL);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    switch (req.method) {

      // ── GET ────────────────────────────────────────────────────────────────
      case 'GET': {
        const { id, search, pipeline_id } = req.query;

        // Single contact by id
        if (id) {
          const rows = await sql`
            SELECT c.*,
              COALESCE(
                json_agg(json_build_object('pipeline_id', cp.pipeline_id, 'role', cp.role))
                FILTER (WHERE cp.pipeline_id IS NOT NULL), '[]'
              ) AS properties
            FROM contacts c
            LEFT JOIN contact_properties cp ON cp.contact_id = c.id
            WHERE c.id = ${parseInt(id)}
            GROUP BY c.id`;
          if (!rows.length) return res.status(404).json({ error: 'Not found' });
          return res.status(200).json(rows[0]);
        }

        // Contacts linked to a pipeline item
        if (pipeline_id) {
          const rows = await sql`
            SELECT c.*, cp.role
            FROM contacts c
            JOIN contact_properties cp ON cp.contact_id = c.id
            WHERE cp.pipeline_id = ${pipeline_id}
            ORDER BY c.last_name, c.first_name`;
          return res.status(200).json(rows);
        }

        // Search
        if (search) {
          const q = `%${search}%`;
          const rows = await sql`
            SELECT c.*,
              COALESCE(
                json_agg(json_build_object('pipeline_id', cp.pipeline_id, 'role', cp.role))
                FILTER (WHERE cp.pipeline_id IS NOT NULL), '[]'
              ) AS properties
            FROM contacts c
            LEFT JOIN contact_properties cp ON cp.contact_id = c.id
            WHERE c.first_name ILIKE ${q}
               OR c.last_name  ILIKE ${q}
               OR c.company    ILIKE ${q}
               OR c.email      ILIKE ${q}
            GROUP BY c.id
            ORDER BY c.last_name, c.first_name
            LIMIT 50`;
          return res.status(200).json(rows);
        }

        // List all
        const rows = await sql`
          SELECT c.*,
            COALESCE(
              json_agg(json_build_object('pipeline_id', cp.pipeline_id, 'role', cp.role))
              FILTER (WHERE cp.pipeline_id IS NOT NULL), '[]'
            ) AS properties
          FROM contacts c
          LEFT JOIN contact_properties cp ON cp.contact_id = c.id
          GROUP BY c.id
          ORDER BY c.last_name, c.first_name`;
        return res.status(200).json(rows);
      }

      // ── POST ───────────────────────────────────────────────────────────────
      case 'POST': {
        const body = req.body;

        // Link action
        if (body.action === 'link') {
          const { contact_id, pipeline_id, role = 'referrer' } = body;
          await sql`
            INSERT INTO contact_properties (contact_id, pipeline_id, role)
            VALUES (${contact_id}, ${pipeline_id}, ${role})
            ON CONFLICT (contact_id, pipeline_id) DO UPDATE SET role = EXCLUDED.role`;
          return res.status(200).json({ ok: true });
        }

        // Unlink action
        if (body.action === 'unlink') {
          const { contact_id, pipeline_id } = body;
          await sql`
            DELETE FROM contact_properties
            WHERE contact_id = ${contact_id} AND pipeline_id = ${pipeline_id}`;
          return res.status(200).json({ ok: true });
        }

        // Create contact
        const { first_name, last_name = '', mobile = '', email = '', company = '', source = 'manual', domain_id = null } = body;
        if (!first_name?.trim()) return res.status(400).json({ error: 'first_name required' });

        const rows = await sql`
          INSERT INTO contacts (first_name, last_name, mobile, email, company, source, domain_id)
          VALUES (${first_name.trim()}, ${last_name.trim()}, ${mobile.trim()}, ${email.trim()}, ${company.trim()}, ${source}, ${domain_id})
          RETURNING *`;
        return res.status(201).json(rows[0]);
      }

      // ── PUT ────────────────────────────────────────────────────────────────
      case 'PUT': {
        const { id, first_name, last_name, mobile, email, company, source, domain_id } = req.body;
        if (!id) return res.status(400).json({ error: 'id required' });

        const rows = await sql`
          UPDATE contacts SET
            first_name = COALESCE(${first_name ?? null}, first_name),
            last_name  = COALESCE(${last_name  ?? null}, last_name),
            mobile     = COALESCE(${mobile     ?? null}, mobile),
            email      = COALESCE(${email      ?? null}, email),
            company    = COALESCE(${company    ?? null}, company),
            source     = COALESCE(${source     ?? null}, source),
            domain_id  = COALESCE(${domain_id  ?? null}, domain_id),
            updated_at = now()
          WHERE id = ${parseInt(id)}
          RETURNING *`;
        if (!rows.length) return res.status(404).json({ error: 'Not found' });
        return res.status(200).json(rows[0]);
      }

      // ── DELETE ─────────────────────────────────────────────────────────────
      case 'DELETE': {
        const { id } = req.query;
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
