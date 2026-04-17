/**
 * crm.js
 * CRM Contact management for the Sydney Property Map.
 *
 * Renders inside the Kanban card modal as a collapsible "Contacts" section.
 * Domain agent (if known) appears as the first read-only row.
 * Additional contacts are stored in Neon DB with organisation support,
 * duplicate detection, and per-contact notes.
 *
 * Exposes: window.CRM
 */

const CRM_BASE = '/api/contacts';

const ROLES = [
  { value: 'vendor',      label: 'Vendor'       },
  { value: 'purchaser',   label: 'Purchaser'     },
  { value: 'agent',       label: 'Agent'         },
  { value: 'buyers_agent',label: "Buyer's Agent" },
  { value: 'referrer',    label: 'Referrer'      },
  { value: 'solicitor',   label: 'Solicitor'     },
];

const SOURCES = [
  'Our Website',
  'Realestate.com.au',
  'Domain.com.au',
  'Instagram',
  'Facebook',
  'Letter Drop',
  'Door Knocking',
  'Walk-In',
  'Signboard',
  'Cold-Calling',
  'Open House',
  'Referral',
  'Other',
];

// Resolve a raw source value into { dropdown, other }.
// - If source matches one of SOURCES → dropdown=that, other=''
// - Empty/null/undefined → dropdown='', other=''
// - Anything else (legacy/custom) → dropdown='Other', other=<raw value>
function resolveSource(raw) {
  if (!raw) return { dropdown: '', other: '' };
  const s = String(raw);
  if (SOURCES.includes(s)) return { dropdown: s, other: '' };
  return { dropdown: 'Other', other: s };
}

// Render the Source field HTML (dropdown + hidden Other input that reveals
// when 'Other' is selected). Classes crm-source-sel and crm-source-other are
// used for query selection by the save handlers.
function renderSourceField(rawValue) {
  const { dropdown, other } = resolveSource(rawValue);
  const otherVisible = dropdown === 'Other';
  return `
    <select class="kb-input crm-source-sel">
      <option value="">Select source…</option>
      ${SOURCES.map(s => `<option value="${s}" ${s === dropdown ? 'selected' : ''}>${s}</option>`).join('')}
    </select>
    <input class="kb-input crm-source-other" type="text" placeholder="Describe source…"
      value="${other.replace(/"/g, '&quot;')}"
      style="margin-top:6px;${otherVisible ? '' : 'display:none'}">
  `;
}

// Read the effective source from the form (drop value, or Other text when
// 'Other' is selected). Returns empty string if nothing chosen.
function readSourceField(container) {
  const sel = container.querySelector('.crm-source-sel');
  const oth = container.querySelector('.crm-source-other');
  if (!sel) return '';
  const val = sel.value;
  if (val === 'Other') return (oth?.value || '').trim() || 'Other';
  return val;
}

// Wire up the dropdown so 'Other' reveals the text input.
function wireSourceField(container) {
  const sel = container.querySelector('.crm-source-sel');
  const oth = container.querySelector('.crm-source-other');
  if (!sel || !oth) return;
  sel.addEventListener('change', () => {
    oth.style.display = sel.value === 'Other' ? '' : 'none';
    if (sel.value === 'Other') oth.focus();
  });
}

// ─── API helpers ──────────────────────────────────────────────────────────────

async function apiGet(params = {}) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${CRM_BASE}${qs ? '?' + qs : ''}`);
  if (!res.ok) throw new Error(`CRM GET ${res.status}`);
  return res.json();
}

async function apiPost(body) {
  const res = await fetch(CRM_BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`CRM POST ${res.status}`);
  return res.json();
}

async function apiPut(body) {
  const res = await fetch(CRM_BASE, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`CRM PUT ${res.status}`);
  return res.json();
}

async function apiDelete(params) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${CRM_BASE}?${qs}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`CRM DELETE ${res.status}`);
  return res.json();
}

// ─── Name helpers ─────────────────────────────────────────────────────────────

function splitName(fullName = '') {
  const parts = fullName.trim().split(/\s+/);
  return { first_name: parts[0] || '', last_name: parts.slice(1).join(' ') || '' };
}

function displayName(c) {
  return [c.first_name, c.last_name].filter(Boolean).join(' ') || '—';
}

function formatNoteDate(ts) {
  const d = new Date(ts);
  const pad = n => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth()+1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ─── Organisation typeahead ───────────────────────────────────────────────────

function buildOrgTypeahead(container, onSelect) {
  const wrap = document.createElement('div');
  wrap.style.position = 'relative';
  wrap.innerHTML = `
    <input class="kb-input crm-org-input" type="text" placeholder="Search or create organisation…">
    <div class="crm-search-results crm-org-results"></div>`;
  container.appendChild(wrap);

  const input = wrap.querySelector('.crm-org-input');
  const results = wrap.querySelector('.crm-org-results');
  let selectedOrgId = null;
  let selectedOrgName = '';
  let debounce;

  input.addEventListener('input', () => {
    clearTimeout(debounce);
    selectedOrgId = null;
    const q = input.value.trim();
    if (q.length < 1) { results.innerHTML = ''; return; }
    debounce = setTimeout(async () => {
      const orgs = await apiGet({ org_search: q }).catch(() => []);
      results.innerHTML = '';
      // "Create new" option
      const createItem = document.createElement('div');
      createItem.className = 'crm-search-item crm-org-create';
      createItem.innerHTML = `<em>+ Create "${q}"</em>`;
      createItem.addEventListener('click', async () => {
        const org = await apiPost({ action: 'create_org', name: q });
        selectedOrgId = org.id;
        selectedOrgName = org.name;
        input.value = org.name;
        results.innerHTML = '';
        onSelect(org.id, org.name);
      });
      results.appendChild(createItem);

      orgs.forEach(org => {
        const item = document.createElement('div');
        item.className = 'crm-search-item';
        item.textContent = org.name;
        item.addEventListener('click', () => {
          selectedOrgId = org.id;
          selectedOrgName = org.name;
          input.value = org.name;
          results.innerHTML = '';
          onSelect(org.id, org.name);
        });
        results.appendChild(item);
      });
    }, 250);
  });

  return {
    getOrgId: () => selectedOrgId,
    getOrgName: () => selectedOrgName,
    setValue: (id, name) => { selectedOrgId = id; selectedOrgName = name; input.value = name || ''; },
  };
}

// ─── Duplicate detection ──────────────────────────────────────────────────────

async function checkDuplicates(firstName, lastName, email, mobile) {
  if (!firstName && !email && !mobile) return [];
  return apiGet({
    check_duplicate: '1',
    first_name: firstName || '',
    last_name:  lastName  || '',
    email:      email     || '',
    mobile:     mobile    || '',
  }).catch(() => []);
}

function renderDuplicateWarning(container, duplicates, onSelectExisting) {
  const existing = container.querySelector('.crm-duplicate-warning');
  if (existing) existing.remove();
  if (!duplicates.length) return;

  const warn = document.createElement('div');
  warn.className = 'crm-duplicate-warning';
  warn.innerHTML = `<div class="crm-dup-title">⚠ Possible duplicate${duplicates.length > 1 ? 's' : ''} found:</div>`;
  duplicates.forEach(c => {
    const item = document.createElement('div');
    item.className = 'crm-dup-item';
    item.innerHTML = `<strong>${displayName(c)}</strong>${c.org_name ? ` · ${c.org_name}` : ''}${c.email ? ` · ${c.email}` : ''}${c.mobile ? ` · ${c.mobile}` : ''}`;
    item.addEventListener('click', () => onSelectExisting(c));
    warn.appendChild(item);
  });
  container.insertBefore(warn, container.firstChild);
}

// ─── Contact notes panel ──────────────────────────────────────────────────────

async function renderNotesPanel(contactId, pipelineId) {
  const panel = document.createElement('div');
  panel.className = 'crm-notes-panel';

  async function loadNotes() {
    const notes = await apiGet({ notes: '1', contact_id: contactId }).catch(() => []);
    panel.innerHTML = `
      <div class="crm-notes-title">Notes</div>
      <div class="crm-notes-input-row">
        <input class="kb-input crm-note-input" type="text" placeholder="Add a note…">
        <button class="crm-note-add-btn">Add</button>
      </div>
      <div class="crm-notes-list"></div>`;

    const listEl = panel.querySelector('.crm-notes-list');
    if (!notes.length) {
      listEl.innerHTML = '<div class="crm-empty">No notes yet</div>';
    } else {
      notes.forEach(n => {
        const entry = document.createElement('div');
        entry.className = 'crm-note-entry';
        const propLabel = n.property_address ? ` <span class="crm-note-prop">· ${n.property_address}</span>` : '';
        entry.innerHTML = `
          <div class="crm-note-meta">
            <span class="crm-note-date">${formatNoteDate(n.created_at)}${propLabel}</span>
            <button class="crm-note-delete" data-id="${n.id}">✕</button>
          </div>
          <div class="crm-note-text">${n.note_text}</div>`;
        entry.querySelector('.crm-note-delete').addEventListener('click', async () => {
          await apiDelete({ note_id: n.id });
          loadNotes();
        });
        listEl.appendChild(entry);
      });
    }

    panel.querySelector('.crm-note-add-btn').addEventListener('click', async () => {
      const input = panel.querySelector('.crm-note-input');
      const text = input.value.trim();
      if (!text) return;
      await apiPost({ action: 'add_note', contact_id: contactId, pipeline_id: pipelineId || null, note_text: text });
      input.value = '';
      loadNotes();
    });
    panel.querySelector('.crm-note-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') panel.querySelector('.crm-note-add-btn').click();
    });
  }

  await loadNotes();
  return panel;
}

// ─── Render contacts section ──────────────────────────────────────────────────

async function renderContactsSection(pipelineId, agentData) {
  const section = document.createElement('div');
  section.className = 'crm-section';

  section.innerHTML = `
    <div class="crm-header">
      <button class="crm-toggle" aria-expanded="false">
        <span class="crm-toggle-icon">▶</span>
        <span class="kb-section-label" style="margin:0">Contacts</span>
        <span class="crm-count"></span>
      </button>
      <button class="crm-add-btn" title="Add contact" style="display:none">+ Add</button>
    </div>
    <div class="crm-body" style="display:none">
      <div class="crm-list"></div>
      <div class="crm-form" style="display:none"></div>
    </div>`;

  const toggleBtn = section.querySelector('.crm-toggle');
  const toggleIcon = section.querySelector('.crm-toggle-icon');
  const addBtn    = section.querySelector('.crm-add-btn');
  const body      = section.querySelector('.crm-body');
  const listEl    = section.querySelector('.crm-list');
  const formEl    = section.querySelector('.crm-form');
  const countEl   = section.querySelector('.crm-count');

  let expanded = false;

  function setExpanded(val) {
    expanded = val;
    body.style.display    = expanded ? '' : 'none';
    addBtn.style.display  = expanded ? '' : 'none';
    toggleBtn.setAttribute('aria-expanded', expanded);
    toggleIcon.textContent = expanded ? '▼' : '▶';
  }

  toggleBtn.addEventListener('click', () => setExpanded(!expanded));

  async function reload() {
    listEl.innerHTML = '<div class="crm-loading">Loading…</div>';
    let contacts = [];
    try { contacts = await apiGet({ pipeline_id: pipelineId }); }
    catch (_) { listEl.innerHTML = '<div class="crm-empty">Could not load contacts</div>'; return; }
    renderList(contacts);
  }

  function updateCount(crmCount) {
    const agentCount = (agentData?.name || agentData?.email) ? 1 : 0;
    const total = agentCount + crmCount;
    countEl.textContent = total ? `(${total})` : '';
  }

  function renderList(contacts) {
    listEl.innerHTML = '';
    updateCount(contacts.length);

    // Domain agent row
    if (agentData?.name || agentData?.email || agentData?.phone) {
      const row = document.createElement('div');
      row.className = 'crm-contact-row crm-domain-agent';
      row.innerHTML = `
        <div class="crm-contact-info">
          <div class="crm-contact-name">
            ${agentData.name || '—'}
            <span class="crm-role-badge crm-role-agent">Agent</span>
            <span class="crm-domain-badge">Domain</span>
          </div>
          <div class="crm-contact-meta">
            ${agentData.agency ? `<span>${agentData.agency}</span>` : ''}
            ${agentData.phone  ? `<a href="tel:${agentData.phone}" class="crm-link">${agentData.phone}</a>` : ''}
            ${agentData.email  ? `<a href="mailto:${agentData.email}" class="crm-link">${agentData.email}</a>` : ''}
          </div>
        </div>
        <div class="crm-contact-actions">
          <button class="crm-save-domain-btn" title="Save to contacts">💾</button>
        </div>`;

      row.querySelector('.crm-save-domain-btn').addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true; btn.textContent = '…';
        try {
          const { first_name, last_name } = splitName(agentData.name || '');
          // Find or create org for agency
          let orgId = null;
          if (agentData.agency) {
            const org = await apiPost({ action: 'create_org', name: agentData.agency });
            orgId = org.id;
          }
          const existing = agentData.email
            ? (await apiGet({ search: agentData.email }).catch(() => [])).filter(c => c.email === agentData.email)
            : [];
          let contactId;
          if (existing.length) {
            contactId = existing[0].id;
          } else {
            const created = await apiPost({ first_name, last_name, mobile: agentData.phone || '', email: agentData.email || '', organisation_id: orgId, source: 'Domain.com.au', domain_id: String(pipelineId) });
            contactId = created.id;
          }
          await apiPost({ action: 'link', contact_id: contactId, pipeline_id: pipelineId, role: 'agent' });
          btn.textContent = '✓';
          setTimeout(() => reload(), 800);
        } catch (err) {
          btn.textContent = '✕'; btn.disabled = false;
          console.error('[CRM] save domain agent failed:', err);
        }
      });
      listEl.appendChild(row);
    }

    if (!contacts.length && !agentData?.name) {
      const empty = document.createElement('div');
      empty.className = 'crm-empty';
      empty.textContent = 'No contacts linked';
      listEl.appendChild(empty);
      return;
    }

    contacts.forEach(contact => {
      const row = document.createElement('div');
      row.className = 'crm-contact-row';
      const currentRole = contact.role || 'vendor';
      const roleLabel = ROLES.find(r => r.value === currentRole)?.label || currentRole;
      row.innerHTML = `
        <div class="crm-contact-info">
          <div class="crm-contact-name">
            ${displayName(contact)}
          </div>
          <div class="crm-contact-meta">
            ${contact.org_name ? `<span>${contact.org_name}</span>` : ''}
            <span class="crm-role-badge crm-role-${currentRole.replace(/[^a-z0-9]/gi,'_')}">${roleLabel}</span>
            ${contact.mobile   ? `<a href="tel:${contact.mobile}" class="crm-link">${contact.mobile}</a>` : ''}
            ${contact.email    ? `<a href="mailto:${contact.email}" class="crm-link">${contact.email}</a>` : ''}
          </div>
        </div>
        <div class="crm-contact-actions">
          <button class="crm-notes-btn" data-id="${contact.id}" title="Notes">📝</button>
          <button class="crm-edit-btn"   data-id="${contact.id}" title="Edit">✎</button>
          <button class="crm-unlink-btn" data-id="${contact.id}" title="Remove from property">✕</button>
        </div>`;

      // Notes toggle
      row.querySelector('.crm-notes-btn').addEventListener('click', async () => {
        const existing = row.nextElementSibling;
        if (existing?.classList.contains('crm-notes-panel')) { existing.remove(); return; }
        const panel = await renderNotesPanel(contact.id, pipelineId);
        row.insertAdjacentElement('afterend', panel);
      });

      row.querySelector('.crm-unlink-btn').addEventListener('click', async () => {
        if (!confirm(`Remove ${displayName(contact)} from this property?`)) return;
        await apiPost({ action: 'unlink', contact_id: contact.id, pipeline_id: pipelineId });
        reload();
      });

      // Edit opens form — Role dropdown is available there and saves per-property
      row.querySelector('.crm-edit-btn').addEventListener('click', () => showForm(contact, contact.role));
      listEl.appendChild(row);
    });
  }

  // ── Contact form ────────────────────────────────────────────────────────────

  function showForm(prefill = {}, prefillRole = 'vendor') {
    formEl.style.display = 'block';
    addBtn.style.display = 'none';
    const isEdit = !!prefill.id;

    formEl.innerHTML = `
      <div class="crm-form-inner">
        <div class="crm-form-title">${isEdit ? 'Edit Contact' : 'Add Contact'}</div>

        ${!isEdit ? `
        <div style="margin-bottom:10px">
          <label class="kb-field-label">Search existing contacts</label>
          <input class="kb-input crm-search" type="text" placeholder="Name, organisation, email…">
          <div class="crm-search-results"></div>
        </div>
        <div class="crm-form-divider">— or create new —</div>
        <div class="crm-duplicate-warning-wrap"></div>` : ''}

        <div class="crm-form-row">
          <div class="kb-field-wrap">
            <label class="kb-field-label">First Name *</label>
            <input class="kb-input crm-first" type="text" placeholder="First" value="${prefill.first_name || ''}">
          </div>
          <div class="kb-field-wrap">
            <label class="kb-field-label">Last Name</label>
            <input class="kb-input crm-last" type="text" placeholder="Last" value="${prefill.last_name || ''}">
          </div>
        </div>
        <div class="crm-form-row">
          <div class="kb-field-wrap">
            <label class="kb-field-label">Mobile</label>
            <input class="kb-input crm-mobile" type="text" placeholder="04xx xxx xxx" value="${prefill.mobile || ''}">
          </div>
          <div class="kb-field-wrap">
            <label class="kb-field-label">Email</label>
            <input class="kb-input crm-email" type="text" placeholder="email@domain.com" value="${prefill.email || ''}">
          </div>
        </div>
        <div class="crm-form-row">
          <div class="kb-field-wrap" style="flex:2">
            <label class="kb-field-label">Organisation</label>
            <div class="crm-org-wrap"></div>
          </div>
          <div class="kb-field-wrap">
            <label class="kb-field-label">Role (this property)</label>
            <select class="kb-input crm-role">
              ${ROLES.map(r => `<option value="${r.value}" ${r.value === prefillRole ? 'selected' : ''}>${r.label}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="crm-form-row">
          <div class="kb-field-wrap" style="flex:1">
            <label class="kb-field-label">Source</label>
            ${renderSourceField(prefill.source)}
          </div>
        </div>

        <div class="crm-form-actions">
          <button class="crm-save-btn">${isEdit ? 'Save Changes' : 'Save & Link'}</button>
          <button class="crm-cancel-btn">Cancel</button>
        </div>
      </div>`;

    // Org typeahead
    const orgWrap = formEl.querySelector('.crm-org-wrap');
    let selectedOrgId = prefill.organisation_id || null;
    const orgTA = buildOrgTypeahead(orgWrap, (id) => { selectedOrgId = id; });
    if (prefill.org_name) orgTA.setValue(prefill.organisation_id, prefill.org_name);

    // Source field — reveal Other input when selected
    wireSourceField(formEl);

    // Duplicate detection (new contacts only)
    if (!isEdit) {
      const dupWrap = formEl.querySelector('.crm-duplicate-warning-wrap');
      let dupTimer;
      const checkDups = () => {
        clearTimeout(dupTimer);
        dupTimer = setTimeout(async () => {
          const first  = formEl.querySelector('.crm-first').value.trim();
          const last   = formEl.querySelector('.crm-last').value.trim();
          const email  = formEl.querySelector('.crm-email').value.trim();
          const mobile = formEl.querySelector('.crm-mobile').value.trim();
          if (!first && !email && !mobile) { dupWrap.innerHTML = ''; return; }
          const dups = await checkDuplicates(first, last, email, mobile);
          renderDuplicateWarning(dupWrap, dups, async (existing) => {
            // Link existing contact with the role currently selected in the form
            const role = formEl.querySelector('.crm-role').value;
            await apiPost({ action: 'link', contact_id: existing.id, pipeline_id: pipelineId, role });
            hideForm(); reload();
          });
        }, 500);
      };
      ['crm-first','crm-last','crm-email','crm-mobile'].forEach(cls => {
        formEl.querySelector(`.${cls}`)?.addEventListener('input', checkDups);
      });
    }

    // Search existing
    const searchEl = formEl.querySelector('.crm-search');
    if (searchEl) {
      let t;
      searchEl.addEventListener('input', () => {
        clearTimeout(t);
        const q = searchEl.value.trim();
        const resultsEl = formEl.querySelector('.crm-search-results');
        if (q.length < 2) { resultsEl.innerHTML = ''; return; }
        t = setTimeout(async () => {
          const results = await apiGet({ search: q }).catch(() => []);
          if (!results.length) { resultsEl.innerHTML = '<div class="crm-empty">No matches</div>'; return; }
          resultsEl.innerHTML = '';
          results.forEach(ct => {
            const item = document.createElement('div');
            item.className = 'crm-search-item';
            item.innerHTML = `<strong>${displayName(ct)}</strong>${ct.org_name ? ` · ${ct.org_name}` : ''}${ct.mobile || ct.email ? ` · ${ct.mobile || ct.email}` : ''}`;
            item.addEventListener('click', async () => {
              // Seed form role with their most recent role on any property,
              // so user can accept the default or override before linking.
              const lr = await apiGet({ last_role: '1', contact_id: ct.id }).catch(() => ({}));
              const roleSel = formEl.querySelector('.crm-role');
              if (lr?.role && roleSel) roleSel.value = lr.role;
              const role = roleSel ? roleSel.value : 'vendor';
              await apiPost({ action: 'link', contact_id: ct.id, pipeline_id: pipelineId, role });
              hideForm();
              reload();
            });
            resultsEl.appendChild(item);
          });
        }, 300);
      });
    }

    formEl.querySelector('.crm-save-btn').addEventListener('click', async () => {
      const first = formEl.querySelector('.crm-first').value.trim();
      if (!first) { formEl.querySelector('.crm-first').focus(); return; }
      const sourceVal = readSourceField(formEl);
      const data = {
        first_name:      first,
        last_name:       formEl.querySelector('.crm-last').value.trim(),
        mobile:          formEl.querySelector('.crm-mobile').value.trim(),
        email:           formEl.querySelector('.crm-email').value.trim(),
        organisation_id: selectedOrgId,
        source:          sourceVal || prefill.source || 'Other',
        domain_id:       prefill.domain_id || null,
      };
      const role = formEl.querySelector('.crm-role').value;
      if (isEdit) {
        // Identity fields via PUT; role via link upsert (scoped to this property)
        await apiPut({ id: prefill.id, ...data });
        await apiPost({ action: 'link', contact_id: prefill.id, pipeline_id: pipelineId, role });
      } else {
        const created = await apiPost(data);
        await apiPost({ action: 'link', contact_id: created.id, pipeline_id: pipelineId, role });
      }
      hideForm();
      reload();
    });

    formEl.querySelector('.crm-cancel-btn').addEventListener('click', hideForm);
  }

  function hideForm() {
    formEl.style.display = 'none';
    formEl.innerHTML = '';
    addBtn.style.display = '';
  }

  addBtn.addEventListener('click', () => showForm());

  // Load contacts async — section renders immediately, contacts populate in background
  reload();
  return section;
}

// ─── Public API ───────────────────────────────────────────────────────────────

window.CRM = { renderContactsSection, splitName, displayName, renderCRMView };

// ─── Standalone CRM View ──────────────────────────────────────────────────────

function renderCRMView(container) {
  container.innerHTML = `
    <div class="crm-view-wrap">
      <div class="crm-view-header">
        <div class="crm-view-tabs">
          <button class="crm-tab active" data-tab="contacts">👤 Contacts</button>
          <button class="crm-tab" data-tab="organisations">🏢 Organisations</button>
        </div>
        <button class="crm-view-add-btn" id="crmViewAddBtn">+ New Contact</button>
      </div>
      <div class="crm-view-body">
        <div class="crm-tab-pane active" id="crm-pane-contacts"></div>
        <div class="crm-tab-pane" id="crm-pane-organisations"></div>
      </div>
    </div>
    <div class="crm-drawer-overlay" id="crmDrawerOverlay" style="display:none">
      <div class="crm-drawer" id="crmDrawer"></div>
    </div>`;

  // Tab switching
  container.querySelectorAll('.crm-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      container.querySelectorAll('.crm-tab').forEach(t => t.classList.remove('active'));
      container.querySelectorAll('.crm-tab-pane').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      container.querySelector(`#crm-pane-${tab.dataset.tab}`).classList.add('active');
      if (tab.dataset.tab === 'contacts') loadContactsPane();
      if (tab.dataset.tab === 'organisations') loadOrgsPane();
    });
  });

  // Drawer helpers
  function openDrawer(renderFn) {
    const overlay = container.querySelector('#crmDrawerOverlay');
    const drawer  = container.querySelector('#crmDrawer');
    overlay.style.display = '';
    renderFn(drawer);
    overlay.addEventListener('click', e => { if (e.target === overlay) closeDrawer(); }, { once: true });
  }
  function closeDrawer() {
    const overlay = container.querySelector('#crmDrawerOverlay');
    overlay.style.display = 'none';
    container.querySelector('#crmDrawer').innerHTML = '';
  }
  window._crmCloseDrawer = closeDrawer;

  // + New Contact button
  container.querySelector('#crmViewAddBtn').addEventListener('click', () => {
    openDrawer(drawer => renderContactDrawer(drawer, null, () => { closeDrawer(); loadContactsPane(); }));
  });

  // ── Contacts pane ──────────────────────────────────────────────────────────

  let contactSearch = '';
  let contactPage   = 0;
  const PAGE_SIZE   = 30;

  async function loadContactsPane() {
    const pane = container.querySelector('#crm-pane-contacts');
    pane.innerHTML = `
      <div class="crm-pane-toolbar">
        <input class="kb-input crm-view-search" placeholder="Search contacts…" value="${contactSearch}">
      </div>
      <div class="crm-contact-table-wrap">
        <table class="crm-contact-table">
          <thead><tr>
            <th>Name</th><th>Organisation</th><th>Mobile</th><th>Email</th><th>Properties</th><th></th>
          </tr></thead>
          <tbody id="crmContactTableBody"><tr><td colspan="6" class="crm-loading">Loading…</td></tr></tbody>
        </table>
      </div>
      <div class="crm-pane-pagination" id="crmContactPagination"></div>`;

    pane.querySelector('.crm-view-search').addEventListener('input', e => {
      contactSearch = e.target.value;
      contactPage   = 0;
      fetchContacts();
    });

    fetchContacts();
  }

  async function fetchContacts() {
    const pane   = container.querySelector('#crm-pane-contacts');
    const tbody  = pane?.querySelector('#crmContactTableBody');
    const pagEl  = pane?.querySelector('#crmContactPagination');
    if (!tbody) return;

    tbody.innerHTML = `<tr><td colspan="6" class="crm-loading">Loading…</td></tr>`;
    try {
      const params = { all: '1', offset: contactPage * PAGE_SIZE, limit: PAGE_SIZE };
      if (contactSearch) params.search = contactSearch;
      const data = await apiGet(params);
      const contacts = Array.isArray(data) ? data : (data.contacts || []);
      const total    = data.total ?? contacts.length;

      if (!contacts.length) {
        tbody.innerHTML = `<tr><td colspan="6" class="crm-empty">No contacts found</td></tr>`;
        if (pagEl) pagEl.innerHTML = '';
        return;
      }

      tbody.innerHTML = '';
      contacts.forEach(c => {
        const tr = document.createElement('tr');
        tr.className = 'crm-contact-tr';
        const propCount = c.property_count ?? 0;
        tr.innerHTML = `
          <td class="crm-td-name"><strong>${displayName(c)}</strong></td>
          <td>${c.org_name || '—'}</td>
          <td>${c.mobile ? `<a href="tel:${c.mobile}" class="crm-link">${c.mobile}</a>` : '—'}</td>
          <td>${c.email  ? `<a href="mailto:${c.email}" class="crm-link">${c.email}</a>` : '—'}</td>
          <td>${propCount ? `<span class="crm-prop-count">${propCount}</span>` : '—'}</td>
          <td class="crm-td-actions">
            <button class="crm-view-edit-btn" title="Edit">✎</button>
            <button class="crm-view-delete-btn" title="Delete" style="color:#c0392b">🗑</button>
          </td>`;

        tr.querySelector('.crm-td-name').addEventListener('click', () => {
          openDrawer(drawer => renderContactDetail(drawer, c.id, () => { closeDrawer(); fetchContacts(); }));
        });
        tr.querySelector('.crm-view-edit-btn').addEventListener('click', e => {
          e.stopPropagation();
          openDrawer(drawer => renderContactDrawer(drawer, c, () => { closeDrawer(); fetchContacts(); }));
        });
        tr.querySelector('.crm-view-delete-btn').addEventListener('click', async e => {
          e.stopPropagation();
          if (!confirm(`Permanently delete ${displayName(c)}? This cannot be undone.`)) return;
          await apiDelete({ id: c.id });
          fetchContacts();
        });

        tbody.appendChild(tr);
      });

      // Pagination
      if (pagEl) {
        const totalPages = Math.ceil(total / PAGE_SIZE);
        if (totalPages <= 1) { pagEl.innerHTML = ''; return; }
        pagEl.innerHTML = '';
        const prev = document.createElement('button');
        prev.className = 'crm-page-btn';
        prev.textContent = '← Prev';
        prev.disabled = contactPage === 0;
        prev.addEventListener('click', () => { contactPage--; fetchContacts(); });
        const next = document.createElement('button');
        next.className = 'crm-page-btn';
        next.textContent = 'Next →';
        next.disabled = contactPage >= totalPages - 1;
        next.addEventListener('click', () => { contactPage++; fetchContacts(); });
        const info = document.createElement('span');
        info.className = 'crm-page-info';
        info.textContent = `Page ${contactPage + 1} of ${totalPages} (${total} contacts)`;
        pagEl.appendChild(prev);
        pagEl.appendChild(info);
        pagEl.appendChild(next);
      }
    } catch (err) {
      if (tbody) tbody.innerHTML = `<tr><td colspan="6" class="crm-empty">Error loading contacts</td></tr>`;
    }
  }

  // ── Contact detail drawer ──────────────────────────────────────────────────

  async function renderContactDetail(drawer, contactId, onDone) {
    drawer.innerHTML = '<div class="crm-drawer-loading">Loading…</div>';
    try {
      const [contactData, notes, props, allPipeline, me] = await Promise.all([
        apiGet({ id: contactId }),
        apiGet({ notes: '1', contact_id: contactId }),
        apiGet({ contact_properties: '1', contact_id: contactId }).catch(() => []),
        apiGet({ pipeline_list: '1' }).catch(() => []),
        fetch('/api/auth/me').then(r => r.json()).catch(() => ({ authenticated: false })),
      ]);
      const c = Array.isArray(contactData) ? contactData[0] : contactData;
      if (!c) { drawer.innerHTML = '<div class="crm-drawer-loading">Not found</div>'; return; }

      const viewerIsAdmin = !!(me && me.authenticated && me.user && me.user.isAdmin);
      const viewerId      = me && me.authenticated && me.user ? String(me.user.id) : '';
      const isSelf        = viewerId && String(c.id) === viewerId;
      const canManage     = viewerIsAdmin;
      const canChangePw   = viewerIsAdmin || isSelf;
      const lastLogin     = c.last_login_at ? new Date(c.last_login_at).toLocaleString() : 'Never';
      const hasPassword   = !!c.password_hash;
      const accessModules = Array.isArray(c.access_modules) ? c.access_modules : [];
      // PropMap access = allowed to log in AND has propmap (or wildcard) module
      const hasPropMapAccess = c.can_login && (accessModules.includes('*') || accessModules.includes('propmap'));

      // Site Access section — only rendered when viewer is admin OR viewing self
      const siteAccessHtml = (canManage || isSelf) ? `
        <div class="crm-drawer-section">
          <div class="crm-drawer-section-title" style="display:flex;justify-content:space-between;align-items:center">
            Site Access
            <button class="crm-access-pw-btn kb-add-offer-btn" ${canChangePw ? '' : 'disabled'}>
              ${hasPassword ? (isSelf && !canManage ? 'Change my password' : 'Reset password') : 'Set password'}
            </button>
          </div>
          <div class="crm-access-grid">
            <label class="crm-access-row ${canManage && hasPassword ? '' : 'disabled'}">
              <input type="checkbox" class="crm-access-propmap"
                     ${hasPropMapAccess ? 'checked' : ''}
                     ${canManage && hasPassword ? '' : 'disabled'}>
              <div>
                <div class="crm-access-label">PropMap Access</div>
                <div class="crm-access-hint">${hasPassword ? 'Allows sign-in and use of the property map. CRM and Finance modules will become separate toggles.' : 'Set a password first, then enable access.'}</div>
              </div>
            </label>
            <label class="crm-access-row ${canManage ? '' : 'disabled'}">
              <input type="checkbox" class="crm-access-is-admin"
                     ${c.is_admin ? 'checked' : ''}
                     ${canManage ? '' : 'disabled'}>
              <div>
                <div class="crm-access-label">Administrator</div>
                <div class="crm-access-hint">Can manage site access for all contacts.</div>
              </div>
            </label>
            <div class="crm-access-row readonly">
              <div class="crm-access-label">Last login</div>
              <div class="crm-access-hint">${lastLogin}</div>
            </div>
          </div>

          <div class="crm-access-actions">
            <span class="crm-access-status"></span>
          </div>

          <div class="crm-access-pw-form" style="display:none;margin-top:10px">
            ${(isSelf && !canManage) ? `
              <label class="crm-access-label">Current password</label>
              <input type="password" class="kb-input crm-access-pw-current" autocomplete="current-password" style="width:100%;margin-bottom:8px;box-sizing:border-box">
            ` : ''}
            <label class="crm-access-label">New password (min 8 chars)</label>
            <input type="password" class="kb-input crm-access-pw-new" autocomplete="new-password" style="width:100%;margin-bottom:8px;box-sizing:border-box">
            <label class="crm-access-label">Confirm new password</label>
            <input type="password" class="kb-input crm-access-pw-confirm" autocomplete="new-password" style="width:100%;margin-bottom:8px;box-sizing:border-box">
            <div style="display:flex;gap:6px">
              <button class="crm-access-pw-save kb-add-offer-btn">Save password</button>
              <button class="crm-access-pw-cancel">Cancel</button>
            </div>
          </div>
        </div>` : '';

      drawer.innerHTML = `
        <div class="crm-drawer-header">
          <div>
            <div class="crm-drawer-title">${displayName(c)}</div>
            <div class="crm-drawer-subtitle">${[c.org_name, c.mobile, c.email].filter(Boolean).join(" · ")}</div>
          </div>
          <div style="display:flex;gap:8px;align-items:center">
            <button class="crm-drawer-edit-btn kb-add-offer-btn">✎ Edit</button>
            <button class="crm-drawer-close">✕</button>
          </div>
        </div>
        <div class="crm-drawer-body">

          <div class="crm-drawer-section">
            <div class="crm-drawer-section-title">Contact Details</div>
            <div class="crm-detail-grid">
              ${c.mobile   ? `<div class="crm-detail-label">Mobile</div><div><a href="tel:${c.mobile}" class="crm-link">${c.mobile}</a></div>` : ""}
              ${c.email    ? `<div class="crm-detail-label">Email</div><div><a href="mailto:${c.email}" class="crm-link">${c.email}</a></div>` : ""}
              ${c.org_name ? `<div class="crm-detail-label">Organisation</div><div>${c.org_name}</div>` : ""}
              <div class="crm-detail-label">Source</div><div>${c.source || "manual"}</div>
            </div>
          </div>

          ${siteAccessHtml}

          <div class="crm-drawer-section">
            <div class="crm-drawer-section-title" style="display:flex;justify-content:space-between;align-items:center">
              Linked Properties
              <button class="crm-detail-add-prop-btn kb-add-offer-btn">+ Link Property</button>
            </div>
            <div id="crmDetailPropsList">
              ${props.length ? props.map(p => `
                <div class="crm-prop-row" data-pipeline-id="${p.pipeline_id}">
                  <span class="crm-prop-address">${p.address || '—'}${p.suburb ? ", " + p.suburb : ""}</span>
                  <a href="#" class="crm-prop-id-link" data-pipeline-id="${p.pipeline_id}" title="Open in pipeline">${p.pipeline_id}</a>
                  <select class="crm-prop-role-sel kb-input" data-pipeline-id="${p.pipeline_id}" style="font-size:11px;padding:2px 4px;width:auto">
                    ${ROLES.map(r => `<option value="${r.value}" ${r.value === p.role ? "selected" : ""}>${r.label}</option>`).join("")}
                  </select>
                  <button class="crm-prop-unlink-btn" data-pipeline-id="${p.pipeline_id}" title="Remove">✕</button>
                </div>`).join("") : "<div class=\"crm-empty\">No linked properties</div>"}
            </div>
            <div class="crm-detail-add-prop-form" style="display:none;margin-top:8px">
              <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
                <select class="kb-input crm-prop-select" style="flex:2;font-size:12px">
                  <option value="">Select property…</option>
                  ${allPipeline.map(p => `<option value="${p.id}">${p.address || p.id}${p.suburb ? ", " + p.suburb : ""}</option>`).join("")}
                </select>
                <select class="kb-input crm-prop-role-new" style="font-size:12px">
                  ${ROLES.map(r => `<option value="${r.value}">${r.label}</option>`).join("")}
                </select>
                <button class="crm-prop-link-save kb-add-offer-btn">Link</button>
                <button class="crm-prop-link-cancel">Cancel</button>
              </div>
            </div>
          </div>

          <div class="crm-drawer-section">
            <div class="crm-drawer-section-title" style="display:flex;justify-content:space-between;align-items:center">
              Notes <span style="font-weight:400;color:var(--text-secondary)">(${notes.length})</span>
              <button class="crm-drawer-add-note-btn kb-add-offer-btn">+ Add Note</button>
            </div>
            <div class="crm-drawer-note-input" style="display:none;margin-bottom:10px">
              <textarea class="kb-input crm-drawer-note-text" rows="3" placeholder="Add a note…" style="width:100%;resize:vertical;box-sizing:border-box"></textarea>
              <div style="display:flex;gap:6px;margin-top:4px;align-items:center;flex-wrap:wrap">
                <select class="kb-input crm-drawer-note-prop" style="flex:1;font-size:12px;min-width:140px">
                  <option value="">No property</option>
                  ${allPipeline.map(p => `<option value="${p.id}">${p.address || p.id}${p.suburb ? ", " + p.suburb : ""}</option>`).join("")}
                </select>
                <button class="crm-drawer-note-save kb-add-offer-btn">Save Note</button>
                <button class="crm-drawer-note-cancel">Cancel</button>
              </div>
            </div>
            <div class="crm-drawer-notes-list">
              ${notes.length ? notes.map(n => `
                <div class="crm-note-entry" data-note-id="${n.id}">
                  <div class="crm-note-meta">
                    <span class="crm-note-date">${formatNoteDate(n.created_at)}${n.property_address ? ` · <span class="crm-note-prop">${n.property_address}</span>` : ""}</span>
                    <button class="crm-note-delete" data-id="${n.id}">✕</button>
                  </div>
                  <div class="crm-note-text">${n.note_text}</div>
                </div>`).join("") : "<div class=\"crm-empty\">No notes yet</div>"}
            </div>
          </div>

        </div>`;

      drawer.querySelector(".crm-drawer-close").addEventListener("click", onDone);
      drawer.querySelector(".crm-drawer-edit-btn").addEventListener("click", () => {
        renderContactDrawer(drawer, c, () => renderContactDetail(drawer, contactId, onDone));
      });

      // Property management
      const addPropBtn  = drawer.querySelector(".crm-detail-add-prop-btn");
      const addPropForm = drawer.querySelector(".crm-detail-add-prop-form");
      const propsList   = drawer.querySelector("#crmDetailPropsList");

      addPropBtn.addEventListener("click", () => { addPropForm.style.display = ""; addPropBtn.style.display = "none"; });
      drawer.querySelector(".crm-prop-link-cancel").addEventListener("click", () => { addPropForm.style.display = "none"; addPropBtn.style.display = ""; });
      drawer.querySelector(".crm-prop-link-save").addEventListener("click", async () => {
        const pipelineId = drawer.querySelector(".crm-prop-select").value;
        const role       = drawer.querySelector(".crm-prop-role-new").value;
        if (!pipelineId) return;
        await apiPost({ action: "link", contact_id: contactId, pipeline_id: pipelineId, role });
        renderContactDetail(drawer, contactId, onDone);
      });
      propsList.querySelectorAll(".crm-prop-role-sel").forEach(sel => {
        sel.addEventListener("change", async () => {
          await apiPost({ action: "link", contact_id: contactId, pipeline_id: sel.dataset.pipelineId, role: sel.value });
        });
      });
      propsList.querySelectorAll(".crm-prop-id-link").forEach(link => {
        link.addEventListener("click", (e) => {
          e.preventDefault();
          const pid = link.dataset.pipelineId;
          if (typeof window.openPipelineItem === 'function') {
            window.openPipelineItem(pid);
          }
        });
      });
      propsList.querySelectorAll(".crm-prop-unlink-btn").forEach(btn => {
        btn.addEventListener("click", async () => {
          if (!confirm("Remove this property link?")) return;
          await apiPost({ action: "unlink", contact_id: contactId, pipeline_id: btn.dataset.pipelineId });
          renderContactDetail(drawer, contactId, onDone);
        });
      });

      // Notes
      const addNoteBtn = drawer.querySelector(".crm-drawer-add-note-btn");
      const noteInput  = drawer.querySelector(".crm-drawer-note-input");
      addNoteBtn.addEventListener("click", () => { noteInput.style.display = ""; addNoteBtn.style.display = "none"; drawer.querySelector(".crm-drawer-note-text").focus(); });
      drawer.querySelector(".crm-drawer-note-cancel").addEventListener("click", () => { noteInput.style.display = "none"; addNoteBtn.style.display = ""; });
      drawer.querySelector(".crm-drawer-note-save").addEventListener("click", async () => {
        const text       = drawer.querySelector(".crm-drawer-note-text").value.trim();
        const pipelineId = drawer.querySelector(".crm-drawer-note-prop").value || null;
        if (!text) return;
        await apiPost({ action: "add_note", contact_id: contactId, pipeline_id: pipelineId, note_text: text });
        renderContactDetail(drawer, contactId, onDone);
      });
      drawer.querySelectorAll(".crm-note-delete").forEach(btn => {
        btn.addEventListener("click", async () => {
          if (!confirm("Delete this note?")) return;
          await apiDelete({ note_id: btn.dataset.id });
          renderContactDetail(drawer, contactId, onDone);
        });
      });

      // ── Site Access handlers ───────────────────────────────────────────────
      const statusEl = drawer.querySelector(".crm-access-status");
      const setStatus = (msg, isErr = false) => {
        if (!statusEl) return;
        statusEl.textContent = msg || '';
        statusEl.style.color = isErr ? '#8b2a1f' : 'var(--text-secondary, #7a7366)';
      };

      async function postAccessUpdate(payload) {
        setStatus('Saving…');
        try {
          const r = await fetch('/api/auth/update-access', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ contact_id: contactId, ...payload }),
          });
          const d = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
          setStatus('Saved');
          setTimeout(() => setStatus(''), 2000);
          return d;
        } catch (err) {
          setStatus(err.message || 'Save failed', true);
          throw err;
        }
      }

      const propmapEl = drawer.querySelector(".crm-access-propmap");
      const isAdminEl = drawer.querySelector(".crm-access-is-admin");

      if (propmapEl) {
        propmapEl.addEventListener('change', async (e) => {
          const enabled = e.target.checked;
          // PropMap access = can_login + 'propmap' in access_modules.
          // Turning off: revoke login, clear modules. Password is preserved.
          const payload = enabled
            ? { can_login: true,  access_modules: ['propmap'] }
            : { can_login: false, access_modules: [] };
          try {
            await postAccessUpdate(payload);
          } catch {
            e.target.checked = !e.target.checked; // revert
          }
        });
      }
      if (isAdminEl) {
        isAdminEl.addEventListener('change', async (e) => {
          try {
            await postAccessUpdate({ is_admin: e.target.checked });
          } catch {
            e.target.checked = !e.target.checked; // revert
          }
        });
      }

      // Password form toggle + save
      const pwBtn     = drawer.querySelector(".crm-access-pw-btn");
      const pwForm    = drawer.querySelector(".crm-access-pw-form");
      const pwCancel  = drawer.querySelector(".crm-access-pw-cancel");
      const pwSave    = drawer.querySelector(".crm-access-pw-save");
      if (pwBtn && pwForm) {
        pwBtn.addEventListener('click', () => {
          pwForm.style.display = pwForm.style.display === 'none' ? '' : 'none';
        });
      }
      if (pwCancel) {
        pwCancel.addEventListener('click', () => {
          pwForm.style.display = 'none';
          ['.crm-access-pw-current','.crm-access-pw-new','.crm-access-pw-confirm'].forEach(sel => {
            const el = drawer.querySelector(sel); if (el) el.value = '';
          });
          setStatus('');
        });
      }
      if (pwSave) {
        pwSave.addEventListener('click', async () => {
          const currentEl = drawer.querySelector(".crm-access-pw-current");
          const newEl     = drawer.querySelector(".crm-access-pw-new");
          const confirmEl = drawer.querySelector(".crm-access-pw-confirm");
          const newPw = newEl.value;
          const confPw = confirmEl.value;
          if (newPw.length < 8) { setStatus('Password must be at least 8 characters', true); return; }
          if (newPw !== confPw) { setStatus('Passwords do not match', true); return; }
          const payload = { contact_id: contactId, newPassword: newPw };
          if (currentEl) payload.currentPassword = currentEl.value;
          setStatus('Saving…');
          try {
            const r = await fetch('/api/auth/set-password', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(payload),
            });
            const d = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
            setStatus('Password saved');
            setTimeout(() => renderContactDetail(drawer, contactId, onDone), 800);
          } catch (err) {
            setStatus(err.message || 'Save failed', true);
          }
        });
      }

    } catch (err) {
      console.error("[CRM] renderContactDetail failed:", err);
      drawer.innerHTML = `<div class="crm-drawer-loading">Error loading contact</div>`;
    }
  }

    // ── Contact edit/create drawer ─────────────────────────────────────────────

  function renderContactDrawer(drawer, prefill, onDone) {
    const isEdit = !!prefill?.id;
    drawer.innerHTML = `
      <div class="crm-drawer-header">
        <div class="crm-drawer-title">${isEdit ? 'Edit Contact' : 'New Contact'}</div>
        <button class="crm-drawer-close">✕</button>
      </div>
      <div class="crm-drawer-body">
        <div class="crm-form-inner">
          <div class="crm-form-row">
            <div class="kb-field-wrap">
              <label class="kb-field-label">First Name *</label>
              <input class="kb-input crm-first" type="text" placeholder="First" value="${prefill?.first_name || ''}">
            </div>
            <div class="kb-field-wrap">
              <label class="kb-field-label">Last Name</label>
              <input class="kb-input crm-last" type="text" placeholder="Last" value="${prefill?.last_name || ''}">
            </div>
          </div>
          <div class="crm-form-row">
            <div class="kb-field-wrap">
              <label class="kb-field-label">Mobile</label>
              <input class="kb-input crm-mobile" type="text" placeholder="04xx xxx xxx" value="${prefill?.mobile || ''}">
            </div>
            <div class="kb-field-wrap">
              <label class="kb-field-label">Email</label>
              <input class="kb-input crm-email" type="text" placeholder="email@domain.com" value="${prefill?.email || ''}">
            </div>
          </div>
          <div class="crm-form-row">
            <div class="kb-field-wrap" style="flex:1">
              <label class="kb-field-label">Organisation</label>
              <div class="crm-org-wrap"></div>
            </div>
          </div>
          <div class="crm-form-row">
            <div class="kb-field-wrap" style="flex:1">
              <label class="kb-field-label">Source</label>
              ${renderSourceField(prefill?.source)}
            </div>
          </div>
          <div class="crm-duplicate-warning-wrap"></div>
          <div class="crm-form-actions">
            <button class="crm-save-btn kb-add-offer-btn">${isEdit ? 'Save Changes' : 'Create Contact'}</button>
            <button class="crm-cancel-btn">Cancel</button>
            ${isEdit ? `<button class="crm-delete-btn" style="color:#c0392b;margin-left:auto">🗑 Delete</button>` : ''}
          </div>
        </div>
      </div>`;

    drawer.querySelector('.crm-drawer-close').addEventListener('click', onDone);
    drawer.querySelector('.crm-cancel-btn').addEventListener('click', onDone);

    // Org typeahead
    let selectedOrgId = prefill?.organisation_id || null;
    const orgTA = buildOrgTypeahead(drawer.querySelector('.crm-org-wrap'), (id) => { selectedOrgId = id; });
    if (prefill?.org_name) orgTA.setValue(prefill.organisation_id, prefill.org_name);

    // Source field — reveal Other input when selected
    wireSourceField(drawer);

    // Duplicate detection (new only)
    if (!isEdit) {
      const dupWrap = drawer.querySelector('.crm-duplicate-warning-wrap');
      let dupTimer;
      const checkDups = () => {
        clearTimeout(dupTimer);
        dupTimer = setTimeout(async () => {
          const first  = drawer.querySelector('.crm-first').value.trim();
          const last   = drawer.querySelector('.crm-last').value.trim();
          const email  = drawer.querySelector('.crm-email').value.trim();
          const mobile = drawer.querySelector('.crm-mobile').value.trim();
          const dups   = await checkDuplicates(first, last, email, mobile);
          renderDuplicateWarning(dupWrap, dups, existing => {
            if (!confirm(`Link existing contact "${displayName(existing)}" instead?`)) return;
            onDone();
          });
        }, 500);
      };
      ['crm-first','crm-last','crm-email','crm-mobile'].forEach(cls => {
        drawer.querySelector(`.${cls}`)?.addEventListener('input', checkDups);
      });
    }

    // Save
    drawer.querySelector('.crm-save-btn').addEventListener('click', async () => {
      const first = drawer.querySelector('.crm-first').value.trim();
      if (!first) { drawer.querySelector('.crm-first').focus(); return; }
      const sourceVal = readSourceField(drawer);
      const data = {
        first_name:      first,
        last_name:       drawer.querySelector('.crm-last').value.trim(),
        mobile:          drawer.querySelector('.crm-mobile').value.trim(),
        email:           drawer.querySelector('.crm-email').value.trim(),
        organisation_id: selectedOrgId,
        source:          sourceVal || prefill?.source || 'Other',
      };
      if (isEdit) {
        await apiPut({ id: prefill.id, ...data });
      } else {
        await apiPost(data);
      }
      onDone();
    });

    // Delete (edit only)
    drawer.querySelector('.crm-delete-btn')?.addEventListener('click', async () => {
      if (!confirm(`Permanently delete ${displayName(prefill)}? This cannot be undone.`)) return;
      await apiDelete({ id: prefill.id });
      onDone();
    });
  }

  // ── Organisations pane ─────────────────────────────────────────────────────

  async function loadOrgsPane() {
    const pane = container.querySelector('#crm-pane-organisations');
    pane.innerHTML = `
      <div class="crm-pane-toolbar">
        <input class="kb-input crm-view-search" id="orgSearchInput" placeholder="Search organisations…">
        <button class="crm-view-add-btn" id="orgAddBtn">+ New Organisation</button>
      </div>
      <div class="crm-contact-table-wrap">
        <table class="crm-contact-table">
          <thead><tr><th>Organisation</th><th>Contacts</th><th></th></tr></thead>
          <tbody id="crmOrgTableBody"><tr><td colspan="3" class="crm-loading">Loading…</td></tr></tbody>
        </table>
      </div>`;

    let orgSearch = '';
    pane.querySelector('#orgSearchInput').addEventListener('input', e => {
      orgSearch = e.target.value;
      fetchOrgs(orgSearch);
    });

    pane.querySelector('#orgAddBtn').addEventListener('click', () => {
      openDrawer(drawer => renderOrgDrawer(drawer, null, () => { closeDrawer(); loadOrgsPane(); }));
    });

    async function fetchOrgs(q = '') {
      const tbody = pane.querySelector('#crmOrgTableBody');
      tbody.innerHTML = `<tr><td colspan="3" class="crm-loading">Loading…</td></tr>`;
      const params = { all_orgs: '1' };
      if (q) params.org_search = q;
      const orgs = await apiGet(params).catch(() => []);
      if (!orgs.length) { tbody.innerHTML = `<tr><td colspan="3" class="crm-empty">No organisations found</td></tr>`; return; }
      tbody.innerHTML = '';
      orgs.forEach(org => {
        const tr = document.createElement('tr');
        tr.className = 'crm-contact-tr';
        tr.innerHTML = `
          <td class="crm-td-name"><strong>${org.name}</strong></td>
          <td>${org.contact_count ?? '—'}</td>
          <td class="crm-td-actions">
            <button class="crm-view-edit-btn" title="Edit">✎</button>
            <button class="crm-view-delete-btn" title="Delete" style="color:#c0392b">🗑</button>
          </td>`;
        // Click on name → open drawer in view mode
        tr.querySelector('.crm-td-name').addEventListener('click', () => {
          openDrawer(drawer => renderOrgDrawer(drawer, org, () => { closeDrawer(); fetchOrgs(orgSearch); }));
        });
        // ✎ → open drawer, will go straight to edit mode via handler below
        tr.querySelector('.crm-view-edit-btn').addEventListener('click', (e) => {
          e.stopPropagation();
          openDrawer(drawer => renderOrgDrawer(drawer, { ...org, _startInEditMode: true }, () => { closeDrawer(); fetchOrgs(orgSearch); }));
        });
        tr.querySelector('.crm-view-delete-btn').addEventListener('click', async (e) => {
          e.stopPropagation();
          if (!confirm(`Delete organisation "${org.name}"?`)) return;
          await apiDelete({ org_id: org.id });
          fetchOrgs(orgSearch);
        });
        tbody.appendChild(tr);
      });
    }

    fetchOrgs();
  }

  async function renderOrgDrawer(drawer, prefill, onDone) {
    const isEdit = !!prefill?.id;
    let editMode = !isEdit || !!prefill?._startInEditMode;   // new orgs or ✎ click start in edit mode

    async function render() {
      drawer.innerHTML = '<div class="crm-drawer-loading">Loading…</div>';

      const [orgContacts, allContacts] = isEdit ? await Promise.all([
        apiGet({ org_contacts: prefill.id }).catch(() => []),
        apiGet({ all: '1', limit: 200 }).then(d => d.contacts || d).catch(() => []),
      ]) : [[], []];

      // Contacts not already in this org
      const orgContactIds = new Set(orgContacts.map(c => c.id));
      const available = Array.isArray(allContacts) ? allContacts.filter(c => !orgContactIds.has(c.id)) : [];

      const orgName    = prefill?.name    || '';
      const orgPhone   = prefill?.phone   || '';
      const orgEmail   = prefill?.email   || '';
      const orgWebsite = prefill?.website || '';

      // ── Details section: read mode vs edit mode ────────────────────────────
      const detailsHtml = editMode ? `
        <div class="crm-drawer-section">
          <div class="crm-drawer-section-title">${isEdit ? 'Edit Organisation' : 'New Organisation'}</div>
          <div class="crm-form-row">
            <div class="kb-field-wrap" style="flex:1">
              <label class="kb-field-label">Name *</label>
              <input class="kb-input crm-org-name" type="text" placeholder="e.g. Ray White Parramatta" value="${orgName}">
            </div>
          </div>
          <div class="crm-form-row">
            <div class="kb-field-wrap" style="flex:1">
              <label class="kb-field-label">Phone</label>
              <input class="kb-input crm-org-phone" type="text" placeholder="02 xxxx xxxx" value="${orgPhone}">
            </div>
            <div class="kb-field-wrap" style="flex:1">
              <label class="kb-field-label">Email</label>
              <input class="kb-input crm-org-email" type="text" placeholder="info@example.com" value="${orgEmail}">
            </div>
          </div>
          <div class="crm-form-row">
            <div class="kb-field-wrap" style="flex:1">
              <label class="kb-field-label">Website</label>
              <input class="kb-input crm-org-website" type="text" placeholder="https://example.com" value="${orgWebsite}">
            </div>
          </div>
          <div style="display:flex;gap:8px;margin-top:12px">
            <button class="crm-org-save-btn kb-add-offer-btn">${isEdit ? 'Save Changes' : 'Create'}</button>
            ${isEdit ? '<button class="crm-org-edit-cancel">Cancel</button>' : ''}
          </div>
        </div>
      ` : `
        <div class="crm-drawer-section">
          <div class="crm-drawer-section-title" style="display:flex;justify-content:space-between;align-items:center">
            Organisation Details
            <button class="crm-org-edit-btn kb-add-offer-btn">✎ Edit</button>
          </div>
          <div class="crm-detail-grid">
            ${orgPhone   ? `<div class="crm-detail-label">Phone</div><div><a href="tel:${orgPhone}" class="crm-link">${orgPhone}</a></div>` : ''}
            ${orgEmail   ? `<div class="crm-detail-label">Email</div><div><a href="mailto:${orgEmail}" class="crm-link">${orgEmail}</a></div>` : ''}
            ${orgWebsite ? `<div class="crm-detail-label">Website</div><div><a href="${orgWebsite.startsWith('http') ? orgWebsite : 'https://' + orgWebsite}" target="_blank" rel="noopener" class="crm-link">${orgWebsite}</a></div>` : ''}
            ${!orgPhone && !orgEmail && !orgWebsite ? '<div style="grid-column:1/-1;color:var(--text-secondary);font-size:12px">No contact details yet — click Edit to add.</div>' : ''}
          </div>
        </div>
      `;

      drawer.innerHTML = `
        <div class="crm-drawer-header">
          <div>
            <div class="crm-drawer-title">${orgName || 'New Organisation'}</div>
            ${isEdit ? `<div class="crm-drawer-subtitle">${orgContacts.length} contact${orgContacts.length === 1 ? '' : 's'}</div>` : ''}
          </div>
          <button class="crm-drawer-close">✕</button>
        </div>
        <div class="crm-drawer-body">

          ${detailsHtml}

          ${isEdit ? `
          <div class="crm-drawer-section">
            <div class="crm-drawer-section-title" style="display:flex;justify-content:space-between;align-items:center">
              Contacts (${orgContacts.length})
              <button class="crm-org-add-contact-btn kb-add-offer-btn">+ Add Contact</button>
            </div>
            <div class="crm-org-add-contact-form" style="display:none;margin-bottom:8px">
              <div style="display:flex;gap:6px;align-items:center">
                <select class="kb-input crm-org-contact-select" style="flex:1;font-size:12px">
                  <option value="">Select contact…</option>
                  ${available.map(c => `<option value="${c.id}">${displayName(c)}${c.org_name ? ' · ' + c.org_name : ''}</option>`).join('')}
                </select>
                <button class="crm-org-contact-link-save kb-add-offer-btn">Add</button>
                <button class="crm-org-contact-link-cancel">Cancel</button>
              </div>
            </div>
            <div id="crmOrgContactsList">
              ${orgContacts.length ? orgContacts.map(c => `
                <div class="crm-org-contact-row" data-contact-id="${c.id}">
                  <div class="crm-org-contact-info">
                    <span class="crm-org-contact-name" data-contact-id="${c.id}">${displayName(c)}</span>
                    <span class="crm-org-contact-meta">${[c.mobile, c.email].filter(Boolean).join(' · ')}</span>
                  </div>
                  <button class="crm-org-contact-remove" data-contact-id="${c.id}" title="Remove from org">✕</button>
                </div>`).join('') : '<div class="crm-empty">No contacts in this organisation</div>'}
            </div>
          </div>` : ''}

        </div>`;

      // ── Handlers ───────────────────────────────────────────────────────────
      drawer.querySelector('.crm-drawer-close').addEventListener('click', onDone);

      // Enter edit mode (existing org)
      drawer.querySelector('.crm-org-edit-btn')?.addEventListener('click', () => {
        editMode = true;
        render();
      });

      // Cancel edit (existing org)
      drawer.querySelector('.crm-org-edit-cancel')?.addEventListener('click', () => {
        editMode = false;
        render();
      });

      // Save (create or update)
      drawer.querySelector('.crm-org-save-btn')?.addEventListener('click', async () => {
        const name    = drawer.querySelector('.crm-org-name').value.trim();
        const phone   = drawer.querySelector('.crm-org-phone').value.trim();
        const email   = drawer.querySelector('.crm-org-email').value.trim();
        const website = drawer.querySelector('.crm-org-website').value.trim();
        if (!name) { drawer.querySelector('.crm-org-name').focus(); return; }
        try {
          if (isEdit) {
            await apiPut({ org_id: prefill.id, name, phone, email, website });
            prefill.name    = name;
            prefill.phone   = phone;
            prefill.email   = email;
            prefill.website = website;
            editMode = false;
            render();
          } else {
            await apiPost({ action: 'create_org', name, phone, email, website });
            onDone();
          }
        } catch (err) {
          alert('Save failed: ' + (err.message || 'unknown error'));
        }
      });

      if (!isEdit) return;

      // Add contact to org
      const addContactBtn  = drawer.querySelector('.crm-org-add-contact-btn');
      const addContactForm = drawer.querySelector('.crm-org-add-contact-form');
      addContactBtn?.addEventListener('click', () => { addContactForm.style.display = ''; addContactBtn.style.display = 'none'; });
      drawer.querySelector('.crm-org-contact-link-cancel')?.addEventListener('click', () => { addContactForm.style.display = 'none'; addContactBtn.style.display = ''; });
      drawer.querySelector('.crm-org-contact-link-save')?.addEventListener('click', async () => {
        const contactId = drawer.querySelector('.crm-org-contact-select').value;
        if (!contactId) return;
        await apiPost({ action: 'set_org', contact_id: parseInt(contactId), organisation_id: prefill.id });
        render();
      });

      // Remove contact from org
      drawer.querySelectorAll('.crm-org-contact-remove').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm('Remove this contact from the organisation?')) return;
          await apiPost({ action: 'set_org', contact_id: parseInt(btn.dataset.contactId), organisation_id: null });
          render();
        });
      });

      // Click contact name → open contact detail (same drawer as the contacts list)
      drawer.querySelectorAll('.crm-org-contact-name').forEach(el => {
        el.addEventListener('click', () => {
          renderContactDetail(drawer, parseInt(el.dataset.contactId), () => render());
        });
      });
    }

    render();
  }

  // Initial load
  loadContactsPane();
}
