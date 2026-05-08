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

  // V77.3 — Append a "+ Create new contact" row to the contact search results.
  // Tapping it opens the standalone contact modal (body-mounted so it works
  // over the kanban deal modal on every device). On save, the newly-created
  // contact is auto-selected as state.contact and the Create Card button is
  // enabled — user can submit immediately without searching again.
  //
  // Used by both the Sales/Lease Enquiry contact pickers and (in future) any
  // other contact-search-with-create flow.
  function appendCreateNewContactRow(resultsEl, state, createBtn) {
    const row = document.createElement('div');
    row.className = 'knc-result knc-result-create';
    row.innerHTML = `
      <div class="knc-result-main"><strong>+ Create new contact</strong></div>
      <div class="knc-result-sub">Open the contact form to add their details</div>
    `;
    row.addEventListener('click', () => {
      // Make sure renderCRMView has run so the standalone helper is registered.
      const crmContainer = document.getElementById('crmViewContent');
      if (crmContainer && !crmContainer.dataset.rendered && window.CRM?.renderCRMView) {
        crmContainer.dataset.rendered = '1';
        window.CRM.renderCRMView(crmContainer);
      }
      if (typeof window.openContactModalStandalone !== 'function') {
        alert('Contact modal unavailable — please refresh the page.');
        return;
      }
      window.openContactModalStandalone(null, async (createdId) => {
        if (!createdId) return;
        try {
          // Re-fetch to get the full contact record (with first_name/last_name/email/mobile)
          const r = await fetch(`/api/contacts?id=${createdId}`);
          if (!r.ok) throw new Error(r.status);
          const data = await r.json();
          const ct = Array.isArray(data) ? data[0] : data;
          if (!ct) return;
          const name = [ct.first_name, ct.last_name].filter(Boolean).join(' ').trim() || `Contact #${ct.id}`;
          state.contact = { id: ct.id, label: name };
          // Reflect selection in the results list — clear any prior selection,
          // mark a synthetic selected row at the top so the user sees what's chosen.
          resultsEl.innerHTML = `
            <div class="knc-result knc-result-selected" data-id="${ct.id}">
              <div class="knc-result-main">${esc(name)} <span style="color:var(--muted);font-weight:normal">(just created)</span></div>
              ${ct.email || ct.mobile ? `<div class="knc-result-sub">${esc([ct.email, ct.mobile].filter(Boolean).join(' · '))}</div>` : ''}
            </div>
          `;
          createBtn.disabled = false;
        } catch (err) {
          console.warn('[knc] failed to fetch newly-created contact:', err);
          alert('Contact created but could not be auto-selected. Search for them by name.');
        }
      });
    });
    resultsEl.appendChild(row);
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
      property: null,           // for Listings boards
      listing:  null,           // for Enquiry boards (carries property_id + label)
      contact:  null,           // for both — required if eligible roles defined
      role_id:  null,           // V77.2g — the role chosen at creation
      _enquiryBoardId: boardId,
      _eligibleRoles:  [],      // V77.2g — populated from Lookups.getDefaultRolesForBoard
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

    // V77.2g — fetch eligible roles for this board, then render. If a role
    // requires the board, the contact step is mandatory; if no eligible roles
    // exist for the board, the contact step is skipped entirely.
    (async () => {
      try {
        if (window.Lookups && typeof Lookups.getDefaultRolesForBoard === 'function') {
          state._eligibleRoles = await Lookups.getDefaultRolesForBoard(boardId);
        }
      } catch (err) {
        console.warn('[knc] getDefaultRolesForBoard failed', err);
        state._eligibleRoles = [];
      }
      renderStep();
    })();

    function renderStep() {
      const body   = overlay.querySelector('[data-role="body"]');
      const footer = overlay.querySelector('[data-role="footer"]');
      const requireContact = (state._eligibleRoles || []).length > 0;

      if (cfg.mode === 'single') {
        // Listings boards. Step 1: property; Step 2: contact (only if board has eligible roles)
        if (state.step === 1) {
          renderPropertyPicker(body, footer, state, () => {
            if (requireContact) {
              state.step = 2;
              renderStep();
            } else {
              createDeal(state, boardId, cfg, close, onDealCreated);
            }
          });
        } else if (state.step === 2) {
          renderListingsContactPicker(body, footer, state, () => {
            createDeal(state, boardId, cfg, close, onDealCreated);
          });
        }
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
    const eligibleRoles = state._eligibleRoles || [];
    // V77.2g — role select. If only one eligible role, show it as read-only.
    // If multiple, the agent picks. State.role_id is initialised to the first
    // eligible role so a single-option case Just Works.
    if (!state.role_id && eligibleRoles.length) {
      state.role_id = eligibleRoles[0].id;
    }
    const roleSelectHtml = eligibleRoles.length > 1
      ? `<select class="kb-input knc-role-select">
          ${eligibleRoles.map(r => `<option value="${esc(r.id)}" ${r.id === state.role_id ? 'selected' : ''}>${esc(r.label)}</option>`).join('')}
        </select>`
      : eligibleRoles.length === 1
        ? `<input class="kb-input" type="text" value="${esc(eligibleRoles[0].label)}" disabled>`
        : '<div style="color:var(--muted);font-size:12px;font-style:italic;padding:6px 0">No role assigned (no Default Board Role configured for this board).</div>';

    body.innerHTML = `
      <div class="knc-step-summary">
        <span class="knc-step-label">Listing:</span> ${esc(state.listing.label)}
        <button class="knc-step-back" data-role="back">change</button>
      </div>
      <div class="kb-field-wrap" style="margin-top:10px">
        <label class="kb-field-label">Contact — search</label>
        <input class="kb-input knc-contact-search" type="text" placeholder="Type name or email…" autofocus>
      </div>
      <div class="knc-results" data-role="contact-results"></div>
      <div class="knc-empty-msg" data-role="empty-msg" style="display:none;color:var(--muted);font-size:12px;padding:8px 0">No matches. Create the contact in CRM first, then come back.</div>

      <div class="kb-field-wrap" style="margin-top:10px">
        <label class="kb-field-label">Role on this card</label>
        ${roleSelectHtml}
      </div>

      <!-- V77.1 — capture how the enquiry came in (interaction type + source) so the first inbound note is recorded with proper context -->
      <div class="knc-enquiry-context" style="margin-top:12px;padding-top:10px;border-top:1px solid var(--border)">
        <div class="kb-field-label" style="margin-bottom:6px">How did the enquirer reach you?</div>
        <div style="display:flex;gap:8px">
          <div class="kb-field-wrap" style="flex:1">
            <label class="kb-field-label">Type</label>
            <select class="kb-input knc-interaction-type">
              <option value="">Loading types…</option>
            </select>
          </div>
          <div class="kb-field-wrap" style="flex:1">
            <label class="kb-field-label">Source</label>
            <select class="kb-input knc-source">
              <option value="">— Select —</option>
            </select>
          </div>
        </div>
        <div class="kb-field-wrap" style="margin-top:10px">
          <label class="kb-field-label">Enquiry message <span style="color:var(--muted);font-weight:normal">(optional)</span></label>
          <textarea class="kb-input knc-enquiry-message" rows="3" placeholder="What did they ask? e.g. 'Available for inspection Saturday?', 'Is the price negotiable?'"></textarea>
        </div>
      </div>
    `;
    footer.innerHTML = `
      <button class="params-cancel-btn" data-role="close">Cancel</button>
      <button class="params-save-btn" data-role="create" disabled>Create Card</button>
    `;
    const search   = body.querySelector('.knc-contact-search');
    const results  = body.querySelector('[data-role="contact-results"]');
    const emptyMsg = body.querySelector('[data-role="empty-msg"]');
    // Wire role select if present
    const roleSel = body.querySelector('.knc-role-select');
    if (roleSel) {
      roleSel.addEventListener('change', () => { state.role_id = roleSel.value || null; });
    }
    const createBtn = footer.querySelector('[data-role="create"]');
    const typeSel = body.querySelector('.knc-interaction-type');
    const srcSel  = body.querySelector('.knc-source');

    // V77.1 — populate type + source dropdowns. Defaults bias toward the
    // common Enquiry case: phone_in (inbound) — and source dropdown is shown.
    if (window.Lookups && typeof Lookups.getInteractionTypes === 'function') {
      Lookups.getInteractionTypes().then(types => {
        if (!Array.isArray(types)) { typeSel.innerHTML = '<option value="">(none)</option>'; return; }
        // Filter to inbound-direction types (Enquiry first contact is inherently inbound)
        const inbound = types.filter(t => t.direction === 'inbound' && t.active !== false);
        if (!inbound.length) {
          typeSel.innerHTML = '<option value="">(no inbound types)</option>';
          return;
        }
        typeSel.innerHTML = '<option value="">— Select —</option>' + inbound.map(t => `<option value="${esc(t.id)}">${esc(t.label)}</option>`).join('');
        // Default to phone_in if present
        if (inbound.find(t => t.id === 'phone_in')) typeSel.value = 'phone_in';
      }).catch(err => { console.warn('[knc] interaction types load failed:', err); typeSel.innerHTML = '<option value="">— Select —</option>'; });
    } else {
      typeSel.innerHTML = '<option value="">— Select —</option>';
    }
    if (window.Lookups && typeof Lookups.getSourcesActive === 'function') {
      Lookups.getSourcesActive().then(sources => {
        if (!Array.isArray(sources) || !sources.length) {
          srcSel.innerHTML = '<option value="">(no sources)</option>';
          return;
        }
        srcSel.innerHTML = '<option value="">— Select —</option>' + sources.map(s => `<option value="${esc(s.id)}">${esc(s.label)}</option>`).join('');
      }).catch(err => { console.warn('[knc] sources load failed:', err); srcSel.innerHTML = '<option value="">— Select —</option>'; });
    } else {
      srcSel.innerHTML = '<option value="">— Select —</option>';
    }

    body.querySelector('[data-role="back"]').addEventListener('click', () => {
      state.step = 1;
      state.contact = null;
      state.interaction_type = null;
      state.source = null;
      // Re-render — pick up listing flow
      const overlay = body.closest('.v77-modal-overlay');
      if (overlay) {
        const dlgBody   = overlay.querySelector('[data-role="body"]');
        const dlgFooter = overlay.querySelector('[data-role="footer"]');
        renderListingPicker(dlgBody, dlgFooter, state, state._enquiryBoardId, () => {
          state.step = 2;
          renderContactPicker(dlgBody, dlgFooter, state, onPicked);
        });
      }
    });
    createBtn.addEventListener('click', () => {
      if (!state.contact) return;
      // Snapshot the type+source choices into state before invoking
      state.interaction_type = typeSel.value || null;
      state.source           = srcSel.value  || null;
      const msgEl = body.querySelector('.knc-enquiry-message');
      state.enquiry_message  = msgEl ? msgEl.value.trim() : '';
      onPicked();
    });

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
          // V77.3 — Always show the "+ Create new contact" row at the bottom
          // of the results list. When there are no matches, the create row is
          // the only entry; when there are matches, it sits below them.
          if (!contacts.length) {
            emptyMsg.style.display = 'none';
            results.innerHTML = '<div class="knc-result-empty" style="padding:8px 4px;color:var(--muted);font-size:12px">No matches.</div>';
          } else {
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
          }
          appendCreateNewContactRow(results, state, createBtn);
        } catch (err) {
          console.warn('[knc] contact search failed', err);
        }
      }, 300);
    });
    search.focus();
  }

  // ── Listings Contact picker (V77.2g) ─────────────────────────────────────
  //
  // Step 2 for Listings boards. Shows a contact search and a role select
  // populated from the eligible roles for this board. Mirrors the Enquiry
  // contact picker's UI but without the interaction_type/source fields
  // (those are Enquiry-only — they record how the enquiry came in).

  function renderListingsContactPicker(body, footer, state, onPicked) {
    const eligibleRoles = state._eligibleRoles || [];
    if (!state.role_id && eligibleRoles.length) {
      state.role_id = eligibleRoles[0].id;
    }
    const roleSelectHtml = eligibleRoles.length > 1
      ? `<select class="kb-input knc-role-select">
          ${eligibleRoles.map(r => `<option value="${esc(r.id)}" ${r.id === state.role_id ? 'selected' : ''}>${esc(r.label)}</option>`).join('')}
        </select>`
      : eligibleRoles.length === 1
        ? `<input class="kb-input" type="text" value="${esc(eligibleRoles[0].label)}" disabled>`
        : '<div style="color:var(--muted);font-size:12px;font-style:italic;padding:6px 0">No role assigned (no Default Board Role configured for this board).</div>';

    const propertyLabel = state.property
      ? [state.property.address, state.property.suburb].filter(Boolean).join(', ')
      : '—';

    body.innerHTML = `
      <div class="knc-step-summary">
        <span class="knc-step-label">Property:</span> ${esc(propertyLabel)}
        <button class="knc-step-back" data-role="back">change</button>
      </div>
      <div class="kb-field-wrap" style="margin-top:10px">
        <label class="kb-field-label">Contact — search</label>
        <input class="kb-input knc-contact-search" type="text" placeholder="Type name or email…" autofocus>
      </div>
      <div class="knc-results" data-role="contact-results"></div>
      <div class="knc-empty-msg" data-role="empty-msg" style="display:none;color:var(--muted);font-size:12px;padding:8px 0">No matches. Create the contact in CRM first, then come back.</div>

      <div class="kb-field-wrap" style="margin-top:10px">
        <label class="kb-field-label">Role on this card</label>
        ${roleSelectHtml}
      </div>
    `;
    footer.innerHTML = `
      <button class="params-cancel-btn" data-role="close">Cancel</button>
      <button class="params-save-btn" data-role="create" disabled>Create Card</button>
    `;

    const search    = body.querySelector('.knc-contact-search');
    const results   = body.querySelector('[data-role="contact-results"]');
    const emptyMsg  = body.querySelector('[data-role="empty-msg"]');
    const createBtn = footer.querySelector('[data-role="create"]');

    // Wire role select if present
    const roleSel = body.querySelector('.knc-role-select');
    if (roleSel) {
      roleSel.addEventListener('change', () => { state.role_id = roleSel.value || null; });
    }

    // Back button — return to property picker
    body.querySelector('[data-role="back"]').addEventListener('click', () => {
      state.step = 1;
      state.contact = null;
      state.role_id = eligibleRoles.length ? eligibleRoles[0].id : null;
      const overlay = body.closest('.v77-modal-overlay');
      if (overlay) {
        const dlgBody   = overlay.querySelector('[data-role="body"]');
        const dlgFooter = overlay.querySelector('[data-role="footer"]');
        renderPropertyPicker(dlgBody, dlgFooter, state, () => {
          state.step = 2;
          renderListingsContactPicker(dlgBody, dlgFooter, state, onPicked);
        });
      }
    });

    createBtn.addEventListener('click', () => {
      if (!state.contact) return;
      onPicked();
    });

    footer.querySelector('[data-role="close"]')?.addEventListener('click', () => {
      const overlay = body.closest('.v77-modal-overlay');
      if (overlay) overlay.remove();
    });

    // Contact search
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
          // V77.3 — Always show the "+ Create new contact" row at the bottom
          // of the results list. When there are no matches, the create row is
          // the only entry; when there are matches, it sits below them.
          if (!contacts.length) {
            emptyMsg.style.display = 'none';
            results.innerHTML = '<div class="knc-result-empty" style="padding:8px 4px;color:var(--muted);font-size:12px">No matches.</div>';
          } else {
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
          }
          appendCreateNewContactRow(results, state, createBtn);
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

      // V77.2g — link the chosen contact to the new deal with the chosen role.
      // Applies to both Listings and Enquiry flows whenever a contact was
      // selected. The role_id comes from the agent's pick (or auto-set when
      // there was only one eligible role).
      if (state.contact && state.role_id) {
        await fetch('/api/contacts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'link',
            contact_id:  state.contact.id,
            entity_type: 'deal',
            entity_id:   dealId,
            role_id:     state.role_id,
          }),
        });
      }

      // For two-step (Enquiry boards), also record the first inbound note
      // capturing how the enquiry came in (interaction_type + source).
      if (cfg.mode === 'two_step' && state.contact) {
        // V77.1 — first inbound note. Captures interaction_type + source so the
        // Enquiry timeline shows where the enquiry came from. The note is
        // attached to the deal AND tagged to the enquirer contact.
        // V77.3 — if the agent captured the enquirer's actual message in the
        // optional textarea, append it below the auto-generated summary line.
        try {
          const typeLabel = state.interaction_type ? state.interaction_type.replace(/_/g, ' ') : 'enquiry';
          const summary = `New ${typeLabel} enquiry from ${state.contact.label} for "${state.listing.label}".`;
          const msg = (state.enquiry_message || '').trim();
          const noteText = msg ? `${summary}\nEnquiry:\n${msg}` : summary;
          const body = {
            entity_type:       'deal',
            entity_id:         String(dealId),
            note_text:         noteText,
            tagged_contact_id: state.contact.id,
          };
          if (state.interaction_type) body.interaction_type = state.interaction_type;
          if (state.source)           body.source           = state.source;
          await fetch('/api/notes', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(body),
          });
        } catch (noteErr) {
          // Non-fatal — deal + link succeeded; just log
          console.warn('[knc] first-inbound-note creation failed:', noteErr);
        }
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
