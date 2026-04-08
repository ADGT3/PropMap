/**
 * crm.js
 * CRM Contact management for the Sydney Property Map.
 *
 * Manages contacts stored in the Neon `contacts` + `contact_properties` tables.
 * Rendered inside the Kanban card modal as a "Contacts" section.
 *
 * Exposes: window.CRM
 *
 * CONTACT ROLES
 *   listing_agent — agent marketing the property (on-market)
 *   referrer      — person who introduced the off-market deal
 *   buyer_agent   — buyer's agent acting for us
 *
 * INTEGRATION
 *   Called by kanban.js openCardModal() to render the contacts section.
 *   When a Domain agent is found (resolveFromDomain), kanban.js calls
 *   CRM.offerSaveAgent(modal, pipelineId, agentData) to show a save prompt.
 */

const CRM_BASE = '/api/contacts';

const ROLES = [
  { value: 'listing_agent', label: 'Listing Agent' },
  { value: 'referrer',      label: 'Referrer'       },
  { value: 'buyer_agent',   label: 'Buyer\'s Agent' },
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
  return {
    first_name: parts[0] || '',
    last_name:  parts.slice(1).join(' ') || '',
  };
}

function displayName(contact) {
  return [contact.first_name, contact.last_name].filter(Boolean).join(' ') || '—';
}

// ─── Render contacts section ──────────────────────────────────────────────────
// Returns an HTMLElement. Called by kanban.js and inserted into the modal body.

async function renderContactsSection(pipelineId) {
  const section = document.createElement('div');
  section.className = 'crm-section';
  section.innerHTML = `
    <div class="kb-section-label" style="margin-top:16px;display:flex;align-items:center;justify-content:space-between">
      <span>Contacts</span>
      <button class="crm-add-btn" title="Add contact">+ Add</button>
    </div>
    <div class="crm-list">
      <div class="crm-loading">Loading…</div>
    </div>
    <div class="crm-form" style="display:none"></div>`;

  const listEl = section.querySelector('.crm-list');
  const formEl = section.querySelector('.crm-form');
  const addBtn = section.querySelector('.crm-add-btn');

  // Load linked contacts
  async function reload() {
    listEl.innerHTML = '<div class="crm-loading">Loading…</div>';
    try {
      const contacts = await apiGet({ pipeline_id: pipelineId });
      renderList(contacts);
    } catch (_) {
      listEl.innerHTML = '<div class="crm-empty">Could not load contacts</div>';
    }
  }

  function renderList(contacts) {
    if (!contacts.length) {
      listEl.innerHTML = '<div class="crm-empty">No contacts linked</div>';
      return;
    }
    listEl.innerHTML = '';
    contacts.forEach(c => {
      const row = document.createElement('div');
      row.className = 'crm-contact-row';
      row.innerHTML = `
        <div class="crm-contact-info">
          <div class="crm-contact-name">
            ${displayName(c)}
            <span class="crm-role-badge crm-role-${c.role}">${ROLES.find(r => r.value === c.role)?.label || c.role}</span>
          </div>
          <div class="crm-contact-meta">
            ${c.company  ? `<span>${c.company}</span>` : ''}
            ${c.mobile   ? `<a href="tel:${c.mobile}" class="crm-link">${c.mobile}</a>` : ''}
            ${c.email    ? `<a href="mailto:${c.email}" class="crm-link">${c.email}</a>` : ''}
          </div>
        </div>
        <div class="crm-contact-actions">
          <button class="crm-edit-btn"   data-id="${c.id}" title="Edit contact">✎</button>
          <button class="crm-unlink-btn" data-id="${c.id}" title="Remove from this property">✕</button>
        </div>`;

      row.querySelector('.crm-unlink-btn').addEventListener('click', async () => {
        if (!confirm(`Remove ${displayName(c)} from this property?`)) return;
        await apiPost({ action: 'unlink', contact_id: c.id, pipeline_id: pipelineId });
        reload();
      });

      row.querySelector('.crm-edit-btn').addEventListener('click', () => {
        showForm(c, c.role);
      });

      listEl.appendChild(row);
    });
  }

  // ── Contact form (create / edit) ──────────────────────────────────────────
  function showForm(prefill = {}, prefillRole = 'referrer') {
    formEl.style.display = 'block';
    addBtn.style.display = 'none';

    const isEdit = !!prefill.id;

    formEl.innerHTML = `
      <div class="crm-form-inner">
        <div class="crm-form-title">${isEdit ? 'Edit Contact' : 'Add Contact'}</div>

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
            <input class="kb-input crm-email" type="text" placeholder="email@agency.com.au" value="${prefill.email || ''}">
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

        ${isEdit ? '' : `
        <div style="margin-top:6px">
          <label class="kb-field-label">Or search existing contacts</label>
          <input class="kb-input crm-search" type="text" placeholder="Search by name, company…">
          <div class="crm-search-results"></div>
        </div>`}

        <div class="crm-form-actions">
          <button class="crm-save-btn">${isEdit ? 'Save Changes' : 'Save & Link'}</button>
          <button class="crm-cancel-btn">Cancel</button>
          ${isEdit ? `<button class="crm-delete-btn" style="margin-left:auto;color:#c0392b">Delete Contact</button>` : ''}
        </div>
      </div>`;

    // Search existing contacts
    const searchEl = formEl.querySelector('.crm-search');
    if (searchEl) {
      let searchTimer;
      searchEl.addEventListener('input', () => {
        clearTimeout(searchTimer);
        const q = searchEl.value.trim();
        if (q.length < 2) { formEl.querySelector('.crm-search-results').innerHTML = ''; return; }
        searchTimer = setTimeout(async () => {
          const results = await apiGet({ search: q }).catch(() => []);
          const resultsEl = formEl.querySelector('.crm-search-results');
          if (!results.length) { resultsEl.innerHTML = '<div class="crm-empty">No matches</div>'; return; }
          resultsEl.innerHTML = '';
          results.forEach(c => {
            const item = document.createElement('div');
            item.className = 'crm-search-item';
            item.innerHTML = `<strong>${displayName(c)}</strong> ${c.company ? `· ${c.company}` : ''} ${c.mobile || c.email ? `· ${c.mobile || c.email}` : ''}`;
            item.addEventListener('click', async () => {
              // Link existing contact with selected role
              const role = formEl.querySelector('.crm-role').value;
              await apiPost({ action: 'link', contact_id: c.id, pipeline_id: pipelineId, role });
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

      const contactData = {
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
        await apiPut({ id: prefill.id, ...contactData });
      } else {
        const created = await apiPost(contactData);
        await apiPost({ action: 'link', contact_id: created.id, pipeline_id: pipelineId, role });
      }
      hideForm();
      reload();
    });

    formEl.querySelector('.crm-cancel-btn').addEventListener('click', hideForm);

    const deleteBtn = formEl.querySelector('.crm-delete-btn');
    if (deleteBtn) {
      deleteBtn.addEventListener('click', async () => {
        if (!confirm(`Delete ${displayName(prefill)} permanently from all properties?`)) return;
        await apiDelete(prefill.id);
        hideForm();
        reload();
      });
    }
  }

  function hideForm() {
    formEl.style.display = 'none';
    formEl.innerHTML = '';
    addBtn.style.display = '';
  }

  addBtn.addEventListener('click', () => showForm());

  // Initial load
  reload();
  return section;
}

// ─── "Save agent to contacts" prompt ─────────────────────────────────────────
// Called by kanban.js when Domain agent data is resolved.
// Inserts a subtle prompt under the header agent block.

function offerSaveAgent(modal, pipelineId, agentData, domainId) {
  if (!agentData?.name) return;
  if (modal.querySelector('.crm-save-agent-prompt')) return; // already shown

  const { first_name, last_name } = splitName(agentData.name);

  const prompt = document.createElement('div');
  prompt.className = 'crm-save-agent-prompt';
  prompt.innerHTML = `<span style="font-size:11px;color:#888">Save agent to contacts?</span>
    <button class="crm-save-agent-btn" style="font-size:11px;margin-left:6px;padding:2px 8px;border:1px solid #1a6b3a;border-radius:4px;background:none;color:#1a6b3a;cursor:pointer">Save</button>
    <button class="crm-dismiss-btn" style="font-size:11px;margin-left:4px;padding:2px 6px;border:none;background:none;color:#aaa;cursor:pointer">✕</button>`;

  prompt.querySelector('.crm-save-agent-btn').addEventListener('click', async () => {
    try {
      const existing = agentData.email ? await apiGet({ search: agentData.email }).catch(() => []) : [];
      const match = existing.find(c => c.email === agentData.email);
      if (match) {
        // Already in contacts — just link
        await apiPost({ action: 'link', contact_id: match.id, pipeline_id: pipelineId, role: 'listing_agent' });
      } else {
        const created = await apiPost({
          first_name,
          last_name,
          mobile:    agentData.phone   || '',
          email:     agentData.email   || '',
          company:   agentData.agency  || '',
          source:    'domain_agent',
          domain_id: domainId          || null,
        });
        await apiPost({ action: 'link', contact_id: created.id, pipeline_id: pipelineId, role: 'listing_agent' });
      }
      prompt.innerHTML = '<span style="font-size:11px;color:#1a6b3a">✓ Saved to contacts</span>';
      setTimeout(() => prompt.remove(), 2000);

      // Refresh the crm section if visible
      const crmSection = modal.querySelector('.crm-section');
      if (crmSection) {
        const newSection = await renderContactsSection(pipelineId);
        crmSection.replaceWith(newSection);
      }
    } catch (err) {
      prompt.querySelector('.crm-save-agent-btn').textContent = 'Error — retry';
      console.error('[CRM] save agent failed:', err);
    }
  });

  prompt.querySelector('.crm-dismiss-btn').addEventListener('click', () => prompt.remove());

  // Insert after the header agent block
  const headerAgent = modal.querySelector('.kb-header-agent');
  if (headerAgent) headerAgent.insertAdjacentElement('afterend', prompt);
}

// ─── Public API ───────────────────────────────────────────────────────────────

window.CRM = {
  renderContactsSection,
  offerSaveAgent,
  splitName,
  displayName,
};
