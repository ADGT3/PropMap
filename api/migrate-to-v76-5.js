/**
 * api/migrate-to-v76-5.js
 *
 * V76.5 — Decouple property.id, deal.id, and Domain listing.id keyspaces.
 *
 *   Background:
 *     The original "Add to Pipeline" flow used the Domain listing.id as both
 *     the new property.id AND the new deal.id. Parcel-deal creation used the
 *     parcel.id as the deal.id. Result: in prod, property.id and deal.id
 *     overlap with listing.id and parcel.id respectively.
 *
 *     Going forward, V76.5 enforces three independent keyspaces:
 *       - property.id : prop_<timestamp>_<random>
 *       - deal.id     : deal_<timestamp>_<random>
 *       - listing.id  : Domain's id, stored on properties.domain_listing_id only
 *
 *   This migration renumbers existing rows that violate the new rule, and
 *   cascades the rename through every foreign reference. Then drops temporary
 *   bookkeeping columns and restores the deal.property_id FK constraint.
 *
 *   Heuristics (what we treat as "legacy collision id"):
 *     property.id is purely numeric (^\d{6,}$)        — looks like a Domain id
 *     deal.id     is purely numeric                   — was set to listing.id
 *     deal.id     starts with 'parcel-' or 'parcel_'  — was set to parcel.id
 *     deal.id     starts with 'deal-' (legacy hyphen) — V75.7-era format
 *
 *     Properties or deals with already-correct prefixes (`prop_`, `deal_`) are
 *     skipped. The script is idempotent: running it twice is a no-op the
 *     second time.
 *
 *   Cascade targets:
 *     properties.id renumber:
 *       - deals.property_id
 *       - entity_contacts.entity_id (where entity_type='property')
 *       - notes.entity_id           (where entity_type='property')
 *       - contact_notes.entity_id   (where entity_type='property') [legacy]
 *     deals.id renumber:
 *       - deal_user_order.deal_id
 *       - actions.deal_id
 *       - property_financials.deal_id (and property_financials.pipeline_id legacy)
 *       - entity_contacts.entity_id (where entity_type='deal')
 *       - notes.entity_id           (where entity_type='deal')
 *       - contact_notes.pipeline_id (legacy)
 *
 *   GET  → status report (counts of rows that need migrating, no writes)
 *   POST → runs migration (idempotent; requires admin; body { confirm: true })
 *
 *   On success the temporary `legacy_id` columns are dropped. On error, those
 *   columns survive with the partial state so debugging is possible.
 */

import { neon } from '@neondatabase/serverless';
import { getDatabaseUrl } from '../lib/db.js';
import { requireSession, requireAdmin } from '../lib/auth.js';

const sql = neon(getDatabaseUrl());

// ── Helpers ─────────────────────────────────────────────────────────────────

function newPropId() {
  return 'prop_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}
function newDealId() {
  return 'deal_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

async function columnExists(table, column) {
  const rows = await sql`
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name=${table} AND column_name=${column}
     LIMIT 1`;
  return rows.length > 0;
}

async function tableExists(name) {
  const rows = await sql`
    SELECT 1 FROM information_schema.tables
     WHERE table_schema='public' AND table_name=${name}
     LIMIT 1`;
  return rows.length > 0;
}

async function constraintExists(table, name) {
  const rows = await sql`
    SELECT 1 FROM information_schema.table_constraints
     WHERE table_schema='public' AND table_name=${table} AND constraint_name=${name}
     LIMIT 1`;
  return rows.length > 0;
}

// ── Status report ───────────────────────────────────────────────────────────

async function statusReport() {
  const propLegacy = await sql`
    SELECT COUNT(*)::int AS n FROM properties
     WHERE id ~ '^[0-9]{6,}$' OR id LIKE 'property-%'`;
  const dealLegacy = await sql`
    SELECT COUNT(*)::int AS n FROM deals
     WHERE id ~ '^[0-9]{6,}$' OR id LIKE 'parcel-%' OR id LIKE 'parcel_%' OR id LIKE 'deal-%'`;
  const propNew = await sql`SELECT COUNT(*)::int AS n FROM properties WHERE id LIKE 'prop_%'`;
  const dealNew = await sql`SELECT COUNT(*)::int AS n FROM deals WHERE id LIKE 'deal_%'`;
  const propTotal = await sql`SELECT COUNT(*)::int AS n FROM properties`;
  const dealTotal = await sql`SELECT COUNT(*)::int AS n FROM deals`;
  return {
    properties: {
      total:           propTotal[0].n,
      legacy_pending:  propLegacy[0].n,
      already_v76_5:   propNew[0].n,
    },
    deals: {
      total:           dealTotal[0].n,
      legacy_pending:  dealLegacy[0].n,
      already_v76_5:   dealNew[0].n,
    },
  };
}

// ── Migration core ──────────────────────────────────────────────────────────

async function runMigration() {
  const log = [];
  const step = async (name, fn) => {
    try {
      const r = await fn();
      log.push({ step: name, ok: true, ...(r || {}) });
    } catch (err) {
      log.push({ step: name, ok: false, error: err.message });
      throw err;
    }
  };

  // 1. Add legacy_id columns (paper trail during migration; dropped at end)
  await step('add properties.legacy_id', async () => {
    if (!(await columnExists('properties', 'legacy_id'))) {
      await sql`ALTER TABLE properties ADD COLUMN legacy_id TEXT`;
      return { added: true };
    }
    return { skipped: 'already exists' };
  });
  await step('add deals.legacy_id', async () => {
    if (!(await columnExists('deals', 'legacy_id'))) {
      await sql`ALTER TABLE deals ADD COLUMN legacy_id TEXT`;
      return { added: true };
    }
    return { skipped: 'already exists' };
  });

  // 2. Drop the FK so we can renumber both ends without ordering hell
  await step('drop FK deals_property_id_fkey', async () => {
    if (await constraintExists('deals', 'deals_property_id_fkey')) {
      await sql`ALTER TABLE deals DROP CONSTRAINT deals_property_id_fkey`;
      return { dropped: true };
    }
    return { skipped: 'not present' };
  });
  // Same for actions.deal_id and deal_user_order.deal_id (so renumbers don't
  // trip those FKs either). They're SET NULL / CASCADE which would be fine in
  // theory, but updating the parent.id first leaves dangling refs even though
  // we update the children right after — Postgres validates immediately.
  await step('drop FK actions_deal_id_fkey', async () => {
    if (await constraintExists('actions', 'actions_deal_id_fkey')) {
      await sql`ALTER TABLE actions DROP CONSTRAINT actions_deal_id_fkey`;
      return { dropped: true };
    }
    return { skipped: 'not present' };
  });
  await step('drop FK deal_user_order_deal_id_fkey', async () => {
    if (await constraintExists('deal_user_order', 'deal_user_order_deal_id_fkey')) {
      await sql`ALTER TABLE deal_user_order DROP CONSTRAINT deal_user_order_deal_id_fkey`;
      return { dropped: true };
    }
    return { skipped: 'not present' };
  });

  // 3. Renumber properties first (deals reference them via property_id).
  //    Per-property algorithm:
  //      a. Capture the list of deal ids whose property_id == oldId.
  //      b. Null those deals' property_id (FK is dropped above; column is
  //         no-longer-NOT-NULL since V75.4 so this is allowed).
  //      c. Update properties.id from oldId → newId; stamp legacy_id; ensure
  //         domain_listing_id is set if the old id was a Domain id.
  //      d. Update those captured deals back to property_id = newId.
  //      e. Update polymorphic refs in entity_contacts/notes/contact_notes.
  //    No reliance on legacy_id paper trail for deal relink — direct id capture.
  let propsRenumbered = 0;
  await step('renumber properties + cascade', async () => {
    const candidates = await sql`
      SELECT id FROM properties
       WHERE legacy_id IS NULL
         AND (id ~ '^[0-9]{6,}$' OR id LIKE 'property-%')`;
    for (const row of candidates) {
      const oldId = row.id;
      const newId = newPropId();

      // (a) Capture children before modifying anything
      const childDeals = await sql`SELECT id FROM deals WHERE property_id = ${oldId}`;
      const childDealIds = childDeals.map(r => r.id);

      // (b) Detach children to free the parent for renumber
      if (childDealIds.length) {
        await sql`UPDATE deals SET property_id = NULL WHERE property_id = ${oldId}`;
      }

      // (c) Renumber the parent. domain_listing_id COALESCE: only stamp the
      //     old id if the old id is purely numeric (i.e. it WAS a Domain id).
      //     For 'property-...' synthetic ids we leave domain_listing_id alone.
      const isNumericId = /^[0-9]+$/.test(oldId);
      const stampDomainId = isNumericId ? oldId : null;
      await sql`
        UPDATE properties
           SET id        = ${newId},
               legacy_id = ${oldId},
               domain_listing_id = COALESCE(domain_listing_id, ${stampDomainId})
         WHERE id = ${oldId}`;

      // (d) Reattach children to the new parent id
      for (const cdId of childDealIds) {
        await sql`UPDATE deals SET property_id = ${newId} WHERE id = ${cdId}`;
      }

      // (e) Polymorphic references — update everything keyed by old property id
      await sql`
        UPDATE entity_contacts
           SET entity_id = ${newId}
         WHERE entity_type = 'property' AND entity_id = ${oldId}`;
      if (await tableExists('notes')) {
        await sql`
          UPDATE notes
             SET entity_id = ${newId}
           WHERE entity_type = 'property' AND entity_id = ${oldId}`;
      }
      if (await tableExists('contact_notes')) {
        await sql`
          UPDATE contact_notes
             SET entity_id = ${newId}
           WHERE entity_type = 'property' AND entity_id = ${oldId}`;
      }

      propsRenumbered++;
    }
    return { count: propsRenumbered };
  });

  // 4. Renumber deals
  let dealsRenumbered = 0;
  await step('renumber deals + cascade', async () => {
    const candidates = await sql`
      SELECT id FROM deals
       WHERE legacy_id IS NULL
         AND (id ~ '^[0-9]{6,}$' OR id LIKE 'parcel-%' OR id LIKE 'parcel_%' OR id LIKE 'deal-%')`;
    for (const row of candidates) {
      const oldId = row.id;
      const newId = newDealId();
      // Children to cascade:
      //   deal_user_order.deal_id, actions.deal_id,
      //   property_financials.deal_id, property_financials.pipeline_id (legacy),
      //   entity_contacts.entity_id (deal), notes.entity_id (deal),
      //   contact_notes.pipeline_id (legacy).
      await sql`
        UPDATE deals SET id = ${newId}, legacy_id = ${oldId}
         WHERE id = ${oldId}`;
      await sql`
        UPDATE deal_user_order SET deal_id = ${newId} WHERE deal_id = ${oldId}`;
      if (await tableExists('actions')) {
        await sql`UPDATE actions SET deal_id = ${newId} WHERE deal_id = ${oldId}`;
      }
      if (await tableExists('property_financials')) {
        await sql`UPDATE property_financials SET deal_id = ${newId} WHERE deal_id = ${oldId}`;
        if (await columnExists('property_financials', 'pipeline_id')) {
          await sql`UPDATE property_financials SET pipeline_id = ${newId} WHERE pipeline_id = ${oldId}`;
        }
      }
      await sql`
        UPDATE entity_contacts SET entity_id = ${newId}
         WHERE entity_type = 'deal' AND entity_id = ${oldId}`;
      if (await tableExists('notes')) {
        await sql`
          UPDATE notes SET entity_id = ${newId}
           WHERE entity_type = 'deal' AND entity_id = ${oldId}`;
      }
      if (await tableExists('contact_notes')) {
        await sql`
          UPDATE contact_notes SET entity_id = ${newId}
           WHERE entity_type = 'deal' AND entity_id = ${oldId}`;
        if (await columnExists('contact_notes', 'pipeline_id')) {
          await sql`UPDATE contact_notes SET pipeline_id = ${newId} WHERE pipeline_id = ${oldId}`;
        }
      }
      dealsRenumbered++;
    }
    return { count: dealsRenumbered };
  });

  // 5. Recreate FKs
  await step('recreate FK deals_property_id_fkey', async () => {
    if (!(await constraintExists('deals', 'deals_property_id_fkey'))) {
      await sql`
        ALTER TABLE deals
          ADD CONSTRAINT deals_property_id_fkey
          FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE`;
      return { created: true };
    }
    return { skipped: 'already present' };
  });
  await step('recreate FK actions_deal_id_fkey', async () => {
    if (!(await constraintExists('actions', 'actions_deal_id_fkey'))
        && (await tableExists('actions'))) {
      await sql`
        ALTER TABLE actions
          ADD CONSTRAINT actions_deal_id_fkey
          FOREIGN KEY (deal_id) REFERENCES deals(id) ON DELETE SET NULL`;
      return { created: true };
    }
    return { skipped: 'already present or table missing' };
  });
  await step('recreate FK deal_user_order_deal_id_fkey', async () => {
    if (!(await constraintExists('deal_user_order', 'deal_user_order_deal_id_fkey'))
        && (await tableExists('deal_user_order'))) {
      await sql`
        ALTER TABLE deal_user_order
          ADD CONSTRAINT deal_user_order_deal_id_fkey
          FOREIGN KEY (deal_id) REFERENCES deals(id) ON DELETE CASCADE`;
      return { created: true };
    }
    return { skipped: 'already present or table missing' };
  });

  // 6. Verify integrity — counts of any remaining legacy ids should be 0.
  const verifyProps = await sql`
    SELECT COUNT(*)::int AS n FROM properties
     WHERE id ~ '^[0-9]{6,}$' OR id LIKE 'property-%'`;
  const verifyDeals = await sql`
    SELECT COUNT(*)::int AS n FROM deals
     WHERE id ~ '^[0-9]{6,}$' OR id LIKE 'parcel-%' OR id LIKE 'parcel_%' OR id LIKE 'deal-%'`;
  const orphanDeals = await sql`
    SELECT COUNT(*)::int AS n FROM deals d
     WHERE d.parcel_id IS NULL AND d.property_id IS NULL`;
  const verification = {
    legacy_properties_remaining: verifyProps[0].n,
    legacy_deals_remaining:      verifyDeals[0].n,
    orphan_deals:                orphanDeals[0].n,
  };

  // 7. Drop legacy_id columns (clean up — paper trail no longer needed).
  // Skip the drop if verification failed; the columns help debug what went wrong.
  if (verification.legacy_properties_remaining === 0
      && verification.legacy_deals_remaining === 0
      && verification.orphan_deals === 0) {
    await step('drop properties.legacy_id', async () => {
      if (await columnExists('properties', 'legacy_id')) {
        await sql`ALTER TABLE properties DROP COLUMN legacy_id`;
        return { dropped: true };
      }
      return { skipped: 'not present' };
    });
    await step('drop deals.legacy_id', async () => {
      if (await columnExists('deals', 'legacy_id')) {
        await sql`ALTER TABLE deals DROP COLUMN legacy_id`;
        return { dropped: true };
      }
      return { skipped: 'not present' };
    });
  } else {
    log.push({
      step: 'drop legacy_id columns',
      ok: false,
      skipped: 'verification failed; columns retained for debugging',
      verification,
    });
  }

  return {
    propsRenumbered,
    dealsRenumbered,
    verification,
    log,
  };
}

// ── Handler ─────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  const session = await requireSession(req, res);
  if (!session) return;

  if (req.method === 'GET') {
    if (req.query.check === '1') {
      try {
        const status = await statusReport();
        return res.status(200).json(status);
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    }
    return res.status(200).json({
      message: 'V76.5 migration. POST { confirm: true } to run. GET ?check=1 for status.',
    });
  }

  if (req.method === 'POST') {
    if (!await requireAdmin(req, res, session)) return;
    const { confirm } = req.body || {};
    if (confirm !== true) {
      return res.status(400).json({
        error: 'Migration not confirmed. POST body must include { "confirm": true }.',
      });
    }
    try {
      const result = await runMigration();
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
}
