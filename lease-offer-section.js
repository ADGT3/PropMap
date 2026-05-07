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
      // V77.2: fetch tokens for all offers in one go
      try {
        const tokenPromises = offers.map(o =>
          fetch(`/api/applicant-form-tokens?application_id=${encodeURIComponent(o.id)}`)
            .then(r => r.ok ? r.json() : [])
            .then(rows => { o._tokens = Array.isArray(rows) ? rows : []; })
            .catch(() => { o._tokens = []; })
        );
        await Promise.all(tokenPromises);
      } catch (_) {/* token failure shouldn't block offer rendering */}
      renderList();
    }

    function fmtRelative(iso) {
      if (!iso) return '';
      const d = new Date(iso);
      if (isNaN(d.getTime())) return '';
      const diffMs = Date.now() - d.getTime();
      const diffMin = Math.round(diffMs / 60_000);
      if (diffMin < 1) return 'just now';
      if (diffMin < 60) return `${diffMin} min ago`;
      const diffHr = Math.round(diffMin / 60);
      if (diffHr < 24) return `${diffHr} hour${diffHr === 1 ? '' : 's'} ago`;
      const diffDay = Math.round(diffHr / 24);
      if (diffDay < 30) return `${diffDay} day${diffDay === 1 ? '' : 's'} ago`;
      return fmtDate(iso);
    }
    function daysUntil(iso) {
      if (!iso) return null;
      const d = new Date(iso);
      const ms = d.getTime() - Date.now();
      return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)));
    }

    // V77.2: build the magic-link UI block for a single offer
    function renderTokenBlock(offer) {
      const status = offer.status || 'draft';
      const tokens = offer._tokens || [];
      const tokenStep1 = tokens.find(t => t.step === 1);
      const tokenStep2 = tokens.find(t => t.step === 2);
      const allowStep2 = status === 'offer_accepted' || status === 'evidence_submitted';

      // Step 1 UI
      let step1Html = '';
      if (status === 'draft') {
        // Send Step 1 button (or token state)
        if (tokenStep1) {
          step1Html = renderTokenStateRow(offer, tokenStep1, 1);
        } else {
          step1Html = `
            <div class="lo-token-row lo-token-empty">
              <div class="lo-token-label">Step 1 — Applicant offer form</div>
              <button class="lo-issue-btn" type="button" data-application-id="${esc(offer.id)}" data-step="1">Send Step 1 link to applicant</button>
            </div>`;
        }
      } else {
        // Status has progressed — show Step 1 history
        if (tokenStep1) {
          step1Html = renderTokenStateRow(offer, tokenStep1, 1);
        }
      }

      // Step 2 UI (only meaningful once accepted)
      let step2Html = '';
      if (allowStep2) {
        if (tokenStep2) {
          step2Html = renderTokenStateRow(offer, tokenStep2, 2);
        } else {
          step2Html = `
            <div class="lo-token-row lo-token-empty">
              <div class="lo-token-label">Step 2 — Evidence upload form</div>
              <button class="lo-issue-btn" type="button" data-application-id="${esc(offer.id)}" data-step="2">Send Step 2 link to applicant</button>
            </div>`;
        }
      }

      if (!step1Html && !step2Html) return '';
      return `<div class="lo-token-block">${step1Html}${step2Html}</div>`;
    }

    function renderTokenStateRow(offer, token, step) {
      const stepLabel = step === 1 ? 'Step 1 — Applicant offer form' : 'Step 2 — Evidence upload form';
      const formUrl = `https://propmap.edanproperty.com.au/lease-offer/${token.token}`;

      // Compute state line
      let stateLine = '';
      const status = offer.status || 'draft';
      if (step === 1 && (status === 'submitted' || status === 'offer_accepted' || status === 'evidence_submitted' || status === 'validated')) {
        stateLine = `<span class="lo-token-state lo-token-state-done">✓ Submitted ${esc(fmtRelative(token.last_accessed_at || token.created_at))}</span>`;
      } else if (step === 2 && (status === 'evidence_submitted' || status === 'validated')) {
        stateLine = `<span class="lo-token-state lo-token-state-done">✓ Evidence submitted ${esc(fmtRelative(token.last_accessed_at || token.created_at))}</span>`;
      } else if (token.email_verified) {
        const days = daysUntil(token.expires_at);
        stateLine = `<span class="lo-token-state lo-token-state-verified">✓ Verified — expires in ${days} day${days === 1 ? '' : 's'}</span>`;
      } else {
        const days = daysUntil(token.expires_at);
        stateLine = `<span class="lo-token-state lo-token-state-pending">⏳ Awaiting verification — expires in ${days} day${days === 1 ? '' : 's'}</span>`;
      }

      return `
        <div class="lo-token-row" data-token-id="${esc(token.id)}">
          <div class="lo-token-label">${esc(stepLabel)}</div>
          <div class="lo-token-url-row">
            <input class="lo-token-url" type="text" readonly value="${esc(formUrl)}" data-url="${esc(formUrl)}">
            <button class="lo-token-action-btn lo-token-copy-btn"  type="button" data-token-id="${esc(token.id)}" title="Copy link to clipboard">Copy</button>
            <button class="lo-token-action-btn lo-token-resend-btn" type="button" data-token-id="${esc(token.id)}" title="Re-send the email to ${esc(token.applicant_email)}">Resend</button>
            <button class="lo-token-action-btn lo-token-reissue-btn" type="button" data-token-id="${esc(token.id)}" title="Generate a brand new link (invalidates the old one)">Reissue</button>
          </div>
          <div class="lo-token-meta">
            <span class="lo-token-email">${esc(token.applicant_email)}</span>
            <span class="lo-token-sep">·</span>
            <span class="lo-token-sent">Sent ${esc(fmtRelative(token.created_at))}</span>
            <span class="lo-token-sep">·</span>
            ${stateLine}
          </div>
        </div>
      `;
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
              ${renderTokenBlock(o)}
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
          editingId = b.getAttribute('data-id');
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

      // V77.2 — wire token-action handlers
      wireTokenActions();
    }

    // Pick a Contact for token issuance — uses linked enquirer Contact by default
    async function pickContactForToken(applicationId) {
      // Find the deal's enquirer Contact via /api/contacts?pipeline_id=...
      try {
        const r = await fetch(`/api/contacts?pipeline_id=${encodeURIComponent(dealId)}`);
        if (!r.ok) throw new Error(r.status);
        const linked = await r.json();
        if (!Array.isArray(linked) || !linked.length) {
          alert('This Enquiry deal has no linked Contacts. Add an enquirer Contact first.');
          return null;
        }
        // Prefer enquirer / applicant role; fallback to first
        const enquirer = linked.find(c => c.role === 'enquirer' || c.role === 'applicant');
        const c = enquirer || linked[0];
        if (!c.email || !/^\S+@\S+\.\S+$/.test(c.email)) {
          alert(`Contact "${c.first_name || ''} ${c.last_name || ''}" has no valid email. Edit the Contact and try again.`);
          return null;
        }
        return c;
      } catch (err) {
        alert('Could not look up linked Contacts: ' + err.message);
        return null;
      }
    }

    function wireTokenActions() {
      // Issue (Step 1 or Step 2)
      listEl.querySelectorAll('.lo-issue-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const applicationId = btn.getAttribute('data-application-id');
          const step = parseInt(btn.getAttribute('data-step'), 10);
          const contact = await pickContactForToken(applicationId);
          if (!contact) return;
          if (!confirm(`Send Step ${step} link to ${contact.first_name || ''} ${contact.last_name || ''} <${contact.email}>?`)) return;
          btn.disabled = true;
          btn.textContent = 'Sending…';
          try {
            const r = await fetch('/api/applicant-form-tokens', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'issue', application_id: applicationId, step, contact_id: contact.id }),
            });
            if (!r.ok) {
              const err = await r.json().catch(() => ({}));
              throw new Error(err.error || r.status);
            }
            await load();
          } catch (err) {
            alert('Failed to send link: ' + err.message);
            btn.disabled = false;
            btn.textContent = `Send Step ${step} link to applicant`;
          }
        });
      });

      // Copy
      listEl.querySelectorAll('.lo-token-copy-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const row = btn.closest('.lo-token-row');
          const url = row?.querySelector('.lo-token-url')?.getAttribute('data-url') || '';
          if (!url) return;
          try {
            await navigator.clipboard.writeText(url);
            const orig = btn.textContent;
            btn.textContent = '✓ Copied';
            setTimeout(() => { btn.textContent = orig; }, 1500);
          } catch (_) {
            // Fallback
            const input = row.querySelector('.lo-token-url');
            input.select();
            document.execCommand('copy');
            const orig = btn.textContent;
            btn.textContent = '✓ Copied';
            setTimeout(() => { btn.textContent = orig; }, 1500);
          }
        });
      });

      // Resend
      listEl.querySelectorAll('.lo-token-resend-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const tokenId = btn.getAttribute('data-token-id');
          if (!confirm('Resend the same link to the applicant\'s email?')) return;
          btn.disabled = true;
          const orig = btn.textContent;
          btn.textContent = 'Sending…';
          try {
            const r = await fetch('/api/applicant-form-tokens', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'resend', token_id: parseInt(tokenId, 10) }),
            });
            if (!r.ok) {
              const err = await r.json().catch(() => ({}));
              throw new Error(err.error || r.status);
            }
            const result = await r.json();
            btn.textContent = '✓ Sent';
            console.log('[LeaseOffer] resent to:', result.sent_to);
            setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1800);
          } catch (err) {
            alert('Resend failed: ' + err.message);
            btn.textContent = orig;
            btn.disabled = false;
          }
        });
      });

      // Reissue
      listEl.querySelectorAll('.lo-token-reissue-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const tokenId = btn.getAttribute('data-token-id');
          if (!confirm('Reissue creates a brand new link, deactivating the old one. The current applicant Contact email will be used. Proceed?')) return;
          btn.disabled = true;
          const orig = btn.textContent;
          btn.textContent = 'Reissuing…';
          try {
            const r = await fetch('/api/applicant-form-tokens', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'reissue', token_id: parseInt(tokenId, 10) }),
            });
            if (!r.ok) {
              const err = await r.json().catch(() => ({}));
              throw new Error(err.error || r.status);
            }
            await load();
          } catch (err) {
            alert('Reissue failed: ' + err.message);
            btn.textContent = orig;
            btn.disabled = false;
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
      } : (offers.find(o => String(o.id) === String(editingId)) || {});

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
            payload.id = parseInt(editingId, 10);
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
