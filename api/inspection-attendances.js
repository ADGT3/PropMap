/**
 * api/inspection-attendances.js — V77.1
 *
 * The most complex V77.1 endpoint. Records who attended a scheduled inspection
 * AND wires up the consequences:
 *
 *   1. FIND-OR-CREATE Enquiry deal — every attendee gets linked to a Sales
 *      Enquiry (if listing is on Sales) or Lease Enquiry (if listing is on Lease)
 *      deal at the same property. If they already have an active enquiry deal
 *      on this property, we reuse it. Otherwise we create one in the first
 *      column of the appropriate enquiry board.
 *
 *   2. ROLE LINK — entity_contacts row (role_id='enquirer') created on the
 *      Enquiry deal. Idempotent on (contact, deal, role) UNIQUE constraint.
 *
 *   3. AUTO-ACTIONS — three optional tickboxes on the attendance form:
 *      - requested_followup     → Action assigned to Listing Agent
 *      - requested_offer_form   → Action assigned to Listing Agent
 *      - requested_contract     → Action assigned to Listing Agent
 *      Each writes a timestamp to inspection_attendances and creates a row
 *      in the actions table linked to the Enquiry deal. Action descriptions
 *      include the contact's name and the listing property's address.
 *
 *   4. CONTACT PREFERENCES — three OTHER tickboxes (privacy_consent,
 *      marketing_email_consent, marketing_sms_consent) write timestamps
 *      directly to the contacts table, NOT to attendance. These are the
 *      contact's own preferences — the attendance is just where they got
 *      asked. Per build plan §4.3.4, attendances and contact prefs are
 *      independent: undoing a contact preference doesn't change attendance,
 *      undoing attendance doesn't change contact preferences.
 *
 * Schema (inspection_attendances):
 *   id, scheduled_inspection_id, contact_id, enquiry_deal_id,
 *   attended_at, notes,
 *   requested_followup_at, requested_offer_form_at, requested_contract_at,
 *   created_by, created_at
 *   UNIQUE (scheduled_inspection_id, contact_id)  ← prevents double-booking
 *
 * Routes:
 *   GET    /api/inspection-attendances?scheduled_inspection_id=N
 *           → all attendees for that inspection (with contact name, current trigger flags)
 *   GET    /api/inspection-attendances?enquiry_deal_id=X
 *           → all inspections this enquirer attended (cross-reference for Enquiry timeline)
 *   GET    /api/inspection-attendances?contact_id=N
 *           → all inspections this contact has attended (any deal)
 *   GET    /api/inspection-attendances?id=N
 *           → single record
 *
 *   POST   /api/inspection-attendances
 *           Body: {
 *             scheduled_inspection_id, contact_id,
 *             // The 6 tickboxes — booleans. The first 3 write to attendance + create Action;
 *             // the last 3 write to contact only.
 *             trigger_followup?, trigger_offer_form?, trigger_contract?,
 *             contact_pref_privacy?, contact_pref_email_marketing?, contact_pref_sms_marketing?,
 *             notes?
 *           }
 *           Returns: { attendance, enquiry_deal_id, actions_created: [Action ids] }
 *
 *   PUT    /api/inspection-attendances
 *           Body: { id, notes?, trigger_followup?, trigger_offer_form?, trigger_contract? }
 *           Editing a trigger flag from false→true creates a new Action.
 *           Editing true→false clears the timestamp but does NOT delete the Action
 *           (the agent can manually mark it done/void; deleting the Action would
 *           lose audit trail of "we asked, they wanted X").
 *           contact_id, scheduled_inspection_id, enquiry_deal_id are immutable.
 *
 *   DELETE /api/inspection-attendances?id=N
 *           Removes the attendance record. Does not unlink the entity_contacts
 *           role on the Enquiry deal (the contact may still be an enquirer for
 *           other reasons). Does not delete auto-created Actions.
 */

import { neon } from '@neondatabase/serverless';
import { requireSession } from '../lib/auth.js';
import { getDatabaseUrl } from '../lib/db.js';
const sql = neon(getDatabaseUrl());

// Map listing board id → corresponding enquiry board id
const ENQUIRY_BOARD_FOR = {
  sys_sales_listings: 'sys_sales_enquiry',
  sys_lease_listings: 'sys_lease_enquiry',
};

// First column of each enquiry board (where new auto-created enquiry deals land)
const ENQUIRY_INITIAL_STAGE  = 'enquiry';
const ENQUIRY_INITIAL_COLUMN = (boardId) => `${boardId}_enquiry`;

// Workflow tag stored on deal row — matches the existing convention used by
// other system boards (e.g. 'sales_enquiry', 'lease_enquiry').
const WORKFLOW_FOR = {
  sys_sales_enquiry: 'sales_enquiry',
  sys_lease_enquiry: 'lease_enquiry',
};

function newDealId() {
  // Same pattern as api/deals.js newDealId
  return 'deal_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

function resolveCreator(session) {
  if (!session) return null;
  const sub = session.sub;
  if (typeof sub === 'number' || (typeof sub === 'string' && /^\d+$/.test(sub))) {
    return parseInt(sub, 10);
  }
  return null;
}

// ── Find-or-create the appropriate Enquiry deal for an attendee ───────────
//
// Inputs: listing deal info (board, property/parcel), contact id.
// Returns: enquiry deal id (string).
//
// Logic:
//   1. Look for an active enquiry deal on the same property where the contact
//      already has an entity_contacts role (any role — we don't gate on
//      'enquirer' because they might already be linked as something else).
//   2. If none exists, look for ANY active enquiry deal on the same property
//      (not yet linked to the contact). We prefer to attach to an existing
//      deal rather than create a new one so an inspection slot doesn't fragment
//      the timeline.
//   3. If still none, create a fresh enquiry deal on the appropriate board.
async function findOrCreateEnquiryDeal({
  listingDealId, listingBoardId, propertyId, parcelId, contactId, session,
}) {
  const enquiryBoardId = ENQUIRY_BOARD_FOR[listingBoardId];
  if (!enquiryBoardId) {
    throw new Error(`No enquiry board mapped for listing board '${listingBoardId}'`);
  }

  // Option 1: contact already has a role on an active enquiry deal at this property
  if (propertyId) {
    const existing = await sql`
      SELECT d.id
      FROM deals d
      JOIN entity_contacts ec
        ON ec.entity_type = 'deal' AND ec.entity_id = d.id
      WHERE d.board_id   = ${enquiryBoardId}
        AND d.property_id = ${propertyId}
        AND d.status      = 'active'
        AND ec.contact_id = ${contactId}
      LIMIT 1`;
    if (existing.length) return existing[0].id;
  } else if (parcelId) {
    const existing = await sql`
      SELECT d.id
      FROM deals d
      JOIN entity_contacts ec
        ON ec.entity_type = 'deal' AND ec.entity_id = d.id
      WHERE d.board_id   = ${enquiryBoardId}
        AND d.parcel_id  = ${parcelId}
        AND d.status     = 'active'
        AND ec.contact_id = ${contactId}
      LIMIT 1`;
    if (existing.length) return existing[0].id;
  }

  // Option 2 disabled — V77.1 build plan §4.3.4 wants per-enquirer Enquiry deals,
  // not shared deals across enquirers. Skip directly to create.

  // Option 3: create new enquiry deal on appropriate board, in first column
  const id = newDealId();
  const dataJson = JSON.stringify({
    addedAt:    Date.now(),
    auto_origin: 'inspection_attendance',
    auto_origin_listing_deal_id: listingDealId,
  });
  const workflow = WORKFLOW_FOR[enquiryBoardId];
  const stage    = ENQUIRY_INITIAL_STAGE;
  const columnId = ENQUIRY_INITIAL_COLUMN(enquiryBoardId);
  await sql`
    INSERT INTO deals (id, property_id, parcel_id, workflow, stage, status, data, board_id, column_id, parent_deal_id)
    VALUES (
      ${id}, ${propertyId ?? null}, ${parcelId ?? null},
      ${workflow}, ${stage}, 'active', ${dataJson}::jsonb,
      ${enquiryBoardId}, ${columnId}, ${listingDealId}
    )`;

  // Link the contact as 'enquirer' on the new deal (entity_contacts upsert)
  await sql`
    INSERT INTO entity_contacts (contact_id, entity_type, entity_id, role_id)
    VALUES (${contactId}, 'deal', ${id}, 'enquirer')
    ON CONFLICT (contact_id, entity_type, entity_id, role_id) DO NOTHING`;

  return id;
}

// ── Resolve the Listing Agent for a listing deal ──────────────────────────
//
// Used to decide who an auto-created Action should be assigned to.
// Returns: contact id (integer) or null if no listing agent on this deal.
async function resolveListingAgent(listingDealId) {
  const rows = await sql`
    SELECT contact_id FROM entity_contacts
    WHERE entity_type = 'deal'
      AND entity_id   = ${listingDealId}
      AND role_id     = 'listing_agent'
    ORDER BY linked_at ASC
    LIMIT 1`;
  return rows.length ? rows[0].contact_id : null;
}

// ── Build Action description for each trigger type ────────────────────────
function actionDescription(triggerType, contactName, propertyAddress) {
  const who   = contactName       || 'enquirer';
  const where = propertyAddress   || 'the listing';
  switch (triggerType) {
    case 'followup':   return `Followup with ${who} — attended inspection at ${where}`;
    case 'offer_form': return `Send offer form to ${who} — interested after inspection at ${where}`;
    case 'contract':   return `Send contract to ${who} — wants to proceed after inspection at ${where}`;
    default:           return `Action requested by ${who} at inspection of ${where}`;
  }
}

// ── Create one auto-Action on an Enquiry deal ─────────────────────────────
//
// Returns: action id (integer) or null if no listing agent could be resolved
// (we don't create assignee-less actions because actions.assignee_id is NOT NULL).
// In that case the trigger timestamp is still recorded; agent can manually create
// the action later.
async function createAutoAction({
  triggerType, enquiryDealId, listingAgentId, creatorId,
  contactName, propertyAddress,
}) {
  if (!listingAgentId) return null;
  const description = actionDescription(triggerType, contactName, propertyAddress);
  const rows = await sql`
    INSERT INTO actions (description, assignee_id, creator_id, deal_id, status)
    VALUES (${description}, ${listingAgentId}, ${creatorId}, ${enquiryDealId}, 'todo')
    RETURNING id`;
  return rows[0]?.id ?? null;
}

// ── Apply contact preferences to the contact row ──────────────────────────
//
// Sets the granular consent timestamps on the contacts table. Each is independent:
// any combination can be set or left alone. true → timestamp now(); false → no change.
async function applyContactPreferences(contactId, prefs) {
  const updates = [];
  if (prefs.privacy === true)         updates.push('privacy_consent_at = now()');
  if (prefs.email_marketing === true) updates.push('marketing_email_consent_at = now()');
  if (prefs.sms_marketing === true)   updates.push('marketing_sms_consent_at = now()');
  if (!updates.length) return;
  // Driver doesn't support dynamic column lists, so build branches by combination.
  // 7 combinations (2^3 - 1, all-false case skipped above).
  const p = prefs.privacy === true;
  const e = prefs.email_marketing === true;
  const s = prefs.sms_marketing === true;
  if      (p && e && s)  await sql`UPDATE contacts SET privacy_consent_at = now(), marketing_email_consent_at = now(), marketing_sms_consent_at = now() WHERE id = ${contactId}`;
  else if (p && e)       await sql`UPDATE contacts SET privacy_consent_at = now(), marketing_email_consent_at = now() WHERE id = ${contactId}`;
  else if (p && s)       await sql`UPDATE contacts SET privacy_consent_at = now(), marketing_sms_consent_at = now() WHERE id = ${contactId}`;
  else if (e && s)       await sql`UPDATE contacts SET marketing_email_consent_at = now(), marketing_sms_consent_at = now() WHERE id = ${contactId}`;
  else if (p)            await sql`UPDATE contacts SET privacy_consent_at = now() WHERE id = ${contactId}`;
  else if (e)            await sql`UPDATE contacts SET marketing_email_consent_at = now() WHERE id = ${contactId}`;
  else if (s)            await sql`UPDATE contacts SET marketing_sms_consent_at = now() WHERE id = ${contactId}`;
}

// ── Handler ────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  const session = await requireSession(req, res);
  if (!session) return;

  try {
    if (req.method === 'GET')    return await handleGet(req, res);
    if (req.method === 'POST')   return await handlePost(req, res, session);
    if (req.method === 'PUT')    return await handlePut(req, res, session);
    if (req.method === 'DELETE') return await handleDelete(req, res);
    res.setHeader('Allow', 'GET, POST, PUT, DELETE');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[api/inspection-attendances]', err);
    return res.status(500).json({ error: err.message });
  }
}

async function handleGet(req, res) {
  const { id, scheduled_inspection_id, enquiry_deal_id, contact_id } = req.query;

  // Common SELECT body — inlined into each branch (driver v0.10.x doesn't support
  // composing tagged template fragments).
  if (id) {
    const rows = await sql`
      SELECT a.*,
        c.first_name      AS contact_first_name,
        c.last_name       AS contact_last_name,
        si.scheduled_date,
        si.start_time,
        si.end_time,
        si.inspection_type,
        si.listing_deal_id
      FROM inspection_attendances a
      JOIN contacts             c  ON c.id  = a.contact_id
      JOIN scheduled_inspections si ON si.id = a.scheduled_inspection_id
      WHERE a.id = ${parseInt(id, 10)}`;
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    return res.status(200).json(rows[0]);
  }
  if (scheduled_inspection_id) {
    const rows = await sql`
      SELECT a.*,
        c.first_name      AS contact_first_name,
        c.last_name       AS contact_last_name,
        si.scheduled_date,
        si.start_time,
        si.end_time,
        si.inspection_type,
        si.listing_deal_id
      FROM inspection_attendances a
      JOIN contacts             c  ON c.id  = a.contact_id
      JOIN scheduled_inspections si ON si.id = a.scheduled_inspection_id
      WHERE a.scheduled_inspection_id = ${parseInt(scheduled_inspection_id, 10)}
      ORDER BY a.attended_at ASC`;
    return res.status(200).json(rows);
  }
  if (enquiry_deal_id) {
    const rows = await sql`
      SELECT a.*,
        c.first_name      AS contact_first_name,
        c.last_name       AS contact_last_name,
        si.scheduled_date,
        si.start_time,
        si.end_time,
        si.inspection_type,
        si.listing_deal_id
      FROM inspection_attendances a
      JOIN contacts             c  ON c.id  = a.contact_id
      JOIN scheduled_inspections si ON si.id = a.scheduled_inspection_id
      WHERE a.enquiry_deal_id = ${enquiry_deal_id}
      ORDER BY si.scheduled_date DESC, si.start_time DESC`;
    return res.status(200).json(rows);
  }
  if (contact_id) {
    const rows = await sql`
      SELECT a.*,
        c.first_name      AS contact_first_name,
        c.last_name       AS contact_last_name,
        si.scheduled_date,
        si.start_time,
        si.end_time,
        si.inspection_type,
        si.listing_deal_id
      FROM inspection_attendances a
      JOIN contacts             c  ON c.id  = a.contact_id
      JOIN scheduled_inspections si ON si.id = a.scheduled_inspection_id
      WHERE a.contact_id = ${parseInt(contact_id, 10)}
      ORDER BY si.scheduled_date DESC, si.start_time DESC`;
    return res.status(200).json(rows);
  }
  return res.status(400).json({
    error: 'Specify id, scheduled_inspection_id, enquiry_deal_id, or contact_id',
  });
}

async function handlePost(req, res, session) {
  const body = req.body || {};
  const {
    scheduled_inspection_id, contact_id,
    trigger_followup, trigger_offer_form, trigger_contract,
    contact_pref_privacy, contact_pref_email_marketing, contact_pref_sms_marketing,
    notes,
  } = body;

  if (!scheduled_inspection_id || !contact_id) {
    return res.status(400).json({ error: 'scheduled_inspection_id and contact_id required' });
  }

  // Fetch parent inspection + its listing deal context — single round-trip
  const ctx = await sql`
    SELECT si.id           AS si_id,
           si.listing_deal_id,
           d.board_id      AS listing_board_id,
           d.property_id,
           d.parcel_id,
           p.address       AS property_address,
           p.suburb        AS property_suburb,
           pa.name         AS parcel_name
    FROM scheduled_inspections si
    JOIN deals d ON d.id = si.listing_deal_id
    LEFT JOIN properties p  ON p.id  = d.property_id
    LEFT JOIN parcels    pa ON pa.id = d.parcel_id
    WHERE si.id = ${parseInt(scheduled_inspection_id, 10)}`;
  if (!ctx.length) {
    return res.status(404).json({ error: 'Scheduled inspection not found' });
  }
  const c = ctx[0];

  // Verify contact exists + grab name for action descriptions
  const contactRows = await sql`SELECT id, first_name, last_name FROM contacts WHERE id = ${parseInt(contact_id, 10)}`;
  if (!contactRows.length) return res.status(404).json({ error: 'Contact not found' });
  const contactName = [contactRows[0].first_name, contactRows[0].last_name].filter(Boolean).join(' ').trim() || `Contact #${contact_id}`;
  const propertyLabel = c.property_address
    ? `${c.property_address}${c.property_suburb ? ', ' + c.property_suburb : ''}`
    : (c.parcel_name || 'the listing');

  // 1. Find-or-create the Enquiry deal
  const enquiryDealId = await findOrCreateEnquiryDeal({
    listingDealId:   c.listing_deal_id,
    listingBoardId:  c.listing_board_id,
    propertyId:      c.property_id,
    parcelId:        c.parcel_id,
    contactId:       parseInt(contact_id, 10),
    session,
  });

  // 2. Ensure entity_contacts link (idempotent, in case the find branch ran on
  // a deal where contact had a different role — they should also be 'enquirer'
  // for this attendance link to make sense).
  await sql`
    INSERT INTO entity_contacts (contact_id, entity_type, entity_id, role_id)
    VALUES (${parseInt(contact_id, 10)}, 'deal', ${enquiryDealId}, 'enquirer')
    ON CONFLICT (contact_id, entity_type, entity_id, role_id) DO NOTHING`;

  // 3. Insert the attendance row with trigger timestamps (UNIQUE constraint
  // catches duplicate insertion of same contact at same inspection).
  const createdBy = resolveCreator(session);
  const nowIso     = new Date().toISOString();
  const tFollowup  = trigger_followup    === true ? nowIso : null;
  const tOfferForm = trigger_offer_form  === true ? nowIso : null;
  const tContract  = trigger_contract    === true ? nowIso : null;

  let attendanceRow;
  try {
    const rows = await sql`
      INSERT INTO inspection_attendances (
        scheduled_inspection_id, contact_id, enquiry_deal_id,
        notes,
        requested_followup_at, requested_offer_form_at, requested_contract_at,
        created_by
      )
      VALUES (
        ${parseInt(scheduled_inspection_id, 10)}, ${parseInt(contact_id, 10)}, ${enquiryDealId},
        ${notes ?? null},
        ${tFollowup}, ${tOfferForm}, ${tContract},
        ${createdBy}
      )
      RETURNING *`;
    attendanceRow = rows[0];
  } catch (err) {
    if (err.message && err.message.includes('inspection_attendances_scheduled')) {
      return res.status(409).json({
        error: `Contact #${contact_id} already recorded as attending inspection #${scheduled_inspection_id}. Use PUT to update.`,
      });
    }
    throw err;
  }

  // 4. Auto-create Actions for any triggered tickboxes (assigned to Listing Agent)
  const listingAgentId = await resolveListingAgent(c.listing_deal_id);
  const actionsCreated = [];
  if (trigger_followup === true) {
    const aid = await createAutoAction({
      triggerType: 'followup',
      enquiryDealId,
      listingAgentId,
      creatorId: createdBy,
      contactName,
      propertyAddress: propertyLabel,
    });
    if (aid) actionsCreated.push({ trigger: 'followup', action_id: aid });
  }
  if (trigger_offer_form === true) {
    const aid = await createAutoAction({
      triggerType: 'offer_form',
      enquiryDealId,
      listingAgentId,
      creatorId: createdBy,
      contactName,
      propertyAddress: propertyLabel,
    });
    if (aid) actionsCreated.push({ trigger: 'offer_form', action_id: aid });
  }
  if (trigger_contract === true) {
    const aid = await createAutoAction({
      triggerType: 'contract',
      enquiryDealId,
      listingAgentId,
      creatorId: createdBy,
      contactName,
      propertyAddress: propertyLabel,
    });
    if (aid) actionsCreated.push({ trigger: 'contract', action_id: aid });
  }

  // 5. Apply contact preferences (independent of attendance)
  await applyContactPreferences(parseInt(contact_id, 10), {
    privacy:         contact_pref_privacy,
    email_marketing: contact_pref_email_marketing,
    sms_marketing:   contact_pref_sms_marketing,
  });

  return res.status(201).json({
    attendance:        attendanceRow,
    enquiry_deal_id:   enquiryDealId,
    listing_agent_id:  listingAgentId,
    actions_created:   actionsCreated,
  });
}

async function handlePut(req, res, session) {
  const body = req.body || {};
  const id = body.id;
  if (!id) return res.status(400).json({ error: 'id required' });
  const attendanceId = parseInt(id, 10);

  // Fetch existing for context
  const existing = await sql`
    SELECT a.*, si.listing_deal_id,
           p.address AS property_address, p.suburb AS property_suburb,
           pa.name   AS parcel_name,
           c.first_name, c.last_name
    FROM inspection_attendances a
    JOIN scheduled_inspections si ON si.id = a.scheduled_inspection_id
    JOIN deals d ON d.id = si.listing_deal_id
    LEFT JOIN properties p  ON p.id  = d.property_id
    LEFT JOIN parcels    pa ON pa.id = d.parcel_id
    JOIN contacts c ON c.id = a.contact_id
    WHERE a.id = ${attendanceId}`;
  if (!existing.length) return res.status(404).json({ error: 'Not found' });
  const cur = existing[0];

  // Build an update of just the editable fields
  let nextNotes = cur.notes;
  if (body.notes !== undefined) {
    nextNotes = body.notes ? String(body.notes) : null;
  }

  // Trigger flag transitions: false→true creates Action; true→false clears timestamp
  // (but leaves any existing auto-Action — agent must close manually for audit trail).
  const willTriggerNew = [];
  let nextFollowup  = cur.requested_followup_at;
  let nextOfferForm = cur.requested_offer_form_at;
  let nextContract  = cur.requested_contract_at;

  if (body.trigger_followup !== undefined) {
    const wasOn = !!cur.requested_followup_at;
    const wantOn = body.trigger_followup === true;
    if (!wasOn && wantOn)        { nextFollowup = new Date().toISOString(); willTriggerNew.push('followup'); }
    else if (wasOn && !wantOn)   { nextFollowup = null; }
  }
  if (body.trigger_offer_form !== undefined) {
    const wasOn = !!cur.requested_offer_form_at;
    const wantOn = body.trigger_offer_form === true;
    if (!wasOn && wantOn)        { nextOfferForm = new Date().toISOString(); willTriggerNew.push('offer_form'); }
    else if (wasOn && !wantOn)   { nextOfferForm = null; }
  }
  if (body.trigger_contract !== undefined) {
    const wasOn = !!cur.requested_contract_at;
    const wantOn = body.trigger_contract === true;
    if (!wasOn && wantOn)        { nextContract = new Date().toISOString(); willTriggerNew.push('contract'); }
    else if (wasOn && !wantOn)   { nextContract = null; }
  }

  const rows = await sql`
    UPDATE inspection_attendances SET
      notes                    = ${nextNotes},
      requested_followup_at    = ${nextFollowup},
      requested_offer_form_at  = ${nextOfferForm},
      requested_contract_at    = ${nextContract}
    WHERE id = ${attendanceId}
    RETURNING *`;

  // Create Actions for any flags that just transitioned false→true
  let actionsCreated = [];
  if (willTriggerNew.length) {
    const listingAgentId = await resolveListingAgent(cur.listing_deal_id);
    const createdBy      = resolveCreator(session);
    const contactName    = [cur.first_name, cur.last_name].filter(Boolean).join(' ').trim() || `Contact #${cur.contact_id}`;
    const propertyLabel  = cur.property_address
      ? `${cur.property_address}${cur.property_suburb ? ', ' + cur.property_suburb : ''}`
      : (cur.parcel_name || 'the listing');
    for (const trig of willTriggerNew) {
      const aid = await createAutoAction({
        triggerType: trig,
        enquiryDealId:   cur.enquiry_deal_id,
        listingAgentId,
        creatorId:       createdBy,
        contactName,
        propertyAddress: propertyLabel,
      });
      if (aid) actionsCreated.push({ trigger: trig, action_id: aid });
    }
  }

  return res.status(200).json({
    attendance:      rows[0],
    actions_created: actionsCreated,
  });
}

async function handleDelete(req, res) {
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'id required' });
  const result = await sql`DELETE FROM inspection_attendances WHERE id = ${parseInt(id, 10)} RETURNING id`;
  if (!result.length) return res.status(404).json({ error: 'Not found' });
  return res.status(200).json({ ok: true });
}
