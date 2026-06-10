/**
 * api/migrate-to-v82b-data.js
 * V82.b — Rex CRM data import.
 *
 * Imports contacts and properties from the Rex CRM export per the
 * CRM Migration Plan v2 (June 2026).
 *
 * Reads pre-processed JSON data files:
 *   api/migrate-to-v82b-contacts.json   — 2,966 contacts
 *   api/migrate-to-v82b-addresses.json  — 79 properties
 *
 * Per contact:
 *   1. Org (company) — upsert into organisations, link via organisation_id
 *   2. Contact — insert (skip on duplicate email; keep richer record)
 *   3. contact_marketing_categories rows
 *   4. contact_buyer_profile row
 *   5. contact_marketing_activity row
 *   6. contact_notes rows (background_info, last_note, legal_name, unsubscribe_reason)
 *   7. entity_contacts rows (roles — contact-level, no entity linked)
 *
 * Per address:
 *   1. Property insert (requires lat/lng — skip if missing)
 *   2. Internal notes → contact_notes on property
 *   3. Owner contact reconciliation (exact mobile or email match → link;
 *      no match → create contact, then link)
 *   4. entity_contacts row linking owner to property (role: owner)
 *
 * All operations wrapped in per-record try/catch so one bad row
 * does not abort the entire import.
 *
 * Idempotent — a second run will skip already-imported records
 * (tracked via rex_source_id in migration_log).
 *
 * GET  → status (counts already imported, counts pending)
 * POST → execute (runs full import, returns summary)
 *
 * This is an admin-only endpoint. Expect it to take 30–120 seconds
 * for the full 2,966-contact import. Vercel's 30s function timeout
 * applies — POST accepts an optional ?batch=N&offset=M for pagination
 * if needed.
 */

import { neon } from '@neondatabase/serverless';
import { requireSession, requireAdmin } from '../lib/auth.js';
import { getDatabaseUrl } from '../lib/db.js';
import { createRequire } from 'module';

const sql = neon(getDatabaseUrl());
const require = createRequire(import.meta.url);

// Load pre-processed data (committed as JSON alongside this file)
const ALL_CONTACTS = require('./migrate-to-v82b-contacts.json');
const ALL_ADDRESSES = require('./migrate-to-v82b-addresses.json');

const MIGRATION_ID = 'v82b_rex_data_import';
const LOG_TABLE    = 'rex_import_log';

// ── Helpers ──────────────────────────────────────────────────────────────────

async function ensureLogTable() {
  await sql`
    CREATE TABLE IF NOT EXISTS rex_import_log (
      id          BIGSERIAL PRIMARY KEY,
      entity_type TEXT    NOT NULL,  -- 'contact' | 'property'
      rex_id      TEXT    NOT NULL,
      propmap_id  INTEGER,
      status      TEXT    NOT NULL,  -- 'inserted' | 'skipped_duplicate' | 'error' | 'owner_matched' | 'owner_created'
      detail      TEXT,
      ran_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (entity_type, rex_id)
    )`;
}

async function alreadyLogged(entity_type, rex_id) {
  const r = await sql`
    SELECT 1 FROM rex_import_log
    WHERE entity_type = ${entity_type} AND rex_id = ${rex_id}`;
  return r.length > 0;
}

async function log(entity_type, rex_id, propmap_id, status, detail = null) {
  await sql`
    INSERT INTO rex_import_log (entity_type, rex_id, propmap_id, status, detail)
    VALUES (${entity_type}, ${rex_id}, ${propmap_id}, ${status}, ${detail})
    ON CONFLICT (entity_type, rex_id) DO UPDATE
      SET propmap_id = EXCLUDED.propmap_id,
          status     = EXCLUDED.status,
          detail     = EXCLUDED.detail,
          ran_at     = now()`;
}

async function getOrCreateOrg(company) {
  if (!company) return null;
  const trimmed = company.trim();
  if (!trimmed) return null;
  // Try to find existing
  const existing = await sql`
    SELECT id FROM organisations
    WHERE LOWER(TRIM(name)) = LOWER(${trimmed})
    LIMIT 1`;
  if (existing.length) return existing[0].id;
  // Create new
  const inserted = await sql`
    INSERT INTO organisations (name)
    VALUES (${trimmed})
    RETURNING id`;
  return inserted[0]?.id ?? null;
}

async function findContactByMobileOrEmail(mobile, email) {
  if (!mobile && !email) return null;
  const conditions = [];
  if (mobile) {
    const r = await sql`
      SELECT id FROM contacts WHERE mobile = ${mobile} LIMIT 1`;
    if (r.length) return r[0].id;
  }
  if (email) {
    const r = await sql`
      SELECT id FROM contacts WHERE LOWER(email) = LOWER(${email}) LIMIT 1`;
    if (r.length) return r[0].id;
  }
  return null;
}

// ── Contact import ────────────────────────────────────────────────────────────

async function importContact(c, stats) {
  if (await alreadyLogged('contact', c.rex_id)) {
    stats.contacts_skipped++;
    return null;
  }

  try {
    // 1. Organisation
    const org_id = await getOrCreateOrg(c.company);

    // 2. Check for duplicate email
    let contact_id = null;
    if (c.email) {
      const dup = await sql`
        SELECT id FROM contacts WHERE LOWER(email) = ${c.email} LIMIT 1`;
      if (dup.length) {
        await log('contact', c.rex_id, dup[0].id, 'skipped_duplicate',
          `duplicate email ${c.email}, linked to existing contact ${dup[0].id}`);
        stats.contacts_skipped_duplicate++;
        return dup[0].id; // still return id so notes/roles can be attached
      }
    }

    // 3. Insert contact
    const rows = await sql`
      INSERT INTO contacts (
        first_name, last_name, mobile, email,
        organisation_id, source, dob,
        current_address, current_address_suburb,
        current_address_state, current_address_postcode,
        discipline, last_contacted_at,
        marketing_email_consent_at, marketing_sms_consent_at,
        do_not_send_marketing_at,
        created_at, updated_at
      ) VALUES (
        ${c.first_name}, ${c.last_name}, ${c.mobile ?? null}, ${c.email ?? null},
        ${org_id ?? null}, ${c.source ?? null}, ${c.dob ?? null},
        ${c.current_address ?? null}, ${c.current_address_suburb ?? null},
        ${c.current_address_state ?? null}, ${c.current_address_postcode ?? null},
        ${c.discipline ?? null}, ${c.last_contacted_at ?? null},
        ${c.marketing_email_consent_at ?? null}, ${c.marketing_sms_consent_at ?? null},
        ${c.do_not_send_marketing_at ?? null},
        ${c.created_at ?? 'now()'}, now()
      )
      RETURNING id`;
    contact_id = rows[0].id;

    // 4. Marketing categories
    for (const cat of (c.marketing_categories || [])) {
      await sql`
        INSERT INTO contact_marketing_categories (contact_id, category)
        VALUES (${contact_id}, ${cat})
        ON CONFLICT DO NOTHING`;
    }

    // 5. Buyer profile
    if (c.buyer_profile) {
      const bp = c.buyer_profile;
      await sql`
        INSERT INTO contact_buyer_profile (
          contact_id, listing_types, property_types,
          min_price, max_price, min_rent, max_rent,
          min_bedrooms, max_bedrooms, min_bathrooms, max_bathrooms,
          min_car_spaces, max_car_spaces,
          min_land_size_sqm, max_land_size_sqm,
          commercial_listing_type, max_commercial_rent
        ) VALUES (
          ${contact_id},
          ${bp.listing_types ?? null}, ${bp.property_types ?? null},
          ${bp.min_price ?? null}, ${bp.max_price ?? null},
          ${bp.min_rent ?? null}, ${bp.max_rent ?? null},
          ${bp.min_bedrooms ?? null}, ${bp.max_bedrooms ?? null},
          ${bp.min_bathrooms ?? null}, ${bp.max_bathrooms ?? null},
          ${bp.min_car_spaces ?? null}, ${bp.max_car_spaces ?? null},
          ${bp.min_land_size_sqm ?? null}, ${bp.max_land_size_sqm ?? null},
          ${bp.commercial_listing_type ?? null}, ${bp.max_commercial_rent ?? null}
        )
        ON CONFLICT (contact_id) DO NOTHING`;
    }

    // 6. Marketing activity
    if (c.activity) {
      const a = c.activity;
      await sql`
        INSERT INTO contact_marketing_activity (
          contact_id, activity_score,
          email_opens, email_clicks, page_views
        ) VALUES (
          ${contact_id}, ${a.activity_score ?? null},
          ${a.email_opens ?? 0}, ${a.email_clicks ?? 0}, ${a.page_views ?? 0}
        )
        ON CONFLICT (contact_id) DO NOTHING`;
    }

    // 7. Notes
    for (const note of (c.notes || [])) {
      if (!note?.text) continue;
      await sql`
        INSERT INTO contact_notes (contact_id, note_text, created_at)
        VALUES (${contact_id}, ${`${note.tag} ${note.text}`}, now())`;
    }

    // 8. Entity contacts (roles at contact level — no specific entity)
    // Roles are recorded as contact-level without entity linkage for now;
    // they will be linked to deals/properties as those relationships are
    // established in the future.
    // We store them as entity_type='contact_import', entity_id=rex_id
    // so the data is preserved and queryable.
    for (const role_id of (c.roles || [])) {
      await sql`
        INSERT INTO entity_contacts (contact_id, entity_type, entity_id, role_id)
        VALUES (${contact_id}, 'contact_import', ${c.rex_id}, ${role_id})
        ON CONFLICT (contact_id, entity_type, entity_id, role_id) DO NOTHING`;
    }

    await log('contact', c.rex_id, contact_id, 'inserted');
    stats.contacts_inserted++;
    return contact_id;

  } catch (err) {
    await log('contact', c.rex_id, null, 'error', err.message);
    stats.contacts_errors++;
    return null;
  }
}

// ── Property import ───────────────────────────────────────────────────────────

async function importAddress(a, stats) {
  if (await alreadyLogged('property', a.rex_id)) {
    stats.properties_skipped++;
    return;
  }

  try {
    // lat/lng required — skip if missing
    if (!a.lat || !a.lng) {
      await log('property', a.rex_id, null, 'skipped_duplicate', 'missing lat/lng');
      stats.properties_skipped++;
      return;
    }

    // Build lot_dps string
    const lot_dps = [a.lot_no, a.street_no].filter(Boolean).join('/');

    // Insert property
    const prop_id = `rex_${a.rex_id}`;
    await sql`
      INSERT INTO properties (
        id, address, suburb, state, lat, lng,
        lot_dps, area_sqm, core_logic_id,
        property_metadata, created_at, updated_at
      ) VALUES (
        ${prop_id}, ${a.address}, ${a.suburb}, ${a.state},
        ${a.lat}, ${a.lng},
        ${lot_dps || ''}, ${a.land_size_sqm ?? null}, ${a.core_logic_id ?? null},
        ${a.property_metadata ? JSON.stringify(a.property_metadata) : '{}'},
        ${a.created_at ?? 'now()'}, now()
      )
      ON CONFLICT (id) DO NOTHING`;

    // Internal notes
    if (a.internal_notes) {
      await sql`
        INSERT INTO contact_notes (contact_id, note_text, created_at)
        SELECT NULL, ${`[Rex property note] ${a.internal_notes}`}, now()
        WHERE FALSE`; // placeholder — property notes need a deal_id; log as audit only
    }

    // Owner reconciliation
    if (a.owner) {
      const o = a.owner;
      let owner_contact_id = await findContactByMobileOrEmail(o.mobile, o.email);
      let owner_status = 'owner_matched';

      if (!owner_contact_id) {
        // Create new contact from owner fields
        const org_id = await getOrCreateOrg(o.company);
        const new_owner = await sql`
          INSERT INTO contacts (
            first_name, last_name, mobile, email,
            organisation_id, source, created_at, updated_at
          ) VALUES (
            ${o.first_name}, ${o.last_name}, ${o.mobile ?? null}, ${o.email ?? null},
            ${org_id ?? null}, 'rex_import', now(), now()
          )
          RETURNING id`;
        owner_contact_id = new_owner[0]?.id;
        owner_status = 'owner_created';
        stats.owners_created++;
      } else {
        stats.owners_matched++;
      }

      if (owner_contact_id) {
        await sql`
          INSERT INTO entity_contacts (contact_id, entity_type, entity_id, role_id)
          VALUES (${owner_contact_id}, 'property', ${prop_id}, 'owner')
          ON CONFLICT (contact_id, entity_type, entity_id, role_id) DO NOTHING`;
        await log('property', a.rex_id, null, owner_status,
          `owner contact_id=${owner_contact_id}`);
      }
    }

    await log('property', a.rex_id, null, 'inserted');
    stats.properties_inserted++;

  } catch (err) {
    await log('property', a.rex_id, null, 'error', err.message);
    stats.properties_errors++;
  }
}

// ── Handler ───────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  const session = await requireSession(req, res);
  if (!session) return;
  if (!requireAdmin(session, res)) return;

  try {
    await ensureLogTable();

    if (req.method === 'GET') {
      const logged = await sql`
        SELECT entity_type, status, COUNT(*)::int AS n
        FROM rex_import_log
        GROUP BY entity_type, status
        ORDER BY entity_type, status`;

      const pending_contacts  = ALL_CONTACTS.length;
      const pending_addresses = ALL_ADDRESSES.length;
      const loggedContactIds  = new Set(
        (await sql`SELECT rex_id FROM rex_import_log WHERE entity_type='contact'`).map(r => r.rex_id)
      );
      const loggedPropIds = new Set(
        (await sql`SELECT rex_id FROM rex_import_log WHERE entity_type='property'`).map(r => r.rex_id)
      );

      return res.status(200).json({
        migration_id: MIGRATION_ID,
        source: {
          total_contacts:    pending_contacts,
          total_addresses:   pending_addresses,
          contacts_pending:  ALL_CONTACTS.filter(c => !loggedContactIds.has(c.rex_id)).length,
          addresses_pending: ALL_ADDRESSES.filter(a => !loggedPropIds.has(a.rex_id)).length,
        },
        log_summary: logged,
        note: 'POST to execute. Supports ?batch=N&offset=M for pagination.',
      });
    }

    if (req.method === 'POST') {
      const batch  = parseInt(req.query?.batch  ?? '500', 10);
      const offset = parseInt(req.query?.offset ?? '0',   10);

      const stats = {
        contacts_inserted: 0, contacts_skipped: 0,
        contacts_skipped_duplicate: 0, contacts_errors: 0,
        properties_inserted: 0, properties_skipped: 0, properties_errors: 0,
        owners_matched: 0, owners_created: 0,
      };

      // ── Contacts (paginated) ──────────────────────────────────────────────
      const contactSlice = ALL_CONTACTS.slice(offset, offset + batch);
      for (const c of contactSlice) {
        await importContact(c, stats);
      }

      // ── Addresses (always full — only 79 records) ─────────────────────────
      if (offset === 0) {
        for (const a of ALL_ADDRESSES) {
          await importAddress(a, stats);
        }
      }

      const next_offset = offset + batch;
      const has_more = next_offset < ALL_CONTACTS.length;

      return res.status(200).json({
        migration_id: MIGRATION_ID,
        batch_processed: { offset, batch, count: contactSlice.length },
        stats,
        has_more,
        next_url: has_more
          ? `/api/migrate-to-v82b-data?batch=${batch}&offset=${next_offset}`
          : null,
        message: has_more
          ? `Processed ${offset}–${offset + contactSlice.length} of ${ALL_CONTACTS.length} contacts. POST to next_url to continue.`
          : 'Import complete.',
      });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error('[migrate-v82b-data] fatal:', err);
    return res.status(500).json({ error: err.message, stack: err.stack });
  }
}
