/**
 * lease-offer-section.js — V77.1
 *
 * Multi-record list of Lease Offers (applications) on a Lease Enquiry deal.
 * Each offer carries: rent, bond, term, move-in date, special terms, status.
 * Forward-only state machine (per build plan §12 Q1(b)):
 *
 *   draft → submitted → (offer_accepted | rejected | withdrawn)
 *
 * Once an offer reaches a terminal state (offer_accepted/rejected/withdrawn),
 * its status is locked. The user can still edit other fields on accepted/rejected
 * offers (typo fixes etc.) but the status dropdown is disabled.
 *
 * Mounts via window.LeaseOfferSection.mount(containerEl, dealId).
 *
 * V77.1 ONLY renders for Lease Enquiry deals (board_id === 'sys_lease_enquiry').
 * Caller is expected to gate by board.
 *
 * Public API:
 *   LeaseOfferSection.mount(containerEl, dealId) → { destroy, refresh }
 */

(function () {
  'use strict';

  const API = '/api/applications';

  // V77.1 agent-side only sees these statuses (V77.2 public flow adds the rest)
  const STATUS_OPTIONS = [
    { value: 'draft',          label: 'Draft' },
    { value: 'submitted',      label: 'Submitted' },
    { value: 'offer_accepted', label: 'Accepted' },
    { value: 'rejected',       label: 'Rejected' },
    { value: 'withdrawn',      label: 'Withdrawn' },
  ];
  const TERMINAL = new Set(['offer_accepted', 'rejected', 'withdrawn', 'leased']);

  // What status values can the user transition TO from a given status?
  const ALLOWED_FROM = {
    draft:          ['draft', 'submitted', 'withdrawn'],
    submitted:      ['submitted', 'offer_accepted', 'rejected', 'withdrawn'],
    offer_accepted: ['offer_accepted'], // terminal — locked
    rejected:       ['rejected'],       // terminal — locked
    withdrawn:      ['withdrawn'],      // terminal — locked
  };

  // ── Format helpers ───────────────────────────────────────────────────────
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
  function fmtStatus(s) {
    const opt = STATUS_OPTIONS.find(o => o.value === s);
    return opt ? opt.label : s;
  }
  function statusClass(s) {
    return `lo-status-${(s || '').replace(/_/g, '-')}`;
  }

  // ── Mount ─────────────────────────────────────────────────────────────────
  function mount(containerEl, dealId) {
    if (!containerEl || !dealId) return { destroy() {}, refresh() {} };

    let offers = [];
    let editingId = null; // null = list view, 'new' = adding, otherwise application id

    containerEl.innerHTML = `
      <div class="lo-section">
        <div class="kb-section-label" style="display:flex;justify-content:space-between;align-items:center;margin-top:16px">
          <span>Lease Offers</span>
          <button class="kb-add-offer-btn lo-add-btn" type="button">+ New Offer</button>
        </div>
        <div class="lo-list" data-role="list"></div>
        <div class="lo-form-wrap" data-role="form-wrap" style="display:none"></div>
      </div>
    `;

    const listEl    = containerEl.querySelector('[data-role="list"]');
    const formWrap  = containerEl.querySelector('[data-role="form-wrap"]');
    const addBtn    = containerEl.querySelector('.lo-add-btn');

    addBtn.addEventListener('click', () => {
      editingId = 'new';
      renderForm();
    });

    async function load() {
      try {
        const r = await fetch(`${API}?deal_id=${encodeURIComponent(dealId)}`);
        if (!r.ok) throw new Error(r.status);
        offers = await r.json();
      } catch (err) {
        listEl.innerHTML = '<div class="lo-empty">Could not load offers.</div>';
        console.warn('[LeaseOffer] load failed:', err);
        return;
      }
      renderList();
    }

    function renderList() {
      formWrap.style.display = 'none';
      formWrap.innerHTML = '';
      addBtn.style.display = '';
      if (!offers.length) {
        listEl.innerHTML = '<div class="lo-empty">No lease offers yet.</div>';
        return;
      }
      listEl.innerHTML = offers.map(o => {
        const rent = fmtCurrency(o.requested_rent) + (o.requested_rent ? '/wk' : '');
        const bond = o.bond_weeks ? `${o.bond_weeks} wks` : '—';
        const term = o.lease_term_months ? `${o.lease_term_months} mo` : '—';
        const start = fmtDate(o.preferred_start_date);
        return `
          <div class="lo-row" data-id="${o.id}">
            <div class="lo-row-main">
              <div class="lo-row-headline">
                <span class="lo-status ${statusClass(o.status)}">${esc(fmtStatus(o.status))}</span>
                <span class="lo-rent">${esc(rent)}</span>
                <span class="lo-meta">Bond ${esc(bond)} · Term ${esc(term)} · From ${esc(start)}</span>
              </div>
              ${o.terms ? `<div class="lo-row-terms">${esc(o.terms)}</div>` : ''}
            </div>
            <div class="lo-row-actions">
              <button class="lo-edit-btn" type="button" data-id="${o.id}">Edit</button>
              <button class="lo-delete-btn" type="button" data-id="${o.id}" title="Delete this offer">✕</button>
            </div>
          </div>
        `;
      }).join('');

      listEl.querySelectorAll('.lo-edit-btn').forEach(b => {
        b.addEventListener('click', () => {
          editingId = parseInt(b.getAttribute('data-id'), 10);
          renderForm();
        });
      });
      listEl.querySelectorAll('.lo-delete-btn').forEach(b => {
        b.addEventListener('click', async () => {
          if (!confirm('Delete this lease offer? This cannot be undone.')) return;
          try {
            const r = await fetch(`${API}?id=${encodeURIComponent(b.getAttribute('data-id'))}`, { method: 'DELETE' });
            if (!r.ok) throw new Error(r.status);
            await load();
          } catch (err) {
            alert('Delete failed: ' + err.message);
          }
        });
      });
    }

    function renderForm() {
      addBtn.style.display = 'none';
      formWrap.style.display = '';
      const isNew = editingId === 'new';
      const offer = isNew ? {
        status: 'draft',
        requested_rent: '',
        bond_weeks: 4,
        lease_term_months: 12,
        preferred_start_date: '',
        terms: '',
        notes: '',
      } : (offers.find(o => o.id === editingId) || {});

      const currentStatus = offer.status || 'draft';
      const statusAllowed = ALLOWED_FROM[currentStatus] || [currentStatus];
      const statusOptionsHtml = STATUS_OPTIONS.map(o => {
        const disabled = !statusAllowed.includes(o.value);
        return `<option value="${o.value}" ${o.value === currentStatus ? 'selected' : ''} ${disabled ? 'disabled' : ''}>${esc(o.label)}${disabled && o.value !== currentStatus ? ' (not allowed)' : ''}</option>`;
      }).join('');
      const statusLocked = TERMINAL.has(currentStatus);

      const startDateVal = offer.preferred_start_date
        ? (typeof offer.preferred_start_date === 'string' ? offer.preferred_start_date.slice(0, 10) : '')
        : '';

      formWrap.innerHTML = `
        <div class="lo-form">
          <div class="lo-form-title">${isNew ? 'New Lease Offer' : `Edit Lease Offer #${offer.id}`}</div>

          <div class="lo-form-row">
            <div class="kb-field-wrap" style="flex:1">
              <label class="kb-field-label">Status</label>
              <select class="kb-input lo-status-sel" ${statusLocked ? 'disabled' : ''}>
                ${statusOptionsHtml}
              </select>
              ${statusLocked ? '<div class="lo-help">Status locked — terminal state.</div>' : ''}
            </div>
            <div class="kb-field-wrap" style="flex:1">
              <label class="kb-field-label">Requested rent (per week)</label>
              <input class="kb-input lo-rent" type="text" placeholder="e.g. 650" value="${esc(offer.requested_rent ?? '')}">
            </div>
          </div>

          <div class="lo-form-row">
            <div class="kb-field-wrap">
              <label class="kb-field-label">Bond (weeks)</label>
              <input class="kb-input lo-bond" type="number" min="0" max="12" value="${esc(offer.bond_weeks ?? '')}">
            </div>
            <div class="kb-field-wrap">
              <label class="kb-field-label">Term (months)</label>
              <input class="kb-input lo-term" type="number" min="1" max="60" value="${esc(offer.lease_term_months ?? '')}">
            </div>
            <div class="kb-field-wrap">
              <label class="kb-field-label">Preferred move-in</label>
              <input class="kb-input lo-start-date" type="date" value="${esc(startDateVal)}">
            </div>
          </div>

          <div class="kb-field-wrap" style="margin-top:8px">
            <label class="kb-field-label">Special terms / conditions</label>
            <textarea class="kb-input lo-terms" rows="2" placeholder="e.g. Pet allowed, paint room, etc.">${esc(offer.terms ?? '')}</textarea>
          </div>

          <div class="kb-field-wrap" style="margin-top:8px">
            <label class="kb-field-label">Internal notes (not shown to applicant)</label>
            <textarea class="kb-input lo-notes" rows="2">${esc(offer.notes ?? '')}</textarea>
          </div>

          <div class="lo-form-actions">
            <button class="params-cancel-btn lo-cancel-btn" type="button">Cancel</button>
            <button class="params-save-btn lo-save-btn" type="button">${isNew ? 'Create Offer' : 'Save Changes'}</button>
          </div>
        </div>
      `;

      formWrap.querySelector('.lo-cancel-btn').addEventListener('click', () => {
        editingId = null;
        renderList();
      });
      formWrap.querySelector('.lo-save-btn').addEventListener('click', async () => {
        const rentRaw = formWrap.querySelector('.lo-rent').value.trim();
        const rent    = rentRaw ? parseFloat(rentRaw.replace(/[^0-9.]/g, '')) : null;
        const bond    = parseInt(formWrap.querySelector('.lo-bond').value, 10);
        const term    = parseInt(formWrap.querySelector('.lo-term').value, 10);
        const startD  = formWrap.querySelector('.lo-start-date').value || null;
        const terms   = formWrap.querySelector('.lo-terms').value.trim();
        const notes   = formWrap.querySelector('.lo-notes').value.trim();
        const status  = formWrap.querySelector('.lo-status-sel').value;

        const payload = {
          status,
          requested_rent:        isNaN(rent) ? null : rent,
          bond_weeks:            isNaN(bond) ? null : bond,
          lease_term_months:     isNaN(term) ? null : term,
          preferred_start_date:  startD,
          terms:                 terms || null,
          notes:                 notes || null,
        };

        try {
          const btn = formWrap.querySelector('.lo-save-btn');
          btn.disabled = true; btn.textContent = 'Saving…';
          if (isNew) {
            payload.deal_id = dealId;
            const r = await fetch(API, {
              method:  'POST',
              headers: { 'Content-Type': 'application/json' },
              body:    JSON.stringify(payload),
            });
            if (!r.ok) {
              const err = await r.json().catch(() => ({ error: r.status }));
              throw new Error(err.error || `HTTP ${r.status}`);
            }
          } else {
            payload.id = editingId;
            const r = await fetch(API, {
              method:  'PUT',
              headers: { 'Content-Type': 'application/json' },
              body:    JSON.stringify(payload),
            });
            if (!r.ok) {
              const err = await r.json().catch(() => ({ error: r.status }));
              throw new Error(err.error || `HTTP ${r.status}`);
            }
          }
          editingId = null;
          await load();
        } catch (err) {
          alert('Save failed: ' + err.message);
          const btn = formWrap.querySelector('.lo-save-btn');
          if (btn) { btn.disabled = false; btn.textContent = isNew ? 'Create Offer' : 'Save Changes'; }
        }
      });
    }

    load();

    return {
      destroy: () => { containerEl.innerHTML = ''; },
      refresh: load,
    };
  }

  // Expose
  window.LeaseOfferSection = { mount };
})();
