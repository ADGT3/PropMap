/**
 * api/migrate-to-v82b-data.js
 * V82.b — Rex CRM data import.
 *
 * Imports contacts and properties from the Rex CRM export per the
 * CRM Migration Plan v2 (June 2026).
 *
 * Key schema facts confirmed from codebase:
 *   - contacts: NO source column (dropped V77.1c); source lives on notes table
 *   - notes table (not contact_notes): entity_type, entity_id (TEXT), note_text,
 *     interaction_type (FK interaction_types, default 'file_note'), source (FK contact_sources)
 *   - contact_sources: slug-style ids (our_website, realestate_com_au, domain_com_au,
 *     instagram, facebook, edm, letter_drop, door_knocking, inspection, walk_in,
 *     signboard, cold_calling, referral, other)
 *   - entity_contacts: contact_id, entity_type, entity_id (TEXT), role_id
 *   - properties: id (TEXT), address, suburb, state, lat, lng, lot_dps, area_sqm,
 *     core_logic_id, property_metadata (JSONB) — added by migrate-to-v82b.js
 *
 * Per contact:
 *   1. Org (company) — upsert into organisations, link via organisation_id
 *   2. Contact — insert (skip on duplicate email; keep existing)
 *   3. contact_marketing_categories rows
 *   4. contact_buyer_profile row
 *   5. contact_marketing_activity row
 *   6. notes rows for background_info, last_note, source attribution,
 *      legal_name, unsubscribe_reason
 *   7. entity_contacts rows (roles)
 *
 * Per address:
 *   1. Property insert (requires lat/lng)
 *   2. Owner contact reconciliation (exact mobile or email match → link;
 *      no match → create contact, then link)
 *   3. entity_contacts row linking owner to property (role: owner)
 *
 * Idempotent — tracked via rex_import_log table.
 * Supports ?batch=N&offset=M for Vercel 30s timeout compliance.
 *
 * GET  → status
 * POST → execute
 */

import { neon } from '@neondatabase/serverless';
import { requireSession, requireAdmin } from '../lib/auth.js';
import { getDatabaseUrl } from '../lib/db.js';
import { createRequire } from 'module';

const sql = neon(getDatabaseUrl());
const require = createRequire(import.meta.url);

const ALL_CONTACTS = require('./migrate-to-v82b-contacts.json');
const ALL_ADDRESSES = require('./migrate-to-v82b-addresses.json');

const MIGRATION_ID = 'v82b_rex_data_import';

// ── Source mapping: our JSON values → contact_sources slug ids ───────────────
const SOURCE_SLUG_MAP = {
  'realestate.com.au': 'realestate_com_au',
  'domain.com.au':     'domain_com_au',
  'OpenLot':           'other',
  'Facebook':          'facebook',
  'Google':            'other',
  'Instagram':         'instagram',
  'Open_House':        'inspection',
  'Referral':          'referral',
  'Signboard':         'signboard',
  'Site_Signage':      'signboard',
  'Office_Website':    'our_website',
  'Letterbox_Drop':    'letter_drop',
  'Door_Knock':        'door_knocking',
  'Walk_In':           'walk_in',
  'Phone_In':          'other',
  'Agent_Database':    'other',
};

// ── Helpers ──────────────────────────────────────────────────────────────────

async function ensureLogTable() {
  await sql`
    CREATE TABLE IF NOT EXISTS rex_import_log (
      id          BIGSERIAL PRIMARY KEY,
      entity_type TEXT    NOT NULL,
      rex_id      TEXT    NOT NULL,
      propmap_id  INTEGER,
      status      TEXT    NOT NULL,
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
  const existing = await sql`
    SELECT id FROM organisations
    WHERE LOWER(TRIM(name)) = LOWER(${trimmed})
    LIMIT 1`;
  if (existing.length) return existing[0].id;
  const inserted = await sql`
    INSERT INTO organisations (name) VALUES (${trimmed}) RETURNING id`;
  return inserted[0]?.id ?? null;
}

async function findContactByMobileOrEmail(mobile, email) {
  if (mobile) {
    const r = await sql`SELECT id FROM contacts WHERE mobile = ${mobile} LIMIT 1`;
    if (r.length) return r[0].id;
  }
  if (email) {
    const r = await sql`SELECT id FROM contacts WHERE LOWER(email) = LOWER(${email}) LIMIT 1`;
    if (r.length) return r[0].id;
  }
  return null;
}

async function insertNote(contact_id, note_text, source_slug = null) {
  // entity_id is TEXT in notes table
  await sql`
    INSERT INTO notes (
      entity_type, entity_id, note_text,
      interaction_type, source,
      author_id, author_name
    ) VALUES (
      'contact', ${String(contact_id)}, ${note_text},
      'file_note', ${source_slug ?? null},
      NULL, 'Rex Import'
    )`;
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
    if (c.email) {
      const dup = await sql`
        SELECT id FROM contacts WHERE LOWER(email) = ${c.email} LIMIT 1`;
      if (dup.length) {
        await log('contact', c.rex_id, dup[0].id, 'skipped_duplicate',
          `duplicate email ${c.email}, linked to existing contact ${dup[0].id}`);
        stats.contacts_skipped_duplicate++;
        return dup[0].id;
      }
    }

    // 3. Insert contact (no source column — stored as note below)
    const rows = await sql`
      INSERT INTO contacts (
        first_name, last_name, mobile, email,
        organisation_id,
        dob,
        current_address, current_address_suburb,
        current_address_state, current_address_postcode,
        discipline, last_contacted_at,
        marketing_email_consent_at, marketing_sms_consent_at,
        do_not_send_marketing_at,
        created_at, updated_at
      ) VALUES (
        ${c.first_name}, ${c.last_name ?? ''}, ${c.mobile ?? ''}, ${c.email ?? ''},
        ${org_id ?? null},
        ${c.dob ?? null},
        ${c.current_address ?? null}, ${c.current_address_suburb ?? null},
        ${c.current_address_state ?? null}, ${c.current_address_postcode ?? null},
        ${c.discipline ?? null}, ${c.last_contacted_at ?? null},
        ${c.marketing_email_consent_at ?? null}, ${c.marketing_sms_consent_at ?? null},
        ${c.do_not_send_marketing_at ?? null},
        ${c.created_at ?? null}, now()
      )
      RETURNING id`;
    const contact_id = rows[0].id;

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

    // 7. Notes (into notes table, entity_type='contact')
    const source_slug = c.source ? (SOURCE_SLUG_MAP[c.source] ?? 'other') : null;
    for (const note of (c.notes || [])) {
      if (!note?.text) continue;
      await insertNote(contact_id, `${note.tag} ${note.text}`, source_slug);
    }
    // If no notes but we have a source, record it as a minimal import note
    if ((c.notes || []).length === 0 && source_slug) {
      await insertNote(contact_id, '[Rex Import] Contact imported from Rex CRM.', source_slug);
    }

    // 8. Entity contacts (roles)
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
    if (!a.lat || !a.lng) {
      await log('property', a.rex_id, null, 'skipped_no_latlng', 'missing lat/lng');
      stats.properties_skipped++;
      return;
    }

    const prop_id    = `rex_${a.rex_id}`;
    const lot_dps    = [a.lot_no, a.street_no].filter(Boolean).join('/');

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
        ${a.created_at ?? null}, now()
      )
      ON CONFLICT (id) DO NOTHING`;

    // Owner reconciliation
    let owner_status = null;
    if (a.owner) {
      const o = a.owner;
      let owner_contact_id = await findContactByMobileOrEmail(o.mobile, o.email);

      if (!owner_contact_id) {
        const org_id = await getOrCreateOrg(o.company);
        const new_owner = await sql`
          INSERT INTO contacts (
            first_name, last_name, mobile, email,
            organisation_id, created_at, updated_at
          ) VALUES (
            ${o.first_name}, ${o.last_name ?? ''}, ${o.mobile ?? ''}, ${o.email ?? ''},
            ${org_id ?? null}, now(), now()
          )
          RETURNING id`;
        owner_contact_id = new_owner[0]?.id;
        owner_status = 'owner_created';
        stats.owners_created++;
      } else {
        owner_status = 'owner_matched';
        stats.owners_matched++;
      }

      if (owner_contact_id) {
        await sql`
          INSERT INTO entity_contacts (contact_id, entity_type, entity_id, role_id)
          VALUES (${owner_contact_id}, 'property', ${prop_id}, 'owner')
          ON CONFLICT (contact_id, entity_type, entity_id, role_id) DO NOTHING`;
      }
    }

    await log('property', a.rex_id, null, owner_status ?? 'inserted',
      owner_status ? `prop_id=${prop_id}` : null);
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

      const loggedContactIds = new Set(
        (await sql`SELECT rex_id FROM rex_import_log WHERE entity_type='contact'`).map(r => r.rex_id)
      );
      const loggedPropIds = new Set(
        (await sql`SELECT rex_id FROM rex_import_log WHERE entity_type='property'`).map(r => r.rex_id)
      );

      return res.status(200).json({
        migration_id: MIGRATION_ID,
        source: {
          total_contacts:    ALL_CONTACTS.length,
          total_addresses:   ALL_ADDRESSES.length,
          contacts_pending:  ALL_CONTACTS.filter(c => !loggedContactIds.has(c.rex_id)).length,
          addresses_pending: ALL_ADDRESSES.filter(a => !loggedPropIds.has(a.rex_id)).length,
        },
        log_summary: logged,
        note: 'POST to execute. Supports ?batch=N&offset=M for pagination.',
      });
    }

    if (req.method === 'POST') {
      const batch  = parseInt(req.query?.batch  ?? '300', 10);
      const offset = parseInt(req.query?.offset ?? '0',   10);

      const stats = {
        contacts_inserted: 0, contacts_skipped: 0,
        contacts_skipped_duplicate: 0, contacts_errors: 0,
        properties_inserted: 0, properties_skipped: 0, properties_errors: 0,
        owners_matched: 0, owners_created: 0,
      };

      // Contacts (paginated)
      const contactSlice = ALL_CONTACTS.slice(offset, offset + batch);
      for (const c of contactSlice) {
        await importContact(c, stats);
      }

      // Addresses (always full — only 79 records; only on first batch)
      if (offset === 0) {
        for (const a of ALL_ADDRESSES) {
          await importAddress(a, stats);
        }
      }

      const next_offset = offset + batch;
      const has_more    = next_offset < ALL_CONTACTS.length;

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
