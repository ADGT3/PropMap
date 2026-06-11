/**
 * api/migrate-to-v82b-data.js
 * V82.b — Rex CRM data import. (Bulk insert rewrite — v3)
 *
 * Uses bulk INSERT per batch rather than per-row round trips.
 * Per batch of N contacts: ~10 DB round trips total regardless of N,
 * vs the previous ~8N round trips.
 *
 * Schema facts:
 *   - contacts: no source column (dropped V77.1c)
 *   - notes table: entity_type, entity_id (TEXT), note_text,
 *     interaction_type (default 'file_note'), source (FK contact_sources)
 *   - contact_sources slugs: our_website, realestate_com_au, domain_com_au,
 *     instagram, facebook, edm, letter_drop, door_knocking, inspection,
 *     walk_in, signboard, cold_calling, referral, other
 *
 * GET  → status
 * POST → execute (?batch=N&offset=M or ?mode=addresses)
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

// ── Log table ────────────────────────────────────────────────────────────────

async function ensureLogTable() {
  await sql`
    CREATE TABLE IF NOT EXISTS rex_import_log (
      id          BIGSERIAL PRIMARY KEY,
      entity_type TEXT        NOT NULL,
      rex_id      TEXT        NOT NULL,
      propmap_id  INTEGER,
      status      TEXT        NOT NULL,
      detail      TEXT,
      ran_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (entity_type, rex_id)
    )`;
}

async function getLoggedIds(entity_type) {
  const rows = await sql`
    SELECT rex_id FROM rex_import_log WHERE entity_type = ${entity_type}`;
  return new Set(rows.map(r => r.rex_id));
}

async function bulkLog(rows) {
  // rows: [{entity_type, rex_id, propmap_id, status, detail}]
  if (!rows.length) return;
  for (const r of rows) {
    await sql`
      INSERT INTO rex_import_log (entity_type, rex_id, propmap_id, status, detail)
      VALUES (${r.entity_type}, ${r.rex_id}, ${r.propmap_id ?? null}, ${r.status}, ${r.detail ?? null})
      ON CONFLICT (entity_type, rex_id) DO UPDATE
        SET propmap_id = EXCLUDED.propmap_id,
            status     = EXCLUDED.status,
            detail     = EXCLUDED.detail,
            ran_at     = now()`;
  }
}

// ── Org cache — build once per batch ─────────────────────────────────────────

async function buildOrgCache(companies) {
  const unique = [...new Set(companies.filter(Boolean).map(c => c.trim().toLowerCase()))];
  if (!unique.length) return new Map();
  const existing = await sql`
    SELECT id, LOWER(TRIM(name)) AS name FROM organisations
    WHERE LOWER(TRIM(name)) = ANY(${unique})`;
  const cache = new Map(existing.map(r => [r.name, r.id]));
  // Insert missing orgs
  const missing = unique.filter(n => !cache.has(n));
  for (const name of missing) {
    const r = await sql`INSERT INTO organisations (name) VALUES (${name}) RETURNING id, LOWER(TRIM(name)) AS name`;
    cache.set(r[0].name, r[0].id);
  }
  return cache;
}

// ── Bulk contact import ───────────────────────────────────────────────────────

async function importContactsBulk(contacts, stats) {
  if (!contacts.length) return;

  // 1. Filter already-logged
  const loggedIds = await getLoggedIds('contact');
  const pending = contacts.filter(c => !loggedIds.has(c.rex_id));
  stats.contacts_skipped += contacts.length - pending.length;
  if (!pending.length) return;

  // 2. Check duplicate emails in one query
  const emails = pending.map(c => c.email).filter(Boolean);
  let dupEmailMap = new Map(); // email → existing contact_id
  if (emails.length) {
    const dups = await sql`
      SELECT id, LOWER(email) AS email FROM contacts
      WHERE LOWER(email) = ANY(${emails})`;
    dups.forEach(r => dupEmailMap.set(r.email, r.id));
  }

  const toInsert   = [];
  const dupLogs    = [];
  for (const c of pending) {
    if (c.email && dupEmailMap.has(c.email)) {
      dupLogs.push({ entity_type: 'contact', rex_id: c.rex_id,
        propmap_id: dupEmailMap.get(c.email), status: 'skipped_duplicate',
        detail: `duplicate email ${c.email}` });
      stats.contacts_skipped_duplicate++;
    } else {
      toInsert.push(c);
    }
  }
  await bulkLog(dupLogs);
  if (!toInsert.length) return;

  // 3. Build org cache for this batch
  const orgCache = await buildOrgCache(toInsert.map(c => c.company));

  // 4. Bulk insert contacts in chunks of 20 to avoid overwhelming Neon connections
  const CHUNK = 20;
  const insertResults = [];
  for (let i = 0; i < toInsert.length; i += CHUNK) {
    const chunk = toInsert.slice(i, i + CHUNK);
    const chunkResults = await Promise.allSettled(
      chunk.map(c => {
        const org_id = c.company ? (orgCache.get(c.company.trim().toLowerCase()) ?? null) : null;
        return sql`
          INSERT INTO contacts (
            first_name, last_name, mobile, email,
            organisation_id, dob,
            current_address, current_address_suburb,
            current_address_state, current_address_postcode,
            discipline, last_contacted_at,
            marketing_email_consent_at, marketing_sms_consent_at,
            do_not_send_marketing_at,
            created_at, updated_at
          ) VALUES (
            ${c.first_name}, ${c.last_name ?? ''}, ${c.mobile ?? ''}, ${c.email ?? ''},
            ${org_id}, ${c.dob ?? null},
            ${c.current_address ?? null}, ${c.current_address_suburb ?? null},
            ${c.current_address_state ?? null}, ${c.current_address_postcode ?? null},
            ${c.discipline ?? null}, ${c.last_contacted_at ?? null},
            ${c.marketing_email_consent_at ?? null}, ${c.marketing_sms_consent_at ?? null},
            ${c.do_not_send_marketing_at ?? null},
            ${c.created_at ?? null}, now()
          )
          RETURNING id`;
      })
    );
    insertResults.push(...chunkResults);
  }

  // 5. Map results back, collect child rows
  const mktCatRows   = [];
  const buyerProfRows = [];
  const activityRows  = [];
  const noteRows      = [];
  const ecRows        = [];
  const logRows       = [];

  for (let i = 0; i < toInsert.length; i++) {
    const c = toInsert[i];
    const result = insertResults[i];
    if (result.status === 'rejected') {
      stats.contacts_errors++;
      logRows.push({ entity_type: 'contact', rex_id: c.rex_id, propmap_id: null,
        status: 'error', detail: result.reason?.message ?? 'unknown' });
      continue;
    }
    const contact_id = result.value[0]?.id;
    if (!contact_id) continue;
    stats.contacts_inserted++;
    logRows.push({ entity_type: 'contact', rex_id: c.rex_id, propmap_id: contact_id, status: 'inserted' });

    // Marketing categories
    for (const cat of (c.marketing_categories || [])) {
      mktCatRows.push({ contact_id, category: cat });
    }

    // Buyer profile
    if (c.buyer_profile) {
      buyerProfRows.push({ contact_id, ...c.buyer_profile });
    }

    // Activity
    if (c.activity) {
      activityRows.push({ contact_id, ...c.activity });
    }

    // Notes — correct interaction_type and source per note type:
    //   last_note        → email_out,  source = NULL  (outbound campaign, no source)
    //   background_info  → file_note,  source = NULL  (internal note, no source)
    //   legal_name       → file_note,  source = NULL
    //   unsubscribe      → file_note,  source = NULL
    //   source attr      → file_note,  source = slug  (separate attribution note)
    const source_slug = c.source ? (SOURCE_SLUG_MAP[c.source] ?? 'other') : null;
    for (const note of (c.notes || [])) {
      if (!note?.text) continue;
      const isCampaign = note.tag === '[Rex last note]';
      noteRows.push({
        contact_id,
        text: note.text,  // no tag prefix — author_name 'Rex Import' identifies origin
        interaction_type: isCampaign ? 'email_out' : 'file_note',
        source_slug: null,  // outbound/internal notes never have a source
      });
    }
    // Source attribution — separate inbound note with source slug
    if (source_slug) {
      noteRows.push({
        contact_id,
        text: 'Contact imported from Rex CRM.',
        interaction_type: 'file_note',
        source_slug,
      });
    }

    // Entity contacts (roles)
    for (const role_id of (c.roles || [])) {
      ecRows.push({ contact_id, rex_id: c.rex_id, role_id });
    }
  }

  // 6. Bulk insert child tables in chunked parallel batches (max 20 concurrent)
  const allChildOps = [
    ...mktCatRows.map(r => () => sql`
      INSERT INTO contact_marketing_categories (contact_id, category)
      VALUES (${r.contact_id}, ${r.category}) ON CONFLICT DO NOTHING`),
    ...buyerProfRows.map(r => () => sql`
      INSERT INTO contact_buyer_profile (
        contact_id, listing_types, property_types,
        min_price, max_price, min_rent, max_rent,
        min_bedrooms, max_bedrooms, min_bathrooms, max_bathrooms,
        min_car_spaces, max_car_spaces,
        min_land_size_sqm, max_land_size_sqm,
        commercial_listing_type, max_commercial_rent
      ) VALUES (
        ${r.contact_id}, ${r.listing_types ?? null}, ${r.property_types ?? null},
        ${r.min_price ?? null}, ${r.max_price ?? null},
        ${r.min_rent ?? null}, ${r.max_rent ?? null},
        ${r.min_bedrooms ?? null}, ${r.max_bedrooms ?? null},
        ${r.min_bathrooms ?? null}, ${r.max_bathrooms ?? null},
        ${r.min_car_spaces ?? null}, ${r.max_car_spaces ?? null},
        ${r.min_land_size_sqm ?? null}, ${r.max_land_size_sqm ?? null},
        ${r.commercial_listing_type ?? null}, ${r.max_commercial_rent ?? null}
      ) ON CONFLICT (contact_id) DO NOTHING`),
    ...activityRows.map(r => () => sql`
      INSERT INTO contact_marketing_activity (
        contact_id, activity_score, email_opens, email_clicks, page_views
      ) VALUES (
        ${r.contact_id}, ${r.activity_score ?? null},
        ${r.email_opens ?? 0}, ${r.email_clicks ?? 0}, ${r.page_views ?? 0}
      ) ON CONFLICT (contact_id) DO NOTHING`),
    ...noteRows.map(r => () => sql`
      INSERT INTO notes (entity_type, entity_id, note_text, interaction_type, source, author_id, author_name)
      VALUES ('contact', ${String(r.contact_id)}, ${r.text}, ${r.interaction_type}, ${r.source_slug ?? null}, NULL, 'Rex Import')`),
    ...ecRows.map(r => () => sql`
      INSERT INTO entity_contacts (contact_id, entity_type, entity_id, role_id)
      VALUES (${r.contact_id}, 'contact_import', ${r.rex_id}, ${r.role_id})
      ON CONFLICT (contact_id, entity_type, entity_id, role_id) DO NOTHING`),
  ];
  for (let i = 0; i < allChildOps.length; i += CHUNK) {
    await Promise.allSettled(allChildOps.slice(i, i + CHUNK).map(fn => fn()));
  }

  // 7. Log results
  await bulkLog(logRows);
}

// ── Address import (sequential — only 38 pending) ────────────────────────────

async function importAddresses(stats) {
  const loggedIds = await getLoggedIds('property');
  const pending = ALL_ADDRESSES.filter(a => !loggedIds.has(a.rex_id));
  stats.properties_skipped += ALL_ADDRESSES.length - pending.length;

  for (const a of pending) {
    try {
      if (!a.lat || !a.lng) {
        await bulkLog([{ entity_type: 'property', rex_id: a.rex_id, propmap_id: null,
          status: 'skipped_no_latlng', detail: 'missing lat/lng' }]);
        stats.properties_skipped++;
        continue;
      }

      const prop_id = `rex_${a.rex_id}`;
      const lot_dps = [a.lot_no, a.street_no].filter(Boolean).join('/');

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
        ) ON CONFLICT (id) DO NOTHING`;

      let owner_status = 'inserted';
      if (a.owner) {
        const o = a.owner;
        let owner_id = null;
        if (o.mobile) {
          const r = await sql`SELECT id FROM contacts WHERE mobile = ${o.mobile} LIMIT 1`;
          if (r.length) owner_id = r[0].id;
        }
        if (!owner_id && o.email) {
          const r = await sql`SELECT id FROM contacts WHERE LOWER(email) = LOWER(${o.email}) LIMIT 1`;
          if (r.length) owner_id = r[0].id;
        }
        if (!owner_id) {
          const r = await sql`
            INSERT INTO contacts (first_name, last_name, mobile, email, created_at, updated_at)
            VALUES (${o.first_name}, ${o.last_name ?? ''}, ${o.mobile ?? ''}, ${o.email ?? ''}, now(), now())
            RETURNING id`;
          owner_id = r[0]?.id;
          owner_status = 'owner_created';
          stats.owners_created++;
        } else {
          owner_status = 'owner_matched';
          stats.owners_matched++;
        }
        if (owner_id) {
          await sql`
            INSERT INTO entity_contacts (contact_id, entity_type, entity_id, role_id)
            VALUES (${owner_id}, 'property', ${prop_id}, 'owner')
            ON CONFLICT (contact_id, entity_type, entity_id, role_id) DO NOTHING`;
        }
      }

      await bulkLog([{ entity_type: 'property', rex_id: a.rex_id, propmap_id: null,
        status: owner_status, detail: `prop_id=${prop_id}` }]);
      stats.properties_inserted++;

    } catch (err) {
      await bulkLog([{ entity_type: 'property', rex_id: a.rex_id, propmap_id: null,
        status: 'error', detail: err.message }]);
      stats.properties_errors++;
    }
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
      const loggedContactIds = await getLoggedIds('contact');
      const loggedPropIds    = await getLoggedIds('property');
      return res.status(200).json({
        migration_id: MIGRATION_ID,
        source: {
          total_contacts:    ALL_CONTACTS.length,
          total_addresses:   ALL_ADDRESSES.length,
          contacts_pending:  ALL_CONTACTS.filter(c => !loggedContactIds.has(c.rex_id)).length,
          addresses_pending: ALL_ADDRESSES.filter(a => !loggedPropIds.has(a.rex_id)).length,
        },
        log_summary: logged,
        note: 'POST to execute. ?batch=N&offset=M or ?mode=addresses',
      });
    }

    if (req.method === 'POST') {
      const batch  = parseInt(req.query?.batch  ?? '500', 10);
      const offset = parseInt(req.query?.offset ?? '0',   10);
      const mode   = req.query?.mode ?? 'contacts';

      const stats = {
        contacts_inserted: 0, contacts_skipped: 0,
        contacts_skipped_duplicate: 0, contacts_errors: 0,
        properties_inserted: 0, properties_skipped: 0, properties_errors: 0,
        owners_matched: 0, owners_created: 0,
      };

      if (mode === 'addresses') {
        await importAddresses(stats);
        return res.status(200).json({ migration_id: MIGRATION_ID, mode: 'addresses', stats, message: 'Addresses import complete.' });
      }

      const contactSlice = ALL_CONTACTS.slice(offset, offset + batch);
      await importContactsBulk(contactSlice, stats);

      const next_offset = offset + batch;
      const has_more    = next_offset < ALL_CONTACTS.length;

      return res.status(200).json({
        migration_id: MIGRATION_ID,
        batch_processed: { offset, batch, count: contactSlice.length },
        stats,
        has_more,
        next_url: has_more ? `/api/migrate-to-v82b-data?batch=${batch}&offset=${next_offset}` : null,
        message: has_more
          ? `Processed ${offset}–${offset + contactSlice.length} of ${ALL_CONTACTS.length}. POST to next_url to continue.`
          : 'Contacts done. POST ?mode=addresses to import properties.',
      });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error('[migrate-v82b-data] fatal:', err);
    return res.status(500).json({ error: err.message, stack: err.stack });
  }
}
