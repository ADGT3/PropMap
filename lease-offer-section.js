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

  // Mirror of the doc-type list in lease-offer/step-2.js. Used to render
  // friendly labels in the agent's review block.
  const ID_DOC_LABELS = {
    passport:             'Passport (70 pts)',
    birth_certificate:    'Birth certificate (70 pts)',
    drivers_licence:      'Drivers licence — front (40 pts)',
    drivers_licence_back: 'Drivers licence — back (0 pts)',
    medicare:             'Medicare card (25 pts)',
    bank_statement:       'Bank statement (25 pts)',
    utility_bill:         'Utility bill (25 pts)',
    rates_notice:         'Rates notice (25 pts)',
    other:                'Other (10 pts)',
  };

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
      draft:                       'Draft',
      submitted:                   'Submitted',
      offer_resubmit_requested:    'Offer Resubmit Requested',
      offer_accepted:              'Accepted',
      evidence_submitted:          'Evidence In',
      evidence_resubmit_requested: 'Resubmit Requested',
      validated:                   'Validated',
      leased:                      'Leased',
      rejected:                    'Rejected',
      withdrawn:                   'Withdrawn',
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
    // V78b — id of the offer whose Offer Terms are currently being edited inline
    // (null = not editing). String, matching the existing pattern used for
    // expandedIds and offer.id from the API. Cleared on save / cancel / row collapse.
    let editingTermsId = null;

    containerEl.innerHTML = `
      <div class="kb-fin-pick-header" style="margin-top:16px">
        <span>Lease Offers</span>
        <button class="kb-add-offer-btn lo-add-btn" type="button">+ New Offer</button>
      </div>
      <div class="lo-list"></div>
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
        // V78c — Pick the recipient up front. For single-enquirer deals
        // (the common case) this is silent and uses the only linked contact.
        // For multi-enquirer deals a picker dialog appears.
        const contact = await pickContactForToken();
        if (!contact) {
          // pickContactForToken already alerted (no contacts / bad email / cancelled)
          return;
        }

        addBtn.textContent = 'Creating…';
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

        // Issue Step 1 token + send invite email to the chosen contact.
        addBtn.textContent = 'Sending link…';
        const tr = await fetch('/api/applicant-form-tokens', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'issue', application_id: newOffer.id, step: 1, contact_id: contact.id }),
        });
        if (!tr.ok) {
          const err = await tr.json().catch(() => ({}));
          // Draft was created — surface failure but don't roll back. The agent
          // can use + Send Link on the empty token row to retry.
          throw new Error(err.error || tr.status);
        }

        await load();
      } catch (err) {
        alert('Failed to create offer: ' + err.message);
        await load(); // reload anyway so a partial state (draft without token) is visible
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
      const allowStep2 = status === 'offer_accepted' || status === 'evidence_submitted' ||
                         status === 'evidence_resubmit_requested' || status === 'validated' ||
                         status === 'leased';

      let step1Html = '';
      if (status === 'draft') {
        if (tokenStep1) {
          step1Html = renderTokenStateRow(offer, tokenStep1, 1);
        } else {
          step1Html = renderEmptyTokenRow(offer, 1);
        }
      } else if (tokenStep1) {
        step1Html = renderTokenStateRow(offer, tokenStep1, 1);
      }

      let step2Html = '';
      if (allowStep2) {
        if (tokenStep2) {
          step2Html = renderTokenStateRow(offer, tokenStep2, 2);
        } else {
          step2Html = renderEmptyTokenRow(offer, 2);
        }
      }

      if (!step1Html && !step2Html) return '';
      return `<div class="lo-token-block">${step1Html}${step2Html}</div>`;
    }

    function renderEmptyTokenRow(offer, step) {
      const stepLabel = step === 1 ? 'Offer Form' : 'Evidence Upload Form';
      return `
        <div class="lo-token-row lo-token-row-empty">
          <div class="lo-token-label">${esc(stepLabel)}</div>
          <div class="lo-token-url-row">
            <button class="lo-issue-btn" type="button" data-application-id="${esc(offer.id)}" data-step="${step}">+ Send Link</button>
          </div>
          <div class="lo-token-meta">
            <span class="lo-token-state lo-token-state-pending">Not yet sent</span>
          </div>
        </div>
      `;
    }

    function renderTokenStateRow(offer, token, step) {
      const stepLabel = step === 1 ? 'Offer Form' : 'Evidence Upload Form';
      const stepPath = step === 2 ? 'step-2/' : '';
      const formUrl = `https://propmap.edanproperty.com.au/lease-offer/${stepPath}${token.token}`;
      const status = offer.status || 'draft';

      let stateLine = '';
      if (step === 1 && status === 'offer_resubmit_requested') {
        stateLine = `<span class="lo-token-state lo-token-state-pending">↻ Offer resubmit requested — applicant can edit and resubmit</span>`;
      } else if (step === 1 && (status === 'submitted' || status === 'offer_accepted' || status === 'evidence_submitted' || status === 'evidence_resubmit_requested' || status === 'validated' || status === 'leased')) {
        stateLine = `<span class="lo-token-state lo-token-state-done">✓ Submitted ${esc(fmtRelative(token.last_accessed_at || token.created_at))}</span>`;
      } else if (step === 2 && status === 'evidence_resubmit_requested') {
        stateLine = `<span class="lo-token-state lo-token-state-pending">↻ Resubmit requested — applicant can edit and resubmit</span>`;
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
      const status = offer.status || '';
      const isTerminal = ['leased', 'rejected', 'withdrawn'].includes(status);
      const canEditTerms = !isTerminal;
      const isEditing = editingTermsId === String(offer.id);

      let html = '<div class="lo-detail">';

      html += '<div class="lo-detail-section">';
      html += '<div class="lo-detail-section-title">Offer Terms';
      if (canEditTerms && !isEditing) {
        html += ` <button type="button" class="lo-terms-edit-btn" data-id="${esc(offer.id)}" title="Edit offer terms (e.g. after a verbal negotiation)">Edit</button>`;
      }
      html += '</div>';

      if (isEditing) {
        // V78b — Inline edit form for the five Offer Terms fields
        const dateForInput = offer.preferred_start_date ? String(offer.preferred_start_date).slice(0, 10) : '';
        html += `
          <table class="lo-detail-table lo-terms-edit" data-id="${esc(offer.id)}">
            <tr><th>Rent offered</th><td>
              <input class="lo-terms-input" type="number" min="0" step="1" data-field="requested_rent" value="${esc(offer.requested_rent ?? '')}"> <span class="lo-terms-suffix">/wk</span>
            </td></tr>
            <tr><th>Bond</th><td>
              <input class="lo-terms-input" type="number" min="0" step="1" data-field="bond_weeks" value="${esc(offer.bond_weeks ?? '')}"> <span class="lo-terms-suffix">weeks</span>
            </td></tr>
            <tr><th>Lease term</th><td>
              <input class="lo-terms-input" type="number" min="0" step="1" data-field="lease_term_months" value="${esc(offer.lease_term_months ?? '')}"> <span class="lo-terms-suffix">months</span>
            </td></tr>
            <tr><th>Preferred start</th><td>
              <input class="lo-terms-input" type="date" data-field="preferred_start_date" value="${esc(dateForInput)}">
            </td></tr>
            <tr><th>Special terms</th><td>
              <textarea class="lo-terms-input lo-terms-textarea" rows="2" data-field="terms" placeholder="Any negotiated extras (e.g. early access, pet allowance)…">${esc(offer.terms || '')}</textarea>
            </td></tr>
          </table>
          <div class="lo-terms-edit-actions">
            <button type="button" class="lo-terms-save-btn" data-id="${esc(offer.id)}">Save Terms</button>
            <button type="button" class="lo-terms-cancel-btn" data-id="${esc(offer.id)}">Cancel</button>
          </div>
        `;
      } else {
        html += '<table class="lo-detail-table">';
        html += `<tr><th>Rent offered</th><td>${esc(fmtCurrency(offer.requested_rent))}/wk</td></tr>`;
        html += `<tr><th>Bond</th><td>${offer.bond_weeks || '—'} weeks</td></tr>`;
        html += `<tr><th>Lease term</th><td>${offer.lease_term_months ? `${offer.lease_term_months} months` : '—'}</td></tr>`;
        html += `<tr><th>Preferred start</th><td>${esc(fmtDate(offer.preferred_start_date))}</td></tr>`;
        if (offer.terms) html += `<tr><th>Special terms</th><td>${esc(offer.terms)}</td></tr>`;
        html += '</table>';
        // V78b — Amendment audit line. Shown only when an agent has edited terms
        // post-submit. Applicants' own resubmissions don't stamp these fields.
        if (offer.amended_at) {
          const who = offer.amended_by_name ? `by ${esc(offer.amended_by_name)} ` : '';
          html += `<div class="lo-terms-amended-line">Terms amended ${who}${esc(fmtRelative(offer.amended_at))}</div>`;
        }
      }
      html += '</div>';

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

    // V77.2d — Review block for submitted Step 2 evidence.
    // Renders consents, ID files (per applicant) with View links, housing/income
    // history with files, and lease docs. Plus the validation checklist (moved
    // from the per-deal Validation section into this per-offer block) and
    // Approve/Resubmit buttons.
    function renderReviewBlock(offer) {
      const evidence = Array.isArray(offer.evidence) ? offer.evidence : [];
      const housing  = Array.isArray(offer.housing_history) ? offer.housing_history : [];
      const income   = Array.isArray(offer.income_history)  ? offer.income_history  : [];
      const apps     = Array.isArray(offer.applicants_jsonb) ? offer.applicants_jsonb : [];
      const validation = offer.validation_jsonb || {};
      const status = offer.status || '';

      const isLocked = ['validated', 'leased', 'rejected', 'withdrawn'].includes(status);

      // Group evidence by category prefix
      const evByCat = {
        id: {},                          // applicant_contact_id → [files]
        housing: {},                     // client_id → [files]
        income: {},                      // client_id → [files]
        leasedoc: { 'signed-contract': [], 'condition-report': [] },
      };
      evidence.forEach(e => {
        const cat = e.category || '';
        if (cat.startsWith('id-')) {
          const k = e.applicant_contact_id || '_';
          if (!evByCat.id[k]) evByCat.id[k] = [];
          evByCat.id[k].push(e);
        } else if (cat.startsWith('housing-evidence:')) {
          const cid = cat.split(':')[1];
          if (!evByCat.housing[cid]) evByCat.housing[cid] = [];
          evByCat.housing[cid].push(e);
        } else if (cat.startsWith('income-evidence:')) {
          const cid = cat.split(':')[1];
          if (!evByCat.income[cid]) evByCat.income[cid] = [];
          evByCat.income[cid].push(e);
        } else if (cat.startsWith('lease-doc:')) {
          const slot = cat.split(':')[1];
          if (!evByCat.leasedoc[slot]) evByCat.leasedoc[slot] = [];
          evByCat.leasedoc[slot].push(e);
        }
      });

      let html = '<div class="lo-review-block">';
      html += '<div class="lo-review-title">Application & Evidence Review</div>';

      // ID Documents per applicant
      html += '<div class="lo-review-section">';
      html += '<div class="lo-review-section-title">ID Documents</div>';
      if (!apps.length) {
        html += '<div class="lo-review-empty">No applicants on this offer.</div>';
      } else {
        apps.forEach(a => {
          const name = [a.first_name, a.last_name].filter(Boolean).join(' ') || a.email || 'Applicant';
          const files = evByCat.id[a.contact_id] || [];
          const totalPoints = files.reduce((s, f) => s + (f.points_value || 0), 0);
          html += `<div class="lo-review-applicant">`;
          html += `  <div class="lo-review-applicant-head"><strong>${esc(name)}</strong> · <span class="lo-review-points ${totalPoints >= 100 ? '' : 'lo-review-points-low'}">${totalPoints} ID points</span></div>`;
          if (files.length) {
            html += '<ul class="lo-review-files">';
            files.forEach(f => {
              const docTypeLabel = ID_DOC_LABELS[f.doc_type] || f.doc_type || 'No type set';
              html += `<li><span class="lo-review-file-text">${esc(f.filename)} <span class="lo-review-file-meta">— ${esc(docTypeLabel)}</span></span> ${renderViewLink(f)}</li>`;
            });
            html += '</ul>';
          } else {
            html += '<div class="lo-review-empty">No ID files uploaded.</div>';
          }
          html += `</div>`;
        });
      }
      html += '</div>';

      // Housing history
      html += '<div class="lo-review-section">';
      html += '<div class="lo-review-section-title">Rental / Housing History</div>';
      if (!housing.length) {
        html += '<div class="lo-review-empty">No housing entries.</div>';
      } else {
        housing.forEach(h => {
          // client_id was stashed in evidence_label as 'client_id:xxx'
          const cid = (h.evidence_label || '').startsWith('client_id:')
            ? h.evidence_label.slice(10) : null;
          const files = (cid && evByCat.housing[cid]) || [];
          const range = `${esc(fmtDate(h.term_start_date))} – ${h.term_end_date ? esc(fmtDate(h.term_end_date)) : 'present'}`;
          const monthly = h.monthly_amount ? `${esc(fmtCurrency(h.monthly_amount))}/mo` : '—';
          html += `<div class="lo-review-entry">`;
          html += `  <div class="lo-review-entry-head"><strong>${esc(h.address || '—')}</strong> · ${esc(h.housing_type || '—')} · ${range} · ${monthly}</div>`;
          if (h.landlord_lender_name || h.landlord_lender_contact) {
            html += `<div class="lo-review-entry-meta">Landlord/Lender: ${esc(h.landlord_lender_name || '')}${h.landlord_lender_contact ? ' · ' + esc(h.landlord_lender_contact) : ''}</div>`;
          }
          if (files.length) {
            html += '<ul class="lo-review-files">';
            files.forEach(f => { html += `<li><span class="lo-review-file-text">${esc(f.filename)}</span> ${renderViewLink(f)}</li>`; });
            html += '</ul>';
          } else {
            html += '<div class="lo-review-empty">No supporting documents.</div>';
          }
          html += `</div>`;
        });
      }
      html += '</div>';

      // Income history
      html += '<div class="lo-review-section">';
      html += '<div class="lo-review-section-title">Income History</div>';
      if (!income.length) {
        html += '<div class="lo-review-empty">No income entries.</div>';
      } else {
        income.forEach(i => {
          const cid = (i.evidence_label || '').startsWith('client_id:')
            ? i.evidence_label.slice(10) : null;
          const files = (cid && evByCat.income[cid]) || [];
          const annual = i.annual_income ? esc(fmtCurrency(i.annual_income)) + '/yr' : '—';
          const range = `${esc(fmtDate(i.term_start_date))} – ${i.term_end_date ? esc(fmtDate(i.term_end_date)) : 'present'}`;
          html += `<div class="lo-review-entry">`;
          html += `  <div class="lo-review-entry-head"><strong>${esc(i.income_source_name || '—')}</strong>${i.role ? ' · ' + esc(i.role) : ''} · ${esc(i.income_type || '')} · ${annual} · ${range}</div>`;
          if (i.employer_contact_name || i.employer_contact_email || i.employer_contact_mobile) {
            const parts = [i.employer_contact_name, i.employer_contact_email, i.employer_contact_mobile].filter(Boolean).map(esc);
            html += `<div class="lo-review-entry-meta">Manager: ${parts.join(' · ')}</div>`;
          }
          if (files.length) {
            html += '<ul class="lo-review-files">';
            files.forEach(f => { html += `<li><span class="lo-review-file-text">${esc(f.filename)}</span> ${renderViewLink(f)}</li>`; });
            html += '</ul>';
          } else {
            html += '<div class="lo-review-empty">No supporting documents.</div>';
          }
          html += `</div>`;
        });
      }
      html += '</div>';

      // Lease documents
      const sc = evByCat.leasedoc['signed-contract'] || [];
      const cr = evByCat.leasedoc['condition-report'] || [];
      if (sc.length || cr.length) {
        html += '<div class="lo-review-section">';
        html += '<div class="lo-review-section-title">Lease Documents</div>';
        html += '<div class="lo-review-entry">';
        html += '<div class="lo-review-entry-head"><strong>Signed Lease Agreement</strong></div>';
        if (sc.length) {
          html += '<ul class="lo-review-files">';
          sc.forEach(f => { html += `<li><span class="lo-review-file-text">${esc(f.filename)}</span> ${renderViewLink(f)}</li>`; });
          html += '</ul>';
        } else {
          html += '<div class="lo-review-empty">Not yet uploaded.</div>';
        }
        html += '</div>';
        html += '<div class="lo-review-entry">';
        html += '<div class="lo-review-entry-head"><strong>Accepted Condition Report</strong></div>';
        if (cr.length) {
          html += '<ul class="lo-review-files">';
          cr.forEach(f => { html += `<li><span class="lo-review-file-text">${esc(f.filename)}</span> ${renderViewLink(f)}</li>`; });
          html += '</ul>';
        } else {
          html += '<div class="lo-review-empty">Not yet uploaded.</div>';
        }
        html += '</div>';
        html += '</div>';
      }

      // Validation checklist (moved from per-deal Validation section)
      const checklist = [
        { key: 'id_verified',                label: 'ID verified' },
        { key: 'income_evidence_reviewed',   label: 'Income evidence reviewed' },
        { key: 'references_checked',         label: 'References checked' },
        { key: 'rental_history_clean',       label: 'Rental history clean' },
        { key: 'affordability_confirmed',    label: 'Affordability confirmed' },
        { key: 'condition_report_completed', label: 'Condition Report completed' },
        { key: 'agreement_fully_executed',   label: 'Agreement Fully Executed' },
      ];
      const allChecked = checklist.every(c => !!validation[c.key]);

      html += '<div class="lo-review-section">';
      html += '<div class="lo-review-section-title">Validation Checklist</div>';
      html += `<div class="lo-review-checklist" data-application-id="${esc(offer.id)}">`;
      checklist.forEach(c => {
        const checked = validation[c.key] ? 'checked' : '';
        const disabled = isLocked ? 'disabled' : '';
        html += `<label class="lo-review-check"><input type="checkbox" data-vkey="${esc(c.key)}" ${checked} ${disabled}> ${esc(c.label)}</label>`;
      });
      html += `<div class="lo-review-notes-row"><textarea class="lo-review-notes" rows="2" placeholder="Validation notes…" ${isLocked ? 'disabled' : ''}>${esc(validation.notes || '')}</textarea></div>`;
      if (validation.last_updated_at) {
        const byPart = validation.last_updated_name ? ` by ${esc(validation.last_updated_name)}` : '';
        html += `<div class="lo-review-meta">Last updated ${esc(fmtRelative(validation.last_updated_at))}${byPart}</div>`;
      }
      html += '</div>';

      // Action buttons
      if (!isLocked) {
        html += '<div class="lo-review-actions">';
        if (status === 'evidence_submitted' || status === 'evidence_resubmit_requested') {
          html += `<button type="button" class="lo-resubmit-btn" data-id="${esc(offer.id)}" title="Unlock the form for the applicant — they'll get an email asking to review and resubmit.">Request Resubmit</button>`;
        }
        if (status === 'evidence_submitted' && allChecked) {
          html += `<button type="button" class="lo-validate-btn" data-id="${esc(offer.id)}" title="Mark this application as validated.">Approve & Validate</button>`;
        } else if (status === 'evidence_submitted') {
          html += `<button type="button" class="lo-validate-btn" data-id="${esc(offer.id)}" disabled title="Tick all 6 checklist items first.">Approve & Validate</button>`;
        }
        if (status === 'validated') {
          html += `<button type="button" class="lo-validate-btn lo-mark-leased-btn" data-id="${esc(offer.id)}" title="Mark application as leased.">Mark as Leased</button>`;
        }
        html += '</div>';
      }
      html += '</div>'; // .lo-review-block
      return html;
    }

    function renderViewLink(f) {
      return `<a class="lo-review-view-link" href="/api/applications/evidence/${esc(f.id)}/view" target="_blank" rel="noopener">View</a>`;
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
        const isSubmitted = ['submitted', 'offer_resubmit_requested', 'offer_accepted', 'evidence_submitted', 'evidence_resubmit_requested', 'validated', 'leased'].includes(status);
        const hasEvidence = ['evidence_submitted', 'evidence_resubmit_requested', 'validated', 'leased'].includes(status);
        const isExpanded = expandedIds.has(String(o.id));
        const canAccept = status === 'submitted';
        const canReject = status === 'submitted';
        // V78 — Step 1 resubmit. Shown while status is submitted (agent decides
        // to unlock the form) and remains visible while in offer_resubmit_requested
        // so the agent can re-trigger the email if needed.
        const canOfferResubmit = status === 'submitted' || status === 'offer_resubmit_requested';

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
                ${hasEvidence ? renderReviewBlock(o) : ''}
                ${canAccept || canReject || canOfferResubmit ? `
                  <div class="lo-decision-row">
                    ${canAccept ? `<button type="button" class="lo-accept-btn" data-id="${o.id}">Accept Offer</button>` : ''}
                    ${canOfferResubmit ? `<button type="button" class="lo-offer-resubmit-btn" data-id="${o.id}" title="Unlock the offer form for the applicant — they'll get an email asking to review and resubmit.">Request Offer Resubmit</button>` : ''}
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
          if (expandedIds.has(id)) {
            expandedIds.delete(id);
            // V78b — clear inline-edit state when row collapses
            if (editingTermsId === id) editingTermsId = null;
          } else {
            expandedIds.add(id);
          }
          renderList();
        });
      });
      listEl.querySelectorAll('.lo-row-summary').forEach(row => {
        row.addEventListener('click', e => {
          if (e.target.closest('button') || e.target.closest('input')) return;
          const id = String(row.parentElement.getAttribute('data-id'));
          if (expandedIds.has(id)) {
            expandedIds.delete(id);
            if (editingTermsId === id) editingTermsId = null;
          } else {
            expandedIds.add(id);
          }
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
          if (!confirm('Accept this offer? This will:\n\n• Match each applicant to an existing Contact (by email) or create a new one if none exists\n• Update name and mobile on matched Contacts with the applicant\'s submitted values\n• Link each Contact to this deal as Applicant\n• Send an Evidence Upload Form link to the primary applicant\n• Lock the offer terms\n\nProceed?')) return;
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

        // V78c — If multiple Contacts are linked to the Enquiry deal (e.g. a
        // couple or group of co-applicants), show a picker dialog. The agent
        // selects which one receives the Offer Form link.
        // For the common single-Contact case, fall through silently to the
        // first (and only) linked contact.
        let c;
        if (linked.length === 1) {
          c = linked[0];
        } else {
          c = await showContactPickerDialog(linked);
          if (!c) return null; // user cancelled
        }

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

    // V78c — Modal picker shown when an Enquiry deal has multiple linked
    // Contacts and the agent must choose who receives the Offer Form link.
    // Returns a Promise resolving to the chosen Contact, or null if cancelled.
    // Uses the existing kb-modal-overlay pattern for consistency with the
    // rest of the app.
    function showContactPickerDialog(contacts) {
      return new Promise(resolve => {
        const wrap = document.createElement('div');
        wrap.className = 'kb-modal-overlay';
        wrap.innerHTML = `
          <div class="kb-modal" role="dialog" aria-modal="true" style="max-width:480px">
            <div class="kb-modal-header">
              <h2>Send Offer Form to which applicant?</h2>
              <button class="kb-modal-close" title="Close" type="button">✕</button>
            </div>
            <div class="kb-modal-body">
              <div class="lo-picker-help">This Enquiry has multiple linked contacts. Choose who should receive the Offer Form link by email.</div>
              <div class="lo-picker-list">
                ${contacts.map((c, i) => `
                  <label class="lo-picker-row">
                    <input type="radio" name="lo-picker" value="${i}" ${i === 0 ? 'checked' : ''}>
                    <span class="lo-picker-name">${esc([c.first_name, c.last_name].filter(Boolean).join(' ') || '(no name)')}</span>
                    <span class="lo-picker-email">${esc(c.email || '— no email')}</span>
                  </label>
                `).join('')}
              </div>
            </div>
            <div class="kb-modal-footer">
              <button type="button" class="lo-picker-cancel-btn">Cancel</button>
              <button type="button" class="lo-picker-send-btn">Send Link</button>
            </div>
          </div>
        `;
        document.body.appendChild(wrap);

        function close(result) {
          if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
          resolve(result);
        }
        wrap.querySelector('.kb-modal-close').addEventListener('click', () => close(null));
        wrap.querySelector('.lo-picker-cancel-btn').addEventListener('click', () => close(null));
        wrap.querySelector('.lo-picker-send-btn').addEventListener('click', () => {
          const checked = wrap.querySelector('input[name="lo-picker"]:checked');
          if (!checked) { close(null); return; }
          close(contacts[parseInt(checked.value, 10)]);
        });
      });
    }

    function wireTokenActions() {
      listEl.querySelectorAll('.lo-issue-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const applicationId = btn.getAttribute('data-application-id');
          const step = parseInt(btn.getAttribute('data-step'), 10);
          const contact = await pickContactForToken();
          if (!contact) return;
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
            btn.textContent = '+ Send Link';
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

      // V77.2d — Validation checklist autosave (debounced)
      let _validationSaveTimer = null;
      const _validationDirty = {};  // applicationId → patch object
      async function flushValidation(applicationId) {
        const patch = _validationDirty[applicationId];
        if (!patch) return;
        delete _validationDirty[applicationId];
        const offer = offers.find(o => String(o.id) === String(applicationId));
        if (!offer) return;
        // Optimistic local merge (server will overwrite the timestamp + by-fields)
        const merged = Object.assign({}, offer.validation_jsonb || {}, patch);
        offer.validation_jsonb = merged;
        renderList();
        try {
          const r = await fetch(API, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: parseInt(applicationId, 10), validation_jsonb: merged }),
          });
          if (r.ok) {
            const updated = await r.json();
            // Pick up the server-stamped last_updated_at / last_updated_by / last_updated_name
            offer.validation_jsonb = updated.validation_jsonb || merged;
            renderList();
          }
        } catch (err) { console.warn('[LeaseOffer] validation save failed', err); }
      }
      function scheduleValidationSave(applicationId, patch) {
        _validationDirty[applicationId] = Object.assign({}, _validationDirty[applicationId] || {}, patch);
        if (_validationSaveTimer) clearTimeout(_validationSaveTimer);
        _validationSaveTimer = setTimeout(() => flushValidation(applicationId), 600);
      }

      listEl.querySelectorAll('.lo-review-checklist input[type="checkbox"]').forEach(cb => {
        cb.addEventListener('change', () => {
          const wrap = cb.closest('.lo-review-checklist');
          const applicationId = wrap.getAttribute('data-application-id');
          const key = cb.getAttribute('data-vkey');
          scheduleValidationSave(applicationId, { [key]: cb.checked });
        });
      });
      listEl.querySelectorAll('.lo-review-notes').forEach(ta => {
        ta.addEventListener('input', () => {
          const wrap = ta.closest('.lo-review-section')?.querySelector('.lo-review-checklist');
          if (!wrap) return;
          const applicationId = wrap.getAttribute('data-application-id');
          scheduleValidationSave(applicationId, { notes: ta.value });
        });
      });

      // V77.2d — Approve & Validate
      listEl.querySelectorAll('.lo-validate-btn:not(.lo-mark-leased-btn)').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const id = btn.getAttribute('data-id');
          if (!confirm('Mark this application as Validated? The applicant will no longer be able to edit their evidence.')) return;
          btn.disabled = true;
          try {
            // Flush any pending validation save first
            if (_validationDirty[id]) flushValidation(id);
            const r = await fetch(API, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: parseInt(id, 10), status: 'validated' }),
            });
            if (!r.ok) {
              const err = await r.json().catch(() => ({}));
              throw new Error(err.error || r.status);
            }
            await load();
          } catch (err) {
            alert('Could not validate: ' + err.message);
            btn.disabled = false;
          }
        });
      });

      // V77.2d — Mark as Leased (validated → leased)
      listEl.querySelectorAll('.lo-mark-leased-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const id = btn.getAttribute('data-id');
          if (!confirm('Mark this application as Leased? This is a terminal status — no further changes can be made.')) return;
          btn.disabled = true;
          try {
            const r = await fetch(API, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: parseInt(id, 10), status: 'leased' }),
            });
            if (!r.ok) {
              const err = await r.json().catch(() => ({}));
              throw new Error(err.error || r.status);
            }
            await load();
          } catch (err) {
            alert('Could not mark as leased: ' + err.message);
            btn.disabled = false;
          }
        });
      });

      // V77.2d — Request Resubmit
      listEl.querySelectorAll('.lo-resubmit-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const id = btn.getAttribute('data-id');
          if (!confirm('Request the applicant to review and resubmit?\n\nThis will:\n• Unlock the form for them to edit\n• Send them a generic email asking them to log back in\n\nYou should follow up separately to explain what needs updating.')) return;
          btn.disabled = true;
          try {
            const r = await fetch(API, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: parseInt(id, 10), status: 'evidence_resubmit_requested' }),
            });
            if (!r.ok) {
              const err = await r.json().catch(() => ({}));
              throw new Error(err.error || r.status);
            }
            await load();
          } catch (err) {
            alert('Could not request resubmit: ' + err.message);
            btn.disabled = false;
          }
        });
      });

      // V78 — Request Offer Resubmit (Step 1)
      listEl.querySelectorAll('.lo-offer-resubmit-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const id = btn.getAttribute('data-id');
          if (!confirm('Request the applicant to review and resubmit their offer?\n\nThis will:\n• Unlock the offer form for them to edit\n• Send them a generic email asking them to log back in\n\nYou should follow up separately to explain what needs updating.')) return;
          btn.disabled = true;
          try {
            const r = await fetch(API, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: parseInt(id, 10), status: 'offer_resubmit_requested' }),
            });
            if (!r.ok) {
              const err = await r.json().catch(() => ({}));
              throw new Error(err.error || r.status);
            }
            await load();
          } catch (err) {
            alert('Could not request offer resubmit: ' + err.message);
            btn.disabled = false;
          }
        });
      });

      // V78b — Edit Offer Terms (inline)
      listEl.querySelectorAll('.lo-terms-edit-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          editingTermsId = String(btn.getAttribute('data-id'));
          renderList();
        });
      });

      listEl.querySelectorAll('.lo-terms-cancel-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          editingTermsId = null;
          renderList();
        });
      });

      listEl.querySelectorAll('.lo-terms-save-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const id = parseInt(btn.getAttribute('data-id'), 10);
          const tbl = listEl.querySelector(`.lo-terms-edit[data-id="${id}"]`);
          if (!tbl) return;

          // Collect the five fields
          const inputs = tbl.querySelectorAll('.lo-terms-input');
          const payload = { id };
          inputs.forEach(inp => {
            const f = inp.getAttribute('data-field');
            let v = inp.value;
            if (f === 'requested_rent' || f === 'bond_weeks' || f === 'lease_term_months') {
              v = v === '' ? null : Number(v);
              if (v != null && (!Number.isFinite(v) || v < 0)) {
                alert(`${f} must be a non-negative number`);
                v = undefined;
              }
            } else if (f === 'preferred_start_date') {
              v = v === '' ? null : v; // YYYY-MM-DD passes through
            } else if (f === 'terms') {
              v = String(v || '').trim();
            }
            if (v !== undefined) payload[f] = v;
          });

          btn.disabled = true;
          const origLabel = btn.textContent;
          btn.textContent = 'Saving…';
          try {
            const r = await fetch(API, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload),
            });
            if (!r.ok) {
              const err = await r.json().catch(() => ({}));
              throw new Error(err.error || r.status);
            }
            editingTermsId = null;
            await load();
          } catch (err) {
            alert('Could not save terms: ' + err.message);
            btn.disabled = false;
            btn.textContent = origLabel;
          }
        });
      });
    }
  }

  window.LeaseOfferSection = { mount };
})();
