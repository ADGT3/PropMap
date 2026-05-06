/**
 * api/enquiry-card-meta.js — V77.1 Phase 3.3
 *
 * Returns kanban card display metadata for Sales/Lease Enquiry deals:
 *   - enquirer contact name (first non-agent contact linked to the deal)
 *   - has_submitted_offer       (Lease Enquiry: any application status submitted/accepted)
 *   - has_evidence              (Lease Enquiry: any application has evidence_submitted_at)
 *   - latest_rent               (Lease Enquiry: latest application's requested_rent)
 *   - has_inspection_attended   (Sales Enquiry: any inspection_attendances row for this deal)
 *   - has_contract_requested    (Sales Enquiry: any note flagged as 'contract_requested' interaction)
 *
 * GET /api/enquiry-card-meta?deal_ids=id1,id2,id3
 *   → { deal_id: { contact_name, has_submitted_offer, has_evidence, latest_rent, has_inspection_attended, has_contract_requested } }
 *
 * Single-query batch — designed to be called once per board render.
 */

import { neon } from '@neondatabase/serverless';
import { requireSession } from '../lib/auth.js';
import { getDatabaseUrl } from '../lib/db.js';
const sql = neon(getDatabaseUrl());

export default async function handler(req, res) {
  const session = await requireSession(req, res);
  if (!session) return;

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const dealIdsRaw = (req.query.deal_ids || '').toString();
  if (!dealIdsRaw) return res.status(200).json({});
  const dealIds = dealIdsRaw.split(',').map(s => s.trim()).filter(Boolean);
  if (!dealIds.length) return res.status(200).json({});

  try {
    // Single multi-purpose query using array params via tagged-template ANY trick.
    // We do this in a few queries since neon's tagged template doesn't allow IN-list interpolation.
    // Using = ANY(${array}) pattern.

    // 1. Enquirer contact name — first non-agent contact linked to the deal
    const contactRows = await sql`
      SELECT ec.entity_id AS deal_id,
             c.first_name, c.last_name, c.org_name,
             ec.role_id
      FROM entity_contacts ec
      JOIN contacts c ON c.id = ec.contact_id
      WHERE ec.entity_type = 'deal'
        AND ec.entity_id = ANY(${dealIds})
        AND ec.role_id <> 'agent'
      ORDER BY ec.linked_at ASC`;

    // 2. Lease offer summary per deal
    const offerRows = await sql`
      SELECT deal_id,
             BOOL_OR(status = 'submitted' OR status = 'offer_accepted') AS has_submitted,
             BOOL_OR(evidence_submitted_at IS NOT NULL)               AS has_evidence,
             (
               SELECT requested_rent
               FROM applications a2
               WHERE a2.deal_id = a.deal_id
                 AND a2.requested_rent IS NOT NULL
               ORDER BY a2.created_at DESC
               LIMIT 1
             ) AS latest_rent
      FROM applications a
      WHERE deal_id = ANY(${dealIds})
      GROUP BY deal_id`;

    // 3. Inspection attended per deal (Sales Enquiry)
    //    — uses the inspection_attendances table where attended_at is set
    const inspRows = await sql`
      SELECT enquiry_deal_id AS deal_id, COUNT(*)::int AS attended_count
      FROM inspection_attendances
      WHERE enquiry_deal_id = ANY(${dealIds})
        AND attended_at IS NOT NULL
      GROUP BY enquiry_deal_id`;

    // 4. Contract requested per deal — proxied via a note with interaction_type='contract_request'
    //    (interaction_type seeded only if needed — tolerated absent here)
    const contractRows = await sql`
      SELECT entity_id AS deal_id, COUNT(*)::int AS contract_count
      FROM notes
      WHERE entity_type = 'deal'
        AND entity_id = ANY(${dealIds})
        AND interaction_type = 'contract_request'
      GROUP BY entity_id`;

    // Build lookup maps
    const contactsByDeal = {};
    contactRows.forEach(r => {
      if (!contactsByDeal[r.deal_id]) {
        const name = [r.first_name, r.last_name].filter(Boolean).join(' ').trim()
                  || r.org_name
                  || '';
        contactsByDeal[r.deal_id] = name;
      }
    });

    const offersByDeal = {};
    offerRows.forEach(r => {
      offersByDeal[r.deal_id] = {
        has_submitted: !!r.has_submitted,
        has_evidence:  !!r.has_evidence,
        latest_rent:   r.latest_rent != null ? parseFloat(r.latest_rent) : null,
      };
    });

    const inspByDeal = {};
    inspRows.forEach(r => {
      inspByDeal[r.deal_id] = (r.attended_count || 0) > 0;
    });

    const contractByDeal = {};
    contractRows.forEach(r => {
      contractByDeal[r.deal_id] = (r.contract_count || 0) > 0;
    });

    // Compose result
    const result = {};
    dealIds.forEach(id => {
      result[id] = {
        contact_name:              contactsByDeal[id]   || '',
        has_submitted_offer:       offersByDeal[id]?.has_submitted || false,
        has_evidence:              offersByDeal[id]?.has_evidence  || false,
        latest_rent:               offersByDeal[id]?.latest_rent   || null,
        has_inspection_attended:   inspByDeal[id]       || false,
        has_contract_requested:    contractByDeal[id]   || false,
      };
    });

    return res.status(200).json(result);
  } catch (err) {
    console.error('[enquiry-card-meta] error:', err);
    return res.status(500).json({ error: err.message });
  }
}
