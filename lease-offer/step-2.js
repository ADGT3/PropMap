/* Lease Offer Step 2 (evidence upload) form — V77.2 */
(function () {
  'use strict';

  const m = location.pathname.match(/^\/lease-offer\/step-2\/([A-Za-z0-9]+)\/?$/);
  const TOKEN = m ? m[1] : null;
  if (!TOKEN) {
    showError('No token provided in URL.');
    return;
  }
  const API_BASE = '/api/public/lease-offers/' + encodeURIComponent(TOKEN);

  // ID document types and their points value
  const ID_TYPES = [
    { id: '',                     label: '— Select document type —', points: 0 },
    { id: 'passport',             label: 'Passport',                 points: 70 },
    { id: 'birth_certificate',    label: 'Birth certificate',        points: 70 },
    { id: 'drivers_licence',      label: 'Drivers licence (front)',  points: 40 },
    { id: 'drivers_licence_back', label: 'Drivers licence (back)',   points: 0 },
    { id: 'medicare',             label: 'Medicare card',            points: 25 },
    { id: 'bank_statement',       label: 'Bank statement',           points: 25 },
    { id: 'utility_bill',         label: 'Utility bill',             points: 25 },
    { id: 'rates_notice',         label: 'Rates notice',             points: 25 },
    { id: 'other',                label: 'Other',                    points: 10 },
  ];

  // State
  let LOAD_DATA = null;
  let APPLICANTS = [];
  let ID_FILES = {};       // { applicant_idx: [{ id, filename, doc_type, points, status, ... }] }
  let HOUSING_FILES = {};  // { client_id: [{ id, filename, status, ... }] }
  let INCOME_FILES = {};   // { client_id: [{ id, filename, status, ... }] }
  let LEASEDOC_FILES = {   // two slots — keys are stable category suffixes
    'signed-contract':  [],
    'condition-report': [],
  };
  let HOUSING = [];
  let INCOME = [];
  let SAVE_TIMER = null;
  let SAVE_IN_FLIGHT = false;

  bootstrap();

  async function bootstrap() {
    try {
      const r = await fetch(API_BASE + '/step2-token-info');
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        showError(err.error || 'This link is no longer valid.');
        return;
      }
      const info = await r.json();
      if (info.verified) {
        await loadAndShowForm();
      } else {
        showVerify(info.masked_email);
      }
    } catch (err) {
      showError('Could not connect to the server. Please try again.');
    }
  }

  async function loadAndShowForm() {
    try {
      const r = await fetch(API_BASE + '/step2-load');
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        showError(err.error || 'Could not load form.');
        return;
      }
      LOAD_DATA = await r.json();
      if (LOAD_DATA.application.status === 'evidence_submitted' || LOAD_DATA.application.status === 'validated' || LOAD_DATA.application.status === 'leased') {
        showThanks();
        return;
      }
      seedFromLoad();
      renderForm();
      showForm();
    } catch (err) {
      showError('Could not load form: ' + err.message);
    }
  }

  function seedFromLoad() {
    APPLICANTS = LOAD_DATA.application.applicants || [];
    HOUSING    = Array.isArray(LOAD_DATA.housing_history) ? [...LOAD_DATA.housing_history] : [];
    INCOME     = Array.isArray(LOAD_DATA.income_history)  ? [...LOAD_DATA.income_history]  : [];
    // Each loaded entry gets a stable client_id: re-use server-stored client_id from notes
    // if available, else generate. (Server roundtrips client_id back via the "client_id" field
    // in the JSON column — see API.)
    HOUSING.forEach(h => { if (!h.client_id) h.client_id = genClientId(); });
    INCOME.forEach(i => { if (!i.client_id) i.client_id = genClientId(); });
    if (!HOUSING.length) HOUSING.push(blankHousingEntry());
    if (!INCOME.length)  INCOME.push(blankIncomeEntry());

    // Group ID files by applicant
    ID_FILES = {};
    APPLICANTS.forEach((_, i) => { ID_FILES[i] = []; });

    // Group housing/income files by client_id (suffix of category)
    HOUSING_FILES = {};
    INCOME_FILES = {};
    LEASEDOC_FILES = { 'signed-contract': [], 'condition-report': [] };
    HOUSING.forEach(h => { HOUSING_FILES[h.client_id] = []; });
    INCOME.forEach(i  => { INCOME_FILES[i.client_id]  = []; });

    (LOAD_DATA.evidence || []).forEach(e => {
      if (!e.category) return;
      if (e.category.startsWith('id-')) {
        const idx = APPLICANTS.findIndex(a => a.contact_id === e.applicant_contact_id);
        const useIdx = idx >= 0 ? idx : 0;
        if (!ID_FILES[useIdx]) ID_FILES[useIdx] = [];
        ID_FILES[useIdx].push({
          id: e.id, filename: e.filename, mime_type: e.mime_type, size: e.size_bytes,
          doc_type: e.doc_type || '',
          points: e.points_value || 0,
          url: e.url, status: 'uploaded',
        });
      } else if (e.category.startsWith('housing-evidence:')) {
        const cid = e.category.split(':')[1];
        if (!HOUSING_FILES[cid]) HOUSING_FILES[cid] = [];
        HOUSING_FILES[cid].push({
          id: e.id, filename: e.filename, mime_type: e.mime_type, size: e.size_bytes,
          url: e.url, status: 'uploaded',
        });
      } else if (e.category.startsWith('income-evidence:')) {
        const cid = e.category.split(':')[1];
        if (!INCOME_FILES[cid]) INCOME_FILES[cid] = [];
        INCOME_FILES[cid].push({
          id: e.id, filename: e.filename, mime_type: e.mime_type, size: e.size_bytes,
          url: e.url, status: 'uploaded',
        });
      } else if (e.category.startsWith('lease-doc:')) {
        const slot = e.category.split(':')[1];  // 'signed-contract' or 'condition-report'
        if (!LEASEDOC_FILES[slot]) LEASEDOC_FILES[slot] = [];
        LEASEDOC_FILES[slot].push({
          id: e.id, filename: e.filename, mime_type: e.mime_type, size: e.size_bytes,
          url: e.url, status: 'uploaded',
        });
      }
    });
  }

  function genClientId() {
    return 'c' + Math.random().toString(36).slice(2, 12);
  }

  function blankHousingEntry() {
    return { client_id: genClientId(), housing_type: 'rented', address: '', monthly_amount: null, term_value: null, term_unit: 'months', started_at: '', ended_at: '', current_residence: false, landlord_name: '', landlord_email: '', landlord_phone: '', notes: '' };
  }
  function blankIncomeEntry() {
    return { client_id: genClientId(), income_type: 'employment', income_source_name: '', position: '', gross_amount: null, gross_period: 'weekly', started_at: '', ended_at: '', current_role: false, manager_name: '', manager_email: '', manager_phone: '', notes: '' };
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
      if (!mobile) {
        errEl.textContent = 'Please enter your mobile number.';
        errEl.style.display = '';
        return;
      }
      btn.disabled = true;
      btn.textContent = 'Checking…';
      try {
        const r = await fetch(API_BASE + '/step2-verify', {
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
    document.getElementById('lofLoading').style.display = 'none';
    document.getElementById('lofVerify').style.display = 'none';
    document.getElementById('lofError').style.display = 'none';
    document.getElementById('lofForm').style.display = 'none';
    document.getElementById('lofThanks').style.display = '';
    window.scrollTo(0, 0);
  }

  // ── Form rendering ────────────────────────────────────────────────────

  function renderForm() {
    const p = LOAD_DATA.property;
    document.getElementById('lofProperty').textContent = [p.address, p.suburb, p.state].filter(Boolean).join(', ');

    // Pre-fill consent checkboxes from existing app row
    document.getElementById('s2CreditConsent').checked    = !!LOAD_DATA.application.credit_check_consent_at;
    document.getElementById('s2TenancyDbConsent').checked = !!LOAD_DATA.application.tenancy_database_consent_at;
    document.getElementById('s2RetentionConsent').checked = !!LOAD_DATA.application.retention_consent_at;

    renderIdSections();
    renderHousing();
    renderIncome();
    renderLeaseDocs();
    wireFormEvents();
  }

  function renderIdSections() {
    const wrap = document.getElementById('s2IdSections');
    wrap.innerHTML = APPLICANTS.map((a, i) => renderIdBlock(a, i)).join('');
    APPLICANTS.forEach((_, i) => wireIdBlock(i));
  }

  function renderIdBlock(a, i) {
    const name = [a.first_name, a.last_name].filter(Boolean).join(' ') || `Applicant ${i + 1}`;
    const files = ID_FILES[i] || [];
    const totalPoints = files.reduce((sum, f) => sum + (f.points || 0), 0);
    const pointsCls = totalPoints >= 100 ? '' : 's2-points-low';

    let docRowsHtml = '';
    files.forEach((f, fi) => {
      docRowsHtml += renderUploadedFileRow(f, i, fi);
    });

    return `
      <div class="s2-applicant-block" data-idx="${i}">
        <div class="s2-applicant-block-header">
          <span>${esc(name)}</span>
          <span class="s2-points-display ${pointsCls}">${totalPoints} / 100 pts</span>
        </div>

        <div class="s2-uploaded-files">${docRowsHtml}</div>

        <div class="s2-upload-zone" data-idx="${i}">
          <div class="s2-upload-zone-prompt">+ Add ID document</div>
          <div class="s2-upload-zone-help">Drag &amp; drop or click to upload (PDF, JPG, PNG, HEIC · max 10MB)</div>
          <input type="file" accept=".pdf,.jpg,.jpeg,.png,.heic,.heif" multiple>
        </div>
      </div>
    `;
  }

  // Reusable evidence drag-drop zone for housing/income entries
  function renderEvidenceZone({ section, clientId, files, prompt, help }) {
    let filesHtml = '';
    files.forEach((f, fi) => {
      filesHtml += renderEvidenceFileRow(f, section, clientId, fi);
    });
    return `
      <div class="s2-entry-evidence">
        <div class="s2-entry-evidence-label">${prompt}</div>
        <div class="s2-uploaded-files" data-evidence-section="${section}" data-client-id="${esc(clientId)}">${filesHtml}</div>
        <div class="s2-upload-zone s2-upload-zone-small" data-evidence-section="${section}" data-client-id="${esc(clientId)}">
          <div class="s2-upload-zone-prompt">+ Add file</div>
          <div class="s2-upload-zone-help">${esc(help)} Drag &amp; drop or click. PDF/JPG/PNG/HEIC, max 10MB.</div>
          <input type="file" accept=".pdf,.jpg,.jpeg,.png,.heic,.heif" multiple>
        </div>
      </div>
    `;
  }

  function renderEvidenceFileRow(f, section, clientId, fileIdx) {
    const sizeStr = f.size ? `(${(f.size / 1024).toFixed(0)} KB)` : '';
    const isUploaded = f.status === 'uploaded';
    const statusHtml =
      f.status === 'uploading' ? '<span class="s2-file-status s2-file-uploading">Uploading…</span>' :
      f.status === 'error'     ? `<span class="s2-file-status s2-file-error" title="${esc(f.error || '')}">Error</span>` :
                                 '<span class="s2-file-status">✓ Uploaded</span>';
    return `
      <div class="s2-id-row" data-evidence-section="${section}" data-client-id="${esc(clientId)}" data-file="${fileIdx}">
        <span class="s2-file-icon">📄</span>
        <span class="s2-file-name" title="${esc(f.filename)}">${esc(f.filename)}</span>
        <span class="s2-file-size">${sizeStr}</span>
        ${statusHtml}
        ${isUploaded ? `<button type="button" class="s2-file-action-btn s2-evidence-remove-btn" data-evidence-section="${section}" data-client-id="${esc(clientId)}" data-file="${fileIdx}" title="Delete this file">Remove</button>` : ''}
      </div>
    `;
  }

  function renderUploadedFileRow(f, applicantIdx, fileIdx) {
    const sizeStr = f.size ? `(${(f.size / 1024).toFixed(0)} KB)` : '';
    const isUploaded = f.status === 'uploaded';
    const statusHtml =
      f.status === 'uploading' ? '<span class="s2-file-status s2-file-uploading">Uploading…</span>' :
      f.status === 'error'     ? `<span class="s2-file-status s2-file-error" title="${esc(f.error || '')}">Error</span>` :
                                 '<span class="s2-file-status">✓ Uploaded</span>';

    return `
      <div class="s2-id-row" data-applicant="${applicantIdx}" data-file="${fileIdx}">
        <span class="s2-file-icon">📄</span>
        <span class="s2-file-name" title="${esc(f.filename)}">${esc(f.filename)}</span>
        <select data-applicant="${applicantIdx}" data-file="${fileIdx}" class="s2-doctype-select">
          ${ID_TYPES.map(t => `<option value="${t.id}" ${t.id === f.doc_type ? 'selected' : ''}>${esc(t.label)}${t.points ? ` (${t.points} pts)` : ''}</option>`).join('')}
        </select>
        <span class="s2-points">${f.points || 0} pts</span>
        <span class="s2-file-size">${sizeStr}</span>
        ${statusHtml}
        ${isUploaded ? `<button type="button" class="s2-file-action-btn s2-file-remove-btn" data-applicant="${applicantIdx}" data-file="${fileIdx}" title="Delete this file">Remove</button>` : ''}
      </div>
    `;
  }

  function wireIdBlock(applicantIdx) {
    const block = document.querySelector(`.s2-applicant-block[data-idx="${applicantIdx}"]`);
    if (!block) return;
    const zone = block.querySelector('.s2-upload-zone');
    const fileInput = zone.querySelector('input[type="file"]');

    zone.addEventListener('click', () => fileInput.click());
    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('s2-drag-over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('s2-drag-over'));
    zone.addEventListener('drop', async (e) => {
      e.preventDefault();
      zone.classList.remove('s2-drag-over');
      const files = Array.from(e.dataTransfer.files || []);
      for (const f of files) await uploadIdFile(f, applicantIdx);
    });
    fileInput.addEventListener('change', async () => {
      const files = Array.from(fileInput.files || []);
      for (const f of files) await uploadIdFile(f, applicantIdx);
      fileInput.value = '';
    });

    // Wire doc-type selects on each existing file row
    block.querySelectorAll('.s2-doctype-select').forEach(sel => {
      sel.addEventListener('change', async () => {
        const ai = parseInt(sel.getAttribute('data-applicant'), 10);
        const fi = parseInt(sel.getAttribute('data-file'), 10);
        const docType = sel.value;
        const def = ID_TYPES.find(t => t.id === docType);
        const points = def?.points || 0;
        const fileEntry = ID_FILES[ai] && ID_FILES[ai][fi];
        if (fileEntry) {
          fileEntry.doc_type = docType;
          fileEntry.points = points;
          // Persist to server so the agent's review block sees the right values
          if (fileEntry.id) {
            try {
              await fetch(API_BASE + '/step2-update-evidence-meta', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  evidence_id: fileEntry.id,
                  doc_type: docType,
                  points_value: points,
                }),
              });
            } catch (err) { console.warn('update-meta failed', err); }
          }
        }
        renderIdSections();
        scheduleAutosave();
      });
    });

    // Wire Remove buttons
    block.querySelectorAll('.s2-file-remove-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const ai = parseInt(btn.getAttribute('data-applicant'), 10);
        const fi = parseInt(btn.getAttribute('data-file'), 10);
        const fileEntry = ID_FILES[ai]?.[fi];
        if (!fileEntry) return;
        if (!confirm(`Remove "${fileEntry.filename}"?`)) return;
        if (fileEntry.id) {
          // Server-side delete
          try {
            await fetch(API_BASE + '/step2-delete-evidence', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ evidence_id: fileEntry.id }),
            });
          } catch (err) { console.warn('delete failed', err); }
        }
        ID_FILES[ai].splice(fi, 1);
        renderIdSections();
      });
    });
  }

  async function uploadIdFile(file, applicantIdx) {
    if (file.size > 10 * 1024 * 1024) {
      alert('File too large. Maximum 10 MB per file.');
      return;
    }
    const allowedTypes = ['application/pdf', 'image/jpeg', 'image/png', 'image/heic', 'image/heif'];
    if (file.type && !allowedTypes.includes(file.type.toLowerCase())) {
      alert('Unsupported file type. Allowed: PDF, JPG, PNG, HEIC.');
      return;
    }

    const fileEntry = {
      filename: file.name, mime_type: file.type || 'application/octet-stream',
      size: file.size,
      doc_type: '',
      points: 0,
      status: 'uploading',
    };
    if (!ID_FILES[applicantIdx]) ID_FILES[applicantIdx] = [];
    ID_FILES[applicantIdx].push(fileEntry);
    renderIdSections();

    try {
      const base64 = await fileToBase64(file);
      const applicant = APPLICANTS[applicantIdx] || {};
      const r = await fetch(API_BASE + '/step2-upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: file.name,
          mime_type: file.type || 'application/octet-stream',
          size: file.size,
          applicant_contact_id: applicant.contact_id || null,
          category: 'id-100-points',
          points_value: 0,
          body_base64: base64,
        }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        fileEntry.status = 'error';
        fileEntry.error = err.error || 'Upload failed';
      } else {
        const data = await r.json();
        fileEntry.id = data.evidence.id;
        fileEntry.url = data.evidence.url;
        fileEntry.status = 'uploaded';
      }
    } catch (err) {
      fileEntry.status = 'error';
      fileEntry.error = err.message;
    }
    renderIdSections();
    scheduleAutosave();
  }

  // Upload housing/income evidence file (separate from ID — different category, different storage)
  async function uploadEvidenceFile(file, section, clientId) {
    if (file.size > 10 * 1024 * 1024) {
      alert('File too large. Maximum 10 MB per file.');
      return;
    }
    const allowedTypes = ['application/pdf', 'image/jpeg', 'image/png', 'image/heic', 'image/heif'];
    if (file.type && !allowedTypes.includes(file.type.toLowerCase())) {
      alert('Unsupported file type. Allowed: PDF, JPG, PNG, HEIC.');
      return;
    }
    const arr = section === 'housing' ? HOUSING_FILES : INCOME_FILES;
    if (!arr[clientId]) arr[clientId] = [];
    const fileEntry = {
      filename: file.name, mime_type: file.type || 'application/octet-stream',
      size: file.size, status: 'uploading',
    };
    arr[clientId].push(fileEntry);
    if (section === 'housing') renderHousing(); else renderIncome();

    try {
      const base64 = await fileToBase64(file);
      const applicant = APPLICANTS[0] || {};
      const r = await fetch(API_BASE + '/step2-upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: file.name,
          mime_type: file.type || 'application/octet-stream',
          size: file.size,
          applicant_contact_id: applicant.contact_id || null,
          category: `${section}-evidence:${clientId}`,
          points_value: 0,
          body_base64: base64,
        }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        fileEntry.status = 'error';
        fileEntry.error = err.error || 'Upload failed';
      } else {
        const data = await r.json();
        fileEntry.id = data.evidence.id;
        fileEntry.url = data.evidence.url;
        fileEntry.status = 'uploaded';
      }
    } catch (err) {
      fileEntry.status = 'error';
      fileEntry.error = err.message;
    }
    if (section === 'housing') renderHousing(); else renderIncome();
    scheduleAutosave();
  }

  // When a housing/income entry is removed, delete all its evidence files server-side
  async function deleteAllForClientId(section, clientId) {
    const arr = section === 'housing' ? HOUSING_FILES[clientId] : INCOME_FILES[clientId];
    if (!Array.isArray(arr)) return;
    for (const f of arr) {
      if (f.id) {
        try {
          await fetch(API_BASE + '/step2-delete-evidence', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ evidence_id: f.id }),
          });
        } catch (_) {/* ignore */}
      }
    }
    if (section === 'housing') delete HOUSING_FILES[clientId];
    else                       delete INCOME_FILES[clientId];
  }

  // Upload a lease-doc file into a specific slot ('signed-contract' / 'condition-report')
  async function uploadLeaseDocFile(file, slot) {
    if (file.size > 10 * 1024 * 1024) {
      alert('File too large. Maximum 10 MB per file.');
      return;
    }
    const allowedTypes = ['application/pdf', 'image/jpeg', 'image/png', 'image/heic', 'image/heif'];
    if (file.type && !allowedTypes.includes(file.type.toLowerCase())) {
      alert('Unsupported file type. Allowed: PDF, JPG, PNG, HEIC.');
      return;
    }
    if (!LEASEDOC_FILES[slot]) LEASEDOC_FILES[slot] = [];
    const fileEntry = {
      filename: file.name, mime_type: file.type || 'application/octet-stream',
      size: file.size, status: 'uploading',
    };
    LEASEDOC_FILES[slot].push(fileEntry);
    renderLeaseDocs();

    try {
      const base64 = await fileToBase64(file);
      const applicant = APPLICANTS[0] || {};
      const r = await fetch(API_BASE + '/step2-upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: file.name,
          mime_type: file.type || 'application/octet-stream',
          size: file.size,
          applicant_contact_id: applicant.contact_id || null,
          category: `lease-doc:${slot}`,
          points_value: 0,
          body_base64: base64,
        }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        fileEntry.status = 'error';
        fileEntry.error = err.error || 'Upload failed';
      } else {
        const data = await r.json();
        fileEntry.id = data.evidence.id;
        fileEntry.url = data.evidence.url;
        fileEntry.status = 'uploaded';
      }
    } catch (err) {
      fileEntry.status = 'error';
      fileEntry.error = err.message;
    }
    renderLeaseDocs();
    scheduleAutosave();
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result || '';
        const base64 = String(result).split(',')[1] || '';
        resolve(base64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  function renderHousing() {
    const wrap = document.getElementById('s2HousingEntries');
    wrap.innerHTML = HOUSING.map((h, i) => renderHousingEntry(h, i)).join('');
    HOUSING.forEach((_, i) => wireHousingEntry(i));
  }

  function renderHousingEntry(h, i) {
    const cid = h.client_id;
    const files = HOUSING_FILES[cid] || [];
    return `
      <div class="s2-history-entry" data-idx="${i}" data-client-id="${esc(cid)}">
        ${HOUSING.length > 1 ? `<button type="button" class="s2-history-entry-remove" data-section="housing" data-idx="${i}">✕</button>` : ''}
        <div class="lof-row">
          <div class="lof-field">
            <label>Address</label>
            <input type="text" data-section="housing" data-field="address" data-idx="${i}" value="${esc(h.address)}">
          </div>
          <div class="lof-field" style="flex:0 0 140px">
            <label>Type</label>
            <select data-section="housing" data-field="housing_type" data-idx="${i}">
              <option value="rented" ${h.housing_type === 'rented' ? 'selected' : ''}>Rented</option>
              <option value="owned"  ${h.housing_type === 'owned'  ? 'selected' : ''}>Owned</option>
              <option value="other"  ${h.housing_type === 'other'  ? 'selected' : ''}>Other</option>
            </select>
          </div>
        </div>
        <div class="lof-row">
          <div class="lof-field">
            <label>Started</label>
            <input type="date" data-section="housing" data-field="started_at" data-idx="${i}" value="${esc(h.started_at || '')}">
          </div>
          <div class="lof-field">
            <label>Ended</label>
            <input type="date" data-section="housing" data-field="ended_at" data-idx="${i}" value="${esc(h.ended_at || '')}" ${h.current_residence ? 'disabled' : ''}>
          </div>
          <div class="lof-field lof-field-checkbox" style="flex:0 0 auto;align-self:flex-end">
            <input type="checkbox" data-section="housing" data-field="current_residence" data-idx="${i}" ${h.current_residence ? 'checked' : ''}>
            <label>Current residence</label>
          </div>
        </div>
        <div class="lof-row">
          <div class="lof-field">
            <label>Landlord / Property Manager name</label>
            <input type="text" data-section="housing" data-field="landlord_name" data-idx="${i}" value="${esc(h.landlord_name || '')}">
          </div>
        </div>
        <div class="lof-row">
          <div class="lof-field">
            <label>Landlord email</label>
            <input type="email" data-section="housing" data-field="landlord_email" data-idx="${i}" value="${esc(h.landlord_email || '')}">
          </div>
          <div class="lof-field">
            <label>Landlord phone</label>
            <input type="tel" data-section="housing" data-field="landlord_phone" data-idx="${i}" value="${esc(h.landlord_phone || '')}">
          </div>
        </div>
        ${renderEvidenceZone({ section: 'housing', clientId: cid, files,
          prompt: 'Last 3 months of statements <span class="lof-req">*</span>',
          help: 'Rent receipts, mortgage statements, or rates notices proving you lived here.' })}
      </div>
    `;
  }

  function wireHousingEntry(i) {
    const block = document.querySelector(`.s2-history-entry[data-idx="${i}"][data-section]`);
    // Use general delegation rather than per-block
  }

  function renderIncome() {
    const wrap = document.getElementById('s2IncomeEntries');
    wrap.innerHTML = INCOME.map((inc, i) => renderIncomeEntry(inc, i)).join('');
  }

  function renderIncomeEntry(inc, i) {
    const cid = inc.client_id;
    const files = INCOME_FILES[cid] || [];
    return `
      <div class="s2-history-entry" data-idx="${i}" data-type="income" data-client-id="${esc(cid)}">
        ${INCOME.length > 1 ? `<button type="button" class="s2-history-entry-remove" data-section="income" data-idx="${i}">✕</button>` : ''}
        <div class="lof-row">
          <div class="lof-field" style="flex:0 0 160px">
            <label>Type</label>
            <select data-section="income" data-field="income_type" data-idx="${i}">
              <option value="employment"     ${inc.income_type === 'employment'     ? 'selected' : ''}>Employment</option>
              <option value="self_employed"  ${inc.income_type === 'self_employed'  ? 'selected' : ''}>Self-employed</option>
              <option value="centrelink"     ${inc.income_type === 'centrelink'     ? 'selected' : ''}>Centrelink</option>
              <option value="investments"    ${inc.income_type === 'investments'    ? 'selected' : ''}>Investments</option>
              <option value="other"          ${inc.income_type === 'other'          ? 'selected' : ''}>Other</option>
            </select>
          </div>
          <div class="lof-field">
            <label>Employer / Source name</label>
            <input type="text" data-section="income" data-field="income_source_name" data-idx="${i}" value="${esc(inc.income_source_name || '')}">
          </div>
        </div>
        <div class="lof-row">
          <div class="lof-field">
            <label>Position / role</label>
            <input type="text" data-section="income" data-field="position" data-idx="${i}" value="${esc(inc.position || '')}">
          </div>
          <div class="lof-field" style="flex:0 0 160px">
            <label>Gross amount ($)</label>
            <input type="number" min="0" step="1" inputmode="numeric" data-section="income" data-field="gross_amount" data-idx="${i}" value="${inc.gross_amount != null ? inc.gross_amount : ''}">
          </div>
          <div class="lof-field" style="flex:0 0 120px">
            <label>Period</label>
            <select data-section="income" data-field="gross_period" data-idx="${i}">
              <option value="weekly"     ${inc.gross_period === 'weekly'     ? 'selected' : ''}>Weekly</option>
              <option value="fortnightly" ${inc.gross_period === 'fortnightly' ? 'selected' : ''}>Fortnightly</option>
              <option value="monthly"    ${inc.gross_period === 'monthly'    ? 'selected' : ''}>Monthly</option>
              <option value="annually"   ${inc.gross_period === 'annually'   ? 'selected' : ''}>Annually</option>
            </select>
          </div>
        </div>
        <div class="lof-row">
          <div class="lof-field">
            <label>Started</label>
            <input type="date" data-section="income" data-field="started_at" data-idx="${i}" value="${esc(inc.started_at || '')}">
          </div>
          <div class="lof-field">
            <label>Ended</label>
            <input type="date" data-section="income" data-field="ended_at" data-idx="${i}" value="${esc(inc.ended_at || '')}" ${inc.current_role ? 'disabled' : ''}>
          </div>
          <div class="lof-field lof-field-checkbox" style="flex:0 0 auto;align-self:flex-end">
            <input type="checkbox" data-section="income" data-field="current_role" data-idx="${i}" ${inc.current_role ? 'checked' : ''}>
            <label>Current role</label>
          </div>
        </div>
        <div class="lof-row">
          <div class="lof-field">
            <label>Manager / Reference name</label>
            <input type="text" data-section="income" data-field="manager_name" data-idx="${i}" value="${esc(inc.manager_name || '')}">
          </div>
        </div>
        <div class="lof-row">
          <div class="lof-field">
            <label>Manager email</label>
            <input type="email" data-section="income" data-field="manager_email" data-idx="${i}" value="${esc(inc.manager_email || '')}">
          </div>
          <div class="lof-field">
            <label>Manager phone</label>
            <input type="tel" data-section="income" data-field="manager_phone" data-idx="${i}" value="${esc(inc.manager_phone || '')}">
          </div>
        </div>
        ${renderEvidenceZone({ section: 'income', clientId: cid, files,
          prompt: 'Last 3 months of payslips or bank statements <span class="lof-req">*</span>',
          help: 'Evidence to support your declared income (payslips, bank statements showing salary deposits).' })}
      </div>
    `;
  }

  // Lease docs section — two upload zones (Signed Contract + Accepted Condition Report).
  // Same Remove-only pattern as housing/income evidence. Always visible, optional.
  function renderLeaseDocs() {
    const wrap = document.getElementById('s2LeaseDocZones');
    if (!wrap) return;
    const slots = [
      { key: 'signed-contract',  label: 'Signed Lease Agreement',
        help: 'Once your agent has provided the lease agreement and you\'ve signed it, upload the signed copy here.' },
      { key: 'condition-report', label: 'Accepted Condition Report',
        help: 'Once your agent has provided the property condition report and you\'ve accepted it, upload the accepted copy here.' },
    ];
    wrap.innerHTML = slots.map(s => renderLeaseDocZone(s.key, s.label, s.help)).join('');
  }

  function renderLeaseDocZone(slotKey, label, help) {
    const files = LEASEDOC_FILES[slotKey] || [];
    let filesHtml = '';
    files.forEach((f, fi) => { filesHtml += renderLeaseDocFileRow(f, slotKey, fi); });
    return `
      <div class="s2-leasedoc">
        <div class="s2-leasedoc-label">${esc(label)}</div>
        <div class="s2-uploaded-files" data-leasedoc-slot="${esc(slotKey)}">${filesHtml}</div>
        <div class="s2-upload-zone s2-upload-zone-small" data-leasedoc-slot="${esc(slotKey)}">
          <div class="s2-upload-zone-prompt">+ Add file</div>
          <div class="s2-upload-zone-help">${esc(help)} Drag &amp; drop or click. PDF/JPG/PNG/HEIC, max 10MB.</div>
          <input type="file" accept=".pdf,.jpg,.jpeg,.png,.heic,.heif" multiple>
        </div>
      </div>
    `;
  }

  function renderLeaseDocFileRow(f, slotKey, fileIdx) {
    const sizeStr = f.size ? `(${(f.size / 1024).toFixed(0)} KB)` : '';
    const isUploaded = f.status === 'uploaded';
    const statusHtml =
      f.status === 'uploading' ? '<span class="s2-file-status s2-file-uploading">Uploading…</span>' :
      f.status === 'error'     ? `<span class="s2-file-status s2-file-error" title="${esc(f.error || '')}">Error</span>` :
                                 '<span class="s2-file-status">✓ Uploaded</span>';
    return `
      <div class="s2-id-row" data-leasedoc-slot="${esc(slotKey)}" data-file="${fileIdx}">
        <span class="s2-file-icon">📄</span>
        <span class="s2-file-name" title="${esc(f.filename)}">${esc(f.filename)}</span>
        <span class="s2-file-size">${sizeStr}</span>
        ${statusHtml}
        ${isUploaded ? `<button type="button" class="s2-file-action-btn s2-leasedoc-remove-btn" data-leasedoc-slot="${esc(slotKey)}" data-file="${fileIdx}" title="Delete this file">Remove</button>` : ''}
      </div>
    `;
  }

  function wireFormEvents() {
    document.getElementById('s2AddHousingBtn').addEventListener('click', () => {
      HOUSING.push(blankHousingEntry());
      renderHousing();
      scheduleAutosave();
    });
    document.getElementById('s2AddIncomeBtn').addEventListener('click', () => {
      INCOME.push(blankIncomeEntry());
      renderIncome();
      scheduleAutosave();
    });

    // Delegated: housing/income field changes + remove buttons
    const formEl = document.getElementById('lofFormEl');
    formEl.addEventListener('input', e => {
      const t = e.target;
      const section = t.getAttribute('data-section');
      const field   = t.getAttribute('data-field');
      const idx     = parseInt(t.getAttribute('data-idx'), 10);
      if (!section || isNaN(idx)) return;
      const arr = section === 'housing' ? HOUSING : (section === 'income' ? INCOME : null);
      if (!arr || !arr[idx]) return;
      if (t.type === 'checkbox') {
        arr[idx][field] = t.checked;
      } else {
        arr[idx][field] = t.value;
      }
      scheduleAutosave();
    });
    formEl.addEventListener('change', e => {
      // For dates and selects (input event also fires, but for safety re-run)
      const t = e.target;
      const section = t.getAttribute('data-section');
      const field   = t.getAttribute('data-field');
      const idx     = parseInt(t.getAttribute('data-idx'), 10);
      if (!section || isNaN(idx)) return;
      const arr = section === 'housing' ? HOUSING : (section === 'income' ? INCOME : null);
      if (!arr || !arr[idx]) return;
      if (t.type === 'checkbox') {
        arr[idx][field] = t.checked;
        // For current_residence/current_role: clear ended_at when ticked, and
        // re-render so the end-date input shows as disabled+greyed.
        if (field === 'current_residence' || field === 'current_role') {
          if (t.checked) arr[idx].ended_at = '';
          if (section === 'housing') renderHousing();
          else renderIncome();
        }
      } else {
        arr[idx][field] = t.value;
      }
      scheduleAutosave();
    });
    formEl.addEventListener('click', async e => {
      const removeEntryBtn = e.target.closest('.s2-history-entry-remove');
      if (removeEntryBtn) {
        const section = removeEntryBtn.getAttribute('data-section');
        const idx     = parseInt(removeEntryBtn.getAttribute('data-idx'), 10);
        if (section === 'housing') {
          // Also delete any uploaded evidence files for this entry
          const cid = HOUSING[idx]?.client_id;
          if (cid) await deleteAllForClientId('housing', cid);
          HOUSING.splice(idx, 1);
          renderHousing();
        } else if (section === 'income') {
          const cid = INCOME[idx]?.client_id;
          if (cid) await deleteAllForClientId('income', cid);
          INCOME.splice(idx, 1);
          renderIncome();
        }
        scheduleAutosave();
        return;
      }

      // Click on an evidence upload zone → open file picker
      const evidZone = e.target.closest('.s2-upload-zone[data-evidence-section]');
      if (evidZone) {
        const fi = evidZone.querySelector('input[type="file"]');
        if (fi) fi.click();
        return;
      }

      // Click on a lease-doc upload zone → open file picker
      const leaseDocZone = e.target.closest('.s2-upload-zone[data-leasedoc-slot]');
      if (leaseDocZone) {
        const fi = leaseDocZone.querySelector('input[type="file"]');
        if (fi) fi.click();
        return;
      }

      // Click on Remove button on an evidence file row
      const removeFileBtn = e.target.closest('.s2-evidence-remove-btn');
      if (removeFileBtn) {
        const section = removeFileBtn.getAttribute('data-evidence-section');
        const cid     = removeFileBtn.getAttribute('data-client-id');
        const fi      = parseInt(removeFileBtn.getAttribute('data-file'), 10);
        const arr = section === 'housing' ? HOUSING_FILES[cid] : INCOME_FILES[cid];
        if (!arr || !arr[fi]) return;
        const f = arr[fi];
        if (!confirm(`Remove "${f.filename}"?`)) return;
        if (f.id) {
          try {
            await fetch(API_BASE + '/step2-delete-evidence', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ evidence_id: f.id }),
            });
          } catch (err) { console.warn('delete failed', err); }
        }
        arr.splice(fi, 1);
        if (section === 'housing') renderHousing();
        else renderIncome();
        scheduleAutosave();
        return;
      }

      // Click on Remove button on a lease-doc file row
      const removeLeaseDocBtn = e.target.closest('.s2-leasedoc-remove-btn');
      if (removeLeaseDocBtn) {
        const slot = removeLeaseDocBtn.getAttribute('data-leasedoc-slot');
        const fi   = parseInt(removeLeaseDocBtn.getAttribute('data-file'), 10);
        const arr = LEASEDOC_FILES[slot];
        if (!arr || !arr[fi]) return;
        const f = arr[fi];
        if (!confirm(`Remove "${f.filename}"?`)) return;
        if (f.id) {
          try {
            await fetch(API_BASE + '/step2-delete-evidence', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ evidence_id: f.id }),
            });
          } catch (err) { console.warn('delete failed', err); }
        }
        arr.splice(fi, 1);
        renderLeaseDocs();
        scheduleAutosave();
      }
    });

    // Drag-drop on evidence zones
    formEl.addEventListener('dragover', e => {
      const z = e.target.closest('.s2-upload-zone[data-evidence-section], .s2-upload-zone[data-leasedoc-slot]');
      if (!z) return;
      e.preventDefault();
      z.classList.add('s2-drag-over');
    });
    formEl.addEventListener('dragleave', e => {
      const z = e.target.closest('.s2-upload-zone[data-evidence-section], .s2-upload-zone[data-leasedoc-slot]');
      if (!z) return;
      z.classList.remove('s2-drag-over');
    });
    formEl.addEventListener('drop', async e => {
      const evZ = e.target.closest('.s2-upload-zone[data-evidence-section]');
      if (evZ) {
        e.preventDefault();
        evZ.classList.remove('s2-drag-over');
        const section = evZ.getAttribute('data-evidence-section');
        const cid     = evZ.getAttribute('data-client-id');
        const files = Array.from(e.dataTransfer.files || []);
        for (const f of files) await uploadEvidenceFile(f, section, cid);
        return;
      }
      const ldZ = e.target.closest('.s2-upload-zone[data-leasedoc-slot]');
      if (ldZ) {
        e.preventDefault();
        ldZ.classList.remove('s2-drag-over');
        const slot = ldZ.getAttribute('data-leasedoc-slot');
        const files = Array.from(e.dataTransfer.files || []);
        for (const f of files) await uploadLeaseDocFile(f, slot);
      }
    });
    // File input change on evidence + lease-doc zones
    formEl.addEventListener('change', async e => {
      const t = e.target;
      if (t.matches('.s2-upload-zone[data-evidence-section] input[type="file"]')) {
        const z = t.closest('.s2-upload-zone[data-evidence-section]');
        const section = z.getAttribute('data-evidence-section');
        const cid     = z.getAttribute('data-client-id');
        const files = Array.from(t.files || []);
        for (const f of files) await uploadEvidenceFile(f, section, cid);
        t.value = '';
        return;
      }
      if (t.matches('.s2-upload-zone[data-leasedoc-slot] input[type="file"]')) {
        const z = t.closest('.s2-upload-zone[data-leasedoc-slot]');
        const slot = z.getAttribute('data-leasedoc-slot');
        const files = Array.from(t.files || []);
        for (const f of files) await uploadLeaseDocFile(f, slot);
        t.value = '';
      }
    });

    // Submit
    formEl.addEventListener('submit', async (e) => {
      e.preventDefault();
      await doSubmit();
    });
  }

  // ── Autosave ────────────────────────────────────────────────────────

  function scheduleAutosave() {
    clearTimeout(SAVE_TIMER);
    setSaveState('saving', 'Saving…');
    SAVE_TIMER = setTimeout(doAutosave, 1000);
  }
  async function doAutosave() {
    if (SAVE_IN_FLIGHT) {
      SAVE_TIMER = setTimeout(doAutosave, 500);
      return;
    }
    SAVE_IN_FLIGHT = true;
    try {
      const payload = collectPayload();
      const r = await fetch(API_BASE + '/step2-save-draft', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
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

  // ── Submit ────────────────────────────────────────────────────────────

  async function doSubmit() {
    clearTimeout(SAVE_TIMER);
    const errs = clientValidate();
    showValidation(errs);
    if (errs.length) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    const btn = document.getElementById('lofSubmitBtn');
    btn.disabled = true;
    btn.textContent = 'Submitting…';
    try {
      const payload = collectPayload();
      const r = await fetch(API_BASE + '/step2-submit', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        showValidation([err.error || 'Submission failed']);
        btn.disabled = false;
        btn.textContent = 'Submit Evidence';
        return;
      }
      showThanks();
    } catch (err) {
      showValidation(['Submission failed: ' + err.message]);
      btn.disabled = false;
      btn.textContent = 'Submit Evidence';
    }
  }

  function clientValidate() {
    const errs = [];
    if (!document.getElementById('s2RefConsent').checked) {
      errs.push('You must agree to allow reference checks.');
    }
    if (!document.getElementById('s2RetentionConsent').checked) {
      errs.push('You must agree to the records retention policy.');
    }
    // Check ID points
    APPLICANTS.forEach((a, i) => {
      const points = (ID_FILES[i] || []).reduce((s, f) => s + (f.points || 0), 0);
      if (points < 100) {
        const name = [a.first_name, a.last_name].filter(Boolean).join(' ') || `Applicant ${i + 1}`;
        errs.push(`${name}: only ${points} ID points uploaded — 100 needed.`);
      }
      (ID_FILES[i] || []).forEach((f) => {
        if (!f.doc_type) {
          const name = [a.first_name, a.last_name].filter(Boolean).join(' ') || `Applicant ${i + 1}`;
          errs.push(`${name}: file "${f.filename}" needs a document type selected.`);
        }
      });
    });
    // Each housing entry needs at least 1 evidence file
    HOUSING.forEach((h, i) => {
      const files = (HOUSING_FILES[h.client_id] || []).filter(f => f.status === 'uploaded');
      if (!files.length) {
        const desc = h.address || `Housing entry ${i + 1}`;
        errs.push(`Housing — "${desc}": at least one supporting document is required.`);
      }
    });
    // Each income entry needs at least 1 evidence file
    INCOME.forEach((inc, i) => {
      const files = (INCOME_FILES[inc.client_id] || []).filter(f => f.status === 'uploaded');
      if (!files.length) {
        const desc = inc.income_source_name || `Income entry ${i + 1}`;
        errs.push(`Income — "${desc}": at least one supporting document is required.`);
      }
    });
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

  function collectPayload() {
    return {
      reference_consent:           document.getElementById('s2RefConsent').checked,
      retention_consent:           document.getElementById('s2RetentionConsent').checked,
      credit_check_consent:        document.getElementById('s2CreditConsent').checked,
      tenancy_database_consent:    document.getElementById('s2TenancyDbConsent').checked,
      housing_history: HOUSING.map((h) => ({
        applicant_contact_id: APPLICANTS[0]?.contact_id || null,
        ...h,
      })),
      income_history: INCOME.map((inc) => ({
        applicant_contact_id: APPLICANTS[0]?.contact_id || null,
        ...inc,
      })),
    };
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  function esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
})();
