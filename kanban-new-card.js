/**
 * kanban-new-card.js — V77.1
 *
 * "+ New Card" toolbar button on the kanban for V77.1 system boards.
 * Per build plan §3.2 — board-aware single/two-step deal creation:
 *
 *   Sales Listings   — single-step: property picker → deal in Prospecting
 *   Lease Listings   — single-step: property picker → deal in Prospecting
 *   Sales Enquiry    — two-step:    property → contact → deal in Enquiry
 *                                   (entity_contacts role='enquirer' added)
 *   Lease Enquiry    — two-step:    property → contact → deal in Enquiry
 *                                   (entity_contacts role='enquirer' added)
 *
 *   Acquisition / user boards / Actions board — button hidden (existing flows
 *   handle these: map "+ Pipeline" for Acquisition, "+ New Action" for Actions).
 *
 * Property picker behaviour (per Q3): if no match, just say "Property not found."
 * — user is responsible for going to the map to create the property.
 *
 * Public API (window.KanbanNewCard):
 *   KanbanNewCard.attachToToolbar(toolbarEl, currentBoardId, onDealCreated)
 *     - Inserts the "+ New Card" button into toolbarEl if currentBoardId is
 *       a V77.1 system board; else removes any existing button.
 *     - onDealCreated is called with the new deal id after creation
 *
 *   KanbanNewCard.refresh(currentBoardId, onDealCreated)
 *     - Re-evaluates button visibility for the current board (call after
 *       board switch in kanban toolbar).
 */

(function () {
  'use strict';

  const SUPPORTED_BOARDS = {
    sys_sales_listings: { mode: 'single', label: 'Sales Listing', target_stage: 'prospecting', workflow: 'sales_listings' },
    sys_lease_listings: { mode: 'single', label: 'Lease Listing', target_stage: 'prospecting', workflow: 'lease_listings' },
    sys_sales_enquiry:  { mode: 'two_step', label: 'Sales Enquiry', target_stage: 'enquiry', workflow: 'sales_enquiry' },
    sys_lease_enquiry:  { mode: 'two_step', label: 'Lease Enquiry', target_stage: 'enquiry', workflow: 'lease_enquiry' },
  };

  function esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function showToast(message, kind = 'success') {
    let toast = document.querySelector('.v77-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'v77-toast';
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.remove('v77-toast-success', 'v77-toast-error', 'v77-toast-info');
    toast.classList.add(`v77-toast-${kind}`);
    toast.classList.add('v77-toast-visible');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toast.classList.remove('v77-toast-visible'), 4000);
  }

  // ── Attach button to toolbar ──────────────────────────────────────────────

  function attachToToolbar(toolbarEl, currentBoardId, onDealCreated) {
    if (!toolbarEl) return;
    // Remove any existing button first
    const existing = toolbarEl.querySelector('#kanbanNewCardBtn');
    if (existing) existing.remove();

    const cfg = SUPPORTED_BOARDS[currentBoardId];
    if (!cfg) return; // not a supported board, button hidden

    const btn = document.createElement('button');
    btn.id = 'kanbanNewCardBtn';
    btn.className = 'kb-toolbar-btn knc-btn';
    btn.title = `Create a new ${cfg.label} card`;
    btn.textContent = '+ New Card';
    btn.addEventListener('click', () => {
      openNewCardDialog(currentBoardId, onDealCreated);
    });

    // Insert near the "+ Board" button
    const newBoardBtn = toolbarEl.querySelector('#kanbanNewBoardBtn');
    if (newBoardBtn) {
      newBoardBtn.parentNode.insertBefore(btn, newBoardBtn);
    } else {
      toolbarEl.appendChild(btn);
    }
  }

  function refresh(currentBoardId, onDealCreated) {
    const toolbar = document.getElementById('kanbanBoardToolbar');
    if (toolbar) attachToToolbar(toolbar, currentBoardId, onDealCreated);
  }

  // ── Dialog ────────────────────────────────────────────────────────────────

  function openNewCardDialog(boardId, onDealCreated) {
    const cfg = SUPPORTED_BOARDS[boardId];
    if (!cfg) return;

    // State for the multi-step flow
    const state = {
      step: 1,
      property: null,           // for Listings boards (single-step)
      listing:  null,           // for Enquiry boards (carries property_id + label)
      contact:  null,           // for Enquiry boards
      _enquiryBoardId: boardId, // used by contact picker's back-button
    };

    const overlay = document.createElement('div');
    overlay.className = 'v77-modal-overlay';
    overlay.innerHTML = `
      <div class="v77-modal" style="max-width:560px">
        <div class="v77-modal-header">
          <div class="v77-modal-title">New ${esc(cfg.label)} Card</div>
          <button class="v77-modal-close" data-role="close">✕</button>
        </div>
        <div class="v77-modal-body" data-role="body">
          <div class="knc-loading">Loading…</div>
        </div>
        <div class="v77-modal-footer" data-role="footer">
          <button class="params-cancel-btn" data-role="close">Cancel</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.querySelectorAll('[data-role="close"]').forEach(b => b.addEventListener('click', close));
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

    function renderStep() {
      const body   = overlay.querySelector('[data-role="body"]');
      const footer = overlay.querySelector('[data-role="footer"]');
      if (cfg.mode === 'single') {
        // Single-step: just pick a property and create
        renderPropertyPicker(body, footer, state, () => {
          createDeal(state, boardId, cfg, close, onDealCreated);
        });
      } else {
        // Two-step (Enquiry boards): listing-pick → contact-pick → create
        if (state.step === 1) {
          renderListingPicker(body, footer, state, boardId, () => {
            state.step = 2;
            renderStep();
          });
        } else if (state.step === 2) {
          renderContactPicker(body, footer, state, () => {
            createDeal(state, boardId, cfg, close, onDealCreated);
          });
        }
      }
    }
    renderStep();
  }

  // ── Property picker ───────────────────────────────────────────────────────

  function renderPropertyPicker(body, footer, state, onPicked) {
    body.innerHTML = `
      <div class="kb-field-wrap">
        <label class="kb-field-label">Property — search by address</label>
        <input class="kb-input knc-prop-search" type="text" placeholder="Type address or suburb…" autofocus>
      </div>
      <div class="knc-results" data-role="prop-results"></div>
      <div class="knc-empty-msg" data-role="empty-msg" style="display:none;color:var(--muted);font-size:12px;padding:8px 0">Property not found.</div>
    `;
    footer.innerHTML = `
      <button class="params-cancel-btn" data-role="close">Cancel</button>
      <button class="params-save-btn" data-role="next" disabled>Next</button>
    `;

    const search   = body.querySelector('.knc-prop-search');
    const results  = body.querySelector('[data-role="prop-results"]');
    const emptyMsg = body.querySelector('[data-role="empty-msg"]');
    const nextBtn  = footer.querySelector('[data-role="next"]');
    nextBtn.addEventListener('click', () => { if (state.property) onPicked(); });

    let _t = null;
    search.addEventListener('input', () => {
      clearTimeout(_t);
      const q = search.value.trim();
      results.innerHTML = '';
      emptyMsg.style.display = 'none';
      state.property = null;
      nextBtn.disabled = true;
      if (!q) return;
      _t = setTimeout(async () => {
        try {
          const r = await fetch(`/api/properties?search=${encodeURIComponent(q)}`);
          if (!r.ok) throw new Error(r.status);
          const props = await r.json();
          if (!props.length) {
            emptyMsg.style.display = '';
            return;
          }
          results.innerHTML = props.slice(0, 10).map(p => {
            const addr = p.address || '—';
            const sub  = p.suburb ? `, ${p.suburb}` : '';
            return `
              <div class="knc-result" data-id="${esc(p.id)}" data-label="${esc(addr + sub)}">
                <div class="knc-result-main">${esc(addr + sub)}</div>
                ${p.lot_dps ? `<div class="knc-result-sub">${esc(p.lot_dps)}</div>` : ''}
              </div>
            `;
          }).join('');
          results.querySelectorAll('.knc-result').forEach(item => {
            item.addEventListener('click', () => {
              results.querySelectorAll('.knc-result').forEach(x => x.classList.remove('knc-result-selected'));
              item.classList.add('knc-result-selected');
              state.property = { id: item.getAttribute('data-id'), label: item.getAttribute('data-label') };
              nextBtn.disabled = false;
            });
          });
        } catch (err) {
          console.warn('[knc] property search failed', err);
        }
      }, 300);
    });

    // Bind close
    footer.querySelector('[data-role="close"]')?.addEventListener('click', () => {
      const overlay = body.closest('.v77-modal-overlay');
      if (overlay) overlay.remove();
    });
    search.focus();
  }

  // ── Listing picker (Enquiry boards step 1) ───────────────────────────────
  // Searches active Listing deals (Sales Listings or Lease Listings — matched
  // to the Enquiry board's siblings). Returns deal id + property snapshot
  // (address + suburb + price from deal.data.terms.price).

  function renderListingPicker(body, footer, state, enquiryBoardId, onPicked) {
    const targetListingBoard = enquiryBoardId === 'sys_sales_enquiry'
      ? 'sys_sales_listings'
      : 'sys_lease_listings';
    const targetLabel = enquiryBoardId === 'sys_sales_enquiry'
      ? 'Sales Listing'
      : 'Lease Listing';

    body.innerHTML = `
      <div class="kb-field-wrap">
        <label class="kb-field-label">${esc(targetLabel)} — search by address</label>
        <input class="kb-input knc-listing-search" type="text" placeholder="Type address or suburb…" autofocus>
      </div>
      <div class="knc-results" data-role="listing-results"></div>
      <div class="knc-empty-msg" data-role="empty-msg" style="display:none;color:var(--muted);font-size:12px;padding:8px 0">No active ${esc(targetLabel)} found at that address.</div>
    `;
    footer.innerHTML = `
      <button class="params-cancel-btn" data-role="close">Cancel</button>
      <button class="params-save-btn" data-role="next" disabled>Next</button>
    `;

    const search    = body.querySelector('.knc-listing-search');
    const results   = body.querySelector('[data-role="listing-results"]');
    const emptyMsg  = body.querySelector('[data-role="empty-msg"]');
    const nextBtn   = footer.querySelector('[data-role="next"]');
    nextBtn.addEventListener('click', () => { if (state.listing) onPicked(); });

    let _t = null;
    search.addEventListener('input', () => {
      clearTimeout(_t);
      const q = search.value.trim();
      results.innerHTML = '';
      emptyMsg.style.display = 'none';
      state.listing = null;
      nextBtn.disabled = true;
      if (!q) return;
      _t = setTimeout(async () => {
        try {
          // Fetch all deals on the target listing board, filter client-side by address
          const r = await fetch(`/api/deals?board_id=${encodeURIComponent(targetListingBoard)}&status=active`);
          if (!r.ok) throw new Error(r.status);
          const deals = await r.json();
          const ql = q.toLowerCase();
          const matches = deals.filter(d => {
            const addr = (d.property?.address || '').toLowerCase();
            const sub  = (d.property?.suburb  || '').toLowerCase();
            return addr.includes(ql) || sub.includes(ql);
          });
          if (!matches.length) {
            emptyMsg.style.display = '';
            return;
          }
          results.innerHTML = matches.slice(0, 10).map(d => {
            const addr = d.property?.address || '—';
            const sub  = d.property?.suburb ? `, ${d.property.suburb}` : '';
            const stage = d.stage ? `<span class="knc-listing-stage">${esc(d.stage)}</span>` : '';
            const t = d.data?.terms || {};
            const isLease = targetListingBoard === 'sys_lease_listings';
            let priceLabel;
            if (isLease) {
              const r = t.rent_amount;
              const period = t.rent_period === 'monthly' ? 'month' : 'week';
              priceLabel = r != null
                ? `$${Number(r).toLocaleString('en-AU')}/${period}`
                : '<span style="color:var(--muted)">no rent set</span>';
            } else {
              priceLabel = t.price != null
                ? `$${Number(t.price).toLocaleString('en-AU')}`
                : '<span style="color:var(--muted)">no price set</span>';
            }
            return `
              <div class="knc-result" data-id="${esc(d.id)}" data-property-id="${esc(d.property_id || '')}" data-label="${esc(addr + sub)}">
                <div class="knc-result-main">${esc(addr + sub)} ${stage}</div>
                <div class="knc-result-sub">${isLease ? 'Rent' : 'Listing'}: ${priceLabel}</div>
              </div>
            `;
          }).join('');
          results.querySelectorAll('.knc-result').forEach(item => {
            item.addEventListener('click', () => {
              results.querySelectorAll('.knc-result').forEach(x => x.classList.remove('knc-result-selected'));
              item.classList.add('knc-result-selected');
              state.listing = {
                id:          item.getAttribute('data-id'),
                property_id: item.getAttribute('data-property-id'),
                label:       item.getAttribute('data-label'),
              };
              nextBtn.disabled = false;
            });
          });
        } catch (err) {
          console.warn('[knc] listing search failed', err);
        }
      }, 300);
    });

    footer.querySelector('[data-role="close"]')?.addEventListener('click', () => {
      const overlay = body.closest('.v77-modal-overlay');
      if (overlay) overlay.remove();
    });
    search.focus();
  }

  // ── Contact picker (two-step only) ───────────────────────────────────────

  function renderContactPicker(body, footer, state, onPicked) {
    body.innerHTML = `
      <div class="knc-step-summary">
        <span class="knc-step-label">Listing:</span> ${esc(state.listing.label)}
        <button class="knc-step-back" data-role="back">change</button>
      </div>
      <div class="kb-field-wrap" style="margin-top:10px">
        <label class="kb-field-label">Enquirer — search contact</label>
        <input class="kb-input knc-contact-search" type="text" placeholder="Type name or email…" autofocus>
      </div>
      <div class="knc-results" data-role="contact-results"></div>
      <div class="knc-empty-msg" data-role="empty-msg" style="display:none;color:var(--muted);font-size:12px;padding:8px 0">No matches. Create the contact in CRM first, then come back.</div>
    `;
    footer.innerHTML = `
      <button class="params-cancel-btn" data-role="close">Cancel</button>
      <button class="params-save-btn" data-role="create" disabled>Create Card</button>
    `;
    const search   = body.querySelector('.knc-contact-search');
    const results  = body.querySelector('[data-role="contact-results"]');
    const emptyMsg = body.querySelector('[data-role="empty-msg"]');
    const createBtn = footer.querySelector('[data-role="create"]');

    body.querySelector('[data-role="back"]').addEventListener('click', () => {
      state.step = 1;
      state.contact = null;
      // Re-render — pick up listing flow
      const overlay = body.closest('.v77-modal-overlay');
      if (overlay) {
        const dlgBody   = overlay.querySelector('[data-role="body"]');
        const dlgFooter = overlay.querySelector('[data-role="footer"]');
        // Determine board from where we came — closure captures it via openNewCardDialog scope
        // The modal title still has it — extract once and use
        renderListingPicker(dlgBody, dlgFooter, state, state._enquiryBoardId, () => {
          state.step = 2;
          renderContactPicker(dlgBody, dlgFooter, state, onPicked);
        });
      }
    });
    createBtn.addEventListener('click', () => { if (state.contact) onPicked(); });

    footer.querySelector('[data-role="close"]')?.addEventListener('click', () => {
      const overlay = body.closest('.v77-modal-overlay');
      if (overlay) overlay.remove();
    });

    let _t = null;
    search.addEventListener('input', () => {
      clearTimeout(_t);
      const q = search.value.trim();
      results.innerHTML = '';
      emptyMsg.style.display = 'none';
      state.contact = null;
      createBtn.disabled = true;
      if (!q) return;
      _t = setTimeout(async () => {
        try {
          const r = await fetch(`/api/contacts?search=${encodeURIComponent(q)}`);
          if (!r.ok) throw new Error(r.status);
          const contacts = await r.json();
          if (!contacts.length) {
            emptyMsg.style.display = '';
            return;
          }
          results.innerHTML = contacts.slice(0, 10).map(c => {
            const name = [c.first_name, c.last_name].filter(Boolean).join(' ').trim() || `Contact #${c.id}`;
            const meta = [c.email, c.mobile].filter(Boolean).join(' · ');
            return `
              <div class="knc-result" data-id="${c.id}" data-label="${esc(name)}">
                <div class="knc-result-main">${esc(name)}</div>
                ${meta ? `<div class="knc-result-sub">${esc(meta)}</div>` : ''}
              </div>
            `;
          }).join('');
          results.querySelectorAll('.knc-result').forEach(item => {
            item.addEventListener('click', () => {
              results.querySelectorAll('.knc-result').forEach(x => x.classList.remove('knc-result-selected'));
              item.classList.add('knc-result-selected');
              state.contact = { id: parseInt(item.getAttribute('data-id'), 10), label: item.getAttribute('data-label') };
              createBtn.disabled = false;
            });
          });
        } catch (err) {
          console.warn('[knc] contact search failed', err);
        }
      }, 300);
    });
    search.focus();
  }

  // ── Create the deal + entity link (for two-step) ─────────────────────────

  async function createDeal(state, boardId, cfg, close, onDealCreated) {
    // For Listings boards: state.property carries the chosen property
    // For Enquiry boards: state.listing carries the parent listing deal info
    //   - listing.id  → goes into parent_deal_id on the new Enquiry deal
    //   - listing.property_id → also carried so the Enquiry deal has property_id
    //     (transitively the same as the Listing's property)
    let propertyId, parentDealId;
    if (cfg.mode === 'single') {
      propertyId   = state.property.id;
      parentDealId = null;
    } else {
      propertyId   = state.listing.property_id;
      parentDealId = state.listing.id;
    }
    const stage    = cfg.target_stage;
    const workflow = cfg.workflow;
    try {
      // Create the deal
      const r = await fetch('/api/deals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          property_id:    propertyId,
          board_id:       boardId,
          stage,
          workflow,
          parent_deal_id: parentDealId,
          data: {},
        }),
      });
      if (!r.ok) {
        const err = await r.json();
        alert(err.error || 'Create failed');
        return;
      }
      const result = await r.json();
      const dealId = result.id || result.deal?.id;
      if (!dealId) throw new Error('No deal id returned');

      // For two-step (Enquiry boards), also create the entity_contacts link
      if (cfg.mode === 'two_step' && state.contact) {
        await fetch('/api/contacts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'link',
            contact_id:  state.contact.id,
            entity_type: 'deal',
            entity_id:   dealId,
            role_id:     'enquirer',
          }),
        });
      }

      showToast(`${cfg.label} card created`, 'success');
      close();
      if (onDealCreated) onDealCreated(dealId);
    } catch (err) {
      alert('Create failed: ' + err.message);
    }
  }

  // ── Expose ────────────────────────────────────────────────────────────────

  window.KanbanNewCard = { attachToToolbar, refresh };
})();
