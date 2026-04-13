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
            const created = await apiPost({ first_name, last_name, mobile: agentData.phone || '', email: agentData.email || '', organisation_id: orgId, source: 'domain_agent', domain_id: String(pipelineId) });
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
      const roleLabel = ROLES.find(r => r.value === contact.role)?.label || contact.role;
      const roleClass = contact.role.replace(/[^a-z0-9]/gi, '_');
      row.innerHTML = `
        <div class="crm-contact-info">
          <div class="crm-contact-name">
            ${displayName(contact)}
            <span class="crm-role-badge crm-role-${roleClass}">${roleLabel}</span>
          </div>
          <div class="crm-contact-meta">
            ${contact.org_name ? `<span>${contact.org_name}</span>` : ''}
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
            <label class="kb-field-label">Role</label>
            <select class="kb-input crm-role">
              ${ROLES.map(r => `<option value="${r.value}" ${r.value === prefillRole ? 'selected' : ''}>${r.label}</option>`).join('')}
            </select>
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
          renderDuplicateWarning(dupWrap, dups, (existing) => {
            // Link existing contact instead of creating new
            const role = formEl.querySelector('.crm-role').value;
            apiPost({ action: 'link', contact_id: existing.id, pipeline_id: pipelineId, role })
              .then(() => { hideForm(); reload(); });
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
              const role = formEl.querySelector('.crm-role').value;
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
      const data = {
        first_name:      first,
        last_name:       formEl.querySelector('.crm-last').value.trim(),
        mobile:          formEl.querySelector('.crm-mobile').value.trim(),
        email:           formEl.querySelector('.crm-email').value.trim(),
        organisation_id: selectedOrgId,
        source:          prefill.source || 'manual',
        domain_id:       prefill.domain_id || null,
      };
      const role = formEl.querySelector('.crm-role').value;
      if (isEdit) {
        await apiPut({ id: prefill.id, ...data });
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
            <th>Name</th><th>Organisation</th><th>Role</th><th>Mobile</th><th>Email</th><th>Properties</th><th></th>
          </tr></thead>
          <tbody id="crmContactTableBody"><tr><td colspan="7" class="crm-loading">Loading…</td></tr></tbody>
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

    tbody.innerHTML = `<tr><td colspan="7" class="crm-loading">Loading…</td></tr>`;
    try {
      const params = { all: '1', offset: contactPage * PAGE_SIZE, limit: PAGE_SIZE };
      if (contactSearch) params.search = contactSearch;
      const data = await apiGet(params);
      const contacts = Array.isArray(data) ? data : (data.contacts || []);
      const total    = data.total ?? contacts.length;

      if (!contacts.length) {
        tbody.innerHTML = `<tr><td colspan="7" class="crm-empty">No contacts found</td></tr>`;
        if (pagEl) pagEl.innerHTML = '';
        return;
      }

      tbody.innerHTML = '';
      contacts.forEach(c => {
        const tr = document.createElement('tr');
        tr.className = 'crm-contact-tr';
        const roleLabel = ROLES.find(r => r.value === c.role)?.label || c.role || '—';
        const propCount = c.property_count ?? 0;
        tr.innerHTML = `
          <td class="crm-td-name"><strong>${displayName(c)}</strong></td>
          <td>${c.org_name || '—'}</td>
          <td><span class="crm-role-badge crm-role-${(c.role||'').replace(/[^a-z0-9]/gi,'_')}">${roleLabel}</span></td>
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
      if (tbody) tbody.innerHTML = `<tr><td colspan="7" class="crm-empty">Error loading contacts</td></tr>`;
    }
  }

  // ── Contact detail drawer ──────────────────────────────────────────────────

  async function renderContactDetail(drawer, contactId, onDone) {
    drawer.innerHTML = '<div class="crm-drawer-loading">Loading…</div>';
    try {
      const [contactData, notes, props] = await Promise.all([
        apiGet({ id: contactId }),
        apiGet({ notes: '1', contact_id: contactId }),
        apiGet({ contact_properties: '1', contact_id: contactId }).catch(() => []),
      ]);
      const c = Array.isArray(contactData) ? contactData[0] : contactData;
      if (!c) { drawer.innerHTML = '<div class="crm-drawer-loading">Not found</div>'; return; }

      const roleLabel = ROLES.find(r => r.value === c.role)?.label || c.role || '—';
      drawer.innerHTML = `
        <div class="crm-drawer-header">
          <div>
            <div class="crm-drawer-title">${displayName(c)}</div>
            <div class="crm-drawer-subtitle">${c.org_name || ''}${c.org_name && roleLabel ? ' · ' : ''}${roleLabel}</div>
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
              ${c.mobile ? `<div class="crm-detail-label">Mobile</div><div><a href="tel:${c.mobile}" class="crm-link">${c.mobile}</a></div>` : ''}
              ${c.email  ? `<div class="crm-detail-label">Email</div><div><a href="mailto:${c.email}" class="crm-link">${c.email}</a></div>` : ''}
              ${c.org_name ? `<div class="crm-detail-label">Organisation</div><div>${c.org_name}</div>` : ''}
              <div class="crm-detail-label">Source</div><div>${c.source || 'manual'}</div>
            </div>
          </div>

          ${props.length ? `
          <div class="crm-drawer-section">
            <div class="crm-drawer-section-title">Linked Properties (${props.length})</div>
            ${props.map(p => `
              <div class="crm-prop-row">
                <span class="crm-prop-address">${p.address || p.pipeline_id}</span>
                <span class="crm-role-badge crm-role-${(p.role||'').replace(/[^a-z0-9]/gi,'_')}">${ROLES.find(r=>r.value===p.role)?.label||p.role||'—'}</span>
              </div>`).join('')}
          </div>` : ''}

          <div class="crm-drawer-section">
            <div class="crm-drawer-section-title" style="display:flex;justify-content:space-between;align-items:center">
              Notes
              <button class="crm-drawer-add-note-btn kb-add-offer-btn">+ Add Note</button>
            </div>
            <div class="crm-drawer-note-input" style="display:none;margin-bottom:8px">
              <textarea class="kb-input crm-drawer-note-text" rows="2" placeholder="Add a note…" style="width:100%;resize:vertical"></textarea>
              <div style="display:flex;gap:6px;margin-top:4px">
                <button class="crm-drawer-note-save kb-add-offer-btn">Save</button>
                <button class="crm-drawer-note-cancel">Cancel</button>
              </div>
            </div>
            <div class="crm-drawer-notes-list">
              ${notes.length ? notes.map(n => `
                <div class="crm-note-entry" data-note-id="${n.id}">
                  <div class="crm-note-meta">
                    <span class="crm-note-date">${formatNoteDate(n.created_at)}${n.property_address ? ` · <span class="crm-note-prop">${n.property_address}</span>` : ''}</span>
                    <button class="crm-note-delete" data-id="${n.id}">✕</button>
                  </div>
                  <div class="crm-note-text">${n.note_text}</div>
                </div>`).join('') : '<div class="crm-empty">No notes yet</div>'}
            </div>
          </div>
        </div>`;

      drawer.querySelector('.crm-drawer-close').addEventListener('click', onDone);
      drawer.querySelector('.crm-drawer-edit-btn').addEventListener('click', () => {
        renderContactDrawer(drawer, c, () => renderContactDetail(drawer, contactId, onDone));
      });

      // Note add toggle
      const addNoteBtn  = drawer.querySelector('.crm-drawer-add-note-btn');
      const noteInput   = drawer.querySelector('.crm-drawer-note-input');
      addNoteBtn.addEventListener('click', () => { noteInput.style.display = ''; addNoteBtn.style.display = 'none'; drawer.querySelector('.crm-drawer-note-text').focus(); });
      drawer.querySelector('.crm-drawer-note-cancel').addEventListener('click', () => { noteInput.style.display = 'none'; addNoteBtn.style.display = ''; });
      drawer.querySelector('.crm-drawer-note-save').addEventListener('click', async () => {
        const text = drawer.querySelector('.crm-drawer-note-text').value.trim();
        if (!text) return;
        await apiPost({ action: 'add_note', contact_id: contactId, note_text: text });
        renderContactDetail(drawer, contactId, onDone);
      });

      // Note delete
      drawer.querySelectorAll('.crm-note-delete').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm('Delete this note?')) return;
          await apiDelete({ note_id: btn.dataset.id });
          renderContactDetail(drawer, contactId, onDone);
        });
      });
    } catch (err) {
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
            <div class="kb-field-wrap" style="flex:2">
              <label class="kb-field-label">Organisation</label>
              <div class="crm-org-wrap"></div>
            </div>
            <div class="kb-field-wrap">
              <label class="kb-field-label">Role</label>
              <select class="kb-input crm-role">
                ${ROLES.map(r => `<option value="${r.value}" ${r.value === (prefill?.role || 'vendor') ? 'selected' : ''}>${r.label}</option>`).join('')}
              </select>
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
      const data = {
        first_name:      first,
        last_name:       drawer.querySelector('.crm-last').value.trim(),
        mobile:          drawer.querySelector('.crm-mobile').value.trim(),
        email:           drawer.querySelector('.crm-email').value.trim(),
        organisation_id: selectedOrgId,
        source:          prefill?.source || 'manual',
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
          <td><strong>${org.name}</strong></td>
          <td>${org.contact_count ?? '—'}</td>
          <td class="crm-td-actions">
            <button class="crm-view-edit-btn" title="Edit">✎</button>
            <button class="crm-view-delete-btn" title="Delete" style="color:#c0392b">🗑</button>
          </td>`;
        tr.querySelector('.crm-view-edit-btn').addEventListener('click', () => {
          openDrawer(drawer => renderOrgDrawer(drawer, org, () => { closeDrawer(); fetchOrgs(orgSearch); }));
        });
        tr.querySelector('.crm-view-delete-btn').addEventListener('click', async () => {
          if (!confirm(`Delete organisation "${org.name}"?`)) return;
          await apiDelete({ org_id: org.id });
          fetchOrgs(orgSearch);
        });
        tbody.appendChild(tr);
      });
    }

    fetchOrgs();
  }

  function renderOrgDrawer(drawer, prefill, onDone) {
    const isEdit = !!prefill?.id;
    drawer.innerHTML = `
      <div class="crm-drawer-header">
        <div class="crm-drawer-title">${isEdit ? 'Edit Organisation' : 'New Organisation'}</div>
        <button class="crm-drawer-close">✕</button>
      </div>
      <div class="crm-drawer-body">
        <div class="crm-form-inner">
          <div class="kb-field-wrap">
            <label class="kb-field-label">Organisation Name *</label>
            <input class="kb-input crm-org-name" type="text" placeholder="e.g. Ray White Parramatta" value="${prefill?.name || ''}">
          </div>
          <div class="crm-form-actions" style="margin-top:12px">
            <button class="crm-save-btn kb-add-offer-btn">${isEdit ? 'Save Changes' : 'Create'}</button>
            <button class="crm-cancel-btn">Cancel</button>
          </div>
        </div>
      </div>`;
    drawer.querySelector('.crm-drawer-close').addEventListener('click', onDone);
    drawer.querySelector('.crm-cancel-btn').addEventListener('click', onDone);
    drawer.querySelector('.crm-save-btn').addEventListener('click', async () => {
      const name = drawer.querySelector('.crm-org-name').value.trim();
      if (!name) { drawer.querySelector('.crm-org-name').focus(); return; }
      if (isEdit) {
        await apiPut({ org_id: prefill.id, name });
      } else {
        await apiPost({ action: 'create_org', name });
      }
      onDone();
    });
  }

  // Initial load
  loadContactsPane();
}
