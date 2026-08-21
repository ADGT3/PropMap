/**
 * attendee-registration.js — V79
 *
 * Full-screen attendee self-registration view, opened when the agent taps a
 * listing card in the Upcoming Inspections panel and hands the device to a
 * walk-in attendee.
 */

(function () {
  'use strict';

  function esc(s) {
    return String(s ?? '').replace(/[&<>"]/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'
    })[c]);
  }

  function formatDate(iso) {
    if (!iso) return '';
    const datePart = String(iso).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return String(iso);
    const [y, m, d] = datePart.split('-');
    return `${d}-${m}-${y}`;
  }

  function formatTime(t) {
    if (!t) return '';
    const [hh, mm] = t.split(':');
    let h = parseInt(hh, 10);
    const ampm = h >= 12 ? 'pm' : 'am';
    h = h % 12; if (h === 0) h = 12;
    return `${h}:${mm}${ampm}`;
  }

  function inspectionLine(insp) {
    const addr = insp.property_address || '';
    const date = formatDate(insp.scheduled_date);
    const start = formatTime(insp.start_time);
    const end   = formatTime(insp.end_time);
    const time = start ? `${start}${end ? '–' + end : ''}` : '';
    const type = (insp.inspection_type || '').replace(/_/g, ' ');
    const parts = [];
    if (addr) parts.push(`<strong>${esc(addr)}</strong>`);
    if (type) parts.push(esc(type));
    if (date) parts.push(esc(date));
    if (time) parts.push(esc(time));
    return parts.join(' · ');
  }

  function open({ inspection }) {
    if (!inspection) {
      console.warn('[attendee-reg] open() called without inspection');
      return;
    }
    const existing = document.querySelector('.areg-screen');
    if (existing) existing.remove();

    const screen = document.createElement('div');
    screen.className = 'areg-screen';
    screen.innerHTML = `
      <div class="areg-header">
        <div class="areg-header-text">
          <div class="areg-title">Attendee Registration</div>
          <div class="areg-subtitle">${inspectionLine(inspection)}</div>
        </div>
        <button class="areg-close" data-role="close" aria-label="Close">✕</button>
      </div>
      <div class="areg-body" data-role="body"></div>
    `;
    document.body.appendChild(screen);
    screen.querySelector('[data-role="close"]').addEventListener('click', () => screen.remove());
    showSearchStep(screen, inspection);
  }

  function showSearchStep(screen, inspection) {
    const body = screen.querySelector('[data-role="body"]');
    body.innerHTML = `
      <div class="areg-search-step">
        <div class="areg-prompt">Please find your name to register your attendance.</div>
        <div class="areg-search-wrap">
          <input class="areg-search" type="search" placeholder="Search by name, email or mobile…" autocomplete="off">
          <div class="areg-search-results" data-role="results"></div>
        </div>
      </div>
    `;
    const searchEl  = body.querySelector('.areg-search');
    const resultsEl = body.querySelector('[data-role="results"]');
    let timer = null;
    searchEl.addEventListener('input', () => {
      clearTimeout(timer);
      const q = searchEl.value.trim();
      if (!q) { resultsEl.innerHTML = ''; resultsEl.classList.remove('areg-results-open'); return; }
      timer = setTimeout(() => doSearch(q, resultsEl, screen, inspection), 250);
    });
    if (window.matchMedia('(hover: hover)').matches) searchEl.focus();
  }

  async function doSearch(q, resultsEl, screen, inspection) {
    try {
      const r = await fetch(`/api/contacts?search=${encodeURIComponent(q)}`);
      if (!r.ok) {
        resultsEl.innerHTML = '<div class="areg-result-empty">Search failed — try again.</div>';
        resultsEl.classList.add('areg-results-open');
        return;
      }
      const contacts = await r.json();
      renderResults(contacts, resultsEl, screen, inspection);
    } catch (e) {
      console.warn('[attendee-reg] search failed:', e);
      resultsEl.innerHTML = '<div class="areg-result-empty">Search failed — try again.</div>';
      resultsEl.classList.add('areg-results-open');
    }
  }

  function renderResults(contacts, resultsEl, screen, inspection) {
    const matches = contacts.slice(0, 20);
    const matchesHtml = matches.map(c => {
      const name = [c.first_name, c.last_name].filter(Boolean).join(' ').trim() || `Contact #${c.id}`;
      const sub  = [c.email, c.mobile].filter(Boolean).join(' · ');
      return `
        <div class="areg-result" data-id="${c.id}" data-name="${esc(name)}">
          <div class="areg-result-name">${esc(name)}</div>
          ${sub ? `<div class="areg-result-sub">${esc(sub)}</div>` : ''}
        </div>`;
    }).join('');
    const noMatchesHtml = matches.length ? '' : '<div class="areg-result-empty">No matches.</div>';
    const createRowHtml = `
      <div class="areg-result areg-result-create" data-role="create">
        <div class="areg-result-name"><strong>+ I'm not in the list — create a new entry</strong></div>
        <div class="areg-result-sub">Tap to add your details</div>
      </div>`;
    resultsEl.innerHTML = matchesHtml + noMatchesHtml + createRowHtml;
    resultsEl.classList.add('areg-results-open');
    resultsEl.querySelectorAll('.areg-result').forEach(item => {
      if (item.getAttribute('data-role') === 'create') {
        item.addEventListener('click', (e) => {
          e.stopPropagation();
          // V79.1 — skip the popup. Go straight to the form step in
          // "create new contact" mode (no contact id, empty fields).
          showFormStep(screen, inspection, { id: null, name: '', isNew: true });
        });
      } else {
        item.addEventListener('click', () => {
          const id   = parseInt(item.getAttribute('data-id'), 10);
          const name = item.getAttribute('data-name');
          showFormStep(screen, inspection, { id, name, isNew: false });
        });
      }
    });
  }

  // (V79.1 — onCreateNewContact removed; the search-step result handler
  //  now goes straight into showFormStep with isNew: true.)

  async function showFormStep(screen, inspection, contact) {
    const body = screen.querySelector('[data-role="body"]');
    const isNew = !!contact.isNew;
    let c;
    if (isNew) {
      // Empty record for the create-new flow — no GET needed.
      c = {
        id: null,
        first_name: '', last_name: '', email: '', mobile: '',
        marketing_pref_set_at: null,
        do_not_send_marketing_at: null,
        marketing_email_consent_at: null,
        marketing_sms_consent_at: null,
      };
    } else {
      body.innerHTML = `<div class="areg-form-step"><div class="areg-form-loading">Loading your details…</div></div>`;
      try {
        const r = await fetch(`/api/contacts?id=${contact.id}`);
        if (!r.ok) throw new Error(r.status);
        c = await r.json();
        if (Array.isArray(c)) c = c[0];
      } catch (err) {
        body.innerHTML = `<div class="areg-error">Could not load your details: ${esc(err.message)}</div>`;
        return;
      }
    }
    // Pre-fill defaults
    const isFresh = !c.marketing_pref_set_at;
    const initialEmail = isFresh ? true  : !!c.marketing_email_consent_at;
    const initialSms   = isFresh ? true  : !!c.marketing_sms_consent_at;
    const initialDns   = isFresh ? false : !!c.do_not_send_marketing_at;

    body.innerHTML = `
      <div class="areg-form-step">
        <div class="areg-section">
          <div class="areg-section-title">Contact details</div>
          <div class="areg-grid">
            <div class="areg-field">
              <label>First name</label>
              <input class="areg-input" data-cf="first_name" type="text" value="${esc(c.first_name || '')}">
            </div>
            <div class="areg-field">
              <label>Last name</label>
              <input class="areg-input" data-cf="last_name" type="text" value="${esc(c.last_name || '')}">
            </div>
            <div class="areg-field">
              <label>Email</label>
              <input class="areg-input" data-cf="email" type="email" inputmode="email" value="${esc(c.email || '')}">
            </div>
            <div class="areg-field">
              <label>Mobile</label>
              <input class="areg-input" data-cf="mobile" type="tel" inputmode="tel" value="${esc(c.mobile || '')}">
            </div>
          </div>
        </div>
        <div class="areg-section">
          <div class="areg-section-title">Contact preferences</div>
          <div class="areg-consent-text">I consent to receive notification about this and similar properties and marketing.</div>
          <div class="areg-via-row">
            <span class="areg-via-label">Via:</span>
            <label class="areg-check"><input type="checkbox" data-flag="email" ${initialEmail ? 'checked' : ''}> Email</label>
            <label class="areg-check"><input type="checkbox" data-flag="sms"   ${initialSms   ? 'checked' : ''}> SMS</label>
          </div>
          <label class="areg-check areg-dns-row">
            <input type="checkbox" data-flag="dns" ${initialDns ? 'checked' : ''}>
            Do not send me marketing
          </label>
        </div>
        <div class="areg-section">
          <div class="areg-section-title">Information requested</div>
          <label class="areg-check areg-stack-check"><input type="checkbox" data-flag="trigger_followup">  Follow up with me about this property.</label>
          <label class="areg-check areg-stack-check"><input type="checkbox" data-flag="trigger_offer_form"> Send me the offer form</label>
          <label class="areg-check areg-stack-check"><input type="checkbox" data-flag="trigger_contract">   Send me the Contract</label>
        </div>
        <div class="areg-actions">
          <button class="areg-btn areg-btn-cancel" data-role="cancel" type="button">Cancel</button>
          <button class="areg-btn areg-btn-save"   data-role="save"   type="button">Register</button>
        </div>
      </div>
    `;

    const emailCb = body.querySelector('[data-flag="email"]');
    const smsCb   = body.querySelector('[data-flag="sms"]');
    const dnsCb   = body.querySelector('[data-flag="dns"]');
    function syncChannels() {
      const dnsOn = dnsCb.checked;
      emailCb.disabled = dnsOn;
      smsCb.disabled   = dnsOn;
      if (dnsOn) { emailCb.checked = false; smsCb.checked = false; }
    }
    function turnOffDnsIfChannel() {
      if (emailCb.checked || smsCb.checked) dnsCb.checked = false;
      syncChannels();
    }
    dnsCb.addEventListener('change', syncChannels);
    emailCb.addEventListener('change', turnOffDnsIfChannel);
    smsCb.addEventListener('change', turnOffDnsIfChannel);
    syncChannels();

    body.querySelector('[data-role="cancel"]').addEventListener('click', () => {
      showSearchStep(screen, inspection);
    });

    body.querySelector('[data-role="save"]').addEventListener('click', async () => {
      const saveBtn = body.querySelector('[data-role="save"]');
      const cancelBtn = body.querySelector('[data-role="cancel"]');
      saveBtn.disabled = true;
      cancelBtn.disabled = true;
      const origText = saveBtn.textContent;
      saveBtn.innerHTML = '<span class="areg-spinner"></span> Saving…';
      const restore = () => {
        saveBtn.disabled = false;
        cancelBtn.disabled = false;
        saveBtn.textContent = origText;
      };

      // ── Collect edited values ────────────────────────────────────────────
      const edited = {};
      body.querySelectorAll('[data-cf]').forEach(input => {
        edited[input.getAttribute('data-cf')] = input.value.trim();
      });

      // ── Validation ───────────────────────────────────────────────────────
      // V79.1 — for create-new: first AND last required, plus at least one of
      // email or mobile. For existing contact: same rules apply if they edit
      // the fields, but we don't force them to fill missing legacy data.
      const validationErrors = [];
      if (isNew) {
        if (!edited.first_name) validationErrors.push('First name is required.');
        if (!edited.last_name)  validationErrors.push('Last name is required.');
        if (!edited.email && !edited.mobile) validationErrors.push('Please provide either an email or a mobile number.');
      }
      if (edited.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(edited.email)) {
        validationErrors.push('Please enter a valid email address.');
      }
      if (validationErrors.length) {
        alert(validationErrors.join('\n'));
        restore();
        return;
      }

      // ── Compute consent state ────────────────────────────────────────────
      const wantDns   = dnsCb.checked;
      const wantEmail = emailCb.checked && !wantDns;
      const wantSms   = smsCb.checked   && !wantDns;
      const nowIso    = new Date().toISOString();

      // ── Step 1a: CREATE new contact (if isNew) ──────────────────────────
      let contactId = contact.id;
      if (isNew) {
        const createBody = {
          first_name:   edited.first_name,
          last_name:    edited.last_name,
          email:        edited.email   || '',
          mobile:       edited.mobile  || '',
          // Marketing prefs sent via the new V79 fields the contacts CREATE
          // accepts. Channel timestamps inferred server-side.
          marketing_email_consent: !!wantEmail,
          marketing_sms_consent:   !!wantSms,
          do_not_send_marketing:   !!wantDns,
          marketing_pref_set:      true,    // attendee did go through the form
        };
        try {
          const r = await fetch('/api/contacts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(createBody),
          });
          if (!r.ok) {
            const err = await r.json().catch(() => ({}));
            alert('Could not create contact: ' + (err.error || r.status));
            restore();
            return;
          }
          const created = await r.json();
          contactId = created.id;
        } catch (err) {
          alert('Could not create contact: ' + err.message);
          restore();
          return;
        }
      } else {
        // ── Step 1b: PATCH existing contact ────────────────────────────────
        const contactPatch = { id: contact.id };
        for (const k of ['first_name', 'last_name', 'email', 'mobile']) {
          if ((edited[k] || '') !== (c[k] || '')) {
            contactPatch[k] = edited[k] || null;
          }
        }
        contactPatch.marketing_email_consent_at = wantEmail ? (c.marketing_email_consent_at || nowIso) : null;
        contactPatch.marketing_sms_consent_at   = wantSms   ? (c.marketing_sms_consent_at   || nowIso) : null;
        contactPatch.do_not_send_marketing_at   = wantDns   ? (c.do_not_send_marketing_at   || nowIso) : null;
        contactPatch.marketing_pref_set_at      = c.marketing_pref_set_at || nowIso;

        try {
          const r = await fetch('/api/contacts', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(contactPatch),
          });
          if (!r.ok) {
            const err = await r.json().catch(() => ({}));
            alert('Could not save: ' + (err.error || r.status));
            restore();
            return;
          }
        } catch (err) {
          alert('Could not save: ' + err.message);
          restore();
          return;
        }
      }

      // ── Step 2: POST attendance with action-request flags ────────────────
      const attBody = {
        scheduled_inspection_id: inspection.id,
        contact_id:              contactId,
        notes:                   null,
      };
      ['trigger_followup', 'trigger_offer_form', 'trigger_contract'].forEach(flag => {
        attBody[flag] = !!body.querySelector(`[data-flag="${flag}"]`).checked;
      });

      try {
        const r = await fetch('/api/inspection-attendances', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body:   JSON.stringify(attBody),
        });
        if (!r.ok) {
          const err = await r.json().catch(() => ({}));
          alert(err.error || `Register failed (${r.status})`);
          restore();
          return;
        }
        showThankYou(screen, inspection);
      } catch (err) {
        alert('Register failed: ' + err.message);
        restore();
      }
    });
  }

  function showThankYou(screen, inspection) {
    const body = screen.querySelector('[data-role="body"]');
    body.innerHTML = `
      <div class="areg-thanks">
        <div class="areg-thanks-tick">✓</div>
        <div class="areg-thanks-headline">Thank you, you are registered.</div>
        <div class="areg-thanks-sub">Welcome and enjoy your inspection.</div>
      </div>
    `;
    setTimeout(() => {
      if (!document.body.contains(screen)) return;
      showSearchStep(screen, inspection);
    }, 3000);
  }

  window.AttendeeRegistration = { open };
})();
