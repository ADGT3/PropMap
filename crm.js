/**
 * crm.js
 * CRM Contact management for the Sydney Property Map.
 *
 * Renders inside the Kanban card modal as a collapsible "Contacts" section.
 * Domain agent (if known) appears as the first read-only row.
 * Additional contacts (referrers, buyer's agents) are stored in Neon DB.
 *
 * Exposes: window.CRM
 */

const CRM_BASE = '/api/contacts';

const ROLES = [
  { value: 'listing_agent', label: 'Listing Agent' },
  { value: 'referrer',      label: 'Referrer'       },
  { value: 'buyer_agent',   label: "Buyer's Agent"  },
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

async function apiDelete(id) {
  const res = await fetch(`${CRM_BASE}?id=${id}`, { method: 'DELETE' });
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

// ─── Render contacts section ──────────────────────────────────────────────────
// agentData: the Domain-sourced agent object from p._agent (may be null)

async function renderContactsSection(pipelineId, agentData) {
  const section = document.createElement('div');
  section.className = 'crm-section';

  // ── Header row (collapsible toggle) ────────────────────────────────────────
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

  // ── Load linked CRM contacts ────────────────────────────────────────────────
  async function reload() {
    listEl.innerHTML = '<div class="crm-loading">Loading…</div>';
    let contacts = [];
    try {
      contacts = await apiGet({ pipeline_id: pipelineId });
    } catch (_) {
      listEl.innerHTML = '<div class="crm-empty">Could not load contacts</div>';
      return;
    }
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

    // ── Domain agent row (read-only, always first) ──────────────────────────
    if (agentData?.name || agentData?.email || agentData?.phone) {
      const row = document.createElement('div');
      row.className = 'crm-contact-row crm-domain-agent';
      row.innerHTML = `
        <div class="crm-contact-info">
          <div class="crm-contact-name">
            ${agentData.name || '—'}
            <span class="crm-role-badge crm-role-listing_agent">Listing Agent</span>
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

      // Save Domain agent to CRM contacts
      row.querySelector('.crm-save-domain-btn').addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        btn.textContent = '…';
        try {
          const { first_name, last_name } = splitName(agentData.name || '');
          // Check if already in contacts by email
          const existing = agentData.email
            ? (await apiGet({ search: agentData.email }).catch(() => [])).filter(c => c.email === agentData.email)
            : [];
          let contactId;
          if (existing.length) {
            contactId = existing[0].id;
          } else {
            const created = await apiPost({
              first_name,
              last_name,
              mobile:    agentData.phone  || '',
              email:     agentData.email  || '',
              company:   agentData.agency || '',
              source:    'domain_agent',
              domain_id: String(pipelineId),
            });
            contactId = created.id;
          }
          await apiPost({ action: 'link', contact_id: contactId, pipeline_id: pipelineId, role: 'listing_agent' });
          btn.textContent = '✓';
          setTimeout(() => reload(), 800);
        } catch (err) {
          btn.textContent = '✕';
          btn.disabled = false;
          console.error('[CRM] save domain agent failed:', err);
        }
      });

      listEl.appendChild(row);
    }

    // ── CRM contacts ────────────────────────────────────────────────────────
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
      row.innerHTML = `
        <div class="crm-contact-info">
          <div class="crm-contact-name">
            ${displayName(contact)}
            <span class="crm-role-badge crm-role-${contact.role}">${ROLES.find(r => r.value === contact.role)?.label || contact.role}</span>
          </div>
          <div class="crm-contact-meta">
            ${contact.company ? `<span>${contact.company}</span>` : ''}
            ${contact.mobile  ? `<a href="tel:${contact.mobile}" class="crm-link">${contact.mobile}</a>` : ''}
            ${contact.email   ? `<a href="mailto:${contact.email}" class="crm-link">${contact.email}</a>` : ''}
          </div>
        </div>
        <div class="crm-contact-actions">
          <button class="crm-edit-btn"   data-id="${contact.id}" title="Edit">✎</button>
          <button class="crm-unlink-btn" data-id="${contact.id}" title="Remove from property">✕</button>
        </div>`;

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
  function showForm(prefill = {}, prefillRole = 'referrer') {
    formEl.style.display = 'block';
    addBtn.style.display = 'none';
    const isEdit = !!prefill.id;

    formEl.innerHTML = `
      <div class="crm-form-inner">
        <div class="crm-form-title">${isEdit ? 'Edit Contact' : 'Add Contact'}</div>

        ${!isEdit ? `
        <div style="margin-bottom:10px">
          <label class="kb-field-label">Search existing contacts</label>
          <input class="kb-input crm-search" type="text" placeholder="Name, company, email…">
          <div class="crm-search-results"></div>
        </div>
        <div class="crm-form-divider">— or create new —</div>` : ''}

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
            <label class="kb-field-label">Company</label>
            <input class="kb-input crm-company" type="text" placeholder="Agency / company" value="${prefill.company || ''}">
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
            item.innerHTML = `<strong>${displayName(ct)}</strong>${ct.company ? ` · ${ct.company}` : ''}${ct.mobile || ct.email ? ` · ${ct.mobile || ct.email}` : ''}`;
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
        first_name: first,
        last_name:  formEl.querySelector('.crm-last').value.trim(),
        mobile:     formEl.querySelector('.crm-mobile').value.trim(),
        email:      formEl.querySelector('.crm-email').value.trim(),
        company:    formEl.querySelector('.crm-company').value.trim(),
        source:     prefill.source || 'manual',
        domain_id:  prefill.domain_id || null,
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
      await apiDelete(prefill.id);
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
