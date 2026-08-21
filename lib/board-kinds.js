/**
 * lib/board-kinds.js
 *
 * Board "kind" + feature flags replace hard-coded sys_* board id checks.
 *
 * kind     — stable product semantics (acquisition, sales_enquiry, …)
 * features — capability flags the UI mounts sections from
 *
 * System boards are seeded with kind+features. Custom boards inherit kind
 * defaults unless features are overridden on the row.
 */

export const BOARD_KINDS = Object.freeze({
  acquisition: {
    label: 'Acquisition',
    features: Object.freeze([
      'dd',
      'finance',
      'vendor_terms',
      'map_highlight',
      'full_property_card',
      'pipeline_map_stages',
    ]),
  },
  sales_enquiry: {
    label: 'Sales Enquiry',
    features: Object.freeze([
      'enquiry_contacts',
      'interest_level',
      'enquiry_card',
    ]),
  },
  lease_enquiry: {
    label: 'Lease Enquiry',
    features: Object.freeze([
      'enquiry_contacts',
      'interest_level',
      'enquiry_card',
      'lease_offer',
      'validation',
    ]),
  },
  sales_listing: {
    label: 'Sales Listing',
    features: Object.freeze([
      'vendor_terms',
      'listing_summary',
      'agency_agreements',
      'listing_card',
    ]),
  },
  lease_listing: {
    label: 'Lease Listing',
    features: Object.freeze([
      'lease_terms',
      'listing_summary',
      'agency_agreements',
      'lease_offers_received',
      'listing_card',
      'rent_display',
    ]),
  },
  action: {
    label: 'Actions',
    features: Object.freeze(['actions_board']),
  },
  custom: {
    label: 'Custom',
    features: Object.freeze(['full_property_card']),
  },
});

/** Infer kind from legacy system board ids when DB kind is null. */
export const BOARD_ID_TO_KIND = Object.freeze({
  sys_acquisition:    'acquisition',
  sys_sales_enquiry:  'sales_enquiry',
  sys_lease_enquiry:  'lease_enquiry',
  sys_sales_listings: 'sales_listing',
  sys_lease_listings: 'lease_listing',
});

export function kindForBoardId(boardId) {
  return BOARD_ID_TO_KIND[boardId] || null;
}

/**
 * Resolve effective kind + features for a board row (API or client shape).
 * @param {{ id?: string, kind?: string|null, features?: string[]|null, board_type?: string }} board
 */
export function resolveBoardCapabilities(board) {
  if (!board) {
    return { kind: null, features: Object.freeze([]) };
  }
  let kind = board.kind || kindForBoardId(board.id) || null;
  if (!kind && board.board_type === 'action') kind = 'action';
  if (!kind) kind = 'custom';

  const defaults = BOARD_KINDS[kind]?.features || BOARD_KINDS.custom.features;
  const override = Array.isArray(board.features) && board.features.length > 0
    ? board.features
    : null;
  const features = Object.freeze([...(override || defaults)]);
  return { kind, features };
}

export function boardHasFeature(board, feature) {
  return resolveBoardCapabilities(board).features.includes(feature);
}
