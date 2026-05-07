/**
 * lease-offer-section.js — V77.1 / V77.2
 *
 * Renders the Lease Offer section inside Lease Enquiry deal modals.
 *
 * V77.2 changes:
 *   - "+ New Offer" auto-creates blank draft offer + shows magic-link UI
 *     (no manual-entry form).
 *   - Submitted offers expand inline to show full applicant + finance + household details.
 *   - Accept / Reject buttons replace Edit / Delete on submitted offers.
 *   - Accept transition triggers contact normalisation + Step 2 token + email
 *     (server-side; see api/applications.js handlePut).
 *
 * Public API (attached to window.LeaseOfferSection):
 *   LeaseOfferSection.mount(container, dealId)
 */
(function () {
  'use strict';

  const API = '/api/applications';

  function esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtCurrency(n) {
    if (n == null || n === '') return '';
    const num = typeof n === 'number' ? n : parseFloat(String(n).replace(/[^0-9.]/g, ''));
    if (isNaN(num) || num <= 0) return '';
    return '$' + Math.round(num).toLocaleString('en-AU');
  }
  function fmtDate(s) {
    if (!s) return '—';
    const d = new Date(s);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' });
  }
  function fmtStatus(s) {
    return ({
      draft:               'Draft',
      submitted:           'Submitted',
      offer_accepted:      'Accepted',
      evidence_submitted:  'Evidence In',
      validated:           'Validated',
      leased:              'Leased',
      rejected:            'Rejected',
      withdrawn:           'Withdrawn',
    })[s] || s || 'Draft';
  }
  function statusClass(s) {
    return 'lo-status-' + (s || 'draft');
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

  function mount(containerEl, dealId) {
    let offers = [];
    let expandedIds = new Set();

    containerEl.innerHTML = `
      <div class="lo-section">
        <div class="lo-section-header">
          <span class="kb-section-label">Lease Offers</span>
          <button class="lo-add-btn" type="button">+ New Offer</button>
        </div>
        <div class="lo-list"></div>
      </div>
    `;

    const addBtn = containerEl.querySelector('.lo-add-btn');
    const listEl = containerEl.querySelector('.lo-list');

    addBtn.addEventListener('click', () => createBlankDraft());

    load();

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

    async function createBlankDraft() {
      addBtn.disabled = true;
      const orig = addBtn.textContent;
      addBtn.textContent = 'Creating…';
      try {
        const r = await fetch(API, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ deal_id: dealId, status: 'draft' }),
        });
        if (!r.ok) {
          const err = await r.json().catch(() => ({}));
          throw new Error(err.error || r.status);
        }
        const newOffer = await r.json();
        expandedIds.add(String(newOffer.id));
        await load();
      } catch (err) {
        alert('Failed to create offer: ' + err.message);
      } finally {
        addBtn.disabled = false;
        addBtn.textContent = orig;
      }
    }

    function renderTokenBlock(offer) {
      const status = offer.status || 'draft';
      const tokens = offer._tokens || [];
      const tokenStep1 = tokens.find(t => t.step === 1);
      const tokenStep2 = tokens.find(t => t.step === 2);
      const allowStep2 = status === 'offer_accepted' || status === 'evidence_submitted';

      let step1Html = '';
      if (status === 'draft') {
        if (tokenStep1) {
          step1Html = renderTokenStateRow(offer, tokenStep1, 1);
        } else {
          step1Html = `
            <div class="lo-token-row lo-token-empty">
              <div class="lo-token-label">Offer Form</div>
              <button class="lo-issue-btn" type="button" data-application-id="${esc(offer.id)}" data-step="1">Send Offer Form link to applicant</button>
            </div>`;
        }
      } else if (tokenStep1) {
        step1Html = renderTokenStateRow(offer, tokenStep1, 1);
      }

      let step2Html = '';
      if (allowStep2) {
        if (tokenStep2) {
          step2Html = renderTokenStateRow(offer, tokenStep2, 2);
        } else {
          step2Html = `
            <div class="lo-token-row lo-token-empty">
              <div class="lo-token-label">Evidence Upload Form</div>
              <button class="lo-issue-btn" type="button" data-application-id="${esc(offer.id)}" data-step="2">Send Evidence Upload Form link to applicant</button>
            </div>`;
        }
      }

      if (!step1Html && !step2Html) return '';
      return `<div class="lo-token-block">${step1Html}${step2Html}</div>`;
    }

    function renderTokenStateRow(offer, token, step) {
      const stepLabel = step === 1 ? 'Offer Form' : 'Evidence Upload Form';
      const formUrl = `https://propmap.edanproperty.com.au/lease-offer/${token.token}`;
      const status = offer.status || 'draft';

      let stateLine = '';
      if (step === 1 && (status === 'submitted' || status === 'offer_accepted' || status === 'evidence_submitted' || status === 'validated' || status === 'leased')) {
        stateLine = `<span class="lo-token-state lo-token-state-done">✓ Submitted ${esc(fmtRelative(token.last_accessed_at || token.created_at))}</span>`;
      } else if (step === 2 && (status === 'evidence_submitted' || status === 'validated' || status === 'leased')) {
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
            <button class="lo-token-action-btn lo-token-copy-btn"   type="button" data-token-id="${esc(token.id)}" title="Copy link to clipboard">Copy</button>
            <button class="lo-token-action-btn lo-token-resend-btn"  type="button" data-token-id="${esc(token.id)}" title="Re-send the email to ${esc(token.applicant_email)}">Resend</button>
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

    function renderSubmittedDetail(offer) {
      const apps = Array.isArray(offer.applicants_jsonb) ? offer.applicants_jsonb : [];
      const occ  = offer.occupants || {};
      const pets = offer.pets || {};

      let html = '<div class="lo-detail">';

      html += '<div class="lo-detail-section">';
      html += '<div class="lo-detail-section-title">Offer Terms</div>';
      html += '<table class="lo-detail-table">';
      html += `<tr><th>Rent offered</th><td>${esc(fmtCurrency(offer.requested_rent))}/wk</td></tr>`;
      html += `<tr><th>Bond</th><td>${offer.bond_weeks || '—'} weeks</td></tr>`;
      html += `<tr><th>Lease term</th><td>${offer.lease_term_months ? `${offer.lease_term_months} months` : '—'}</td></tr>`;
      html += `<tr><th>Preferred start</th><td>${esc(fmtDate(offer.preferred_start_date))}</td></tr>`;
      if (offer.terms) html += `<tr><th>Special terms</th><td>${esc(offer.terms)}</td></tr>`;
      html += '</table></div>';

      html += '<div class="lo-detail-section">';
      html += '<div class="lo-detail-section-title">Household</div>';
      html += '<table class="lo-detail-table">';
      html += `<tr><th>Total occupants</th><td>${occ.total ?? '—'}</td></tr>`;
      if (occ.details)  html += `<tr><th>Details</th><td>${esc(occ.details)}</td></tr>`;
      html += `<tr><th>Pets</th><td>${pets.has_pets ? 'Yes' : 'No'}${pets.has_pets && pets.details ? ' — ' + esc(pets.details) : ''}</td></tr>`;
      html += '</table></div>';

      apps.forEach((a, i) => {
        const name = [a.first_name, a.last_name].filter(Boolean).join(' ') || `Applicant ${i + 1}`;
        const isPrimary = i === 0;
        html += '<div class="lo-detail-section">';
        html += `<div class="lo-detail-section-title">Applicant ${i + 1}: ${esc(name)}${isPrimary ? ' <span class="lo-primary-tag">Primary</span>' : ''}</div>`;
        html += '<table class="lo-detail-table">';
        html += `<tr><th>Email</th><td>${esc(a.email || '—')}</td></tr>`;
        html += `<tr><th>Mobile</th><td>${esc(a.mobile || '—')}</td></tr>`;
        if (a.dob)             html += `<tr><th>Date of birth</th><td>${esc(fmtDate(a.dob))}</td></tr>`;
        if (a.current_address) html += `<tr><th>Current address</th><td>${esc(a.current_address)}</td></tr>`;
        if (a.smoker !== null && a.smoker !== undefined) html += `<tr><th>Smoker</th><td>${a.smoker ? 'Yes' : 'No'}</td></tr>`;
        if (a.employment_status || a.employer_name || a.gross_weekly_income) {
          html += `<tr><th colspan="2" class="lo-subhead">Finance</th></tr>`;
          if (a.employment_status)    html += `<tr><th>Employment</th><td>${esc(a.employment_status)}</td></tr>`;
          if (a.employer_name)        html += `<tr><th>Employer</th><td>${esc(a.employer_name)}</td></tr>`;
          if (a.position)             html += `<tr><th>Position</th><td>${esc(a.position)}</td></tr>`;
          if (a.gross_weekly_income)  html += `<tr><th>Gross weekly income</th><td>${esc(fmtCurrency(a.gross_weekly_income))}</td></tr>`;
          if (a.length_of_employment) html += `<tr><th>Length of employment</th><td>${esc(a.length_of_employment)}</td></tr>`;
        }
        html += '</table></div>';
      });

      html += '</div>';
      return html;
    }

    function renderList() {
      if (!offers.length) {
        listEl.innerHTML = '<div class="lo-empty">No lease offers yet.</div>';
        return;
      }
      listEl.innerHTML = offers.map(o => {
        const rent  = fmtCurrency(o.requested_rent);
        const bond  = o.bond_weeks ? `${o.bond_weeks} wks` : '—';
        const term  = o.lease_term_months ? `${o.lease_term_months} mo` : '—';
        const start = fmtDate(o.preferred_start_date);
        const status = o.status || 'draft';
        const isSubmitted = ['submitted', 'offer_accepted', 'evidence_submitted', 'validated', 'leased'].includes(status);
        const isExpanded = expandedIds.has(String(o.id));
        const canAccept = status === 'submitted';
        const canReject = status === 'submitted';

        const headlineRent = rent ? `${rent}/wk` : '—';

        return `
          <div class="lo-row ${isExpanded ? 'lo-row-expanded' : ''}" data-id="${o.id}">
            <div class="lo-row-summary">
              <button type="button" class="lo-row-toggle" data-id="${o.id}" title="${isExpanded ? 'Collapse' : 'Expand'}">${isExpanded ? '▼' : '▶'}</button>
              <span class="lo-status ${statusClass(status)}">${esc(fmtStatus(status))}</span>
              <span class="lo-rent">${esc(headlineRent)}</span>
              <span class="lo-meta">Bond ${esc(bond)} · Term ${esc(term)} · From ${esc(start)}</span>
              ${status === 'draft' ? `
                <span class="lo-row-actions-inline">
                  <button class="lo-delete-btn" type="button" data-id="${o.id}" title="Delete this draft offer">✕</button>
                </span>` : ''}
            </div>

            ${isExpanded ? `
              <div class="lo-row-body">
                ${isSubmitted ? renderSubmittedDetail(o) : ''}
                ${renderTokenBlock(o)}
                ${canAccept || canReject ? `
                  <div class="lo-decision-row">
                    ${canAccept ? `<button type="button" class="lo-accept-btn" data-id="${o.id}">Accept Offer</button>` : ''}
                    ${canReject ? `<button type="button" class="lo-reject-btn" data-id="${o.id}">Reject</button>` : ''}
                  </div>` : ''}
              </div>` : ''}
          </div>
        `;
      }).join('');

      wireListEvents();
    }

    function wireListEvents() {
      listEl.querySelectorAll('.lo-row-toggle').forEach(btn => {
        btn.addEventListener('click', e => {
          e.stopPropagation();
          const id = String(btn.getAttribute('data-id'));
          if (expandedIds.has(id)) expandedIds.delete(id);
          else expandedIds.add(id);
          renderList();
        });
      });
      listEl.querySelectorAll('.lo-row-summary').forEach(row => {
        row.addEventListener('click', e => {
          if (e.target.closest('button') || e.target.closest('input')) return;
          const id = String(row.parentElement.getAttribute('data-id'));
          if (expandedIds.has(id)) expandedIds.delete(id);
          else expandedIds.add(id);
          renderList();
        });
      });

      listEl.querySelectorAll('.lo-delete-btn').forEach(b => {
        b.addEventListener('click', async (e) => {
          e.stopPropagation();
          if (!confirm('Delete this draft offer? This cannot be undone.')) return;
          try {
            const r = await fetch(`${API}?id=${encodeURIComponent(b.getAttribute('data-id'))}`, { method: 'DELETE' });
            if (!r.ok) throw new Error(r.status);
            await load();
          } catch (err) {
            alert('Delete failed: ' + err.message);
          }
        });
      });

      listEl.querySelectorAll('.lo-accept-btn').forEach(b => {
        b.addEventListener('click', async () => {
          const id = b.getAttribute('data-id');
          if (!confirm('Accept this offer? This will:\n\n• Convert each applicant into a Contact (linked to this deal as Applicant)\n• Send an Evidence Upload Form link to the primary applicant\n• Lock the offer terms\n\nProceed?')) return;
          b.disabled = true;
          b.textContent = 'Accepting…';
          try {
            const r = await fetch(API, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: parseInt(id, 10), status: 'offer_accepted' }),
            });
            if (!r.ok) {
              const err = await r.json().catch(() => ({}));
              throw new Error(err.error || r.status);
            }
            await load();
          } catch (err) {
            alert('Accept failed: ' + err.message);
            b.disabled = false;
            b.textContent = 'Accept Offer';
          }
        });
      });

      listEl.querySelectorAll('.lo-reject-btn').forEach(b => {
        b.addEventListener('click', async () => {
          const id = b.getAttribute('data-id');
          if (!confirm('Reject this offer? The applicant will not be notified by the system. This is a permanent decision.')) return;
          b.disabled = true;
          b.textContent = 'Rejecting…';
          try {
            const r = await fetch(API, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: parseInt(id, 10), status: 'rejected' }),
            });
            if (!r.ok) {
              const err = await r.json().catch(() => ({}));
              throw new Error(err.error || r.status);
            }
            await load();
          } catch (err) {
            alert('Reject failed: ' + err.message);
            b.disabled = false;
            b.textContent = 'Reject';
          }
        });
      });

      wireTokenActions();
    }

    async function pickContactForToken() {
      try {
        const r = await fetch(`/api/contacts?pipeline_id=${encodeURIComponent(dealId)}`);
        if (!r.ok) throw new Error(r.status);
        const linked = await r.json();
        if (!Array.isArray(linked) || !linked.length) {
          alert('This Enquiry deal has no linked Contacts. Add an enquirer Contact first.');
          return null;
        }
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
      listEl.querySelectorAll('.lo-issue-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const applicationId = btn.getAttribute('data-application-id');
          const step = parseInt(btn.getAttribute('data-step'), 10);
          const formName = step === 1 ? 'Offer Form' : 'Evidence Upload Form';
          const contact = await pickContactForToken();
          if (!contact) return;
          if (!confirm(`Send ${formName} link to ${contact.first_name || ''} ${contact.last_name || ''} <${contact.email}>?`)) return;
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
            btn.textContent = `Send ${formName} link to applicant`;
          }
        });
      });

      listEl.querySelectorAll('.lo-token-copy-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const row = btn.closest('.lo-token-row');
          const url = row?.querySelector('.lo-token-url')?.getAttribute('data-url') || '';
          if (!url) return;
          try {
            await navigator.clipboard.writeText(url);
            const orig = btn.textContent;
            btn.textContent = '✓ Copied';
            setTimeout(() => { btn.textContent = orig; }, 1500);
          } catch (_) {
            const input = row.querySelector('.lo-token-url');
            input.select();
            document.execCommand('copy');
            const orig = btn.textContent;
            btn.textContent = '✓ Copied';
            setTimeout(() => { btn.textContent = orig; }, 1500);
          }
        });
      });

      listEl.querySelectorAll('.lo-token-resend-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
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

      listEl.querySelectorAll('.lo-token-reissue-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
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
  }

  window.LeaseOfferSection = { mount };
})();
