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
          ${isEdit ? `<button class="crm-delete-btn">Delete Contact</button>` : ''}
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

    formEl.querySelector('.crm-delete-btn')?.addEventListener('click', async () => {
      if (!confirm(`Delete ${displayName(prefill)} permanently?`)) return;
      await apiDelete({ id: prefill.id });
      hideForm();
      reload();
    });
  }

  function hideForm() {
    formEl.style.display = 'none';
    formEl.innerHTML = '';
    addBtn.style.display = '';
  }

  addBtn.addEventListener('click', () => showForm());

  await reload();
  return section;
}

// ─── Public API ───────────────────────────────────────────────────────────────

window.CRM = { renderContactsSection, splitName, displayName };
