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
  // Property-scope — belongs to the property itself across deals
  { value: 'vendor',           label: 'Vendor',           scopes: ['property'] },
  { value: 'owner',            label: 'Owner',            scopes: ['property'] },
  { value: 'property_manager', label: 'Property Manager', scopes: ['property'] },
  // Deal-scope — specific to a given deal
  { value: 'agent',            label: 'Agent',            scopes: ['deal'] },
  { value: 'buyers_agent',     label: "Buyer's Agent",    scopes: ['deal'] },
  { value: 'purchaser',        label: 'Purchaser',        scopes: ['deal'] },
  { value: 'enquirer',         label: 'Enquirer',         scopes: ['deal'] },
  // Mixed-scope — can be linked to either
  { value: 'solicitor',        label: 'Solicitor',        scopes: ['property', 'deal'] },
  { value: 'referrer',         label: 'Referrer',         scopes: ['property', 'deal'] },
];
function rolesForScope(scope) {
  return ROLES.filter(r => r.scopes.includes(scope));
}
function roleLabel(id) {
  const r = ROLES.find(x => x.value === id);
  return r ? r.label : id;
}

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
    // V75.3: unified notes API — combined feed where contact is the entity OR is tagged
    const notes = await fetch(`/api/notes?by_contact=${encodeURIComponent(contactId)}`)
      .then(r => r.ok ? r.json() : [])
      .catch(() => []);
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
        const src = n.source_label ? ` <span class="crm-note-prop">· ${n.source_label}</span>` : '';
        const author = n.author_name || 'Unknown';
        entry.innerHTML = `
          <div class="crm-note-meta">
            <span class="crm-note-date">${formatNoteDate(n.created_at)} · by ${author}${src}</span>
            <button class="crm-note-delete" data-id="${n.id}">✕</button>
          </div>
          <div class="crm-note-text">${n.note_text}</div>`;
        entry.querySelector('.crm-note-delete').addEventListener('click', async () => {
          await fetch(`/api/notes?id=${encodeURIComponent(n.id)}`, { method: 'DELETE' });
          loadNotes();
        });
        listEl.appendChild(entry);
      });
    }

    panel.querySelector('.crm-note-add-btn').addEventListener('click', async () => {
      const input = panel.querySelector('.crm-note-input');
      const text = input.value.trim();
      if (!text) return;
      // Panel is rendered from the agent-side CRM section of the pipeline
      // modal. The note is attached to the deal (pipelineId) when present,
      // otherwise to the contact.
      const entity_type = pipelineId ? 'deal'        : 'contact';
      const entity_id   = pipelineId ? String(pipelineId) : String(contactId);
      const tagged_contact_id = pipelineId ? contactId : null;
      await fetch('/api/notes', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entity_type, entity_id, note_text: text, tagged_contact_id }),
      });
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
        <span class="crm-view-title"><svg class="module-header-icon"><use href="#icon-crm"/></svg> CRM</span>
        <div class="crm-view-tabs">
          <button class="crm-tab active" data-tab="contacts">Contacts</button>
          <button class="crm-tab"        data-tab="properties">Properties</button>
          <button class="crm-tab"        data-tab="parcels">Parcels</button>
          <button class="crm-tab"        data-tab="organisations">Organisations</button>
        </div>
        <button class="crm-view-add-btn" id="crmViewAddBtn">+ New Contact</button>
      </div>
      <div class="crm-view-body">
        <div class="crm-tab-pane active" id="crm-pane-contacts"></div>
        <div class="crm-tab-pane"        id="crm-pane-properties"></div>
        <div class="crm-tab-pane"        id="crm-pane-parcels"></div>
        <div class="crm-tab-pane"        id="crm-pane-organisations"></div>
      </div>
    </div>
    <div class="crm-modal-overlay" id="crmModalOverlay" style="display:none">
      <div class="crm-modal" id="crmModal"></div>
    </div>`;

  // Add-button label/handler per tab
  function configureAddButton(tabName) {
    const btn = container.querySelector('#crmViewAddBtn');
    if (tabName === 'contacts') {
      btn.textContent = '+ New Contact';
      btn.style.display = '';
      btn.onclick = () => openModal(modal => renderContactModal(modal, null, () => { closeModal(); loadContactsPane(); }));
    } else if (tabName === 'organisations') {
      btn.textContent = '+ New Organisation';
      btn.style.display = '';
      btn.onclick = () => openModal(modal => renderOrgModal(modal, null, () => { closeModal(); loadOrgsPane(); }));
    } else {
      // Properties and Parcels don't support direct create from the CRM in V75.4
      // — they're created via map ⌘-click or by adding a pipeline deal.
      btn.style.display = 'none';
      btn.onclick = null;
    }
  }

  // Tab switching
  container.querySelectorAll('.crm-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      container.querySelectorAll('.crm-tab').forEach(t => t.classList.remove('active'));
      container.querySelectorAll('.crm-tab-pane').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      container.querySelector(`#crm-pane-${tab.dataset.tab}`).classList.add('active');
      configureAddButton(tab.dataset.tab);
      if (tab.dataset.tab === 'contacts')      loadContactsPane();
      if (tab.dataset.tab === 'properties')    loadPropertiesPane();
      if (tab.dataset.tab === 'parcels')       loadParcelsPane();
      if (tab.dataset.tab === 'organisations') loadOrgsPane();
    });
  });

  // Modal helpers
  function openModal(renderFn) {
    const overlay = container.querySelector('#crmModalOverlay');
    const modal  = container.querySelector('#crmModal');
    overlay.style.display = '';
    renderFn(modal);
    overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(); }, { once: true });
  }
  function closeModal() {
    const overlay = container.querySelector('#crmModalOverlay');
    overlay.style.display = 'none';
    container.querySelector('#crmModal').innerHTML = '';
  }
  window._crmCloseModal = closeModal;

  // + Add button wired by configureAddButton() based on active tab
  configureAddButton('contacts');

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
          openModal(modal => renderContactDetail(modal, c.id, () => { closeModal(); fetchContacts(); }));
        });
        tr.querySelector('.crm-view-edit-btn').addEventListener('click', e => {
          e.stopPropagation();
          openModal(modal => renderContactModal(modal, c, () => { closeModal(); fetchContacts(); }));
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

  // ── Contact detail modal ──────────────────────────────────────────────────

  async function renderContactDetail(modal, contactId, onDone) {
    modal.innerHTML = '<div class="crm-modal-loading">Loading…</div>';
    try {
      const [contactData, notes, props, allPipeline, me] = await Promise.all([
        apiGet({ id: contactId }),
        fetch(`/api/notes?by_contact=${encodeURIComponent(contactId)}`).then(r => r.ok ? r.json() : []).catch(() => []),
        apiGet({ contact_properties: '1', contact_id: contactId }).catch(() => []),
        apiGet({ pipeline_list: '1' }).catch(() => []),
        fetch('/api/auth/me').then(r => r.json()).catch(() => ({ authenticated: false })),
      ]);
      const c = Array.isArray(contactData) ? contactData[0] : contactData;
      if (!c) { modal.innerHTML = '<div class="crm-modal-loading">Not found</div>'; return; }

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

      // V75.2d — Split legacy "Linked Properties" into two sections based on
      // entity_type. The backend's contact_properties query returns both.
      const propLinks = Array.isArray(props) ? props.filter(p => p.entity_type === 'property') : [];
      const dealLinks = Array.isArray(props) ? props.filter(p => p.entity_type === 'deal')     : [];

      // Stage label map — used in Deals section badges
      const dealStageLabels = {
        'shortlisted': 'Shortlisted',
        'under-dd':    'Under DD',
        'offer':       'Offer',
        'acquired':    'Acquired',
        'not-proceeded': 'Not Proceeded',
        'archived':    'Archived',
      };
      const workflowLabels = {
        'acquisition': 'Acquisition',
        'buyer_enquiry': 'Enquiry',
        'agency_sales': 'Listing',
      };

      // Site Access section — only rendered when viewer is admin OR viewing self.
      // V75.2d — now collapsible; defaults to COLLAPSED.
      const siteAccessHtml = (canManage || isSelf) ? `
        <div class="crm-modal-section crm-section-collapsible" data-section="site-access" data-collapsed="1">
          <div class="crm-modal-section-title crm-section-header">
            <span class="crm-section-header-left"><span class="crm-section-chev">▸</span> Site Access</span>
            <button class="crm-access-pw-btn kb-add-offer-btn" ${canChangePw ? '' : 'disabled'}>
              ${hasPassword ? (isSelf && !canManage ? 'Change my password' : 'Reset password') : 'Set password'}
            </button>
          </div>
          <div class="crm-section-body" style="display:none">
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
                <button class="crm-access-pw-cancel crm-cancel-btn">Cancel</button>
              </div>
            </div>
          </div>
        </div>` : '';

      modal.innerHTML = `
        <div class="crm-modal-header">
          <div>
            <div class="crm-modal-title">${displayName(c)}</div>
            <div class="crm-modal-subtitle">${[c.org_name, c.mobile, c.email].filter(Boolean).join(" · ")}</div>
          </div>
          <div style="display:flex;gap:8px;align-items:center">
            <button class="crm-modal-edit-btn kb-add-offer-btn">✎ Edit</button>
            <button class="crm-modal-close">✕</button>
          </div>
        </div>
        <div class="crm-modal-body">

          <div class="crm-modal-section">
            <div class="crm-modal-section-title">Contact Details</div>
            <div class="crm-detail-grid">
              ${c.mobile   ? `<div class="crm-detail-label">Mobile</div><div><a href="tel:${c.mobile}" class="crm-link">${c.mobile}</a></div>` : ""}
              ${c.email    ? `<div class="crm-detail-label">Email</div><div><a href="mailto:${c.email}" class="crm-link">${c.email}</a></div>` : ""}
              ${c.org_name ? `<div class="crm-detail-label">Organisation</div><div>${c.org_name}</div>` : ""}
              <div class="crm-detail-label">Source</div><div>${c.source || "manual"}</div>
            </div>
          </div>

          ${siteAccessHtml}

          <div class="crm-modal-section crm-section-collapsible" data-section="linked-properties">
            <div class="crm-modal-section-title crm-section-header">
              <span class="crm-section-header-left"><span class="crm-section-chev">▾</span> Linked Properties <span class="crm-section-count">(${propLinks.length})</span></span>
              <button class="crm-detail-add-prop-btn kb-add-offer-btn">+ Link Property</button>
            </div>
            <div class="crm-section-body">
              <div id="crmDetailPropsList">
                ${propLinks.length ? propLinks.map(p => `
                  <div class="crm-prop-row" data-entity-type="property" data-entity-id="${p.entity_id}">
                    <a href="#" class="crm-prop-open" data-property-id="${p.entity_id}" title="Open property">${p.address || '—'}${p.suburb ? ", " + p.suburb : ""}</a>
                    <select class="crm-prop-role-sel kb-input" data-entity-type="property" data-entity-id="${p.entity_id}" style="font-size:11px;padding:2px 4px;width:auto">
                      ${ROLES.map(r => `<option value="${r.value}" ${r.value === p.role ? "selected" : ""}>${r.label}</option>`).join("")}
                    </select>
                    <button class="crm-prop-unlink-btn" data-entity-type="property" data-entity-id="${p.entity_id}" title="Remove">✕</button>
                  </div>`).join("") : '<div class="crm-empty">No linked properties</div>'}
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
                  <button class="crm-prop-link-cancel crm-cancel-btn">Cancel</button>
                </div>
              </div>
            </div>
          </div>

          <div class="crm-modal-section crm-section-collapsible" data-section="deals">
            <div class="crm-modal-section-title crm-section-header">
              <span class="crm-section-header-left"><span class="crm-section-chev">▾</span> Deals <span class="crm-section-count">(${dealLinks.length})</span></span>
              <button class="crm-detail-add-deal-btn kb-add-offer-btn">+ Link Deal</button>
            </div>
            <div class="crm-section-body">
              <div id="crmDetailDealsList">
                ${dealLinks.length ? dealLinks.map(d => `
                  <div class="crm-deal-row" data-entity-type="deal" data-entity-id="${d.entity_id}">
                    <a href="#" class="crm-deal-open" data-deal-id="${d.entity_id}" title="Open in pipeline">${d.address || d.entity_id}${d.suburb ? ", " + d.suburb : ""}</a>
                    <span class="crm-deal-badge crm-deal-badge-workflow">${workflowLabels[d.workflow] || d.workflow || 'Acquisition'}</span>
                    <span class="crm-deal-badge crm-deal-badge-stage">${dealStageLabels[d.stage] || d.stage || '—'}</span>
                    <select class="crm-prop-role-sel kb-input" data-entity-type="deal" data-entity-id="${d.entity_id}" style="font-size:11px;padding:2px 4px;width:auto">
                      ${ROLES.map(r => `<option value="${r.value}" ${r.value === d.role ? "selected" : ""}>${r.label}</option>`).join("")}
                    </select>
                    <button class="crm-prop-unlink-btn" data-entity-type="deal" data-entity-id="${d.entity_id}" title="Remove">✕</button>
                  </div>`).join("") : '<div class="crm-empty">No deals linked</div>'}
              </div>
              <div class="crm-detail-add-deal-form" style="display:none;margin-top:8px">
                <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
                  <select class="kb-input crm-deal-select" style="flex:2;font-size:12px">
                    <option value="">Select deal…</option>
                    ${allPipeline.map(p => `<option value="${p.id}">${p.address || p.id}${p.suburb ? ", " + p.suburb : ""}</option>`).join("")}
                  </select>
                  <select class="kb-input crm-deal-role-new" style="font-size:12px">
                    ${ROLES.map(r => `<option value="${r.value}">${r.label}</option>`).join("")}
                  </select>
                  <button class="crm-deal-link-save kb-add-offer-btn">Link</button>
                  <button class="crm-deal-link-cancel crm-cancel-btn">Cancel</button>
                </div>
              </div>
            </div>
          </div>

          <div class="crm-modal-section crm-section-collapsible" data-section="notes">
            <div class="crm-modal-section-title crm-section-header">
              <span class="crm-section-header-left"><span class="crm-section-chev">▾</span> Notes <span class="crm-section-count">(${notes.length})</span></span>
              <button class="crm-modal-add-note-btn kb-add-offer-btn">+ Add Note</button>
            </div>
            <div class="crm-section-body">
              <div class="crm-modal-note-input" style="display:none;margin-bottom:10px">
                <textarea class="kb-input crm-modal-note-text" rows="3" placeholder="Add a note…" style="width:100%;resize:vertical;box-sizing:border-box"></textarea>
                <div style="display:flex;gap:6px;margin-top:4px;align-items:center">
                  <button class="crm-modal-note-save kb-add-offer-btn">Save Note</button>
                  <button class="crm-modal-note-cancel crm-cancel-btn">Cancel</button>
                </div>
              </div>
              <div class="crm-modal-notes-list">
                ${notes.length ? notes.map(n => {
                  const author = n.author_name || 'Unknown';
                  const sourceBadge = n.source_label
                    ? `<span class="crm-note-source">${n.source_label}</span>`
                    : '';
                  return `
                  <div class="crm-note-entry" data-note-id="${n.id}">
                    <div class="crm-note-meta">
                      <span class="crm-note-date">${formatNoteDate(n.created_at)} · by ${author}${sourceBadge ? ' · ' + sourceBadge : ''}</span>
                      <button class="crm-note-delete" data-id="${n.id}">✕</button>
                    </div>
                    <div class="crm-note-text">${n.note_text}</div>
                  </div>`;
                }).join("") : '<div class="crm-empty">No notes yet</div>'}
              </div>
            </div>
          </div>

        </div>`;

      modal.querySelector(".crm-modal-close").addEventListener("click", onDone);
      modal.querySelector(".crm-modal-edit-btn").addEventListener("click", () => {
        renderContactModal(modal, c, () => renderContactDetail(modal, contactId, onDone));
      });

      // ── Collapsible sections ─────────────────────────────────────────────
      // Section state is per-render (no persistence); clicking the header
      // toggles the body and chev. Initial collapsed state comes from
      // data-collapsed="1" on the section (set in the HTML above).
      modal.querySelectorAll(".crm-section-collapsible").forEach(section => {
        const header = section.querySelector(".crm-section-header");
        const body   = section.querySelector(".crm-section-body");
        const chev   = section.querySelector(".crm-section-chev");
        const startCollapsed = section.dataset.collapsed === "1";
        if (startCollapsed) {
          body.style.display = "none";
          chev.textContent   = "▸";
        }
        // Toggle on header click — but not when clicking a button/select/etc
        // inside the header (add buttons, role dropdowns, etc. would otherwise
        // collapse the section when used)
        header.addEventListener("click", (e) => {
          if (e.target.closest("button, select, input, textarea, a")) return;
          const isOpen = body.style.display !== "none";
          body.style.display = isOpen ? "none" : "";
          chev.textContent   = isOpen ? "▸" : "▾";
        });
      });

      // ── Linked Properties section (entity_type = 'property') ─────────────
      const addPropBtn  = modal.querySelector(".crm-detail-add-prop-btn");
      const addPropForm = modal.querySelector(".crm-detail-add-prop-form");
      const propsList   = modal.querySelector("#crmDetailPropsList");

      addPropBtn?.addEventListener("click", () => { addPropForm.style.display = ""; addPropBtn.style.display = "none"; });
      modal.querySelector(".crm-prop-link-cancel")?.addEventListener("click", () => { addPropForm.style.display = "none"; addPropBtn.style.display = ""; });
      modal.querySelector(".crm-prop-link-save")?.addEventListener("click", async () => {
        const entityId = modal.querySelector(".crm-prop-select").value;
        const role     = modal.querySelector(".crm-prop-role-new").value;
        if (!entityId) return;
        await apiPost({ action: "link", contact_id: contactId, entity_type: "property", entity_id: entityId, role_id: role });
        renderContactDetail(modal, contactId, onDone);
      });

      // ── Deals section (entity_type = 'deal') ─────────────────────────────
      const addDealBtn  = modal.querySelector(".crm-detail-add-deal-btn");
      const addDealForm = modal.querySelector(".crm-detail-add-deal-form");
      const dealsList   = modal.querySelector("#crmDetailDealsList");

      addDealBtn?.addEventListener("click", () => { addDealForm.style.display = ""; addDealBtn.style.display = "none"; });
      modal.querySelector(".crm-deal-link-cancel")?.addEventListener("click", () => { addDealForm.style.display = "none"; addDealBtn.style.display = ""; });
      modal.querySelector(".crm-deal-link-save")?.addEventListener("click", async () => {
        const entityId = modal.querySelector(".crm-deal-select").value;
        const role     = modal.querySelector(".crm-deal-role-new").value;
        if (!entityId) return;
        await apiPost({ action: "link", contact_id: contactId, entity_type: "deal", entity_id: entityId, role_id: role });
        renderContactDetail(modal, contactId, onDone);
      });

      // Deal row click → open that deal's card modal in the Pipeline module
      dealsList?.querySelectorAll(".crm-deal-open").forEach(link => {
        link.addEventListener("click", (e) => {
          e.preventDefault();
          const dealId = link.dataset.dealId;
          if (window.Router) Router.navigate(`/pipeline/deal/${dealId}`);
        });
      });

      // Property address click → open property modal (V75.4). For now the
      // route is a no-op if CRM.navigateTo isn't defined; falls back to a
      // brief notice so users don't wonder why nothing happened.
      propsList?.querySelectorAll(".crm-prop-open").forEach(link => {
        link.addEventListener("click", (e) => {
          e.preventDefault();
          const propertyId = link.dataset.propertyId;
          if (window.Router) Router.navigate(`/crm/properties/${propertyId}`);
        });
      });

      // Role change on either a property or deal row (same selector class,
      // different entity_type in the dataset)
      modal.querySelectorAll(".crm-prop-role-sel").forEach(sel => {
        sel.addEventListener("change", async () => {
          await apiPost({
            action:      "link",
            contact_id:  contactId,
            entity_type: sel.dataset.entityType,
            entity_id:   sel.dataset.entityId,
            role_id:     sel.value,
          });
        });
      });

      // Unlink — same class used in both sections, entity_type tells us which
      modal.querySelectorAll(".crm-prop-unlink-btn").forEach(btn => {
        btn.addEventListener("click", async () => {
          const what = btn.dataset.entityType === "deal" ? "deal link" : "property link";
          if (!confirm(`Remove this ${what}?`)) return;
          await apiPost({
            action:      "unlink",
            contact_id:  contactId,
            entity_type: btn.dataset.entityType,
            entity_id:   btn.dataset.entityId,
          });
          renderContactDetail(modal, contactId, onDone);
        });
      });

      // Notes (V75.3 — /api/notes)
      const addNoteBtn = modal.querySelector(".crm-modal-add-note-btn");
      const noteInput  = modal.querySelector(".crm-modal-note-input");
      addNoteBtn.addEventListener("click", () => { noteInput.style.display = ""; addNoteBtn.style.display = "none"; modal.querySelector(".crm-modal-note-text").focus(); });
      modal.querySelector(".crm-modal-note-cancel").addEventListener("click", () => { noteInput.style.display = "none"; addNoteBtn.style.display = ""; });
      modal.querySelector(".crm-modal-note-save").addEventListener("click", async () => {
        const text = modal.querySelector(".crm-modal-note-text").value.trim();
        if (!text) return;
        await fetch('/api/notes', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            entity_type: 'contact',
            entity_id:   String(contactId),
            note_text:   text,
            // tagged_contact_id intentionally null — notes written here are
            // attached to THIS contact already; tagging would be redundant
          }),
        });
        renderContactDetail(modal, contactId, onDone);
      });
      modal.querySelectorAll(".crm-note-delete").forEach(btn => {
        btn.addEventListener("click", async () => {
          if (!confirm("Delete this note?")) return;
          await fetch(`/api/notes?id=${encodeURIComponent(btn.dataset.id)}`, { method: 'DELETE' });
          renderContactDetail(modal, contactId, onDone);
        });
      });

      // ── Site Access handlers ───────────────────────────────────────────────
      const statusEl = modal.querySelector(".crm-access-status");
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

      const propmapEl = modal.querySelector(".crm-access-propmap");
      const isAdminEl = modal.querySelector(".crm-access-is-admin");

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
      const pwBtn     = modal.querySelector(".crm-access-pw-btn");
      const pwForm    = modal.querySelector(".crm-access-pw-form");
      const pwCancel  = modal.querySelector(".crm-access-pw-cancel");
      const pwSave    = modal.querySelector(".crm-access-pw-save");
      if (pwBtn && pwForm) {
        pwBtn.addEventListener('click', () => {
          pwForm.style.display = pwForm.style.display === 'none' ? '' : 'none';
        });
      }
      if (pwCancel) {
        pwCancel.addEventListener('click', () => {
          pwForm.style.display = 'none';
          ['.crm-access-pw-current','.crm-access-pw-new','.crm-access-pw-confirm'].forEach(sel => {
            const el = modal.querySelector(sel); if (el) el.value = '';
          });
          setStatus('');
        });
      }
      if (pwSave) {
        pwSave.addEventListener('click', async () => {
          const currentEl = modal.querySelector(".crm-access-pw-current");
          const newEl     = modal.querySelector(".crm-access-pw-new");
          const confirmEl = modal.querySelector(".crm-access-pw-confirm");
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
            setTimeout(() => renderContactDetail(modal, contactId, onDone), 800);
          } catch (err) {
            setStatus(err.message || 'Save failed', true);
          }
        });
      }

    } catch (err) {
      console.error("[CRM] renderContactDetail failed:", err);
      modal.innerHTML = `<div class="crm-modal-loading">Error loading contact</div>`;
    }
  }

    // ── Contact edit/create modal ─────────────────────────────────────────────

  function renderContactModal(modal, prefill, onDone) {
    const isEdit = !!prefill?.id;
    modal.innerHTML = `
      <div class="crm-modal-header">
        <div class="crm-modal-title">${isEdit ? 'Edit Contact' : 'New Contact'}</div>
        <button class="crm-modal-close">✕</button>
      </div>
      <div class="crm-modal-body">
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

    modal.querySelector('.crm-modal-close').addEventListener('click', onDone);
    modal.querySelector('.crm-cancel-btn').addEventListener('click', onDone);

    // Org typeahead
    let selectedOrgId = prefill?.organisation_id || null;
    const orgTA = buildOrgTypeahead(modal.querySelector('.crm-org-wrap'), (id) => { selectedOrgId = id; });
    if (prefill?.org_name) orgTA.setValue(prefill.organisation_id, prefill.org_name);

    // Source field — reveal Other input when selected
    wireSourceField(modal);

    // Duplicate detection (new only)
    if (!isEdit) {
      const dupWrap = modal.querySelector('.crm-duplicate-warning-wrap');
      let dupTimer;
      const checkDups = () => {
        clearTimeout(dupTimer);
        dupTimer = setTimeout(async () => {
          const first  = modal.querySelector('.crm-first').value.trim();
          const last   = modal.querySelector('.crm-last').value.trim();
          const email  = modal.querySelector('.crm-email').value.trim();
          const mobile = modal.querySelector('.crm-mobile').value.trim();
          const dups   = await checkDuplicates(first, last, email, mobile);
          renderDuplicateWarning(dupWrap, dups, existing => {
            if (!confirm(`Link existing contact "${displayName(existing)}" instead?`)) return;
            onDone();
          });
        }, 500);
      };
      ['crm-first','crm-last','crm-email','crm-mobile'].forEach(cls => {
        modal.querySelector(`.${cls}`)?.addEventListener('input', checkDups);
      });
    }

    // Save
    modal.querySelector('.crm-save-btn').addEventListener('click', async () => {
      const first = modal.querySelector('.crm-first').value.trim();
      if (!first) { modal.querySelector('.crm-first').focus(); return; }
      const sourceVal = readSourceField(modal);
      const data = {
        first_name:      first,
        last_name:       modal.querySelector('.crm-last').value.trim(),
        mobile:          modal.querySelector('.crm-mobile').value.trim(),
        email:           modal.querySelector('.crm-email').value.trim(),
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
    modal.querySelector('.crm-delete-btn')?.addEventListener('click', async () => {
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
      openModal(modal => renderOrgModal(modal, null, () => { closeModal(); loadOrgsPane(); }));
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
        // Click on name → open modal in view mode
        tr.querySelector('.crm-td-name').addEventListener('click', () => {
          openModal(modal => renderOrgModal(modal, org, () => { closeModal(); fetchOrgs(orgSearch); }));
        });
        // ✎ → open modal, will go straight to edit mode via handler below
        tr.querySelector('.crm-view-edit-btn').addEventListener('click', (e) => {
          e.stopPropagation();
          openModal(modal => renderOrgModal(modal, { ...org, _startInEditMode: true }, () => { closeModal(); fetchOrgs(orgSearch); }));
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

  async function renderOrgModal(modal, prefill, onDone) {
    const isEdit = !!prefill?.id;
    let editMode = !isEdit || !!prefill?._startInEditMode;   // new orgs or ✎ click start in edit mode

    async function render() {
      modal.innerHTML = '<div class="crm-modal-loading">Loading…</div>';

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
        <div class="crm-modal-section">
          <div class="crm-modal-section-title">${isEdit ? 'Edit Organisation' : 'New Organisation'}</div>
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
            ${isEdit ? '<button class="crm-org-edit-cancel crm-cancel-btn">Cancel</button>' : ''}
          </div>
        </div>
      ` : `
        <div class="crm-modal-section">
          <div class="crm-modal-section-title" style="display:flex;justify-content:space-between;align-items:center">
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

      modal.innerHTML = `
        <div class="crm-modal-header">
          <div>
            <div class="crm-modal-title">${orgName || 'New Organisation'}</div>
            ${isEdit ? `<div class="crm-modal-subtitle">${orgContacts.length} contact${orgContacts.length === 1 ? '' : 's'}</div>` : ''}
          </div>
          <button class="crm-modal-close">✕</button>
        </div>
        <div class="crm-modal-body">

          ${detailsHtml}

          ${isEdit ? `
          <div class="crm-modal-section">
            <div class="crm-modal-section-title" style="display:flex;justify-content:space-between;align-items:center">
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
                <button class="crm-org-contact-link-cancel crm-cancel-btn">Cancel</button>
              </div>
            </div>
            <div id="crmOrgContactsList">
              ${orgContacts.length ? orgContacts.map(c => `
                <div class="crm-prop-row" data-contact-id="${c.id}">
                  <a href="#" class="crm-org-contact-open" data-contact-id="${c.id}" title="Open contact">${displayName(c)}</a>
                  <span class="crm-org-contact-meta">${[c.mobile, c.email].filter(Boolean).join(' · ')}</span>
                  <button class="crm-prop-unlink-btn crm-org-contact-remove" data-contact-id="${c.id}" title="Remove from org">✕</button>
                </div>`).join('') : '<div class="crm-empty">No contacts in this organisation</div>'}
            </div>
          </div>` : ''}

        </div>`;

      // ── Handlers ───────────────────────────────────────────────────────────
      modal.querySelector('.crm-modal-close').addEventListener('click', onDone);

      // Enter edit mode (existing org)
      modal.querySelector('.crm-org-edit-btn')?.addEventListener('click', () => {
        editMode = true;
        render();
      });

      // Cancel edit (existing org)
      modal.querySelector('.crm-org-edit-cancel')?.addEventListener('click', () => {
        editMode = false;
        render();
      });

      // Save (create or update)
      modal.querySelector('.crm-org-save-btn')?.addEventListener('click', async () => {
        const name    = modal.querySelector('.crm-org-name').value.trim();
        const phone   = modal.querySelector('.crm-org-phone').value.trim();
        const email   = modal.querySelector('.crm-org-email').value.trim();
        const website = modal.querySelector('.crm-org-website').value.trim();
        if (!name) { modal.querySelector('.crm-org-name').focus(); return; }
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
      const addContactBtn  = modal.querySelector('.crm-org-add-contact-btn');
      const addContactForm = modal.querySelector('.crm-org-add-contact-form');
      addContactBtn?.addEventListener('click', () => { addContactForm.style.display = ''; addContactBtn.style.display = 'none'; });
      modal.querySelector('.crm-org-contact-link-cancel')?.addEventListener('click', () => { addContactForm.style.display = 'none'; addContactBtn.style.display = ''; });
      modal.querySelector('.crm-org-contact-link-save')?.addEventListener('click', async () => {
        const contactId = modal.querySelector('.crm-org-contact-select').value;
        if (!contactId) return;
        await apiPost({ action: 'set_org', contact_id: parseInt(contactId), organisation_id: prefill.id });
        render();
      });

      // Remove contact from org
      modal.querySelectorAll('.crm-org-contact-remove').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm('Remove this contact from the organisation?')) return;
          await apiPost({ action: 'set_org', contact_id: parseInt(btn.dataset.contactId), organisation_id: null });
          render();
        });
      });

      // Click contact name → open contact detail (same modal as the contacts list)
      modal.querySelectorAll('.crm-org-contact-open').forEach(el => {
        el.addEventListener('click', (e) => {
          e.preventDefault();
          renderContactDetail(modal, parseInt(el.dataset.contactId), () => render());
        });
      });
    }

    render();
  }

  // ── Parcels pane (V75.4) ───────────────────────────────────────────────────

  let parcelSearch = '';

  async function loadParcelsPane() {
    const pane = container.querySelector('#crm-pane-parcels');
    pane.innerHTML = `
      <div class="crm-pane-toolbar">
        <input class="kb-input crm-view-search" placeholder="Search parcels…" value="${parcelSearch}">
      </div>
      <div class="crm-contact-table-wrap">
        <table class="crm-contact-table">
          <thead><tr>
            <th>Title</th>
            <th>Properties</th>
            <th>Active Deal</th>
            <th>Not Suitable</th>
            <th></th>
          </tr></thead>
          <tbody id="crmParcelTableBody"><tr><td colspan="5" class="crm-loading">Loading…</td></tr></tbody>
        </table>
      </div>`;

    pane.querySelector('.crm-view-search').addEventListener('input', e => {
      parcelSearch = e.target.value;
      renderParcelRows();
    });

    await renderParcelRows();
  }

  // Cache so search is instant (parcel counts stay small)
  let _parcelsCache = null;
  async function renderParcelRows() {
    const pane  = container.querySelector('#crm-pane-parcels');
    const tbody = pane?.querySelector('#crmParcelTableBody');
    if (!tbody) return;

    try {
      if (!_parcelsCache) {
        const [parcels, deals] = await Promise.all([
          fetch('/api/parcels').then(r => r.ok ? r.json() : []).catch(() => []),
          fetch('/api/deals').then(r => r.ok ? r.json() : []).catch(() => []),
        ]);
        // Index deals by parcel_id to find the active deal quickly
        const dealsByParcel = {};
        for (const d of deals) {
          if (!d.parcel_id) continue;
          (dealsByParcel[d.parcel_id] ||= []).push(d);
        }
        _parcelsCache = parcels.map(p => {
          const pDeals = dealsByParcel[p.id] || [];
          const active = pDeals.find(d => d.status === 'active') || null;
          return {
            ...p,
            _deals:       pDeals,
            _activeDeal:  active,
          };
        });
      }

      const q = parcelSearch.trim().toLowerCase();
      const rows = q
        ? _parcelsCache.filter(p => (p.name || '').toLowerCase().includes(q))
        : _parcelsCache;

      if (!rows.length) {
        tbody.innerHTML = `<tr><td colspan="5" class="crm-empty">${q ? 'No parcels match' : 'No parcels yet'}</td></tr>`;
        return;
      }

      tbody.innerHTML = '';
      const now = Date.now();
      for (const p of rows) {
        const tr = document.createElement('tr');
        tr.className = 'crm-contact-tr';
        const count = p.property_count || 0;
        const stageBadge = p._activeDeal
          ? `<span class="crm-deal-badge crm-deal-badge-stage">${p._activeDeal.stage}</span>`
          : '<span style="color:var(--text-secondary);font-size:12px">No active</span>';
        // Not-suitable can be timestamptz (future) or 'infinity' for permanent
        let nsBadge = '—';
        if (p.not_suitable_until) {
          const t = p.not_suitable_until === 'infinity' || String(p.not_suitable_until).includes('infinity')
            ? null
            : new Date(p.not_suitable_until).getTime();
          const active = t === null || (t && t > now);
          if (active) {
            const label = t === null ? 'Permanent' : `Until ${new Date(p.not_suitable_until).toLocaleDateString()}`;
            nsBadge = `<span class="listing-ns-badge">${label}</span>`;
          }
        }
        tr.innerHTML = `
          <td class="crm-td-name"><strong>${p.name || p.id}</strong></td>
          <td>${count}</td>
          <td>${stageBadge}</td>
          <td>${nsBadge}</td>
          <td class="crm-td-actions"></td>`;
        tr.querySelector('.crm-td-name').addEventListener('click', () => {
          openModal(modal => renderParcelModal(modal, p.id, () => {
            closeModal();
            _parcelsCache = null;       // invalidate cache on close
            renderParcelRows();
          }));
        });
        tbody.appendChild(tr);
      }
    } catch (err) {
      console.error('[parcels] fetch failed:', err);
      tbody.innerHTML = `<tr><td colspan="5" class="crm-empty">Failed to load parcels</td></tr>`;
    }
  }

  // ── Parcel modal (V75.4) ───────────────────────────────────────────────────

  async function renderParcelModal(modal, parcelId, onDone) {
    modal.innerHTML = '<div class="crm-modal-loading">Loading…</div>';
    try {
      const [parcel, parcelDeals, parcelContacts, parcelNotes] = await Promise.all([
        fetch(`/api/parcels?id=${encodeURIComponent(parcelId)}&expand=properties`).then(r => r.ok ? r.json() : null),
        fetch(`/api/deals?parcel_id=${encodeURIComponent(parcelId)}`).then(r => r.ok ? r.json() : []).catch(() => []),
        fetch(`/api/contacts?entity_type=parcel&entity_id=${encodeURIComponent(parcelId)}`).then(r => r.ok ? r.json() : []).catch(() => []),
        fetch(`/api/notes?entity_type=parcel&entity_id=${encodeURIComponent(parcelId)}`).then(r => r.ok ? r.json() : []).catch(() => []),
      ]);
      if (!parcel) { modal.innerHTML = '<div class="crm-modal-loading">Not found</div>'; return; }

      const props   = Array.isArray(parcel.properties) ? parcel.properties : [];
      const title   = parcel.name || (window.formatParcelTitle ? window.formatParcelTitle(props) : parcel.id);
      const totalArea = props.reduce((s, p) => s + (p.area_sqm || 0), 0);
      const suburbs  = [...new Set(props.map(p => p.suburb).filter(Boolean))];

      // Active deal detection for the smart-button section header
      const activeDeal = parcelDeals.find(d => d.status === 'active') || null;
      const closedCount = parcelDeals.filter(d => d.status !== 'active').length;

      // Not-suitable state
      const nsRaw = parcel.not_suitable_until;
      const nsActive = !!(nsRaw && (String(nsRaw).includes('infinity') || new Date(nsRaw).getTime() > Date.now()));
      const nsLabel = !nsActive ? '' :
        (String(nsRaw).includes('infinity') ? 'Permanent' : `Until ${new Date(nsRaw).toLocaleDateString()}`);

      // Deal stage labels
      const workflowLabels = { acquisition: 'Acquisition', buyer_enquiry: 'Enquiry', agency_sales: 'Listing' };

      modal.innerHTML = `
        <div class="crm-modal-header">
          <div>
            <div class="crm-modal-title">${title}</div>
            <div class="crm-modal-subtitle">${props.length} propert${props.length === 1 ? 'y' : 'ies'}${totalArea ? ' · ' + Math.round(totalArea).toLocaleString() + ' m²' : ''}${suburbs.length > 0 ? ' · ' + suburbs.join(', ') : ''}</div>
          </div>
          <button class="crm-modal-close">✕</button>
        </div>
        <div class="crm-modal-body">

          <div class="crm-modal-section crm-section-collapsible" data-section="details">
            <div class="crm-modal-section-title crm-section-header">
              <span class="crm-section-header-left"><span class="crm-section-chev">▾</span> Parcel Details</span>
            </div>
            <div class="crm-section-body">
              <div class="crm-detail-grid">
                <div class="crm-detail-label">Parcel Name</div>
                <div>
                  <input class="kb-input crm-parcel-name-input" type="text" value="${(parcel.name || '').replace(/"/g,'&quot;')}" placeholder="${title}" style="width:100%;box-sizing:border-box;font-size:13px">
                </div>
                <div class="crm-detail-label">Merged Title</div><div>${title}</div>
                <div class="crm-detail-label">Total Area</div><div>${totalArea ? Math.round(totalArea).toLocaleString() + ' m²' : '—'}</div>
                <div class="crm-detail-label">Parcel ID</div><div><code style="font-size:11px">${parcel.id}</code></div>
              </div>
              <div style="margin-top:8px"><button class="crm-parcel-name-save kb-add-offer-btn" style="display:none">Save Name</button></div>
            </div>
          </div>

          <div class="crm-modal-section crm-section-collapsible" data-section="not-suitable" ${nsActive ? '' : 'data-collapsed="1"'}>
            <div class="crm-modal-section-title crm-section-header">
              <span class="crm-section-header-left"><span class="crm-section-chev">${nsActive ? '▾' : '▸'}</span> Not Suitable ${nsActive ? `<span class="listing-ns-badge" style="margin-left:6px">${nsLabel}</span>` : ''}</span>
            </div>
            <div class="crm-section-body" ${nsActive ? '' : 'style="display:none"'}>
              ${nsActive ? `
                <div style="margin-bottom:8px">Flagged as not suitable · <strong>${nsLabel}</strong></div>
                ${parcel.not_suitable_reason ? `<div class="crm-detail-label" style="margin-bottom:4px">Reason</div><div style="margin-bottom:8px">${parcel.not_suitable_reason}</div>` : ''}
                <button class="crm-parcel-clear-ns-btn kb-add-offer-btn">Clear flag</button>
              ` : `
                <div style="color:var(--text-secondary);font-size:12px;margin-bottom:8px">Not flagged. Use the map pin popup's snooze controls to mark individual properties, or set a parcel-wide flag here.</div>
                <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
                  <select class="kb-input crm-parcel-ns-snooze" style="font-size:12px">
                    <option value="30d">30 days</option>
                    <option value="90d">90 days</option>
                    <option value="6m">6 months</option>
                    <option value="1y">1 year</option>
                    <option value="permanent">Permanent</option>
                  </select>
                  <input class="kb-input crm-parcel-ns-reason" type="text" placeholder="Reason (optional)" style="flex:1;font-size:12px">
                  <button class="crm-parcel-set-ns-btn kb-add-offer-btn">Mark</button>
                </div>
              `}
            </div>
          </div>

          <div class="crm-modal-section crm-section-collapsible" data-section="properties">
            <div class="crm-modal-section-title crm-section-header">
              <span class="crm-section-header-left"><span class="crm-section-chev">▾</span> Properties <span class="crm-section-count">(${props.length})</span></span>
            </div>
            <div class="crm-section-body">
              ${props.length ? props.map((p, i) => `
                <div class="crm-prop-row" data-property-id="${p.id}">
                  <span style="flex-shrink:0;font-size:11px;color:var(--text-secondary);min-width:18px">${i + 1}.</span>
                  <span class="crm-prop-address">${p.address || '—'}${p.suburb ? ', ' + p.suburb : ''}</span>
                  <span style="font-size:11px;color:var(--text-secondary)">${p.lot_dps || ''}</span>
                  <span style="font-size:11px;color:var(--text-secondary)">${p.area_sqm ? Math.round(p.area_sqm).toLocaleString() + ' m²' : ''}</span>
                  <button class="crm-prop-unlink-btn crm-parcel-remove-prop" data-property-id="${p.id}" title="Remove from parcel">✕</button>
                </div>`).join('') : '<div class="crm-empty">No properties — this parcel is orphaned and can be deleted</div>'}
            </div>
          </div>

          <div class="crm-modal-section crm-section-collapsible" data-section="deals">
            <div class="crm-modal-section-title crm-section-header">
              <span class="crm-section-header-left"><span class="crm-section-chev">▾</span> Deals <span class="crm-section-count">(${parcelDeals.length})</span></span>
              ${activeDeal
                ? `<button class="crm-parcel-open-deal-btn kb-add-offer-btn" data-deal-id="${activeDeal.id}">Open Active Deal</button>`
                : `<button class="crm-parcel-new-deal-btn kb-add-offer-btn">+ New Deal${closedCount ? ` <span style="font-weight:400;font-size:10px;color:rgba(255,255,255,0.75)">(history: ${closedCount} closed)</span>` : ''}</button>`
              }
            </div>
            <div class="crm-section-body">
              ${parcelDeals.length ? parcelDeals.map(d => `
                <div class="crm-deal-row">
                  <a href="#" class="crm-deal-open" data-deal-id="${d.id}">${d.id}</a>
                  <span class="crm-deal-badge crm-deal-badge-workflow">${workflowLabels[d.workflow] || d.workflow}</span>
                  <span class="crm-deal-badge crm-deal-badge-stage">${d.stage}</span>
                  <span class="crm-deal-badge crm-deal-badge-stage">${d.status}</span>
                </div>`).join('') : '<div class="crm-empty">No deals on this parcel</div>'}
            </div>
          </div>

          <div class="crm-modal-section crm-section-collapsible" data-section="contacts">
            <div class="crm-modal-section-title crm-section-header">
              <span class="crm-section-header-left"><span class="crm-section-chev">▾</span> Contacts <span class="crm-section-count">(${parcelContacts.length})</span></span>
            </div>
            <div class="crm-section-body">
              ${parcelContacts.length ? parcelContacts.map(c => `
                <div class="crm-prop-row">
                  <a href="#" class="crm-org-contact-open" data-contact-id="${c.id}">${displayName(c)}</a>
                  <span class="crm-org-contact-meta">${[c.mobile, c.email].filter(Boolean).join(' · ')}</span>
                  <span style="font-size:11px;color:var(--text-secondary)">${c.role || ''}</span>
                </div>`).join('') : '<div class="crm-empty">No contacts linked to this parcel</div>'}
            </div>
          </div>

          <div class="crm-modal-section crm-section-collapsible" data-section="notes">
            <div class="crm-modal-section-title crm-section-header">
              <span class="crm-section-header-left"><span class="crm-section-chev">▾</span> Notes <span class="crm-section-count">(${parcelNotes.length})</span></span>
              <button class="crm-parcel-add-note-btn kb-add-offer-btn">+ Add Note</button>
            </div>
            <div class="crm-section-body">
              <div class="crm-parcel-note-input" style="display:none;margin-bottom:10px">
                <textarea class="kb-input crm-parcel-note-text" rows="3" placeholder="Add a note…" style="width:100%;resize:vertical;box-sizing:border-box"></textarea>
                <div style="display:flex;gap:6px;margin-top:4px">
                  <button class="crm-parcel-note-save kb-add-offer-btn">Save Note</button>
                  <button class="crm-parcel-note-cancel crm-cancel-btn">Cancel</button>
                </div>
              </div>
              <div class="crm-parcel-notes-list">
                ${parcelNotes.length ? parcelNotes.map(n => {
                  const author = n.author_name || 'Unknown';
                  const taggedName = [n.tagged_first_name, n.tagged_last_name].filter(Boolean).join(' ').trim();
                  const taggedBadge = taggedName ? ` <span class="kb-note-contact-badge">@${taggedName}</span>` : '';
                  return `
                    <div class="crm-note-entry" data-note-id="${n.id}">
                      <div class="crm-note-meta">
                        <span class="crm-note-date">${formatNoteDate(n.created_at)} · by ${author}${taggedBadge}</span>
                        <button class="crm-note-delete" data-id="${n.id}">✕</button>
                      </div>
                      <div class="crm-note-text">${n.note_text}</div>
                    </div>`;
                }).join('') : '<div class="crm-empty">No notes yet</div>'}
              </div>
            </div>
          </div>

        </div>`;

      // ── Handlers ─────────────────────────────────────────────────────────

      modal.querySelector('.crm-modal-close').addEventListener('click', onDone);

      // Collapsibles (same pattern as contact modal)
      modal.querySelectorAll('.crm-section-collapsible').forEach(section => {
        const header = section.querySelector('.crm-section-header');
        const body   = section.querySelector('.crm-section-body');
        const chev   = section.querySelector('.crm-section-chev');
        const startCollapsed = section.dataset.collapsed === '1';
        if (startCollapsed) { body.style.display = 'none'; chev.textContent = '▸'; }
        header.addEventListener('click', (e) => {
          if (e.target.closest('button, select, input, textarea, a')) return;
          const isOpen = body.style.display !== 'none';
          body.style.display = isOpen ? 'none' : '';
          chev.textContent   = isOpen ? '▸' : '▾';
        });
      });

      // Name save — show button only when input changed from existing
      const nameInput = modal.querySelector('.crm-parcel-name-input');
      const nameSave  = modal.querySelector('.crm-parcel-name-save');
      const origName  = parcel.name || '';
      nameInput.addEventListener('input', () => {
        nameSave.style.display = nameInput.value.trim() !== origName ? '' : 'none';
      });
      nameSave.addEventListener('click', async () => {
        await fetch('/api/parcels', {
          method:  'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: parcel.id, name: nameInput.value.trim() }),
        });
        renderParcelModal(modal, parcelId, onDone);
      });

      // Not-suitable set / clear
      modal.querySelector('.crm-parcel-set-ns-btn')?.addEventListener('click', async () => {
        const snoozeVal = modal.querySelector('.crm-parcel-ns-snooze').value;
        const reason    = modal.querySelector('.crm-parcel-ns-reason').value.trim() || null;
        const until = snoozeVal === 'permanent' ? 'permanent' :
          new Date(Date.now() + ({ '30d': 30, '90d': 90, '6m': 180, '1y': 365 }[snoozeVal] * 86400000)).toISOString();
        await fetch('/api/parcels', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'set_not_suitable', id: parcel.id, until, reason }),
        });
        renderParcelModal(modal, parcelId, onDone);
      });
      modal.querySelector('.crm-parcel-clear-ns-btn')?.addEventListener('click', async () => {
        await fetch('/api/parcels', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'clear_not_suitable', id: parcel.id }),
        });
        renderParcelModal(modal, parcelId, onDone);
      });

      // Remove a property from parcel
      modal.querySelectorAll('.crm-parcel-remove-prop').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm('Remove this property from the parcel? The property will still exist standalone.')) return;
          await fetch('/api/parcels', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'remove_property', id: parcel.id, property_id: btn.dataset.propertyId }),
          });
          renderParcelModal(modal, parcelId, onDone);
        });
      });

      // Deal-row actions
      modal.querySelector('.crm-parcel-open-deal-btn')?.addEventListener('click', (e) => {
        if (window.Router) Router.navigate(`/pipeline/deal/${e.currentTarget.dataset.dealId}`);
      });
      modal.querySelectorAll('.crm-deal-open').forEach(a => {
        a.addEventListener('click', (e) => {
          e.preventDefault();
          if (window.Router) Router.navigate(`/pipeline/deal/${a.dataset.dealId}`);
        });
      });
      modal.querySelector('.crm-parcel-new-deal-btn')?.addEventListener('click', async () => {
        const r = await fetch('/api/deals', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'new_on_parcel', parcel_id: parcel.id }),
        });
        if (r.ok) {
          const d = await r.json();
          if (window.Router) Router.navigate(`/pipeline/deal/${d.id}`);
        }
      });

      // Contact row click → open contact modal
      modal.querySelectorAll('.crm-org-contact-open').forEach(a => {
        a.addEventListener('click', (e) => {
          e.preventDefault();
          const cid = parseInt(a.dataset.contactId);
          renderContactDetail(modal, cid, () => renderParcelModal(modal, parcelId, onDone));
        });
      });

      // Notes add / delete
      const addNoteBtn = modal.querySelector('.crm-parcel-add-note-btn');
      const noteInput  = modal.querySelector('.crm-parcel-note-input');
      addNoteBtn.addEventListener('click', () => { noteInput.style.display = ''; addNoteBtn.style.display = 'none'; modal.querySelector('.crm-parcel-note-text').focus(); });
      modal.querySelector('.crm-parcel-note-cancel').addEventListener('click', () => { noteInput.style.display = 'none'; addNoteBtn.style.display = ''; });
      modal.querySelector('.crm-parcel-note-save').addEventListener('click', async () => {
        const text = modal.querySelector('.crm-parcel-note-text').value.trim();
        if (!text) return;
        await fetch('/api/notes', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ entity_type: 'parcel', entity_id: parcel.id, note_text: text }),
        });
        renderParcelModal(modal, parcelId, onDone);
      });
      modal.querySelectorAll('.crm-note-delete').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm('Delete this note?')) return;
          await fetch(`/api/notes?id=${encodeURIComponent(btn.dataset.id)}`, { method: 'DELETE' });
          renderParcelModal(modal, parcelId, onDone);
        });
      });

    } catch (err) {
      console.error('[renderParcelModal]', err);
      modal.innerHTML = '<div class="crm-modal-loading">Error loading parcel</div>';
    }
  }

  // ── Properties pane (V75.5 placeholder) ────────────────────────────────────

  async function loadPropertiesPane() {
    const pane = container.querySelector('#crm-pane-properties');
    pane.innerHTML = `
      <div style="padding:48px 24px;text-align:center;color:var(--text-secondary);font-size:13px">
        <div style="font-size:18px;margin-bottom:8px">🏡</div>
        <div style="font-weight:500;margin-bottom:4px">Properties tab coming in V75.5</div>
        <div>Individual property records — for aggregated Parcels, see the Parcels tab.</div>
      </div>`;
  }

  // ── Public navigation hook for router deep links ───────────────────────────
  // window.CRM.navigateTo('parcels', 'parcel-123') → switches to Parcels tab
  // and opens the parcel modal. Called from router.js for /crm/parcels/:id and
  // future /crm/contacts/:id, /crm/properties/:id, /crm/organisations/:id.
  window.CRM.navigateTo = (subRoute, entityId) => {
    const tabMap = {
      contacts:      'contacts',
      properties:    'properties',
      parcels:       'parcels',
      organisations: 'organisations',
    };
    const tabName = tabMap[subRoute];
    if (!tabName) return;
    const tabBtn = container.querySelector(`.crm-tab[data-tab="${tabName}"]`);
    if (tabBtn && !tabBtn.classList.contains('active')) tabBtn.click();
    if (!entityId) return;
    // Deep-link: open the relevant modal
    if (tabName === 'contacts') {
      openModal(modal => renderContactDetail(modal, parseInt(entityId), () => closeModal()));
    } else if (tabName === 'parcels') {
      openModal(modal => renderParcelModal(modal, entityId, () => closeModal()));
    }
    // properties + organisations deep-linking lands in V75.5/later
  };

  // Initial load
  loadContactsPane();
}
