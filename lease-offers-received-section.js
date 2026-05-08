/**
 * lease-offers-received-section.js — V77.1
 *
 * Read-only cross-reference of all Lease Offers received on a Lease Listing.
 * Pulls applications via the listing_deal_id endpoint, which the API joins
 * through Enquiry deals (parent_deal_id → this listing) to surface offers.
 *
 * Mounted on Lease Listing deal modal (board_id === 'sys_lease_listings').
 *
 * Each row shows: enquirer name + status badge + rent + meta. Click any row →
 * opens the relevant Lease Enquiry deal modal (where the offer lives).
 *
 * Public API:
 *   LeaseOffersReceivedSection.mount(containerEl, listingDealId) → { destroy, refresh }
 */

(function () {
  'use strict';

  const API = '/api/applications';

  const STATUS_LABELS = {
    draft:               'Draft',
    submitted:           'Submitted',
    offer_accepted:      'Accepted',
    rejected:            'Rejected',
    evidence_submitted:  'Evidence in',
    validated:           'Validated',
    leased:              'Leased',
    withdrawn:           'Withdrawn',
  };

  const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  function fmtCurrency(n) {
    if (n == null || n === '') return '—';
    const num = parseFloat(n);
    if (isNaN(num)) return '—';
    return '$' + Math.round(num).toLocaleString('en-AU');
  }
  function fmtDate(s) {
    if (!s) return '—';
    const d = new Date(s);
    if (isNaN(d.getTime())) return s;
    return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;
  }

  function mount(containerEl, listingDealId) {
    if (!containerEl || !listingDealId) return { destroy() {}, refresh() {} };

    containerEl.innerHTML = `
      <div class="lor-section">
        <div class="kb-section-label" style="margin-top:16px">Lease Offers Received</div>
        <div class="lor-list" data-role="list"></div>
      </div>
    `;
    const listEl = containerEl.querySelector('[data-role="list"]');

    async function load() {
      listEl.innerHTML = '<div class="lor-loading">Loading…</div>';
      try {
        const r = await fetch(`${API}?listing_deal_id=${encodeURIComponent(listingDealId)}`);
        if (!r.ok) throw new Error(r.status);
        const offers = await r.json();
        render(offers);
      } catch (err) {
        listEl.innerHTML = '<div class="lor-empty">Could not load offers.</div>';
        console.warn('[LeaseOffersReceived] load failed:', err);
      }
    }

    function render(offers) {
      if (!offers.length) {
        listEl.innerHTML = '<div class="lor-empty">No lease offers received yet.</div>';
        return;
      }
      // Sort: highest rent first, then most recent
      offers.sort((a, b) => {
        const ar = parseFloat(a.requested_rent) || 0;
        const br = parseFloat(b.requested_rent) || 0;
        if (br !== ar) return br - ar;
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      });
      listEl.innerHTML = offers.map(o => {
        const statusLbl = STATUS_LABELS[o.status] || o.status;
        const enquirerLabel = o.enquirer_name || `Enquiry #${o.deal_id || ''}`;
        const rent = o.requested_rent ? `${fmtCurrency(o.requested_rent)}/wk` : '—';
        const term = o.lease_term_months ? `${o.lease_term_months} mo` : '—';
        const start = fmtDate(o.preferred_start_date);
        return `
          <div class="lor-row" data-deal-id="${esc(o.deal_id || '')}">
            <div class="lor-row-main">
              <div class="lor-row-headline">
                <span class="lor-status lor-status-${esc((o.status || '').replace(/_/g, '-'))}">${esc(statusLbl)}</span>
                <strong class="lor-enquirer">${esc(enquirerLabel)}</strong>
                <span class="lor-rent">${esc(rent)}</span>
              </div>
              <div class="lor-meta">Term ${esc(term)} · From ${esc(start)}${o.terms ? ` · ${esc(o.terms)}` : ''}</div>
            </div>
            <button class="lor-open-btn" type="button">Open →</button>
          </div>
        `;
      }).join('');

      // Wire row clicks → open Enquiry deal
      listEl.querySelectorAll('.lor-row').forEach(row => {
        const dealId = row.getAttribute('data-deal-id');
        if (!dealId) return;
        const open = () => {
          if (typeof window.openPipelineItem === 'function') {
            window.openPipelineItem(dealId);
          } else {
            console.warn('[LeaseOffersReceived] openPipelineItem unavailable');
          }
        };
        row.querySelector('.lor-open-btn').addEventListener('click', open);
        row.addEventListener('click', (e) => {
          // Allow clicks on the main area to also open
          if (!e.target.closest('button')) open();
        });
      });
    }

    load();

    return {
      destroy: () => { containerEl.innerHTML = ''; },
      refresh: load,
    };
  }

  window.LeaseOffersReceivedSection = { mount };
})();
