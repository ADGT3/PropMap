/**
 * agency-agreements-section.js — V77.1
 *
 * Renders the Agency Agreements section on a Sales Listing or Lease Listing
 * deal modal. Multiple agreements can exist per deal (e.g. one for sale and
 * one for lease — agreement_type is 'sale' or 'lease', no 'both' per build
 * plan v0.17 §12 Q3).
 *
 * Each row displays:
 *   - Agreement type badge (sale/lease)
 *   - Appointed company name (linked to /api/organisations)
 *   - Date range with computed status (pending/active/expired/terminated)
 *   - Rate (e.g. "2.5% of price" or "$25,000 flat")
 *   - Payout trigger
 *   - Edit / Delete buttons
 *
 * Public API (window.AgencyAgreementsSection):
 *   AgencyAgreementsSection.render(containerEl, dealId, boardId)
 */

(function () {
  'use strict';

  const RATE_TYPES = [
    { id: 'percent_of_price', label: '% of price' },
    { id: 'flat_fee',         label: 'Flat fee' },
    { id: 'percent_of_rent',  label: '% of rent' },
  ];

  const PAYOUT_TRIGGERS_FOR = {
    sale:  [
      { id: 'acceptance',    label: 'On acceptance' },
      { id: 'unconditional', label: 'On unconditional' },
      { id: 'settlement',    label: 'On settlement' },
    ],
    lease: [
      { id: 'on_signing',  label: 'On signing' },
      { id: 'on_move_in',  label: 'On move-in' },
      { id: 'monthly',     label: 'Monthly' },
    ],
  };

  const STATUS_BADGE_CLASS = {
    pending:    'aa-status-pending',
    active:     'aa-status-active',
    expired:    'aa-status-expired',
    terminated: 'aa-status-terminated',
  };

  function esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtDate(d) {
    if (!d) return '—';
    const dt = new Date(d);
    if (isNaN(dt.getTime())) return '—';
    const pad = n => String(n).padStart(2, '0');
    return `${pad(dt.getDate())}/${pad(dt.getMonth()+1)}/${dt.getFullYear()}`;
  }

  function fmtRate(rate_type, rate_value) {
    if (rate_value == null) return '—';
    if (rate_type === 'percent_of_price' || rate_type === 'percent_of_rent') {
      return `${Number(rate_value)}%`;
    }
    if (rate_type === 'flat_fee') {
      return `$${Number(rate_value).toLocaleString('en-AU')}`;
    }
    return String(rate_value);
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

  // ── Render ────────────────────────────────────────────────────────────────

  async function render(containerEl, dealId, boardId) {
    if (boardId !== 'sys_sales_listings' && boardId !== 'sys_lease_listings') {
      containerEl.innerHTML = '';
      return;
    }
    containerEl.innerHTML = `
      <div class="kb-section-label" style="margin-top:16px">Agency Agreements</div>
      <div class="aa-section" data-deal-id="${esc(dealId)}" data-board-id="${esc(boardId)}">
        <div class="aa-list" data-role="list">
          <div class="aa-loading">Loading…</div>
        </div>
        <div class="aa-add-row" data-role="add-row">
          <button class="kb-toolbar-btn aa-add-btn" data-role="add-btn">+ New Agreement</button>
        </div>
        <div class="aa-add-form" data-role="add-form" style="display:none"></div>
      </div>
    `;

    const listEl  = containerEl.querySelector('[data-role="list"]');
    const addBtn  = containerEl.querySelector('[data-role="add-btn"]');
    const addForm = containerEl.querySelector('[data-role="add-form"]');

    addBtn.addEventListener('click', () => {
      renderForm(addForm, null, dealId, boardId, async () => {
        addBtn.style.display = '';
        addForm.style.display = 'none';
        await renderList(listEl, dealId, addBtn, addForm, boardId);
      });
      addBtn.style.display = 'none';
    });

    await renderList(listEl, dealId, addBtn, addForm, boardId);
  }

  async function renderList(listEl, dealId, addBtn, addForm, boardId) {
    listEl.innerHTML = '<div class="aa-loading">Loading…</div>';
    try {
      const r = await fetch(`/api/agency-agreements?deal_id=${encodeURIComponent(dealId)}`);
      if (!r.ok) throw new Error(r.status);
      const rows = await r.json();
      if (!rows.length) {
        listEl.innerHTML = '<div class="aa-empty">No agency agreements on this deal yet.</div>';
        return;
      }
      listEl.innerHTML = rows.map(renderAgreementRow).join('');

      listEl.querySelectorAll('[data-role="agreement-row"]').forEach(row => {
        const id = parseInt(row.getAttribute('data-id'), 10);
        const ag = rows.find(x => x.id === id);
        row.querySelector('[data-role="edit-btn"]').addEventListener('click', () => {
          // Replace row with edit form
          row.style.display = 'none';
          const formWrap = document.createElement('div');
          row.parentNode.insertBefore(formWrap, row.nextSibling);
          renderForm(formWrap, ag, dealId, boardId, async () => {
            formWrap.remove();
            row.style.display = '';
            await renderList(listEl, dealId, addBtn, addForm, boardId);
          });
        });
        row.querySelector('[data-role="delete-btn"]').addEventListener('click', async () => {
          if (!confirm(`Delete this ${ag.agreement_type} agreement?`)) return;
          try {
            const dr = await fetch(`/api/agency-agreements?id=${id}`, { method: 'DELETE' });
            if (!dr.ok) { alert('Delete failed'); return; }
            await renderList(listEl, dealId, addBtn, addForm, boardId);
            showToast('Agreement deleted', 'info');
          } catch (err) {
            alert('Delete failed: ' + err.message);
          }
        });
      });
    } catch (err) {
      listEl.innerHTML = `<div class="aa-error">Could not load agreements: ${esc(err.message)}</div>`;
    }
  }

  function renderAgreementRow(ag) {
    const statusCls   = STATUS_BADGE_CLASS[ag.status] || '';
    const typeLabel   = ag.agreement_type ? ag.agreement_type.toUpperCase() : '—';
    const dateRange   = `${fmtDate(ag.start_date)} → ${fmtDate(ag.end_date)}`;
    const rate        = fmtRate(ag.rate_type, ag.rate_value);
    const triggerLbl  = (PAYOUT_TRIGGERS_FOR[ag.agreement_type] || []).find(p => p.id === ag.payout_trigger)?.label || ag.payout_trigger;
    return `
      <div class="aa-row" data-role="agreement-row" data-id="${ag.id}">
        <div class="aa-row-main">
          <div class="aa-row-line1">
            <span class="aa-type-badge aa-type-${esc(ag.agreement_type)}">${esc(typeLabel)}</span>
            <span class="aa-status-badge ${statusCls}">${esc(ag.status || '—')}</span>
            <span class="aa-row-company">${esc(ag.appointed_company_name || `Org #${ag.appointed_company_id}`)}</span>
          </div>
          <div class="aa-row-line2">
            <span class="aa-row-dates">${esc(dateRange)}</span>
            <span class="aa-row-sep">·</span>
            <span class="aa-row-rate">${esc(rate)}</span>
            <span class="aa-row-sep">·</span>
            <span class="aa-row-trigger">${esc(triggerLbl)}</span>
          </div>
          ${ag.notes ? `<div class="aa-row-notes">${esc(ag.notes)}</div>` : ''}
        </div>
        <div class="aa-row-actions">
          <button class="insp-row-btn" data-role="edit-btn" title="Edit">✎</button>
          <button class="insp-row-btn" data-role="delete-btn" title="Delete">✕</button>
        </div>
      </div>
    `;
  }

  // ── Form (create + edit) ──────────────────────────────────────────────────

  function renderForm(formEl, existing, dealId, boardId, onDone) {
    const isEdit = !!existing;
    const presetType = isEdit ? existing.agreement_type : (boardId === 'sys_lease_listings' ? 'lease' : 'sale');
    const today = (() => {
      const d = new Date(); const pad = n => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
    })();
    const startDate = isEdit ? (existing.start_date || today) : today;
    const endDate   = isEdit ? (existing.end_date || '') : '';

    formEl.style.display = '';
    formEl.innerHTML = `
      <div class="aa-form">
        <div class="aa-form-grid">
          <div class="kb-field-wrap">
            <label class="kb-field-label">Type</label>
            <select class="kb-input" data-field="agreement_type">
              <option value="sale"  ${presetType === 'sale'  ? 'selected' : ''}>Sale</option>
              <option value="lease" ${presetType === 'lease' ? 'selected' : ''}>Lease</option>
            </select>
          </div>
          <div class="kb-field-wrap">
            <label class="kb-field-label">Appointed Company</label>
            <input class="kb-input aa-org-search" type="text" data-role="org-search" placeholder="Search organisation…" value="${isEdit ? esc(existing.appointed_company_name || '') : ''}">
            <input type="hidden" data-field="appointed_company_id" value="${isEdit ? existing.appointed_company_id : ''}">
            <div class="aa-org-results" data-role="org-results"></div>
          </div>
          <div class="kb-field-wrap">
            <label class="kb-field-label">Start date</label>
            <input class="kb-input" type="date" data-field="start_date" value="${esc(startDate)}">
          </div>
          <div class="kb-field-wrap">
            <label class="kb-field-label">End date</label>
            <input class="kb-input" type="date" data-field="end_date" value="${esc(endDate)}">
          </div>
          <div class="kb-field-wrap">
            <label class="kb-field-label">Rate type</label>
            <select class="kb-input" data-field="rate_type">
              ${RATE_TYPES.map(rt => `<option value="${rt.id}" ${isEdit && existing.rate_type === rt.id ? 'selected' : ''}>${esc(rt.label)}</option>`).join('')}
            </select>
          </div>
          <div class="kb-field-wrap">
            <label class="kb-field-label">Rate value</label>
            <input class="kb-input" type="number" step="0.01" data-field="rate_value" value="${isEdit ? esc(existing.rate_value || '') : ''}" placeholder="e.g. 2.5">
          </div>
          <div class="kb-field-wrap">
            <label class="kb-field-label">Payout trigger</label>
            <select class="kb-input" data-field="payout_trigger" data-role="payout-select">
              ${(PAYOUT_TRIGGERS_FOR[presetType] || []).map(p => `<option value="${p.id}" ${isEdit && existing.payout_trigger === p.id ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}
            </select>
          </div>
          <div class="kb-field-wrap">
            <label class="kb-field-label">Commission category (optional)</label>
            <input class="kb-input" type="text" data-field="commission_category" value="${isEdit ? esc(existing.commission_category || '') : ''}" placeholder="e.g. Tier A">
          </div>
          <div class="kb-field-wrap" style="grid-column:1/-1">
            <label class="kb-field-label">Contract URL (optional)</label>
            <input class="kb-input" type="url" data-field="contract_url" value="${isEdit ? esc(existing.contract_url || '') : ''}" placeholder="https://…">
          </div>
          <div class="kb-field-wrap" style="grid-column:1/-1">
            <label class="kb-field-label">Notes (optional)</label>
            <textarea class="kb-input" rows="2" data-field="notes" placeholder="Any context…">${isEdit ? esc(existing.notes || '') : ''}</textarea>
          </div>
        </div>
        <div class="aa-form-actions">
          <button class="params-save-btn" data-role="save">${isEdit ? 'Save' : 'Create'}</button>
          <button class="params-cancel-btn" data-role="cancel">Cancel</button>
        </div>
      </div>
    `;

    // Type change → repopulate payout trigger options
    formEl.querySelector('[data-field="agreement_type"]').addEventListener('change', (e) => {
      const newType = e.target.value;
      const sel = formEl.querySelector('[data-role="payout-select"]');
      sel.innerHTML = (PAYOUT_TRIGGERS_FOR[newType] || []).map(p => `<option value="${p.id}">${esc(p.label)}</option>`).join('');
    });

    // Org search
    const orgSearch  = formEl.querySelector('[data-role="org-search"]');
    const orgResults = formEl.querySelector('[data-role="org-results"]');
    const orgIdField = formEl.querySelector('[data-field="appointed_company_id"]');
    let _searchTimer = null;
    orgSearch.addEventListener('input', () => {
      orgIdField.value = ''; // any change invalidates the previous selection
      clearTimeout(_searchTimer);
      const q = orgSearch.value.trim();
      if (!q) { orgResults.innerHTML = ''; return; }
      _searchTimer = setTimeout(async () => {
        try {
          const r = await fetch(`/api/contacts?org_search=${encodeURIComponent(q)}`);
          if (!r.ok) return;
          const orgs = await r.json();
          orgResults.innerHTML = orgs.slice(0, 8).map(o =>
            `<div class="aa-org-result" data-id="${o.id}" data-name="${esc(o.name)}">${esc(o.name)}</div>`
          ).join('') || '<div class="aa-org-result-empty">No matches</div>';
          orgResults.querySelectorAll('.aa-org-result').forEach(item => {
            item.addEventListener('click', () => {
              orgIdField.value = item.getAttribute('data-id');
              orgSearch.value = item.getAttribute('data-name');
              orgResults.innerHTML = '';
            });
          });
        } catch (err) {
          console.warn('[aa] org search failed', err);
        }
      }, 300);
    });

    formEl.querySelector('[data-role="cancel"]').addEventListener('click', () => {
      formEl.style.display = 'none';
      formEl.innerHTML = '';
      const section = formEl.closest('.aa-section');
      const addBtn = section?.querySelector('[data-role="add-btn"]');
      if (addBtn) addBtn.style.display = '';
      if (onDone) onDone();
    });

    formEl.querySelector('[data-role="save"]').addEventListener('click', async () => {
      const body = {
        agreement_type:       formEl.querySelector('[data-field="agreement_type"]').value,
        appointed_company_id: parseInt(orgIdField.value, 10) || null,
        start_date:           formEl.querySelector('[data-field="start_date"]').value,
        end_date:             formEl.querySelector('[data-field="end_date"]').value,
        rate_type:            formEl.querySelector('[data-field="rate_type"]').value,
        rate_value:           parseFloat(formEl.querySelector('[data-field="rate_value"]').value) || null,
        payout_trigger:       formEl.querySelector('[data-field="payout_trigger"]').value,
        commission_category:  formEl.querySelector('[data-field="commission_category"]').value || null,
        contract_url:         formEl.querySelector('[data-field="contract_url"]').value || null,
        notes:                formEl.querySelector('[data-field="notes"]').value || null,
      };
      if (!body.appointed_company_id) {
        alert('Pick an Appointed Company from the dropdown');
        return;
      }
      if (!body.start_date || !body.end_date) {
        alert('Start and end dates required');
        return;
      }
      if (body.rate_value == null) {
        alert('Rate value required');
        return;
      }

      try {
        let r;
        if (isEdit) {
          body.id = existing.id;
          r = await fetch('/api/agency-agreements', {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
        } else {
          body.deal_id = dealId;
          r = await fetch('/api/agency-agreements', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
        }
        if (!r.ok) {
          const err = await r.json();
          alert(err.error || 'Save failed');
          return;
        }
        showToast(isEdit ? 'Agreement updated' : 'Agreement created', 'success');
        if (onDone) onDone();
      } catch (err) {
        alert('Save failed: ' + err.message);
      }
    });
  }

  // ── Expose ────────────────────────────────────────────────────────────────

  window.AgencyAgreementsSection = { render };
})();
