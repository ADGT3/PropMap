/**
 * listing-summary-section.js — V77.1b
 *
 * Renders a read-only Listing Summary section on Sales Enquiry / Lease Enquiry
 * deal modals. Shows the parent Listing's address, current price (from the
 * Listing's Vendor Terms), settlement, current stage, and an "Open Listing"
 * button that navigates to the Listing deal modal.
 *
 * Why this exists: an Enquiry is logically about a Listing, not a Property
 * directly. The Enquiry deal carries `parent_deal_id` pointing at its Listing.
 * On the Enquiry modal, we replace the editable Vendor Terms section with this
 * read-only summary — the price/terms belong to the Listing, not the Enquiry.
 *
 * Public API (window.ListingSummarySection):
 *   ListingSummarySection.render(containerEl, dealId, boardId, parentDealId)
 *     - boardId must be sys_sales_enquiry or sys_lease_enquiry; else no-op
 *     - parentDealId is the listing deal's id (from deals.parent_deal_id)
 *     - If parentDealId is null, shows a "no parent listing linked" notice
 */

(function () {
  'use strict';

  function esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtPrice(v) {
    if (v == null || v === '') return '—';
    const n = Number(v);
    if (Number.isNaN(n)) return String(v);
    return `$${n.toLocaleString('en-AU')}`;
  }

  function fmtSettlement(v) {
    if (v == null || v === '') return '—';
    const n = Number(v);
    if (Number.isNaN(n)) return String(v);
    return `${n} days`;
  }

  async function render(containerEl, dealId, boardId, parentDealId) {
    if (boardId !== 'sys_sales_enquiry' && boardId !== 'sys_lease_enquiry') {
      containerEl.innerHTML = '';
      return;
    }

    if (!parentDealId) {
      containerEl.innerHTML = `
        <div class="kb-section-label" style="margin-top:12px">Listing</div>
        <div class="ls-empty">No parent listing linked. (Legacy enquiry deal — created before V77.1b.)</div>
      `;
      return;
    }

    containerEl.innerHTML = `
      <div class="kb-section-label" style="margin-top:12px">Listing</div>
      <div class="ls-summary" data-deal-id="${esc(parentDealId)}">
        <div class="ls-loading">Loading listing…</div>
      </div>
    `;

    try {
      // Fetch the listing deal — /api/deals supports ?id= for single-deal lookup
      const r = await fetch(`/api/deals?id=${encodeURIComponent(parentDealId)}`);
      if (!r.ok) throw new Error(r.status);
      const data = await r.json();
      // The endpoint may return either an array or an object — handle both
      const listing = Array.isArray(data) ? data[0] : data;
      if (!listing) {
        containerEl.querySelector('.ls-summary').innerHTML =
          '<div class="ls-error">Parent listing not found.</div>';
        return;
      }

      const terms = listing.data?.terms || {};
      const stage = listing.stage || '—';
      const status = listing.status || 'active';
      const address = listing.property?.address
        ? `${listing.property.address}${listing.property.suburb ? ', ' + listing.property.suburb : ''}`
        : '—';

      // Detect Sales vs Lease listing by parent's board_id
      const isLease = listing.board_id === 'sys_lease_listings';

      let primaryRow, metaRows = [];
      if (isLease) {
        // Lease: rent prominent, bond/term/available as meta
        const rentAmt    = terms.rent_amount;
        const rentPeriod = terms.rent_period || 'weekly';
        const rentLabel  = rentAmt != null
          ? `$${Number(rentAmt).toLocaleString('en-AU')}/${rentPeriod === 'monthly' ? 'month' : 'week'}`
          : '—';
        primaryRow = {
          label: 'Asking Rent',
          value: rentLabel,
          prominent: true,
        };
        if (terms.bond != null) {
          metaRows.push({ label: 'Bond', value: `$${Number(terms.bond).toLocaleString('en-AU')}` });
        }
        if (terms.term_months != null) {
          metaRows.push({ label: 'Term', value: `${terms.term_months} months` });
        }
        if (terms.available_from) {
          const d = new Date(terms.available_from);
          const formatted = !isNaN(d.getTime())
            ? `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`
            : terms.available_from;
          metaRows.push({ label: 'Available from', value: formatted });
        }
        if (terms.special_terms) {
          metaRows.push({ label: 'Special terms', value: terms.special_terms });
        }
      } else {
        // Sales: price prominent, settlement as meta
        primaryRow = {
          label: 'Listing Price',
          value: terms.price != null ? `$${Number(terms.price).toLocaleString('en-AU')}` : '—',
          prominent: true,
        };
        if (terms.settlement != null) {
          metaRows.push({ label: 'Settlement', value: `${terms.settlement} days` });
        }
      }

      const summary = containerEl.querySelector('.ls-summary');
      summary.innerHTML = `
        <div class="ls-row">
          <span class="ls-label">Address</span>
          <span class="ls-value">${esc(address)}</span>
        </div>
        <div class="ls-row">
          <span class="ls-label">${esc(primaryRow.label)}</span>
          <span class="ls-value ls-value-prom">${esc(primaryRow.value)}</span>
        </div>
        ${metaRows.map(r => `
          <div class="ls-row">
            <span class="ls-label">${esc(r.label)}</span>
            <span class="ls-value">${esc(r.value)}</span>
          </div>`).join('')}
        <div class="ls-row">
          <span class="ls-label">Stage</span>
          <span class="ls-value">${esc(stage)} <span class="ls-status-pill ls-status-${esc(status)}">${esc(status)}</span></span>
        </div>
        <div class="ls-actions">
          <button class="kb-toolbar-btn ls-open-btn" data-listing-id="${esc(parentDealId)}">Open Listing →</button>
        </div>
      `;

      // Wire "Open Listing" — close current modal, open the listing modal
      summary.querySelector('.ls-open-btn').addEventListener('click', () => {
        const listingId = summary.querySelector('.ls-open-btn').getAttribute('data-listing-id');
        // Close current modal first
        const overlay = containerEl.closest('.kb-modal-overlay');
        if (overlay) overlay.remove();
        // Open the listing modal — kanban exposes openPipelineItem on window
        if (typeof window.openPipelineItem === 'function') {
          window.openPipelineItem(listingId);
        }
      });
    } catch (err) {
      const summary = containerEl.querySelector('.ls-summary');
      if (summary) {
        summary.innerHTML = `<div class="ls-error">Could not load listing: ${esc(err.message)}</div>`;
      }
    }
  }

  window.ListingSummarySection = { render };
})();
