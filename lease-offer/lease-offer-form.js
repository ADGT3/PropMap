/* ─────────────────────────────────────────────────────────────────────────
   Lease Offer public form logic — V77.2
   Token from URL → /api/public/lease-offers/{token}/...
   ───────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  // ── Token from URL ────────────────────────────────────────────────────
  const m = location.pathname.match(/^\/lease-offer\/([A-Za-z0-9]+)\/?$/);
  const TOKEN = m ? m[1] : null;
  if (!TOKEN) {
    showError('No token provided in URL.');
    return;
  }

  const API_BASE = '/api/public/lease-offers/' + encodeURIComponent(TOKEN);

  // ── State ─────────────────────────────────────────────────────────────
  let LOAD_DATA = null;            // server-provided context (deal/property/listing terms/applicant defaults)
  let APPLICANTS = [];             // [{ first_name, last_name, email, mobile, dob, current_address, smoker, employment_status, employer_name, position, gross_weekly_income, length_of_employment }]
  let SAVE_TIMER = null;
  let SAVE_IN_FLIGHT = false;
  let HAS_SUBMITTED = false;

  // ── Bootstrap ─────────────────────────────────────────────────────────
  bootstrap();

  async function bootstrap() {
    // First, get token info to decide which view to show.
    try {
      const r = await fetch(API_BASE + '/token-info');
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        showError(err.error || 'This link is no longer valid.');
        return;
      }
      const info = await r.json();
      if (info.verified) {
        // Already verified on a prior visit — load form directly
        await loadAndShowForm();
      } else {
        // Show verify gate with masked email + mobile challenge
        showVerify(info.masked_email);
      }
    } catch (err) {
      showError('Could not connect to the server. Please try again.');
    }
  }

  async function loadAndShowForm() {
    try {
      const r = await fetch(API_BASE + '/load');
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        showError(err.error || 'Could not load form.');
        return;
      }
      LOAD_DATA = await r.json();
      if (LOAD_DATA.application.status !== 'draft') {
        // Already submitted — show thanks/info
        showAlreadySubmitted();
        return;
      }
      seedApplicantsFromLoad();
      renderForm();
      showForm();
    } catch (err) {
      showError('Could not load form: ' + err.message);
    }
  }

  function seedApplicantsFromLoad() {
    // Existing applicants_jsonb takes priority (if user already saved a draft)
    if (Array.isArray(LOAD_DATA.application.applicants_jsonb) && LOAD_DATA.application.applicants_jsonb.length) {
      APPLICANTS = LOAD_DATA.application.applicants_jsonb.map(a => ({ ...a }));
      return;
    }
    // Otherwise seed primary from token-linked Contact + add empty placeholder for any extra fields
    const def = LOAD_DATA.primary_applicant_default || {};
    APPLICANTS = [{
      first_name: def.first_name || '',
      last_name:  def.last_name  || '',
      email:      def.email      || '',
      mobile:     def.mobile     || '',
      dob:        def.dob        || '',
      current_address: '',
      smoker: null,
      employment_status: '',
      employer_name: '',
      position: '',
      gross_weekly_income: null,
      length_of_employment: '',
    }];
  }

  // ── Views ────────────────────────────────────────────────────────────

  function showError(msg) {
    document.getElementById('lofLoading').style.display = 'none';
    document.getElementById('lofVerify').style.display = 'none';
    document.getElementById('lofForm').style.display = 'none';
    document.getElementById('lofThanks').style.display = 'none';
    document.getElementById('lofErrorMessage').textContent = msg;
    document.getElementById('lofError').style.display = '';
  }

  function showVerify(maskedEmail) {
    document.getElementById('lofLoading').style.display = 'none';
    const emailEl = document.getElementById('lofVerifyEmail');
    if (maskedEmail) {
      emailEl.textContent = maskedEmail;
      emailEl.style.display = '';
    } else {
      emailEl.style.display = 'none';
    }
    document.getElementById('lofVerify').style.display = '';
    document.getElementById('lofVerifyForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const mobile = document.getElementById('lofVerifyMobile').value.trim();
      const errEl = document.getElementById('lofVerifyError');
      const btn = document.getElementById('lofVerifyBtn');
      errEl.style.display = 'none';
      errEl.textContent = '';

      if (!mobile) {
        errEl.textContent = 'Please enter your mobile number.';
        errEl.style.display = '';
        return;
      }

      btn.disabled = true;
      btn.textContent = 'Checking…';
      try {
        const r = await fetch(API_BASE + '/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mobile }),
        });
        if (!r.ok) {
          const err = await r.json().catch(() => ({}));
          errEl.textContent = err.error || 'Verification failed.';
          errEl.style.display = '';
          btn.disabled = false;
          btn.textContent = 'Continue';
          return;
        }
        // Success — load and show the form
        await loadAndShowForm();
      } catch (err) {
        errEl.textContent = 'Network error. Please try again.';
        errEl.style.display = '';
        btn.disabled = false;
        btn.textContent = 'Continue';
      }
    }, { once: false });
  }

  function showForm() {
    document.getElementById('lofLoading').style.display = 'none';
    document.getElementById('lofVerify').style.display = 'none';
    document.getElementById('lofError').style.display = 'none';
    document.getElementById('lofThanks').style.display = 'none';
    document.getElementById('lofForm').style.display = '';
  }

  function showThanks() {
    document.getElementById('lofForm').style.display = 'none';
    document.getElementById('lofThanks').style.display = '';
    window.scrollTo(0, 0);
  }

  function showAlreadySubmitted() {
    document.getElementById('lofLoading').style.display = 'none';
    document.getElementById('lofVerify').style.display = 'none';
    document.getElementById('lofError').style.display = 'none';
    document.getElementById('lofForm').style.display = 'none';
    document.getElementById('lofThanks').style.display = '';
  }

  // ── Form rendering ───────────────────────────────────────────────────

  function renderForm() {
    // Property address
    const p = LOAD_DATA.property;
    const addr = [p.address, p.suburb, p.state].filter(Boolean).join(', ');
    document.getElementById('lofProperty').textContent = addr;

    // Listing summary (advertised rent / bond / term)
    const lt = LOAD_DATA.listing_terms;
    const parts = [];
    if (lt.rent_amount != null) {
      const period = lt.rent_period === 'monthly' ? '/month' : '/wk';
      parts.push(`Advertised: <strong>$${Math.round(lt.rent_amount).toLocaleString('en-AU')}${period}</strong>`);
    }
    if (lt.term_months) parts.push(`<strong>${lt.term_months}</strong> month term`);
    if (lt.special_terms) parts.push(`<em>${esc(lt.special_terms)}</em>`);
    document.getElementById('lofListingSummary').innerHTML = parts.length ? parts.join(' · ') : 'Reference details from listing not available.';

    // Pre-fill offer terms from saved draft, falling back to listing defaults
    const a = LOAD_DATA.application;
    setVal('lofRent', a.requested_rent != null ? a.requested_rent : (lt.rent_amount || ''));
    setVal('lofBond', a.bond_weeks || 4);
    setVal('lofTermMonths', a.lease_term_months != null ? a.lease_term_months : (lt.term_months || ''));
    setVal('lofStartDate', a.preferred_start_date || lt.available_from || '');
    setVal('lofTerms', a.terms || '');

    // Household
    if (a.occupants) {
      setVal('lofOccupantsTotal', a.occupants.total || '');
      setVal('lofOccupantsDetails', a.occupants.details || '');
    }
    if (a.pets) {
      document.getElementById('lofHasPets').checked = !!a.pets.has_pets;
      setVal('lofPetsDetails', a.pets.details || '');
      togglePetsDetails();
    }

    // Applicants + Finance blocks
    renderApplicants();
    renderFinanceBlocks();

    // Wire events (autosave + submit + add applicant + pets toggle)
    wireFormEvents();
  }

  function renderApplicants() {
    const wrap = document.getElementById('lofApplicants');
    wrap.innerHTML = APPLICANTS.map((a, i) => renderApplicantBlock(a, i)).join('');
  }

  function renderApplicantBlock(a, i) {
    const isPrimary = i === 0;
    return `
      <div class="lof-applicant" data-idx="${i}">
        <div class="lof-applicant-header">
          <span>Applicant ${i + 1}${isPrimary ? ' (Primary)' : ''}</span>
          ${isPrimary ? '' : `<button type="button" class="lof-applicant-remove" data-remove="${i}">Remove</button>`}
        </div>
        <div class="lof-row">
          <div class="lof-field">
            <label>First name <span class="lof-req">*</span></label>
            <input type="text" data-field="first_name" data-idx="${i}" value="${esc(a.first_name)}" autocomplete="given-name">
          </div>
          <div class="lof-field">
            <label>Last name <span class="lof-req">*</span></label>
            <input type="text" data-field="last_name" data-idx="${i}" value="${esc(a.last_name)}" autocomplete="family-name">
          </div>
        </div>
        <div class="lof-row">
          <div class="lof-field">
            <label>Email <span class="lof-req">*</span></label>
            <input type="email" data-field="email" data-idx="${i}" value="${esc(a.email)}" autocomplete="email">
          </div>
          <div class="lof-field">
            <label>Mobile <span class="lof-req">*</span></label>
            <input type="tel" data-field="mobile" data-idx="${i}" value="${esc(a.mobile)}" autocomplete="tel">
          </div>
        </div>
        <div class="lof-row">
          <div class="lof-field">
            <label>Date of birth</label>
            <input type="date" data-field="dob" data-idx="${i}" value="${esc(a.dob)}">
          </div>
          <div class="lof-field lof-field-radio">
            <label>Smoker?</label>
            <div class="lof-field-radio-group">
              <label><input type="radio" name="smoker_${i}" data-field="smoker" data-idx="${i}" data-value="true"  ${a.smoker === true  ? 'checked' : ''}> Yes</label>
              <label><input type="radio" name="smoker_${i}" data-field="smoker" data-idx="${i}" data-value="false" ${a.smoker === false ? 'checked' : ''}> No</label>
            </div>
          </div>
        </div>
        <div class="lof-field">
          <label>Current address</label>
          <input type="text" data-field="current_address" data-idx="${i}" value="${esc(a.current_address)}" autocomplete="street-address" placeholder="Where you live now">
        </div>
      </div>
    `;
  }

  function renderFinanceBlocks() {
    const wrap = document.getElementById('lofFinanceBlocks');
    wrap.innerHTML = APPLICANTS.map((a, i) => renderFinanceBlock(a, i)).join('');
  }

  function renderFinanceBlock(a, i) {
    return `
      <div class="lof-finance-block" data-idx="${i}">
        <div class="lof-finance-block-header">Finance — Applicant ${i + 1}</div>
        <div class="lof-row">
          <div class="lof-field">
            <label>Employment status</label>
            <select data-field="employment_status" data-idx="${i}">
              <option value="">— Select —</option>
              <option value="employed"      ${a.employment_status === 'employed'      ? 'selected' : ''}>Employed</option>
              <option value="self_employed" ${a.employment_status === 'self_employed' ? 'selected' : ''}>Self-employed</option>
              <option value="retired"       ${a.employment_status === 'retired'       ? 'selected' : ''}>Retired</option>
              <option value="student"       ${a.employment_status === 'student'       ? 'selected' : ''}>Student</option>
              <option value="unemployed"    ${a.employment_status === 'unemployed'    ? 'selected' : ''}>Unemployed</option>
            </select>
          </div>
          <div class="lof-field">
            <label>Length of employment</label>
            <input type="text" data-field="length_of_employment" data-idx="${i}" value="${esc(a.length_of_employment)}" placeholder="e.g. 3 years">
          </div>
        </div>
        <div class="lof-row">
          <div class="lof-field">
            <label>Employer name</label>
            <input type="text" data-field="employer_name" data-idx="${i}" value="${esc(a.employer_name)}">
          </div>
          <div class="lof-field">
            <label>Position / role</label>
            <input type="text" data-field="position" data-idx="${i}" value="${esc(a.position)}">
          </div>
        </div>
        <div class="lof-row">
          <div class="lof-field">
            <label>Gross weekly income ($)</label>
            <input type="number" min="0" step="1" inputmode="numeric" data-field="gross_weekly_income" data-idx="${i}" value="${a.gross_weekly_income != null ? a.gross_weekly_income : ''}" placeholder="e.g. 1500">
          </div>
        </div>
      </div>
    `;
  }

  // ── Form events ──────────────────────────────────────────────────────

  function wireFormEvents() {
    // Pets toggle
    document.getElementById('lofHasPets').addEventListener('change', () => {
      togglePetsDetails();
      scheduleAutosave();
    });

    // Add applicant button
    document.getElementById('lofAddApplicantBtn').addEventListener('click', () => {
      if (APPLICANTS.length >= 6) {
        alert('Maximum 6 applicants per offer.');
        return;
      }
      APPLICANTS.push({
        first_name: '', last_name: '', email: '', mobile: '', dob: '',
        current_address: '', smoker: null,
        employment_status: '', employer_name: '', position: '',
        gross_weekly_income: null, length_of_employment: '',
      });
      renderApplicants();
      renderFinanceBlocks();
      // Re-wire delegated events on the freshly-rendered blocks
      wireDelegatedFieldEvents();
      scheduleAutosave();
    });

    wireDelegatedFieldEvents();

    // Top-level offer-terms / household fields
    ['lofRent', 'lofBond', 'lofTermMonths', 'lofStartDate', 'lofTerms',
     'lofOccupantsTotal', 'lofOccupantsDetails', 'lofPetsDetails',
    ].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('blur', scheduleAutosave);
      if (el) el.addEventListener('input', scheduleAutosave);
    });

    // Submit
    document.getElementById('lofFormEl').addEventListener('submit', async e => {
      e.preventDefault();
      await doSubmit();
    });
  }

  function wireDelegatedFieldEvents() {
    // Applicant + Finance blocks: capture blur/input on text/email/select; click on radios; click on Remove
    const wraps = [
      document.getElementById('lofApplicants'),
      document.getElementById('lofFinanceBlocks'),
    ];
    wraps.forEach(wrap => {
      // Replace existing listeners by cloning — defensive against re-wires after re-render
      const clone = wrap.cloneNode(true);
      wrap.parentNode.replaceChild(clone, wrap);
    });
    const applicantsWrap = document.getElementById('lofApplicants');
    const financeWrap = document.getElementById('lofFinanceBlocks');

    [applicantsWrap, financeWrap].forEach(wrap => {
      wrap.addEventListener('input', e => {
        if (e.target.matches('[data-field]')) {
          syncApplicantField(e.target);
          scheduleAutosave();
        }
      });
      wrap.addEventListener('change', e => {
        if (e.target.matches('[data-field]')) {
          syncApplicantField(e.target);
          scheduleAutosave();
        }
      });
    });

    // Remove buttons
    applicantsWrap.addEventListener('click', e => {
      const btn = e.target.closest('.lof-applicant-remove');
      if (!btn) return;
      const idx = parseInt(btn.getAttribute('data-remove'), 10);
      if (idx > 0) {
        APPLICANTS.splice(idx, 1);
        renderApplicants();
        renderFinanceBlocks();
        wireDelegatedFieldEvents();
        scheduleAutosave();
      }
    });
  }

  function syncApplicantField(el) {
    const idx = parseInt(el.getAttribute('data-idx'), 10);
    const field = el.getAttribute('data-field');
    if (isNaN(idx) || !field || !APPLICANTS[idx]) return;
    if (field === 'smoker') {
      const val = el.getAttribute('data-value');
      APPLICANTS[idx].smoker = val === 'true' ? true : (val === 'false' ? false : null);
    } else if (field === 'gross_weekly_income') {
      const n = parseFloat(String(el.value).replace(/[^0-9.]/g, ''));
      APPLICANTS[idx][field] = isNaN(n) ? null : n;
    } else {
      APPLICANTS[idx][field] = el.value;
    }
  }

  function togglePetsDetails() {
    const has = document.getElementById('lofHasPets').checked;
    document.getElementById('lofPetsDetailsWrap').style.display = has ? '' : 'none';
  }

  // ── Autosave ────────────────────────────────────────────────────────

  function scheduleAutosave() {
    if (HAS_SUBMITTED) return;
    clearTimeout(SAVE_TIMER);
    setSaveState('saving', 'Saving…');
    SAVE_TIMER = setTimeout(doAutosave, 1000);
  }

  async function doAutosave() {
    if (HAS_SUBMITTED) return;
    if (SAVE_IN_FLIGHT) {
      // Reschedule
      SAVE_TIMER = setTimeout(doAutosave, 500);
      return;
    }
    SAVE_IN_FLIGHT = true;
    try {
      const payload = collectFormPayload();
      const r = await fetch(API_BASE + '/submit-draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        setSaveState('error', err.error || 'Save failed');
        return;
      }
      const data = await r.json();
      const t = new Date(data.saved_at);
      setSaveState('saved', '✓ Saved at ' + t.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' }));
    } catch (err) {
      setSaveState('error', 'Save failed: ' + err.message);
    } finally {
      SAVE_IN_FLIGHT = false;
    }
  }

  function setSaveState(cls, text) {
    const el = document.getElementById('lofSaveState');
    el.className = 'lof-savestate' + (cls ? ' lof-savestate-' + cls : '');
    el.textContent = text || '';
  }

  // ── Submit ──────────────────────────────────────────────────────────

  async function doSubmit() {
    if (HAS_SUBMITTED) return;
    // Cancel pending autosave so we don't double-write
    clearTimeout(SAVE_TIMER);

    // Client-side validation summary (also re-checked server-side)
    const payload = collectFormPayload();
    const errs = clientValidate(payload);
    showValidation(errs);
    if (errs.length) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }

    const btn = document.getElementById('lofSubmitBtn');
    btn.disabled = true;
    btn.textContent = 'Submitting…';

    try {
      const r = await fetch(API_BASE + '/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        if (Array.isArray(err.errors)) {
          showValidation(err.errors.map(e => e.error || JSON.stringify(e)));
        } else {
          showValidation([err.error || 'Submission failed']);
        }
        btn.disabled = false;
        btn.textContent = 'Submit Offer';
        return;
      }
      HAS_SUBMITTED = true;
      showThanks();
    } catch (err) {
      showValidation(['Submission failed: ' + err.message]);
      btn.disabled = false;
      btn.textContent = 'Submit Offer';
    }
  }

  function clientValidate(p) {
    const errs = [];
    if (!p.requested_rent || p.requested_rent <= 0) errs.push('Rent offered is required.');
    if (!p.bond_weeks || p.bond_weeks < 4) errs.push('Bond is required (minimum 4 weeks).');
    if (!p.preferred_start_date) errs.push('Preferred start date is required.');
    if (!p.applicants.length)    errs.push('At least one applicant is required.');
    p.applicants.forEach((a, i) => {
      const n = i + 1;
      if (!a.first_name) errs.push(`Applicant ${n}: first name is required.`);
      if (!a.last_name)  errs.push(`Applicant ${n}: last name is required.`);
      if (!a.email || !/^\S+@\S+\.\S+$/.test(a.email)) errs.push(`Applicant ${n}: valid email is required.`);
      if (!a.mobile)     errs.push(`Applicant ${n}: mobile is required.`);
    });
    if (!p.occupants || !p.occupants.total) errs.push('Total occupants is required.');
    return errs;
  }

  function showValidation(errs) {
    const el = document.getElementById('lofValidationSummary');
    if (!errs || !errs.length) {
      el.style.display = 'none';
      el.innerHTML = '';
      return;
    }
    el.innerHTML = '<strong>Please fix the following before submitting:</strong><ul>' +
      errs.map(e => `<li>${esc(e)}</li>`).join('') + '</ul>';
    el.style.display = '';
  }

  // ── Payload ──────────────────────────────────────────────────────────

  function collectFormPayload() {
    return {
      requested_rent:       parseNum(getVal('lofRent')),
      bond_weeks:           parseInt(getVal('lofBond'), 10) || null,
      lease_term_months:    parseInt(getVal('lofTermMonths'), 10) || null,
      preferred_start_date: getVal('lofStartDate') || null,
      terms:                getVal('lofTerms') || null,
      occupants: {
        total:   parseInt(getVal('lofOccupantsTotal'), 10) || null,
        details: getVal('lofOccupantsDetails') || null,
      },
      pets: {
        has_pets: document.getElementById('lofHasPets').checked,
        details:  getVal('lofPetsDetails') || null,
      },
      applicants: APPLICANTS.map(a => ({ ...a })),
    };
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  function esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function getVal(id) {
    const el = document.getElementById(id);
    return el ? (el.value || '').trim() : '';
  }
  function setVal(id, v) {
    const el = document.getElementById(id);
    if (el) el.value = v == null ? '' : v;
  }
  function parseNum(v) {
    if (v == null || v === '') return null;
    const n = parseFloat(String(v).replace(/[^0-9.-]/g, ''));
    return isNaN(n) ? null : n;
  }
})();
