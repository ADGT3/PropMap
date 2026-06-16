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

// V77.2g — Roles are sourced exclusively from the DB (the `roles` table) via
// the Lookups module. No hardcoded fallback array — if Lookups isn't ready,
// callers must await Lookups.getRolesActive() first.
//
// Lookups caches the roles list in memory for the page lifetime, with a TTL
// refresh so changes made by other agents propagate within ~60s. Edits made
// in this browser invalidate the cache immediately via Lookups.invalidateRoles.
async function rolesForScope(scope) {
  if (!window.Lookups) {
    console.warn('[crm] Lookups not loaded — cannot resolve roles');
    return [];
  }
  const rows = await Lookups.getRolesActive({ scope });
  // Map to the existing { value, label, scopes } shape that callsites expect
  return rows.map(r => ({ value: r.id, label: r.label, scopes: r.scopes }));
}
function roleLabel(id) {
  if (!window.Lookups) return id;
  return Lookups.roleLabel(id) || id;
}

// V77.2g — Find the lowest-sort_order active role for a given scope. Used as
// the default selection when rendering a role dropdown without a specific
// pre-fill. Returns null if no roles configured for the scope.
async function defaultRoleIdForScope(scope) {
  const roles = await rolesForScope(scope);
  return roles.length ? roles[0].value : null;
}

// V77.1c — SOURCES array, resolveSource(), renderSourceField(),
// readSourceField(), wireSourceField() all REMOVED. Source is no longer a
// contact-level attribute. Per-interaction source lives on notes.source and
// is captured via NoteForm (note-form.js) when interaction_type direction is
// 'inbound'.

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

// ─── V76.4.5: Vendor Terms & Offers history aggregation ──────────────────────
// Pure helper. Takes a list of deal records (as returned by /api/deals) and
// flattens their data.terms and data.offers into a single newest-first list
// for read-only display in the CRM Property and Parcel modals.
//
// Output entry shape:
//   {
//     kind:        'terms' | 'offer',
//     dealId:      string,
//     dealWorkflow: string,           // 'acquisition' | 'agency_sales' | ...
//     date:        ISO string,
//     price:       string|number,
//     settlement:  string|number|null,
//     deposits:    Array<{ amount, due, note }>,
//     label:       string             // e.g. "Vendor Terms" / "Offer 2"
//   }
//
// Legacy data shape note: today data.terms is a singleton OBJECT. The future
// (planned but not yet built) refactor will make it an ARRAY like data.offers.
// This aggregator transparently handles both shapes so it'll keep working
// after that refactor without changes here.
function aggregateDealHistory(deals) {
  const out = [];
  for (const d of deals || []) {
    if (!d || !d.data) continue;
    const wf = d.workflow || '';
    const updatedAt = d.updated_at || d.opened_at || d.created_at || null;

    // ── Terms — singleton (legacy) or array (future)
    const t = d.data.terms;
    if (t) {
      const termsList = Array.isArray(t) ? t : [t];
      termsList.forEach((entry, i) => {
        if (!entry) return;
        if (!entry.price && !entry.settlement && !(entry.deposits && entry.deposits.some(x => x && x.amount))) return;
        out.push({
          kind:         'terms',
          dealId:       d.id,
          dealWorkflow: wf,
          date:         entry.date || updatedAt,
          price:        entry.price || '',
          settlement:   entry.settlement || null,
          deposits:     Array.isArray(entry.deposits) ? entry.deposits : [],
          label:        termsList.length > 1 ? `Vendor Terms ${termsList.length - i}` : 'Vendor Terms',
        });
      });
    }

    // ── Offers — already an array
    const offers = Array.isArray(d.data.offers) ? d.data.offers : [];
    offers.forEach((o, i) => {
      if (!o || !o.price) return;
      out.push({
        kind:         'offer',
        dealId:       d.id,
        dealWorkflow: wf,
        date:         o.date || updatedAt,
        price:        o.price,
        settlement:   o.settlement || null,
        deposits:     Array.isArray(o.deposits) ? o.deposits : [],
        label:        `Offer ${offers.length - i}`,
      });
    });
  }
  // Newest first; entries without dates sink to the bottom
  out.sort((a, b) => {
    const ta = a.date ? new Date(a.date).getTime() : 0;
    const tb = b.date ? new Date(b.date).getTime() : 0;
    return tb - ta;
  });
  return out;
}

// V76.4.5: render the read-only history list as HTML for the CRM modals.
// Reuses kanban styles (.kb-fin-pick-*) so the visual matches the deal modal's
// finance picker. Source deal id is rendered as a link the caller can wire up.
function buildVendorHistoryHtml(history, opts = {}) {
  if (!history.length) {
    return '<div class="crm-empty">No vendor terms or offers recorded yet</div>';
  }
  const wfLabels = { acquisition: 'Acquisition', buyer_enquiry: 'Enquiry', agency_sales: 'Listing' };
  const fmtPrice = window.formatInputPrice || (s => '$' + s);
  const fmtSet   = window.formatSettlement || (s => String(s));
  const fmtDate  = window.formatOfferDate || (iso => new Date(iso).toLocaleDateString('en-AU'));
  const fmtDep   = (deposits, price) => {
    const fmtAmt   = window.formatDepositAmount      || ((a) => String(a));
    const parsePx  = window.parseDepositAmountKanban || (() => 0);
    const px = parsePx(price, null) || 0;
    return (deposits || [])
      .filter(x => x && x.amount)
      .map(x => fmtAmt(x.amount, px) + (x.due ? ' · ' + fmtSet(String(x.due)) : '') + (x.note ? ' · ' + x.note : ''))
      .join('<br>');
  };

  return `<div class="crm-vendor-history-list">${history.map(h => {
    const depSummary = fmtDep(h.deposits, h.price);
    const wfBadge = h.dealWorkflow ? `<span class="kb-fin-pick-meta">${wfLabels[h.dealWorkflow] || h.dealWorkflow}</span>` : '';
    return `
      <div class="kb-fin-pick-row crm-vendor-history-row" data-deal-id="${h.dealId}">
        <div class="kb-fin-pick-main">
          <div class="kb-fin-pick-top">
            <span class="kb-fin-pick-label">${h.label}</span>
            ${h.date ? `<span class="kb-fin-pick-date">${fmtDate(h.date)}</span>` : ''}
          </div>
          <div class="kb-fin-pick-detail">
            <span class="kb-fin-pick-price">${h.price ? fmtPrice(String(h.price)) : '—'}</span>
            ${h.settlement ? `<span class="kb-fin-pick-meta">${fmtSet(String(h.settlement))} settlement</span>` : ''}
            ${wfBadge}
            <span class="kb-fin-pick-meta">Deal <a href="#" class="crm-vendor-history-deal-link" data-deal-id="${h.dealId}">${h.dealId}</a></span>
          </div>
          ${depSummary ? `<div class="kb-fin-pick-deps">${depSummary}</div>` : ''}
        </div>
      </div>`;
  }).join('')}</div>`;
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
      // V76.4: clean API contract — org_search=q alone returns orgs matching q.
      // No coupling rule, no flag-pairing required.
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

// V77.1c — Modal dialog shown when the Domain "+ Add" flow finds possible
// duplicates. Returns a Promise that resolves to one of:
//   { action: 'use_existing', contactId: <id> }
//   { action: 'create_new' }
//   { action: 'cancel' }
function openDomainDuplicateDialog({ agent, duplicates }) {
  return new Promise((resolve) => {
    const escHtml = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    const fullName = [agent.first_name, agent.last_name].filter(Boolean).join(' ').trim() || '(no name)';
    const meta = [agent.email, agent.phone, agent.agency].filter(Boolean).map(escHtml).join(' · ');

    const overlay = document.createElement('div');
    overlay.className = 'v77-modal-overlay';
    overlay.innerHTML = `
      <div class="v77-modal" style="max-width:560px">
        <div class="v77-modal-header">
          <div class="v77-modal-title">Possible duplicate${duplicates.length > 1 ? 's' : ''} found</div>
          <button class="v77-modal-close" data-role="cancel">✕</button>
        </div>
        <div class="v77-modal-body">
          <div style="font-size:12px;color:var(--muted);margin-bottom:6px">Domain agent details:</div>
          <div style="background:var(--surface2);padding:8px 10px;border-radius:4px;margin-bottom:14px;font-size:13px">
            <strong>${escHtml(fullName)}</strong>
            ${meta ? `<div style="font-size:11px;color:var(--muted);margin-top:2px">${meta}</div>` : ''}
          </div>
          <div style="font-size:12px;color:var(--muted);margin-bottom:6px">${duplicates.length} matching contact${duplicates.length > 1 ? 's' : ''} in your system:</div>
          <div class="dom-dup-list" data-role="dup-list"></div>
        </div>
        <div class="v77-modal-footer" style="justify-content:space-between">
          <button class="params-cancel-btn" data-role="cancel">Cancel</button>
          <button class="params-save-btn" data-role="create-new">Create new anyway</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();

    const list = overlay.querySelector('[data-role="dup-list"]');
    duplicates.forEach(c => {
      const row = document.createElement('div');
      row.className = 'dom-dup-row';
      const cName = displayName(c);
      const cMeta = [c.org_name, c.email, c.mobile].filter(Boolean).map(escHtml).join(' · ');
      row.innerHTML = `
        <div class="dom-dup-row-main">
          <strong>${escHtml(cName)}</strong>
          ${cMeta ? `<div class="dom-dup-row-meta">${cMeta}</div>` : ''}
        </div>
        <button class="params-save-btn dom-dup-use" data-id="${c.id}">Use this contact</button>
      `;
      row.querySelector('.dom-dup-use').addEventListener('click', () => {
        close();
        resolve({ action: 'use_existing', contactId: c.id });
      });
      list.appendChild(row);
    });

    overlay.querySelectorAll('[data-role="cancel"]').forEach(b => b.addEventListener('click', () => {
      close();
      resolve({ action: 'cancel' });
    }));
    overlay.querySelector('[data-role="create-new"]').addEventListener('click', () => {
      close();
      resolve({ action: 'create_new' });
    });
    overlay.addEventListener('click', e => {
      if (e.target === overlay) {
        close();
        resolve({ action: 'cancel' });
      }
    });
  });
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
      <div class="v77-note-form-mount-crm"></div>
      <div class="crm-notes-list"></div>`;

    const listEl = panel.querySelector('.crm-notes-list');
    if (!notes.length) {
      listEl.innerHTML = '<div class="crm-empty">No notes yet</div>';
    } else {
      notes.forEach(n => {
        const entry = document.createElement('div');
        entry.className = 'crm-note-entry';
        const src     = n.source_label_text       ? ` <span class="crm-note-prop">· ${n.source_label_text}</span>` : '';
        const typeBdg = n.interaction_type_label ? ` <span class="crm-note-prop">· ${n.interaction_type_label}</span>` : '';
        const author = n.author_name || 'Unknown';
        entry.innerHTML = `
          <div class="crm-note-meta">
            <span class="crm-note-date">${formatNoteDate(n.created_at)} · by ${author}${typeBdg}${src}</span>
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

    // V77.1 — Mount the NoteForm with type+source dropdowns
    const noteMount = panel.querySelector('.v77-note-form-mount-crm');
    if (window.NoteForm && noteMount) {
      NoteForm.mount(noteMount, {
        placeholder: 'Add a note…',
        // No contact tagger needed here — the contact context is implicit (this is the contact's notes)
        showContactTagger: false,
        onAdd: async (vals) => {
          const text = (vals.note_text || '').trim();
          if (!text) return;
          // Panel rendered from agent-side CRM section of pipeline modal.
          // Note attaches to the deal when pipelineId is present, otherwise to the contact.
          const entity_type = pipelineId ? 'deal'              : 'contact';
          const entity_id   = pipelineId ? String(pipelineId)  : String(contactId);
          const tagged_contact_id = pipelineId ? contactId : null;
          const body = { entity_type, entity_id, note_text: text, tagged_contact_id };
          if (vals.interaction_type) body.interaction_type = vals.interaction_type;
          if (vals.source)           body.source           = vals.source;
          await fetch('/api/notes', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(body),
          });
          loadNotes();
        },
      });
    }
  }

  await loadNotes();
  return panel;
}

// ─── Render contacts section ──────────────────────────────────────────────────

async function renderContactsSection(pipelineId, agentData) {
  const section = document.createElement('div');
  section.className = 'crm-section';

  // V77.2g — This component is mounted inside a deal modal, so role-pickers
  // here should show roles flagged with scope='deal'. (Property-scope contacts
  // are handled by a different rendering path.)
  const scope = 'deal';

  // V77.1 — Contacts is always expanded; header matches other static sections
  // (kb-section-label) for visual consistency. The "+ Add" affordance lives on
  // the right of the heading row.
  section.innerHTML = `
    <div class="crm-static-header">
      <span class="kb-section-label" style="margin:0">Contacts <span class="crm-count"></span></span>
      <button class="crm-add-btn" title="Add contact">+ Add</button>
    </div>
    <div class="crm-body">
      <div class="crm-list"></div>
      <div class="crm-form" style="display:none"></div>
    </div>`;

  const addBtn    = section.querySelector('.crm-add-btn');
  const listEl    = section.querySelector('.crm-list');
  const formEl    = section.querySelector('.crm-form');
  const countEl   = section.querySelector('.crm-count');

  // V77.1 — Always expanded; no toggle.

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

          // V77.1c: smarter duplicate detection. Look for matches on first+last
          // name, email, OR mobile (any combination). If found, ask the user
          // whether to use an existing record or create new anyway.
          const dups = await checkDuplicates(first_name, last_name, agentData.email || '', agentData.phone || '');

          let contactId;
          let isNewContact = false;

          if (dups.length === 0) {
            // No matches → just create
            const created = await apiPost({ first_name, last_name, mobile: agentData.phone || '', email: agentData.email || '', organisation_id: orgId, domain_id: String(pipelineId) });
            contactId = created.id;
            isNewContact = true;
          } else {
            // Possible duplicates → ask the user
            const choice = await openDomainDuplicateDialog({
              agent: { first_name, last_name, email: agentData.email || '', phone: agentData.phone || '', agency: agentData.agency || '' },
              duplicates: dups,
            });
            if (choice.action === 'cancel') {
              // User backed out — restore button and stop
              btn.disabled = false;
              btn.textContent = '+';
              return;
            }
            if (choice.action === 'use_existing') {
              contactId = choice.contactId;
              isNewContact = false;
            } else if (choice.action === 'create_new') {
              const created = await apiPost({ first_name, last_name, mobile: agentData.phone || '', email: agentData.email || '', organisation_id: orgId, domain_id: String(pipelineId) });
              contactId = created.id;
              isNewContact = true;
            }
          }

          // V77.2g — link the agent contact using the default role flagged
          // for this deal's board (no hardcoded role IDs). Falls back to the
          // first deal-scope role if the board has no defaults flagged.
          let agentRoleId = null;
          try {
            // pipelineId is the deal id — fetch its board to resolve eligible roles
            const dealRes = await fetch(`/api/deals?id=${encodeURIComponent(pipelineId)}`);
            if (dealRes.ok) {
              const deal = await dealRes.json();
              const boardId = deal?.board_id;
              if (boardId && window.Lookups?.getDefaultRolesForBoard) {
                const eligible = await Lookups.getDefaultRolesForBoard(boardId);
                if (eligible.length) agentRoleId = eligible[0].id;
              }
            }
          } catch (_) {}
          if (!agentRoleId) agentRoleId = await defaultRoleIdForScope('deal');
          if (!agentRoleId) {
            console.warn('[crm] no role available for agent link — skipping');
          } else {
            await apiPost({ action: 'link', contact_id: contactId, pipeline_id: pipelineId, role: agentRoleId });
          }

          // V77.1c — auto-create contact-level note for new contacts only.
          // Records that this contact came in via the Domain API as a first
          // inbound interaction. Existing contacts being re-linked to another
          // listing don't get a new note (that's a deal-level event, not a
          // contact-origin event).
          if (isNewContact) {
            try {
              const noteText = `Contact details imported from Domain.com.au (listing #${pipelineId}${agentData.agency ? `, agency: ${agentData.agency}` : ''}).`;
              await fetch('/api/notes', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({
                  entity_type:      'contact',
                  entity_id:        String(contactId),
                  note_text:        noteText,
                  interaction_type: 'domain_api',
                  source:           'domain_com_au',
                }),
              });
            } catch (noteErr) {
              // Non-fatal — the contact + link succeeded; just log
              console.warn('[CRM] auto-note for Domain agent failed:', noteErr);
            }
          }

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
      const currentRole = contact.role || '';
      const currentRoleLabel = currentRole ? roleLabel(currentRole) : '—';
      row.innerHTML = `
        <div class="crm-contact-info">
          <div class="crm-contact-name">
            ${displayName(contact)}
          </div>
          <div class="crm-contact-meta">
            ${contact.org_name ? `<span>${contact.org_name}</span>` : ''}
            <span class="crm-role-badge crm-role-${(currentRole || 'unset').replace(/[^a-z0-9]/gi,'_')}">${currentRoleLabel}</span>
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
      row.querySelector('.crm-edit-btn').addEventListener('click', async () => {
        try {
          await showForm(contact, contact.role);
        } catch (err) {
          console.error('[crm] showForm (edit) failed:', err);
          formEl.style.display = 'none';
          formEl.innerHTML = '';
          addBtn.style.display = '';
          alert('Could not open the Edit form: ' + (err?.message || err));
        }
      });
      listEl.appendChild(row);
    });
  }

  // ── Contact form ────────────────────────────────────────────────────────────
  //
  // V77.2g — Two flows:
  //   Edit existing link: showForm(contactObj, contactObj.role) — just role dropdown.
  //   Add new link:       showForm() — search box; pick existing OR + Create new
  //                       (which opens the full CRM Contact modal). After pick,
  //                       a compact "Selected: NAME ✕" + Role dropdown is shown.

  async function showForm(prefill = {}, prefillRole = null) {
    formEl.style.display = 'block';
    addBtn.style.display = 'none';
    const isEdit = !!prefill.id;
    // Local HTML-escape helper (no global esc available in this module).
    const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

    // Resolve role list + a sensible default for the dropdown.
    const roleList = await rolesForScope(scope);
    const defaultRole = prefillRole || (await defaultRoleIdForScope(scope)) || (roleList[0]?.value || '');

    if (isEdit) {
      // Lightweight: just the contact label + role dropdown + save/cancel.
      formEl.innerHTML = `
        <div class="crm-form-inner">
          <div class="crm-form-title">Edit role for <strong>${esc(displayName(prefill))}</strong></div>
          <div class="crm-form-row">
            <div class="kb-field-wrap" style="flex:1">
              <label class="kb-field-label">Role</label>
              <select class="kb-input crm-role">
                ${roleList.length
                  ? roleList.map(r => `<option value="${esc(r.value)}" ${r.value === defaultRole ? 'selected' : ''}>${esc(r.label)}</option>`).join('')
                  : '<option value="">No roles configured</option>'}
              </select>
            </div>
          </div>
          <div class="crm-form-actions">
            <button class="crm-save-btn">Save Changes</button>
            <button class="crm-cancel-btn">Cancel</button>
          </div>
        </div>`;
    } else {
      // Add-link flow: search-pick-role.
      formEl.innerHTML = `
        <div class="crm-form-inner">
          <div class="crm-form-title">Add Contact</div>
          <div class="crm-pick-wrap" data-role="pick-wrap">
            <label class="kb-field-label">Search contacts</label>
            <input class="kb-input crm-search" type="text" placeholder="Type name, email, or mobile…" autocomplete="off">
            <div class="crm-search-results"></div>
          </div>
          <div class="crm-form-row" data-role="role-row" style="display:none;margin-top:10px">
            <div class="kb-field-wrap" style="flex:1">
              <label class="kb-field-label">Role</label>
              <select class="kb-input crm-role">
                ${roleList.length
                  ? roleList.map(r => `<option value="${esc(r.value)}" ${r.value === defaultRole ? 'selected' : ''}>${esc(r.label)}</option>`).join('')
                  : '<option value="">No roles configured</option>'}
              </select>
            </div>
          </div>
          <div class="crm-form-actions">
            <button class="crm-save-btn" disabled>Link</button>
            <button class="crm-cancel-btn">Cancel</button>
          </div>
        </div>`;
    }

    // ── Wire up edit flow ──
    if (isEdit) {
      formEl.querySelector('.crm-save-btn').addEventListener('click', async () => {
        const role = formEl.querySelector('.crm-role').value;
        if (!role) { alert('Pick a role.'); return; }
        try {
          await apiPost({ action: 'link', contact_id: prefill.id, pipeline_id: pipelineId, role });
        } catch (err) {
          alert(err?.message || 'Save failed');
          return;
        }
        hideForm();
        reload();
      });
      formEl.querySelector('.crm-cancel-btn').addEventListener('click', hideForm);
      return;
    }

    // ── Wire up add-link flow ──
    let _pickedContact = null;  // null until user picks one
    const pickWrap   = formEl.querySelector('[data-role="pick-wrap"]');
    const searchEl   = formEl.querySelector('.crm-search');
    const resultsEl  = formEl.querySelector('.crm-search-results');
    const roleRow    = formEl.querySelector('[data-role="role-row"]');
    const saveBtn    = formEl.querySelector('.crm-save-btn');

    const renderSelected = () => {
      // V80 — match the saved-contact-row styling so the picked-contact
      // preview is visually consistent with the rest of the section
      // (name in bold on its own line, meta details below in a smaller
      // muted row, separated by · bullets).
      pickWrap.innerHTML = `
        <label class="kb-field-label">Contact</label>
        <div class="crm-pick-selected">
          <div class="crm-pick-selected-info crm-contact-info">
            <div class="crm-contact-name">${esc(displayName(_pickedContact))}</div>
            <div class="crm-contact-meta">
              ${_pickedContact.org_name ? `<span>${esc(_pickedContact.org_name)}</span>` : ''}
              ${_pickedContact.mobile ? `<a href="tel:${esc(_pickedContact.mobile)}" class="crm-link">${esc(_pickedContact.mobile)}</a>` : ''}
              ${_pickedContact.email  ? `<a href="mailto:${esc(_pickedContact.email)}" class="crm-link">${esc(_pickedContact.email)}</a>` : ''}
            </div>
          </div>
          <button class="crm-pick-clear-btn" type="button" title="Clear">✕</button>
        </div>`;
      pickWrap.querySelector('.crm-pick-clear-btn').addEventListener('click', () => {
        _pickedContact = null;
        roleRow.style.display = 'none';
        saveBtn.disabled = true;
        renderSearch();
      });
    };
    const renderSearch = () => {
      pickWrap.innerHTML = `
        <label class="kb-field-label">Search contacts</label>
        <input class="kb-input crm-search" type="text" placeholder="Type name, email, or mobile…" autocomplete="off">
        <div class="crm-search-results"></div>`;
      wireSearch();
    };
    const wireSearch = () => {
      const sEl = pickWrap.querySelector('.crm-search');
      const rEl = pickWrap.querySelector('.crm-search-results');
      let t;
      sEl.addEventListener('input', () => {
        clearTimeout(t);
        const q = sEl.value.trim();
        if (q.length < 2) { rEl.innerHTML = ''; return; }
        t = setTimeout(async () => {
          let results = [];
          try {
            results = await apiGet({ search: q });
            if (!Array.isArray(results)) results = [];
          } catch (_) {}
          // Build result list + a final "+ Create new contact" row
          rEl.innerHTML = '';
          results.slice(0, 10).forEach(ct => {
            const item = document.createElement('div');
            item.className = 'crm-search-item';
            const meta = [ct.org_name, ct.email, ct.mobile].filter(Boolean).join(' · ');
            item.innerHTML = `<strong>${esc(displayName(ct))}</strong>${meta ? `<span class="crm-search-item-meta"> · ${esc(meta)}</span>` : ''}`;
            item.addEventListener('click', () => {
              _pickedContact = ct;
              renderSelected();
              roleRow.style.display = '';
              saveBtn.disabled = false;
            });
            rEl.appendChild(item);
          });
          // "+ Create new contact" entry — opens the CRM Contact modal
          const createItem = document.createElement('div');
          createItem.className = 'crm-search-item crm-search-item-create';
          createItem.innerHTML = `<strong>+ Create new contact</strong><span class="crm-search-item-meta"> · enter full details</span>`;
          createItem.addEventListener('click', () => {
            // Ensure renderCRMView has run so the standalone helper is
            // registered on window. We don't show the CRM view — only need
            // the function definitions to exist.
            const crmContainer = document.getElementById('crmViewContent');
            if (crmContainer && !crmContainer.dataset.rendered && window.CRM?.renderCRMView) {
              crmContainer.dataset.rendered = '1';
              window.CRM.renderCRMView(crmContainer);
            }
            if (typeof window.openContactModalStandalone === 'function') {
              window.openContactModalStandalone(null, async (createdId) => {
                // Callback fires after the new contact is created. Re-fetch and select.
                if (!createdId) return;
                try {
                  const ct = await apiGet({ id: createdId });
                  _pickedContact = Array.isArray(ct) ? ct[0] : ct;
                  if (_pickedContact) {
                    renderSelected();
                    roleRow.style.display = '';
                    saveBtn.disabled = false;
                  }
                } catch (_) {}
              });
            } else {
              alert('Contact modal unavailable — please refresh the page.');
            }
          });
          rEl.appendChild(createItem);
        }, 250);
      });
    };
    wireSearch();

    saveBtn.addEventListener('click', async () => {
      if (!_pickedContact) return;
      const role = formEl.querySelector('.crm-role').value;
      if (!role) { alert('Pick a role.'); return; }
      try {
        await apiPost({ action: 'link', contact_id: _pickedContact.id, pipeline_id: pipelineId, role });
      } catch (err) {
        alert(err?.message || 'Save failed');
        return;
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

  addBtn.addEventListener('click', async () => {
    try {
      await showForm();
    } catch (err) {
      console.error('[crm] showForm failed:', err);
      // Restore button so the agent can retry
      formEl.style.display = 'none';
      formEl.innerHTML = '';
      addBtn.style.display = '';
      alert('Could not open the Add Contact form: ' + (err?.message || err));
    }
  });

  // Load contacts async — section renders immediately, contacts populate in background
  reload();
  return section;
}

// ─── Public API ───────────────────────────────────────────────────────────────

window.CRM = {
  renderContactsSection, splitName, displayName, renderCRMView,
  // V82.b — navigate to CRM contacts pane with a pre-filled search
  openContactsWithSearch(search) {
    if (window.Router) Router.navigate('/crm');
    // Wait for CRM to render, then set search and trigger fetch
    const attempt = (tries = 0) => {
      const input = document.querySelector('.crm-view-search');
      if (input) {
        input.value = search;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      } else if (tries < 20) {
        setTimeout(() => attempt(tries + 1), 100);
      }
    };
    setTimeout(() => attempt(), 200);
  },
};

// ─── Standalone CRM View ──────────────────────────────────────────────────────

function renderCRMView(container) {
  container.innerHTML = `
    <div class="crm-view-wrap">
      <div class="crm-view-header">
        <span class="crm-view-title"><svg class="module-header-icon"><use href="#icon-crm"/></svg> CRM</span>
        <div class="crm-view-tabs">
          <button class="crm-tab active" data-tab="contacts">Contacts</button>
          <button class="crm-tab"        data-tab="organisations">Organisations</button>
          <button class="crm-tab"        data-tab="properties">Properties</button>
          <button class="crm-tab"        data-tab="parcels">Parcels</button>
        </div>
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

  // Tab switching
  container.querySelectorAll('.crm-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      container.querySelectorAll('.crm-tab').forEach(t => t.classList.remove('active'));
      container.querySelectorAll('.crm-tab-pane').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      container.querySelector(`#crm-pane-${tab.dataset.tab}`).classList.add('active');
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

  // V77.1: expose openContactModal globally so deal-modal flows can open a
  // contact's master-record CRM modal as a sub-overlay (e.g. "Edit contact
  // details" from inside the Add Contact form on a deal modal).
  // V77.2g — Accept optional callback. When called as openContactModal(id),
  // opens for view/edit. When called as openContactModal(null, cb), opens the
  // creation form; cb(newContactId) fires on save (used by other UIs that need
  // to immediately reuse the just-created contact).
  window.openContactModal = function (contactId, onCreated) {
    if (contactId) {
      openModal(modal => renderContactDetail(modal, contactId, () => closeModal()));
    } else {
      openModal(modal => renderContactModal(modal, null, (created) => {
        closeModal();
        if (typeof onCreated === 'function' && created?.id) onCreated(created.id);
      }));
    }
  };

  // V77.2g+ — Body-mounted variant for callsites where the CRM view is hidden
  // (e.g. kanban deal modals). The CRM-view-scoped openContactModal above
  // shows its overlay inside #crmViewContent, which is itself a child of
  // #crmView (display:none until the user navigates to CRM). When called
  // from a deal modal in the kanban board, that overlay is rendered into a
  // hidden parent and the modal never appears. This standalone variant
  // attaches a fresh .crm-modal-overlay directly to <body>, independent of
  // #crmView visibility, so the modal is always visible.
  window.openContactModalStandalone = function (contactId, onCreated) {
    const overlay = document.createElement('div');
    overlay.className = 'crm-modal-overlay';
    overlay.style.display = '';
    const modal = document.createElement('div');
    modal.className = 'crm-modal';
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const close = () => { overlay.remove(); };
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

    if (contactId) {
      renderContactDetail(modal, contactId, close);
    } else {
      renderContactModal(modal, null, (created) => {
        close();
        if (typeof onCreated === 'function' && created?.id) onCreated(created.id);
      });
    }
  };

  // V75.5.2: Sync in-memory pipeline state + map pins + CRM caches after a
  // CRM modal deletes a Parcel or Property directly (bypassing Kanban's
  // removeFromPipeline). The server DELETE cascades to deals; this helper
  // makes the in-memory pipeline dict and map pins catch up.
  //
  // Pass ONE of { parcelId, propertyId }. The helper:
  //   - Finds any pipeline[] entries whose deal references the entity and
  //     removes them from the dict
  //   - Calls refreshPipelinePins() to redraw star pins off the updated dict
  //   - Invalidates both CRM Parcels and Properties caches
  function _syncAfterEntityDelete({ parcelId, propertyId } = {}) {
    try {
      if (typeof pipeline !== 'undefined' && pipeline) {
        const toDelete = [];
        for (const [dealId, entry] of Object.entries(pipeline)) {
          if (!entry) continue;
          // Parcel-deals use entry._parcelId; property-deals reference property.id (== dealId for non-parcel)
          if (parcelId && entry._parcelId === parcelId) { toDelete.push(dealId); continue; }
          if (propertyId && (entry.property?.id === propertyId || dealId === propertyId)) {
            toDelete.push(dealId);
          }
        }
        for (const k of toDelete) delete pipeline[k];
        if (toDelete.length && typeof cacheSave === 'function') cacheSave(pipeline);
        if (toDelete.length && typeof renderBoard === 'function') renderBoard();
      }
    } catch (err) {
      console.warn('[crm sync] pipeline scrub failed:', err);
    }
    if (typeof window.refreshPipelinePins === 'function') {
      window.refreshPipelinePins();
    }
    if (window.CRM?.invalidateParcelsCache)    window.CRM.invalidateParcelsCache();
    if (window.CRM?.invalidatePropertiesCache) window.CRM.invalidatePropertiesCache();
  }

  // ── Contacts pane ──────────────────────────────────────────────────────────

  let contactSearch = '';
  let contactPage   = 0;
  let pageSize      = 50;

  async function loadContactsPane() {
    const pane = container.querySelector('#crm-pane-contacts');
    pane.innerHTML = `
      <div class="crm-pane-toolbar">
        <input class="kb-input crm-view-search" placeholder="Search… or category=edan, role=vendor, organisation=edan, discipline=builder" value="${contactSearch}">
        <select class="crm-page-size-select kb-input">
          <option value="50"  ${pageSize===50  ? 'selected':''}>50 per page</option>
          <option value="100" ${pageSize===100 ? 'selected':''}>100 per page</option>
          <option value="150" ${pageSize===150 ? 'selected':''}>150 per page</option>
          <option value="200" ${pageSize===200 ? 'selected':''}>200 per page</option>
        </select>
        <button class="crm-pane-add-btn" data-role="pane-add-contact">+ New Contact</button>
      </div>
      <div class="crm-contact-table-wrap">
        <table class="crm-contact-table">
          <thead><tr>
            <th>Name</th><th>Organisation</th><th>Roles</th><th>Categories</th><th>Mobile</th><th>Email</th><th>Properties</th><th></th>
          </tr></thead>
          <tbody id="crmContactTableBody"><tr><td colspan="8" class="crm-loading">Loading…</td></tr></tbody>
        </table>
      </div>
      <div class="crm-pane-pagination" id="crmContactPagination"></div>`;

    pane.querySelector('.crm-view-search').addEventListener('input', e => {
      contactSearch = e.target.value;
      contactPage   = 0;
      fetchContacts();
    });
    pane.querySelector('.crm-page-size-select').addEventListener('change', e => {
      pageSize    = parseInt(e.target.value, 10);
      contactPage = 0;
      fetchContacts();
    });
    pane.querySelector('[data-role="pane-add-contact"]').addEventListener('click', () => {
      openModal(modal => renderContactModal(modal, null, () => { closeModal(); loadContactsPane(); }));
    });

    fetchContacts();
  }

  async function fetchContacts() {
    const pane   = container.querySelector('#crm-pane-contacts');
    const tbody  = pane?.querySelector('#crmContactTableBody');
    const pagEl  = pane?.querySelector('#crmContactPagination');
    if (!tbody) return;

    tbody.innerHTML = `<tr><td colspan="8" class="crm-loading">Loading…</td></tr>`;
    try {
      const params = { all: '1', offset: contactPage * pageSize, limit: pageSize };
      if (contactSearch) params.search = contactSearch;
      const data = await apiGet(params);
      const contacts = Array.isArray(data) ? data : (data.contacts || []);
      const total    = data.total ?? contacts.length;

      if (!contacts.length) {
        tbody.innerHTML = `<tr><td colspan="8" class="crm-empty">No contacts found</td></tr>`;
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
          <td>${c.roles_label ? `<span class="crm-roles-label">${c.roles_label}</span>` : '—'}</td>
          <td>${c.categories_label ? `<span class="crm-roles-label">${c.categories_label}</span>` : '—'}</td>
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
          // V76.7+ — site-styled confirm modal (matches kanban + property + parcel UX).
          const name = displayName(c);
          if (!window.openConfirmModal) {
            if (!confirm(`Permanently delete ${name}? This cannot be undone.`)) return;
            await apiDelete({ id: c.id });
            fetchContacts();
            return;
          }
          window.openConfirmModal({
            title:        'Delete this contact?',
            subject:      name,
            bodyHtml:     'This is <strong style="color:#c0392b">permanent</strong> — it deletes the contact record and any links to deals or properties.<br><br>It cannot be undone from the UI.',
            confirmLabel: 'Delete',
            onConfirm: async () => {
              await apiDelete({ id: c.id });
              fetchContacts();
            },
          });
        });

        tbody.appendChild(tr);
      });

      // Pagination
      if (pagEl) {
        const totalPages = Math.ceil(total / pageSize);
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
      if (tbody) tbody.innerHTML = `<tr><td colspan="8" class="crm-empty">Error loading contacts</td></tr>`;
    }
  }

  // ── Contact detail modal ──────────────────────────────────────────────────

  async function renderContactDetail(modal, contactId, onDone) {
    modal.innerHTML = '<div class="crm-modal-loading">Loading…</div>';
    try {
      const [contactData, notes, props, allPipeline, me, propScopeRoles, dealScopeRoles, contactActions, contactGroups, buyerProfile, marketingActivity, allCategoriesData, allRolesData] = await Promise.all([
        apiGet({ id: contactId }),
        fetch(`/api/notes?by_contact=${encodeURIComponent(contactId)}`).then(r => r.ok ? r.json() : []).catch(() => []),
        apiGet({ contact_properties: '1', contact_id: contactId }).catch(() => []),
        apiGet({ pipeline_list: '1' }).catch(() => []),
        fetch('/api/auth/me').then(r => r.json()).catch(() => ({ authenticated: false })),
        rolesForScope('property'),
        rolesForScope('deal'),
        // V80 — actions where this contact is an assignee
        fetch(`/api/actions?contact_id=${encodeURIComponent(contactId)}`).then(r => r.ok ? r.json() : []).catch(() => []),
        // V82.b — contact roles and marketing categories
        fetch(`/api/contact-groups?contact_id=${encodeURIComponent(contactId)}`).then(r => r.ok ? r.json() : {}).catch(() => {}),
        // V82.b — buyer profile
        fetch(`/api/contact-buyer-profile?contact_id=${encodeURIComponent(contactId)}`).then(r => r.ok ? r.json() : {}).catch(() => {}),
        // V82.b — marketing activity
        fetch(`/api/contact-marketing-activity?contact_id=${encodeURIComponent(contactId)}`).then(r => r.ok ? r.json() : {}).catch(() => {}),
        // V82.b — all categories for multi-select
        fetch('/api/contact-marketing-categories').then(r => r.ok ? r.json() : {categories:[]}).catch(() => ({categories:[]})),
        // V82.b — all active roles for roles multi-select
        fetch('/api/roles?active=1').then(r => r.ok ? r.json() : []).catch(() => []),
      ]);
      const c = Array.isArray(contactData) ? contactData[0] : contactData;
      if (!c) { modal.innerHTML = '<div class="crm-modal-loading">Not found</div>'; return; }

      // Derive source from earliest note that has a source label (V82.b)
      const sortedNotes = [...notes].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
      const firstSourceNote = sortedNotes.find(n => n.source_label_text);
      const contactSource = firstSourceNote?.source_label_text ?? null;

      // Local HTML-escape helper for the V80 Action Requests section.
      const esc = (s) => String(s ?? '').replace(/[&<>"']/g, ch =>
        ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])
      );

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
            ${c.org_name ? `<div class="crm-modal-subtitle">${c.org_name}</div>` : ''}
          </div>
          <button class="crm-modal-close">✕</button>
        </div>
        <div class="crm-modal-body">

          <div class="crm-modal-section">
            <div class="crm-modal-section-title crm-section-header">
              <span class="crm-section-header-left">Contact Details</span>
              <button class="crm-modal-edit-btn kb-add-offer-btn">✎ Edit</button>
            </div>
            <div class="crm-detail-grid">
              ${c.mobile       ? `<div class="crm-detail-label">Mobile</div><div><a href="tel:${c.mobile}" class="crm-link">${c.mobile}</a></div>` : ""}
              ${c.email        ? `<div class="crm-detail-label">Email</div><div><a href="mailto:${c.email}" class="crm-link">${c.email}</a></div>` : ""}
              ${c.org_name     ? `<div class="crm-detail-label">Organisation</div><div>${c.org_name}</div>` : ""}
              ${contactSource  ? `<div class="crm-detail-label">Source</div><div>${contactSource}</div>` : ""}
              ${(contactGroups?.roles?.length) ? `<div class="crm-detail-label">Roles</div><div>${contactGroups.roles.map(r => r.label).join(', ')}</div>` : ''}
              ${c.discipline       ? `<div class="crm-detail-label">Discipline</div><div>${c.discipline}</div>` : ""}
              ${c.last_contacted_at ? `<div class="crm-detail-label">Last Contacted</div><div>${new Date(c.last_contacted_at).toLocaleDateString()}</div>` : ""}
            </div>
          </div>

          <!-- Marketing Preferences — V79 read-only status, V82.b adds manual update -->
          <div class="crm-modal-section">
            <div class="crm-modal-section-title crm-section-header">
              <span class="crm-section-header-left">Marketing Preferences</span>
              <button class="crm-mkt-edit-btn kb-add-offer-btn">✎ Edit</button>
            </div>
            <div class="crm-mkt-display">
              ${(() => {
                const dns       = !!c.do_not_send_marketing_at;
                const email     = !!c.marketing_email_consent_at;
                const sms       = !!c.marketing_sms_consent_at;
                const prefSetAt = c.marketing_pref_set_at;
                let statusLabel, statusClass;
                if (!prefSetAt) {
                  statusLabel = 'Not yet confirmed';
                  statusClass = 'crm-mkt-unset';
                } else if (dns) {
                  statusLabel = 'Do not send marketing';
                  statusClass = 'crm-mkt-dns';
                } else if (email && sms) {
                  statusLabel = 'Email + SMS';
                  statusClass = 'crm-mkt-yes';
                } else if (email) {
                  statusLabel = 'Email only';
                  statusClass = 'crm-mkt-yes';
                } else if (sms) {
                  statusLabel = 'SMS only';
                  statusClass = 'crm-mkt-yes';
                } else {
                  statusLabel = 'Asked, no marketing channels';
                  statusClass = 'crm-mkt-none';
                }
                const lastSet  = prefSetAt ? new Date(prefSetAt).toLocaleString() : '—';
                const setBy    = c.marketing_pref_set_by || null;
                return `
                  <div class="crm-detail-grid">
                    <div class="crm-detail-label">Status</div>
                    <div><span class="crm-mkt-status ${statusClass}">${statusLabel}</span></div>
                    <div class="crm-detail-label">Categories</div>
                    <div>${(contactGroups?.marketing_categories?.length) ? contactGroups.marketing_categories.join(', ') : '<span class="crm-muted">None</span>'}</div>
                    <div class="crm-detail-label">Last set</div>
                    <div>${lastSet}${setBy ? ` <span class="crm-muted">by ${setBy}</span>` : ''}</div>
                  </div>`;
              })()}
            </div>


            <div class="crm-mkt-edit-form" style="display:none">
              <div class="crm-detail-grid" style="margin-top:8px">
                <div class="crm-detail-label">Email</div>
                <div>
                  <label class="crm-mkt-toggle"><input type="checkbox" class="crm-mkt-email-chk"> Subscribed</label>
                </div>
                <div class="crm-detail-label">SMS</div>
                <div>
                  <label class="crm-mkt-toggle"><input type="checkbox" class="crm-mkt-sms-chk"> Subscribed</label>
                </div>
                <div class="crm-detail-label">Do not contact</div>
                <div>
                  <label class="crm-mkt-toggle"><input type="checkbox" class="crm-mkt-dns-chk"> Do not send marketing</label>
                </div>
                <div class="crm-detail-label" style="align-self:start;padding-top:4px">Categories</div>
                <div>
                  <div class="crm-cat-checkboxes"></div>
                </div>
              </div>
              <div style="display:flex;gap:8px;margin-top:10px">
                <button class="crm-mkt-save-btn kb-add-offer-btn">Save</button>
                <button class="crm-mkt-cancel-btn crm-cancel-btn">Cancel</button>
              </div>
            </div>
          </div>

          ${siteAccessHtml}

          <!-- V82.b — Buyer Profile section -->
          ${buyerProfile && Object.keys(buyerProfile).some(k => k !== 'contact_id' && k !== 'updated_at' && buyerProfile[k] !== null) ? `
          <div class="crm-modal-section crm-section-collapsible" data-section="buyer-profile" data-collapsed="0">
            <div class="crm-modal-section-title crm-section-header">
              <span class="crm-section-header-left"><span class="crm-section-chev">▾</span> Buyer Profile</span>
              <button class="crm-bp-edit-btn kb-add-offer-btn">✎ Edit</button>
            </div>
            <div class="crm-section-body">
              <div class="crm-bp-display crm-detail-grid">
                ${buyerProfile.listing_types?.length  ? `<div class="crm-detail-label">Listing Types</div><div>${buyerProfile.listing_types.join(', ')}</div>` : ''}
                ${buyerProfile.property_types?.length ? `<div class="crm-detail-label">Property Types</div><div>${buyerProfile.property_types.join(', ')}</div>` : ''}
                ${(buyerProfile.min_price || buyerProfile.max_price) ? `<div class="crm-detail-label">Price Range</div><div>${[buyerProfile.min_price ? '$'+buyerProfile.min_price.toLocaleString() : 'Any', buyerProfile.max_price ? '$'+buyerProfile.max_price.toLocaleString() : 'Any'].join(' – ')}</div>` : ''}
                ${(buyerProfile.min_rent || buyerProfile.max_rent) ? `<div class="crm-detail-label">Rent Range</div><div>${[buyerProfile.min_rent ? '$'+buyerProfile.min_rent.toLocaleString() : 'Any', buyerProfile.max_rent ? '$'+buyerProfile.max_rent.toLocaleString() : 'Any'].join(' – ')}</div>` : ''}
                ${(buyerProfile.min_bedrooms || buyerProfile.max_bedrooms) ? `<div class="crm-detail-label">Bedrooms</div><div>${[buyerProfile.min_bedrooms ?? 'Any', buyerProfile.max_bedrooms ?? 'Any'].join(' – ')}</div>` : ''}
                ${(buyerProfile.min_bathrooms || buyerProfile.max_bathrooms) ? `<div class="crm-detail-label">Bathrooms</div><div>${[buyerProfile.min_bathrooms ?? 'Any', buyerProfile.max_bathrooms ?? 'Any'].join(' – ')}</div>` : ''}
                ${(buyerProfile.min_car_spaces || buyerProfile.max_car_spaces) ? `<div class="crm-detail-label">Car Spaces</div><div>${[buyerProfile.min_car_spaces ?? 'Any', buyerProfile.max_car_spaces ?? 'Any'].join(' – ')}</div>` : ''}
                ${(buyerProfile.min_land_size_sqm || buyerProfile.max_land_size_sqm) ? `<div class="crm-detail-label">Land Size</div><div>${[buyerProfile.min_land_size_sqm ? buyerProfile.min_land_size_sqm.toLocaleString()+'m²' : 'Any', buyerProfile.max_land_size_sqm ? buyerProfile.max_land_size_sqm.toLocaleString()+'m²' : 'Any'].join(' – ')}</div>` : ''}
                ${buyerProfile.postcode_preferences?.length ? `<div class="crm-detail-label">Postcodes</div><div>${buyerProfile.postcode_preferences.join(', ')}</div>` : ''}
                ${buyerProfile.commercial_listing_type ? `<div class="crm-detail-label">Commercial Type</div><div>${buyerProfile.commercial_listing_type}</div>` : ''}
                ${buyerProfile.max_commercial_rent ? `<div class="crm-detail-label">Max Commercial Rent</div><div>$${buyerProfile.max_commercial_rent.toLocaleString()}</div>` : ''}
                ${buyerProfile.updated_at ? `<div class="crm-detail-label">Last Updated</div><div>${new Date(buyerProfile.updated_at).toLocaleDateString()}</div>` : ''}
              </div>
              <div class="crm-bp-edit-form" style="display:none">
                <div class="crm-detail-grid">
                  <div class="crm-detail-label">Listing Types</div><div><input class="kb-input crm-bp-listing-types" value="${(buyerProfile.listing_types||[]).join(', ')}" placeholder="e.g. land, residential_sale"></div>
                  <div class="crm-detail-label">Property Types</div><div><input class="kb-input crm-bp-property-types" value="${(buyerProfile.property_types||[]).join(', ')}" placeholder="e.g. house, townhouse"></div>
                  <div class="crm-detail-label">Min Price</div><div><input type="number" class="kb-input crm-bp-min-price" value="${buyerProfile.min_price ?? ''}"></div>
                  <div class="crm-detail-label">Max Price</div><div><input type="number" class="kb-input crm-bp-max-price" value="${buyerProfile.max_price ?? ''}"></div>
                  <div class="crm-detail-label">Min Rent</div><div><input type="number" class="kb-input crm-bp-min-rent" value="${buyerProfile.min_rent ?? ''}"></div>
                  <div class="crm-detail-label">Max Rent</div><div><input type="number" class="kb-input crm-bp-max-rent" value="${buyerProfile.max_rent ?? ''}"></div>
                  <div class="crm-detail-label">Min Bedrooms</div><div><input type="number" class="kb-input crm-bp-min-bed" value="${buyerProfile.min_bedrooms ?? ''}"></div>
                  <div class="crm-detail-label">Max Bedrooms</div><div><input type="number" class="kb-input crm-bp-max-bed" value="${buyerProfile.max_bedrooms ?? ''}"></div>
                  <div class="crm-detail-label">Min Bathrooms</div><div><input type="number" class="kb-input crm-bp-min-bath" value="${buyerProfile.min_bathrooms ?? ''}"></div>
                  <div class="crm-detail-label">Max Bathrooms</div><div><input type="number" class="kb-input crm-bp-max-bath" value="${buyerProfile.max_bathrooms ?? ''}"></div>
                  <div class="crm-detail-label">Min Car Spaces</div><div><input type="number" class="kb-input crm-bp-min-car" value="${buyerProfile.min_car_spaces ?? ''}"></div>
                  <div class="crm-detail-label">Max Car Spaces</div><div><input type="number" class="kb-input crm-bp-max-car" value="${buyerProfile.max_car_spaces ?? ''}"></div>
                  <div class="crm-detail-label">Min Land (m²)</div><div><input type="number" class="kb-input crm-bp-min-land" value="${buyerProfile.min_land_size_sqm ?? ''}"></div>
                  <div class="crm-detail-label">Max Land (m²)</div><div><input type="number" class="kb-input crm-bp-max-land" value="${buyerProfile.max_land_size_sqm ?? ''}"></div>
                  <div class="crm-detail-label">Postcodes</div><div><input class="kb-input crm-bp-postcodes" value="${(buyerProfile.postcode_preferences||[]).join(', ')}" placeholder="Comma separated"></div>
                  <div class="crm-detail-label">Commercial Type</div><div><input class="kb-input crm-bp-comm-type" value="${buyerProfile.commercial_listing_type ?? ''}"></div>
                  <div class="crm-detail-label">Max Comm. Rent</div><div><input type="number" class="kb-input crm-bp-max-comm-rent" value="${buyerProfile.max_commercial_rent ?? ''}"></div>
                </div>
                <div style="display:flex;gap:8px;margin-top:12px">
                  <button class="crm-bp-save-btn kb-add-offer-btn">Save</button>
                  <button class="crm-bp-cancel-btn crm-cancel-btn">Cancel</button>
                </div>
              </div>
            </div>
          </div>` : ''}

          <!-- V82.b — Marketing Activity section -->
          ${marketingActivity && marketingActivity.contact_id ? `
          <div class="crm-modal-section crm-section-collapsible" data-section="marketing-activity" data-collapsed="1">
            <div class="crm-modal-section-title crm-section-header">
              <span class="crm-section-header-left"><span class="crm-section-chev">▸</span> Marketing Activity</span>
            </div>
            <div class="crm-section-body" style="display:none">
              <div class="crm-detail-grid">
                ${marketingActivity.activity_score != null ? `<div class="crm-detail-label">Activity Score</div><div>${marketingActivity.activity_score}</div>` : ''}
                <div class="crm-detail-label">Email Opens</div><div>${marketingActivity.email_opens ?? 0}</div>
                <div class="crm-detail-label">Email Clicks</div><div>${marketingActivity.email_clicks ?? 0}</div>
                <div class="crm-detail-label">Page Views</div><div>${marketingActivity.page_views ?? 0}</div>
                ${marketingActivity.last_email_open_at ? `<div class="crm-detail-label">Last Email Open</div><div>${new Date(marketingActivity.last_email_open_at).toLocaleDateString()}</div>` : ''}
                ${marketingActivity.last_click_at ? `<div class="crm-detail-label">Last Click</div><div>${new Date(marketingActivity.last_click_at).toLocaleDateString()}</div>` : ''}
                ${marketingActivity.last_campaign ? `<div class="crm-detail-label">Last Campaign</div><div>${marketingActivity.last_campaign}</div>` : ''}
                ${marketingActivity.updated_at ? `<div class="crm-detail-label">Last Updated</div><div>${new Date(marketingActivity.updated_at).toLocaleDateString()}</div>` : ''}
              </div>
            </div>
          </div>` : ''}

          <!-- V80 — Pending Action Requests on this contact (joined via
               action_assignees from check-in triggers, etc.). Read-only
               summary; full details on the assignee's My Actions board. -->
          <div class="crm-modal-section crm-section-collapsible" data-section="action-requests">
            <div class="crm-modal-section-title crm-section-header">
              <span class="crm-section-header-left"><span class="crm-section-chev">▾</span> Action Requests <span class="crm-section-count">(${(contactActions || []).length})</span></span>
            </div>
            <div class="crm-section-body">
              ${(() => {
                if (!contactActions || !contactActions.length) {
                  return '<div class="crm-empty">No outstanding action requests for this contact.</div>';
                }
                const statusBadge = (s) => {
                  const map = {
                    todo: ['ToDo',  '#64748b'],
                    wip:  ['WIP',   '#2563eb'],
                    due:  ['Due',   '#dc2626'],
                    done: ['Done',  '#16a34a'],
                    void: ['Void',  '#94a3b8'],
                  };
                  const [label, color] = map[s] || [s, '#94a3b8'];
                  return `<span style="background:${color};color:white;padding:2px 8px;border-radius:9px;font-size:11px;font-weight:500">${label}</span>`;
                };
                const fmtDate = (d) => d ? new Date(d).toLocaleDateString('en-AU') : '';
                return contactActions.map(a => {
                  const assignees = (a.assignees || []).map(x => x.name).filter(Boolean).join(', ') || '(unassigned)';
                  const due = a.due_date ? `Due ${fmtDate(a.due_date)}` : '';
                  return `
                    <div class="crm-action-request-row">
                      <div class="crm-action-request-main">
                        ${statusBadge(a.status)}
                        <span class="crm-action-request-desc">${esc(a.description || '')}</span>
                      </div>
                      <div class="crm-action-request-meta">
                        <span>Assigned to: ${esc(assignees)}</span>
                        ${due ? `<span>${esc(due)}</span>` : ''}
                        ${a.deal?.label ? `<span>🔗 ${esc(a.deal.label)}</span>` : ''}
                      </div>
                    </div>
                  `;
                }).join('');
              })()}
            </div>
          </div>

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
                      ${propScopeRoles.map(r => `<option value="${r.value}" ${r.value === p.role ? "selected" : ""}>${r.label}</option>`).join("")}
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
                    ${propScopeRoles.map(r => `<option value="${r.value}">${r.label}</option>`).join("")}
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
                      ${dealScopeRoles.map(r => `<option value="${r.value}" ${r.value === d.role ? "selected" : ""}>${r.label}</option>`).join("")}
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
                    ${dealScopeRoles.map(r => `<option value="${r.value}">${r.label}</option>`).join("")}
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
                <div class="v77-note-form-mount-contact-modal"></div>
              </div>
              <div class="crm-modal-notes-list">
                ${notes.length ? notes.map(n => {
                  const author = n.author_name || 'Unknown';
                  const sourceBadge = n.source_label_text
                    ? `<span class="crm-note-source">${n.source_label_text}</span>`
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

      // ── Marketing preference edit (V82.b) ────────────────────────────────
      const mktEditBtn    = modal.querySelector(".crm-mkt-edit-btn");
      const mktDisplay    = modal.querySelector(".crm-mkt-display");
      const mktEditForm   = modal.querySelector(".crm-mkt-edit-form");
      const mktSaveBtn    = modal.querySelector(".crm-mkt-save-btn");
      const mktCancelBtn  = modal.querySelector(".crm-mkt-cancel-btn");

      // Pre-tick checkboxes from current state
      const emailChk = mktEditForm.querySelector('.crm-mkt-email-chk');
      const smsChk   = mktEditForm.querySelector('.crm-mkt-sms-chk');
      const dnsChk   = mktEditForm.querySelector('.crm-mkt-dns-chk');
      emailChk.checked = !!c.marketing_email_consent_at;
      smsChk.checked   = !!c.marketing_sms_consent_at;
      dnsChk.checked   = !!c.do_not_send_marketing_at;

      mktEditBtn.addEventListener('click', () => {
        // Build category checkboxes inside the edit form on open
        const catChkboxes = mktEditForm.querySelector('.crm-cat-checkboxes');
        if (catChkboxes) {
          const allCats     = allCategoriesData?.categories ?? [];
          const currentCats = new Set(contactGroups?.marketing_categories ?? []);
          const allKnown    = [...new Set([...allCats, ...currentCats])].sort();
          catChkboxes.innerHTML = allKnown.map(cat => `
            <label class="crm-mkt-toggle" style="margin-bottom:4px">
              <input type="checkbox" value="${cat}" ${currentCats.has(cat) ? 'checked' : ''}> ${cat}
            </label>`).join('');

        }
        mktDisplay.style.display  = 'none';
        mktEditForm.style.display = 'block';
        mktEditBtn.style.display  = 'none';
      });
      mktCancelBtn.addEventListener('click', () => {
        mktDisplay.style.display  = '';
        mktEditForm.style.display = 'none';
        mktEditBtn.style.display  = '';
      });
      mktSaveBtn.addEventListener('click', async () => {
        const payload = {
          marketing_email_consent: emailChk.checked ? true : null,
          marketing_sms_consent:   smsChk.checked   ? true : null,
          do_not_send_marketing:   dnsChk.checked   ? true : null,
          marketing_pref_set:      true,
        };
        mktSaveBtn.disabled = true;
        mktSaveBtn.textContent = 'Saving…';
        try {
          // Save consent fields
          const r = await fetch(`/api/contacts?id=${contactId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          if (!r.ok) throw new Error(await r.text());
          // Save categories from the same form
          const catChkboxes = mktEditForm.querySelector('.crm-cat-checkboxes');
          if (catChkboxes) {
            const selected = [...catChkboxes.querySelectorAll('input:checked')].map(i => i.value);
            await fetch(`/api/contact-marketing-categories?contact_id=${contactId}`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ categories: selected }),
            });
          }
          await renderContactDetail(modal, contactId, onDone);
        } catch (err) {
          mktSaveBtn.disabled = false;
          mktSaveBtn.textContent = 'Save';
          alert('Failed to save: ' + err.message);
        }
      });

      // ── V82.b — Categories multi-select ─────────────────────────────────
      const catEditBtn    = modal.querySelector('.crm-cat-edit-btn');
      const catDisplay    = modal.querySelector('.crm-categories-display-wrap');
      const catEditForm   = modal.querySelector('.crm-cat-edit-form');
      const catSaveBtn    = modal.querySelector('.crm-cat-save-btn');
      const catCancelBtn  = modal.querySelector('.crm-cat-cancel-btn');
      const catCheckboxes = modal.querySelector('.crm-cat-checkboxes');
      const catNewInput   = modal.querySelector('.crm-cat-new-input');
      const catAddBtn     = modal.querySelector('.crm-cat-add-btn');

      if (catEditBtn && catEditForm) {
        const allCats = allCategoriesData?.categories ?? [];
        const currentCats = new Set(contactGroups?.marketing_categories ?? []);

        const buildCheckboxes = (cats) => {
          const allKnown = [...new Set([...allCats, ...currentCats, ...cats])].sort();
          catCheckboxes.innerHTML = allKnown.map(cat => `
            <label class="crm-mkt-toggle" style="margin-bottom:4px">
              <input type="checkbox" value="${cat}" ${currentCats.has(cat) || cats.includes(cat) ? 'checked' : ''}> ${cat}
            </label>`).join('');
        };
        buildCheckboxes([]);

        catEditBtn.addEventListener('click', () => {
          catEditForm.style.display = 'block';
          catEditBtn.style.display  = 'none';
        });
        catCancelBtn.addEventListener('click', () => {
          catEditForm.style.display = 'none';
          catEditBtn.style.display  = '';
        });
        catAddBtn.addEventListener('click', () => {
          const val = catNewInput.value.trim();
          if (!val) return;
          const checked = [...catCheckboxes.querySelectorAll('input:checked')].map(i => i.value);
          buildCheckboxes([...checked, val]);
          catNewInput.value = '';
        });
      }

      // ── V82.b — Buyer Profile edit/save ──────────────────────────────────
      const bpEditBtn   = modal.querySelector('.crm-bp-edit-btn');
      const bpDisplay   = modal.querySelector('.crm-bp-display');
      const bpEditForm  = modal.querySelector('.crm-bp-edit-form');
      const bpSaveBtn   = modal.querySelector('.crm-bp-save-btn');
      const bpCancelBtn = modal.querySelector('.crm-bp-cancel-btn');

      if (bpEditBtn && bpEditForm) {
        bpEditBtn.addEventListener('click', () => {
          bpDisplay.style.display  = 'none';
          bpEditForm.style.display = 'block';
          bpEditBtn.style.display  = 'none';
        });
        bpCancelBtn.addEventListener('click', () => {
          bpDisplay.style.display  = '';
          bpEditForm.style.display = 'none';
          bpEditBtn.style.display  = '';
        });
        bpSaveBtn.addEventListener('click', async () => {
          const f = bpEditForm;
          const splitArr = v => v ? v.split(',').map(s => s.trim()).filter(Boolean) : null;
          const intVal   = sel => { const v = parseInt(f.querySelector(sel)?.value); return isNaN(v) ? null : v; };
          const floatVal = sel => { const v = parseFloat(f.querySelector(sel)?.value); return isNaN(v) ? null : v; };
          const payload  = {
            listing_types:           splitArr(f.querySelector('.crm-bp-listing-types')?.value),
            property_types:          splitArr(f.querySelector('.crm-bp-property-types')?.value),
            min_price:               intVal('.crm-bp-min-price'),
            max_price:               intVal('.crm-bp-max-price'),
            min_rent:                intVal('.crm-bp-min-rent'),
            max_rent:                intVal('.crm-bp-max-rent'),
            min_bedrooms:            intVal('.crm-bp-min-bed'),
            max_bedrooms:            intVal('.crm-bp-max-bed'),
            min_bathrooms:           intVal('.crm-bp-min-bath'),
            max_bathrooms:           intVal('.crm-bp-max-bath'),
            min_car_spaces:          intVal('.crm-bp-min-car'),
            max_car_spaces:          intVal('.crm-bp-max-car'),
            min_land_size_sqm:       floatVal('.crm-bp-min-land'),
            max_land_size_sqm:       floatVal('.crm-bp-max-land'),
            postcode_preferences:    splitArr(f.querySelector('.crm-bp-postcodes')?.value),
            commercial_listing_type: f.querySelector('.crm-bp-comm-type')?.value.trim() || null,
            max_commercial_rent:     intVal('.crm-bp-max-comm-rent'),
          };
          bpSaveBtn.disabled = true; bpSaveBtn.textContent = 'Saving…';
          try {
            const r = await fetch(`/api/contact-buyer-profile?contact_id=${contactId}`, {
              method: 'PATCH', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload),
            });
            if (!r.ok) throw new Error(await r.text());
            await renderContactDetail(modal, contactId, onDone);
          } catch (err) {
            bpSaveBtn.disabled = false; bpSaveBtn.textContent = 'Save';
            alert('Failed to save: ' + err.message);
          }
        });
      }

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

      // V77.1 — Notes use the extended NoteForm (type+source dropdowns).
      // Toggling visibility of the panel still uses the +Add Note button.
      const addNoteBtn = modal.querySelector(".crm-modal-add-note-btn");
      const noteInput  = modal.querySelector(".crm-modal-note-input");
      const noteMount  = modal.querySelector(".v77-note-form-mount-contact-modal");
      let _crmNoteFormHandle = null;
      addNoteBtn.addEventListener("click", () => {
        noteInput.style.display = "";
        addNoteBtn.style.display = "none";
        if (window.NoteForm && noteMount && !_crmNoteFormHandle) {
          _crmNoteFormHandle = NoteForm.mount(noteMount, {
            placeholder: 'Add a note…',
            showContactTagger: false,
            onAdd: async (vals) => {
              const text = (vals.note_text || '').trim();
              if (!text) return;
              const body = {
                entity_type: 'contact',
                entity_id:   String(contactId),
                note_text:   text,
              };
              if (vals.interaction_type) body.interaction_type = vals.interaction_type;
              if (vals.source)           body.source           = vals.source;
              await fetch('/api/notes', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify(body),
              });
              renderContactDetail(modal, contactId, onDone);
            },
          });
        }
        if (_crmNoteFormHandle?.focus) _crmNoteFormHandle.focus();
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
              <label class="kb-field-label">Discipline</label>
              <select class="kb-input crm-discipline">
                <option value="">— None —</option>
              </select>
            </div>
          </div>
          <div class="crm-form-row">
            <div class="kb-field-wrap" style="flex:1">
              <label class="kb-field-label">Roles</label>
              <div class="crm-roles-checkboxes kb-input" style="height:auto;max-height:160px;overflow-y:auto;padding:8px">
                <div class="crm-roles-loading" style="color:var(--muted);font-size:12px">Loading roles…</div>
              </div>
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

    // Populate discipline dropdown from API
    const discSel = modal.querySelector('.crm-discipline');
    if (discSel) {
      fetch('/api/disciplines').then(r => r.ok ? r.json() : []).then(disciplines => {
        const active = disciplines.filter(d => d.active);
        active.forEach(d => {
          const opt = document.createElement('option');
          opt.value = d.label;
          opt.textContent = d.label;
          if (prefill?.discipline === d.label) opt.selected = true;
          discSel.appendChild(opt);
        });
      }).catch(() => {});
    }

    // Populate roles checkboxes from API
    const rolesWrap = modal.querySelector('.crm-roles-checkboxes');
    if (rolesWrap) {
      Promise.all([
        fetch('/api/roles?active=1').then(r => r.ok ? r.json() : []).catch(() => []),
        prefill?.id
          ? fetch(`/api/contact-groups?contact_id=${prefill.id}`).then(r => r.ok ? r.json() : {}).catch(() => ({}))
          : Promise.resolve({}),
      ]).then(([allRoles, groups]) => {
        const currentRoleIds = new Set((groups?.roles ?? []).map(r => r.id));
        rolesWrap.innerHTML = allRoles.map(r => `
          <label class="crm-mkt-toggle" style="margin-bottom:4px;display:flex;align-items:center;gap:6px">
            <input type="checkbox" class="crm-role-chk" value="${r.id}" ${currentRoleIds.has(r.id) ? 'checked' : ''}> ${r.label}
          </label>`).join('');
      }).catch(() => { rolesWrap.innerHTML = ''; });
    }

    // V77.1c: Source field removed — source now lives only on notes.source

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
      const data = {
        first_name:      first,
        last_name:       modal.querySelector('.crm-last').value.trim(),
        mobile:          modal.querySelector('.crm-mobile').value.trim(),
        email:           modal.querySelector('.crm-email').value.trim(),
        organisation_id: selectedOrgId,
        discipline:      modal.querySelector('.crm-discipline')?.value || null,
      };
      let saved;
      if (isEdit) {
        saved = await apiPut({ id: prefill.id, ...data });
      } else {
        saved = await apiPost(data);
      }
      // Save roles if checkboxes present
      const roleChks = modal.querySelectorAll('.crm-role-chk');
      if (roleChks.length && saved?.id) {
        const selectedRoles = [...roleChks].filter(c => c.checked).map(c => c.value);
        await fetch(`/api/contact-groups?contact_id=${saved.id}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ roles: selectedRoles }),
        }).catch(() => {});
      }
      // V77.2g — pass saved contact to onDone callback so callers can
      // re-use the freshly-created/updated contact (e.g. inline link flows).
      onDone(saved);
    });

    // Delete (edit only) — V76.7+ site-styled confirm modal
    modal.querySelector('.crm-delete-btn')?.addEventListener('click', async () => {
      const name = displayName(prefill);
      if (!window.openConfirmModal) {
        if (!confirm(`Permanently delete ${name}? This cannot be undone.`)) return;
        await apiDelete({ id: prefill.id });
        onDone();
        return;
      }
      window.openConfirmModal({
        title:        'Delete this contact?',
        subject:      name,
        bodyHtml:     'This is <strong style="color:#c0392b">permanent</strong> — it deletes the contact record and any links to deals or properties.<br><br>It cannot be undone from the UI.',
        confirmLabel: 'Delete',
        onConfirm: async () => {
          await apiDelete({ id: prefill.id });
          onDone();
        },
      });
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
      // V76.4: each parameter expresses one intent. `org_search=q` returns
      // orgs matching q; `all_orgs=1` returns the unfiltered list. No mixing.
      const params = q ? { org_search: q } : { all_orgs: '1' };
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
          // V76.7+ — site-styled confirm modal.
          if (!window.openConfirmModal) {
            if (!confirm(`Delete organisation "${org.name}"?`)) return;
            await apiDelete({ org_id: org.id });
            fetchOrgs(orgSearch);
            return;
          }
          window.openConfirmModal({
            title:        'Delete this organisation?',
            subject:      org.name || 'Organisation',
            bodyHtml:     'This is <strong style="color:#c0392b">permanent</strong> — it deletes the organisation record and any links to contacts.<br><br>It cannot be undone from the UI.',
            confirmLabel: 'Delete',
            onConfirm: async () => {
              await apiDelete({ org_id: org.id });
              fetchOrgs(orgSearch);
            },
          });
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

      // V76.4: dropped the 200-row preload of all contacts — the new search
      // input loads matches on demand via /api/contacts?search=q.
      const orgContacts = isEdit
        ? await apiGet({ org_contacts: prefill.id }).catch(() => [])
        : [];

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
            <!-- V76.4: replaced static <select> dropdown with search-or-create
                 flow, matching the deal-modal contact form pattern. -->
            <div class="crm-org-add-contact-form" style="display:none;margin-bottom:8px">
              <input class="kb-input crm-org-contact-search" type="text" placeholder="Search existing contacts by name or email…" style="width:100%">
              <div class="crm-search-results crm-org-contact-search-results"></div>
              <div style="display:flex;gap:6px;margin-top:6px;justify-content:flex-end">
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

      // V76.4: search-or-link contact in org modal (replaces dropdown).
      // Mirrors the deal-modal contact search pattern: type → debounced
      // /api/contacts?search=q → click result → POST set_org → re-render.
      const addContactBtn  = modal.querySelector('.crm-org-add-contact-btn');
      const addContactForm = modal.querySelector('.crm-org-add-contact-form');
      addContactBtn?.addEventListener('click', () => {
        addContactForm.style.display = '';
        addContactBtn.style.display = 'none';
        modal.querySelector('.crm-org-contact-search')?.focus();
      });
      modal.querySelector('.crm-org-contact-link-cancel')?.addEventListener('click', () => {
        addContactForm.style.display = 'none';
        addContactBtn.style.display = '';
        const searchInput  = modal.querySelector('.crm-org-contact-search');
        const resultsEl    = modal.querySelector('.crm-org-contact-search-results');
        if (searchInput) searchInput.value = '';
        if (resultsEl)   resultsEl.innerHTML = '';
      });

      const contactSearchInput = modal.querySelector('.crm-org-contact-search');
      if (contactSearchInput) {
        let searchTimer;
        contactSearchInput.addEventListener('input', () => {
          clearTimeout(searchTimer);
          const q = contactSearchInput.value.trim();
          const resultsEl = modal.querySelector('.crm-org-contact-search-results');
          if (!resultsEl) return;
          if (q.length < 2) { resultsEl.innerHTML = ''; return; }
          searchTimer = setTimeout(async () => {
            const results = await apiGet({ search: q }).catch(() => []);
            // Filter out anyone already in this org
            const orgContactIds = new Set(orgContacts.map(c => c.id));
            const filtered = (Array.isArray(results) ? results : []).filter(c => !orgContactIds.has(c.id));
            if (!filtered.length) { resultsEl.innerHTML = '<div class="crm-empty">No matches</div>'; return; }
            resultsEl.innerHTML = '';
            filtered.forEach(ct => {
              const item = document.createElement('div');
              item.className = 'crm-search-item';
              item.innerHTML = `<strong>${displayName(ct)}</strong>${ct.org_name ? ` · ${ct.org_name}` : ''}${ct.mobile || ct.email ? ` · ${ct.mobile || ct.email}` : ''}`;
              item.addEventListener('click', async () => {
                await apiPost({ action: 'set_org', contact_id: ct.id, organisation_id: prefill.id });
                render();
              });
              resultsEl.appendChild(item);
            });
          }, 300);
        });
      }

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

  // Expose a cache-bust hook for external code that mutates parcels
  // (e.g. map.js after creating a parcel via +Pipeline multi-select).
  // If the Parcels tab is currently active, also re-render it.
  if (window.CRM) {
    window.CRM.invalidateParcelsCache = () => {
      _parcelsCache = null;
      const pane = container.querySelector('#crm-pane-parcels');
      if (pane && pane.classList.contains('active')) {
        renderParcelRows();
      }
    };
  }

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
      // V76.4.5: read-only vendor terms & offers history aggregated from
      // every deal attached to this parcel.
      const vendorHistory = (typeof aggregateDealHistory === 'function')
        ? aggregateDealHistory(parcelDeals)
        : [];

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
          <div class="crm-modal-header-actions">
            <button class="crm-parcel-delete-btn crm-modal-delete"
              ${parcelDeals.length ? 'disabled' : ''}
              title="${parcelDeals.length ? `Cannot delete — ${parcelDeals.length} deal${parcelDeals.length === 1 ? '' : 's'} reference this parcel` : 'Delete'}">
              Delete
            </button>
            <button class="crm-modal-close">✕</button>
          </div>
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
              ${closedCount ? `<span class="crm-section-meta" style="font-size:11px;color:var(--muted)">(history: ${closedCount} closed)</span>` : ''}
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

          <!-- V76.4.5: read-only vendor terms & offers history aggregated from
               all deals attached to this parcel. -->
          <div class="crm-modal-section crm-section-collapsible" data-section="vendor-history" ${vendorHistory.length ? '' : 'data-collapsed="1"'}>
            <div class="crm-modal-section-title crm-section-header">
              <span class="crm-section-header-left"><span class="crm-section-chev">${vendorHistory.length ? '▾' : '▸'}</span> Vendor Terms &amp; Offers <span class="crm-section-count">(${vendorHistory.length})</span></span>
            </div>
            <div class="crm-section-body" ${vendorHistory.length ? '' : 'style="display:none"'}>
              ${buildVendorHistoryHtml(vendorHistory)}
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
                <div class="v77-note-form-mount-parcel-modal"></div>
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
        window.CRM?.notifyParcelChanged?.(parcel.id);
        renderParcelModal(modal, parcelId, onDone);
      });

      // V75.4d: Delete parcel — confirm, then DELETE. API refuses if deals exist (409).
      modal.querySelector('.crm-parcel-delete-btn')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        if (btn.disabled) return;
        // V76.7+ — site-styled confirm modal (matches kanban + property delete UX).
        if (!window.openConfirmModal) {
          if (!confirm('Delete this parcel?')) return;
          await _doDeleteParcel();
        } else {
          window.openConfirmModal({
            title:        'Delete this parcel?',
            subject:      parcel.name || parcel.id,
            bodyHtml:     'This is <strong style="color:#c0392b">permanent</strong> — it deletes the parcel record and any associated child properties.<br><br>It cannot be undone from the UI.',
            confirmLabel: 'Delete',
            onConfirm:    _doDeleteParcel,
          });
        }
        async function _doDeleteParcel() {
          const r = await fetch(`/api/parcels?id=${encodeURIComponent(parcel.id)}`, { method: 'DELETE' });
          if (r.ok) {
            // V75.5.2: sync in-memory pipeline dict, map pins, and CRM caches
            _syncAfterEntityDelete({ parcelId: parcel.id });
            onDone();
          } else {
            const err = await r.json().catch(() => ({}));
            alert(`Failed to delete: ${err.error || r.status}`);
          }
        }
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
        window.CRM?.notifyParcelChanged?.(parcel.id);
        renderParcelModal(modal, parcelId, onDone);
      });
      modal.querySelector('.crm-parcel-clear-ns-btn')?.addEventListener('click', async () => {
        await fetch('/api/parcels', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'clear_not_suitable', id: parcel.id }),
        });
        window.CRM?.notifyParcelChanged?.(parcel.id);
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
          window.CRM?.notifyParcelChanged?.(parcel.id);
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

      // V76.4.5: vendor terms & offers history — deal-id links open the deal modal
      modal.querySelectorAll('.crm-vendor-history-deal-link').forEach(a => {
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

      // V77.1 — Notes use the extended NoteForm.
      const addNoteBtn = modal.querySelector('.crm-parcel-add-note-btn');
      const noteInput  = modal.querySelector('.crm-parcel-note-input');
      const noteMount  = modal.querySelector('.v77-note-form-mount-parcel-modal');
      let _parcelNoteFormHandle = null;
      addNoteBtn.addEventListener('click', () => {
        noteInput.style.display = '';
        addNoteBtn.style.display = 'none';
        if (window.NoteForm && noteMount && !_parcelNoteFormHandle) {
          _parcelNoteFormHandle = NoteForm.mount(noteMount, {
            placeholder: 'Add a note…',
            showContactTagger: true,
            onAdd: async (vals) => {
              const text = (vals.note_text || '').trim();
              if (!text) return;
              const body = {
                entity_type: 'parcel',
                entity_id:   parcel.id,
                note_text:   text,
              };
              if (vals.tagged_contact_id) body.tagged_contact_id = vals.tagged_contact_id;
              if (vals.interaction_type)  body.interaction_type  = vals.interaction_type;
              if (vals.source)            body.source            = vals.source;
              await fetch('/api/notes', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify(body),
              });
              renderParcelModal(modal, parcelId, onDone);
            },
          });
        }
        if (_parcelNoteFormHandle?.focus) _parcelNoteFormHandle.focus();
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

  // ── Properties pane (V75.5) ────────────────────────────────────────────────
  let propertySearch = '';
  // V76.5.4 — Properties filter: hide rows currently flagged not-suitable.
  // Default OFF (hidden) so the main list stays focused on active workspace.
  // Toggle ON exposes properties whose not_suitable_until is in the future.
  let showScreenedOut = false;
  let _propertiesCache = null;

  // Expose cache-bust hook for external code that mutates properties.
  // Same pattern as invalidateParcelsCache (V75.4d.3).
  if (window.CRM) {
    window.CRM.invalidatePropertiesCache = () => {
      _propertiesCache = null;
      const pane = container.querySelector('#crm-pane-properties');
      if (pane && pane.classList.contains('active')) {
        renderPropertyRows();
      }
    };

    // V76.7 — broadcast property/parcel mutations so other modules (kanban
    // pipeline cards, map pins) can refresh their stale in-memory copies
    // without requiring a hard page refresh. Match the existing CustomEvent
    // pattern used by router.js.
    window.CRM.notifyPropertyChanged = (propertyId) => {
      if (!propertyId) return;
      _propertiesCache = null; // also bust local cache
      window.dispatchEvent(new CustomEvent('propertyChanged', {
        detail: { propertyId: String(propertyId) },
      }));
    };
    window.CRM.notifyParcelChanged = (parcelId) => {
      if (!parcelId) return;
      window.dispatchEvent(new CustomEvent('parcelChanged', {
        detail: { parcelId: String(parcelId) },
      }));
    };
  }

  async function loadPropertiesPane() {
    const pane = container.querySelector('#crm-pane-properties');
    pane.innerHTML = `
      <div class="crm-pane-toolbar" style="display:flex;align-items:center;gap:12px">
        <input class="kb-input crm-view-search" placeholder="Search properties…" value="${propertySearch}" style="flex:1">
        <label class="crm-prop-screened-toggle" style="display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--text-secondary);white-space:nowrap;cursor:pointer">
          <input type="checkbox" class="crm-prop-screened-cb" ${showScreenedOut ? 'checked' : ''}>
          Show Not Suitable
        </label>
      </div>
      <div class="crm-contact-table-wrap">
        <table class="crm-contact-table crm-contact-table--properties">
          <thead><tr>
            <th>Address</th>
            <th>Suburb</th>
            <th>Lot/DP</th>
            <th>Domain</th>
            <th>Deal</th>
            <th></th>
          </tr></thead>
          <tbody id="crmPropertyTableBody"><tr><td colspan="6" class="crm-loading">Loading…</td></tr></tbody>
        </table>
      </div>`;

    pane.querySelector('.crm-view-search').addEventListener('input', e => {
      propertySearch = e.target.value;
      renderPropertyRows();
    });
    pane.querySelector('.crm-prop-screened-cb').addEventListener('change', e => {
      showScreenedOut = e.target.checked;
      renderPropertyRows();
    });

    await renderPropertyRows();
  }

  async function renderPropertyRows() {
    const pane  = container.querySelector('#crm-pane-properties');
    const tbody = pane?.querySelector('#crmPropertyTableBody');
    if (!tbody) return;

    try {
      if (!_propertiesCache) {
        const [properties, deals, parcels] = await Promise.all([
          fetch('/api/properties').then(r => r.ok ? r.json() : []).catch(() => []),
          fetch('/api/deals').then(r => r.ok ? r.json() : []).catch(() => []),
          fetch('/api/parcels').then(r => r.ok ? r.json() : []).catch(() => []),
        ]);

        // Index deals by both property_id and parcel_id
        const dealsByProperty = {};
        const dealsByParcel = {};
        for (const d of deals) {
          if (d.property_id) (dealsByProperty[d.property_id] ||= []).push(d);
          if (d.parcel_id)   (dealsByParcel[d.parcel_id]     ||= []).push(d);
        }
        const parcelsById = {};
        for (const p of parcels) parcelsById[p.id] = p;

        _propertiesCache = properties.map(p => {
          const pDeals = dealsByProperty[p.id] || [];
          const active = pDeals.find(d => d.status === 'active') || null;
          const parcel = p.parcel_id ? (parcelsById[p.parcel_id] || null) : null;
          // V75.5: if the property is a parcel-child, surface the parcel's active deal
          // as the "effective" deal for this row. Parcel-children don't have their own
          // deals; the parcel-level deal drives the lifecycle.
          const parcelActive = parcel ? (dealsByParcel[parcel.id] || []).find(d => d.status === 'active') : null;
          return {
            ...p,
            _deals:            pDeals,
            _activeDeal:       active,
            _parcel:           parcel,
            _parcelActiveDeal: parcelActive,
          };
        });
      }

      // V76.5.4 — Hide properties with an ACTIVE not-suitable flag unless the
      // user has toggled "Show screened-out". A flag is active when
      // not_suitable_until is in the future (or 'infinity' for permanent).
      // Cleared/expired flags do not hide the row — those rows stay visible
      // because they're no longer being actively avoided.
      const now = Date.now();
      const isCurrentlyScreened = (p) => {
        const v = p.not_suitable_until;
        if (!v) return false;
        if (typeof v === 'string' && /infinity/i.test(v)) return true;
        const t = Date.parse(v);
        return !Number.isNaN(t) && t > now;
      };

      const q = propertySearch.trim().toLowerCase();
      const baseRows = showScreenedOut
        ? _propertiesCache
        : _propertiesCache.filter(p => !isCurrentlyScreened(p));
      const rows = q
        ? baseRows.filter(p => {
            const blob = [p.address, p.suburb, p.lot_dps, p.state_prop_id].filter(Boolean).join(' ').toLowerCase();
            return blob.includes(q);
          })
        : baseRows;

      if (!rows.length) {
        tbody.innerHTML = `<tr><td colspan="6" class="crm-empty">${q ? 'No properties match' : 'No properties yet'}</td></tr>`;
        return;
      }

      tbody.innerHTML = '';
      for (const p of rows) {
        const tr = document.createElement('tr');
        tr.className = 'crm-contact-tr';

        const addr = p.address || '(no address)';
        const suburb = p.suburb || '';
        const lotDp = p.lot_dps || '';
        const listingUrl = p.listing_url || '';
        const domBadge = listingUrl
          ? `<a href="${listingUrl}" target="_blank" rel="noopener" class="domain-badge" onclick="event.stopPropagation()">
               <img src="https://ui-avatars.com/api/?name=D&size=12&background=1ea765&color=fff&bold=true&rounded=true" style="width:12px;height:12px;border-radius:50%;vertical-align:middle"> Domain
             </a>`
          : '';

        // Deal badge: prefer direct active deal; else parcel's active deal (for parcel-children); else dash
        const effectiveDeal = p._activeDeal || p._parcelActiveDeal || null;
        const dealBadge = effectiveDeal
          ? `<a href="#" class="crm-deal-open" data-deal-id="${effectiveDeal.id}" onclick="event.stopPropagation()"><span class="crm-deal-badge crm-deal-badge-stage">${effectiveDeal.stage}</span></a>`
          : '<span style="color:var(--text-secondary);font-size:12px">—</span>';

        tr.innerHTML = `
          <td class="crm-td-name"><strong>${addr}</strong></td>
          <td>${suburb}</td>
          <td style="font-size:11px;color:var(--text-secondary)">${lotDp}</td>
          <td>${domBadge}</td>
          <td>${dealBadge}</td>
          <td class="crm-td-actions"></td>`;

        tr.querySelector('.crm-td-name').addEventListener('click', () => {
          openModal(modal => renderPropertyModal(modal, p.id, () => {
            closeModal();
            _propertiesCache = null;
            renderPropertyRows();
          }));
        });

        tr.querySelector('.crm-deal-open')?.addEventListener('click', (e) => {
          e.preventDefault();
          const dealId = e.currentTarget.dataset.dealId;
          if (dealId && typeof window.openPipelineItem === 'function') {
            closeModal();
            window.openPipelineItem(dealId);
          }
        });

        tbody.appendChild(tr);
      }
    } catch (err) {
      console.error('[properties] fetch failed:', err);
      tbody.innerHTML = `<tr><td colspan="6" class="crm-empty">Failed to load properties</td></tr>`;
    }
  }

  // ── Property modal (V75.5) ─────────────────────────────────────────────────
  async function renderPropertyModal(modal, propertyId, onDone) {
    modal.innerHTML = '<div class="crm-modal-loading">Loading…</div>';
    try {
      const [properties, allDeals, allParcels, propContacts, propNotes] = await Promise.all([
        fetch('/api/properties').then(r => r.ok ? r.json() : []).catch(() => []),
        fetch('/api/deals').then(r => r.ok ? r.json() : []).catch(() => []),
        fetch('/api/parcels').then(r => r.ok ? r.json() : []).catch(() => []),
        fetch(`/api/contacts?entity_type=property&entity_id=${encodeURIComponent(propertyId)}`).then(r => r.ok ? r.json() : []).catch(() => []),
        fetch(`/api/notes?entity_type=property&entity_id=${encodeURIComponent(propertyId)}`).then(r => r.ok ? r.json() : []).catch(() => []),
      ]);
      const property = properties.find(p => p.id === propertyId);
      if (!property) { modal.innerHTML = '<div class="crm-modal-loading">Not found</div>'; return; }

      const parcel = property.parcel_id ? allParcels.find(x => x.id === property.parcel_id) : null;
      const propertyDeals = allDeals.filter(d => d.property_id === propertyId);
      // V76.4.5: for the read-only Vendor Terms & Offers history we ALSO want
      // to see deals on the parcel this property belongs to — that's where
      // parcel-level negotiations record their terms/offers, and they're
      // genuinely the history of this property too.
      const historyDeals = property.parcel_id
        ? allDeals.filter(d => d.property_id === propertyId || d.parcel_id === property.parcel_id)
        : propertyDeals;
      const vendorHistory = (typeof aggregateDealHistory === 'function')
        ? aggregateDealHistory(historyDeals)
        : [];
      const activeDeal  = propertyDeals.find(d => d.status === 'active') || null;
      const closedCount = propertyDeals.filter(d => d.status !== 'active').length;

      // Not-suitable state
      const nsRaw = property.not_suitable_until;
      const nsActive = !!(nsRaw && (String(nsRaw).includes('infinity') || new Date(nsRaw).getTime() > Date.now()));
      const nsLabel = !nsActive ? '' :
        (String(nsRaw).includes('infinity') ? 'Permanent' : `Until ${new Date(nsRaw).toLocaleDateString()}`);

      const workflowLabels = { acquisition: 'Acquisition', buyer_enquiry: 'Enquiry', agency_sales: 'Listing' };

      // Delete constraints: refuse if has deals or is part of a parcel
      const hasDeals = propertyDeals.length > 0;
      const inParcel = !!parcel;
      const deleteDisabled = hasDeals || inParcel;
      const deleteTooltip = hasDeals ? `Cannot delete — ${propertyDeals.length} deal${propertyDeals.length === 1 ? '' : 's'} reference this property`
                          : inParcel  ? `Cannot delete — property is part of parcel "${parcel.name}". Remove from parcel first.`
                          : 'Delete this property';

      // V76.5: Domain badge + attach/unlink affordance.
      // When linked: show badge linking out + tiny "Unlink" button.
      // When unlinked: show "Attach Domain listing" button which opens an
      // inline popover where the user pastes a Domain listing URL or id.
      // The link operation is auth-confirmed if it would steal the listing
      // from another property (server warns; client confirm() before POST).
      const listingUrl    = property.listing_url || '';
      const domainListing = property.domain_listing_id || null;
      const domBadgeLink = listingUrl
        ? `<a href="${listingUrl}" target="_blank" rel="noopener" class="domain-badge" style="display:inline-flex">
             <img src="https://ui-avatars.com/api/?name=D&size=12&background=1ea765&color=fff&bold=true&rounded=true" style="width:12px;height:12px;border-radius:50%;vertical-align:middle"> Domain
           </a>`
        : '';
      const domCell = domainListing
        ? `<div class="crm-prop-domain-cell" style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
             ${domBadgeLink || `<code style="font-size:11px">${domainListing}</code>`}
             <button class="crm-prop-unlink-domain-btn" title="Unlink this Domain listing from this property"
               style="font-size:10px;padding:2px 6px">Unlink</button>
           </div>`
        : `<div class="crm-prop-domain-cell" style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
             <span style="color:var(--text-secondary);font-size:12px">Not linked</span>
             <button class="crm-prop-attach-domain-btn kb-add-offer-btn" style="font-size:11px;padding:2px 8px">Attach Domain listing</button>
             <div class="crm-prop-attach-domain-popover" style="display:none;flex-basis:100%;margin-top:6px;padding:8px;border:1px solid var(--border);border-radius:4px;background:var(--surface)">
               <div style="font-size:11px;color:var(--text-secondary);margin-bottom:6px">
                 Paste the Domain listing URL or its numeric id. The listing will be linked to this property; if the listing was previously linked to another property, that link will be moved to here (you'll be asked to confirm).
               </div>
               <div style="display:flex;gap:6px;align-items:center">
                 <input class="kb-input crm-prop-attach-domain-input" type="text" placeholder="https://www.domain.com.au/2023456789  or  2023456789" style="flex:1;font-size:12px">
                 <button class="crm-prop-attach-domain-confirm kb-add-offer-btn" style="font-size:11px;padding:4px 10px">Link</button>
                 <button class="crm-prop-attach-domain-cancel crm-cancel-btn" style="font-size:11px;padding:4px 10px">Cancel</button>
               </div>
             </div>
           </div>`;

      modal.innerHTML = `
        <div class="crm-modal-header">
          <div>
            <div class="crm-modal-title">${property.address || property.id}${property.suburb ? ', ' + property.suburb : ''}</div>
            <div class="crm-modal-subtitle">${property.lot_dps || ''}${property.area_sqm ? ' · ' + Math.round(property.area_sqm).toLocaleString() + ' m²' : ''}</div>
          </div>
          <div class="crm-modal-header-actions">
            <button class="crm-prop-delete-btn crm-modal-delete"
              ${deleteDisabled ? 'disabled' : ''}
              title="${deleteTooltip}">
              Delete
            </button>
            <button class="crm-modal-close">✕</button>
          </div>
        </div>
        <div class="crm-modal-body">

          <div class="crm-modal-section crm-section-collapsible" data-section="details">
            <div class="crm-modal-section-title crm-section-header">
              <span class="crm-section-header-left"><span class="crm-section-chev">▾</span> Property Details</span>
            </div>
            <div class="crm-section-body">
              <div class="crm-detail-grid">
                <div class="crm-detail-label">Address</div>
                <div><input class="kb-input crm-prop-address-input" type="text" value="${(property.address || '').replace(/"/g,'&quot;')}" style="width:100%;box-sizing:border-box;font-size:13px"></div>
                <div class="crm-detail-label">Suburb</div>
                <div><input class="kb-input crm-prop-suburb-input" type="text" value="${(property.suburb || '').replace(/"/g,'&quot;')}" style="width:100%;box-sizing:border-box;font-size:13px"></div>
                <div class="crm-detail-label">State</div>
                <div>
                  <select class="kb-input crm-prop-state-input" style="width:100%;box-sizing:border-box;font-size:13px">
                    ${['NSW','VIC','QLD','WA','SA','TAS','ACT','NT'].map(s =>
                      `<option value="${s}"${(property.state || 'NSW') === s ? ' selected' : ''}>${s}</option>`
                    ).join('')}
                  </select>
                </div>
                <div class="crm-detail-label">Lot/DP</div>
                <div><input class="kb-input crm-prop-lotdp-input" type="text" value="${(property.lot_dps || '').replace(/"/g,'&quot;')}" style="width:100%;box-sizing:border-box;font-size:13px"></div>
                <div class="crm-detail-label">Area</div>
                <div>${property.area_sqm ? Math.round(property.area_sqm).toLocaleString() + ' m²' : '—'}</div>
                <div class="crm-detail-label">Coordinates</div>
                <div style="font-size:12px;color:var(--text-secondary)">${property.lat != null && property.lng != null ? `${property.lat.toFixed(6)}, ${property.lng.toFixed(6)}` : '—'}</div>
                <div class="crm-detail-label">State Prop ID</div>
                <div><code style="font-size:11px">${property.state_prop_id || '—'}</code></div>
                <div class="crm-detail-label">Domain</div>
                <div>${domCell}</div>
                <div class="crm-detail-label">Parcel</div>
                <div>${parcel ? `<a href="#" class="crm-prop-open-parcel" data-parcel-id="${parcel.id}">${parcel.name || parcel.id}</a>` : '<span style="color:var(--text-secondary);font-size:12px">Not in a parcel</span>'}</div>
                <div class="crm-detail-label">Property ID</div>
                <div><code style="font-size:11px">${property.id}</code></div>
              </div>
              <div style="margin-top:8px">
                <button class="crm-prop-save-btn kb-add-offer-btn" style="display:none">Save Changes</button>
              </div>
            </div>
          </div>

          <div class="crm-modal-section crm-section-collapsible" data-section="not-suitable" ${nsActive ? '' : 'data-collapsed="1"'}>
            <div class="crm-modal-section-title crm-section-header">
              <span class="crm-section-header-left"><span class="crm-section-chev">${nsActive ? '▾' : '▸'}</span> Not Suitable Status</span>
              ${nsActive ? `<button class="crm-prop-clear-ns-btn kb-add-offer-btn">Clear flag</button>` : ''}
            </div>
            <div class="crm-section-body" ${nsActive ? '' : 'style="display:none"'}>
              ${nsActive ? `
                <div class="crm-detail-grid">
                  <div class="crm-detail-label">Status</div>
                  <div>Flagged as not suitable · ${nsLabel}</div>
                  ${property.not_suitable_reason ? `<div class="crm-detail-label">Reason</div><div>${property.not_suitable_reason}</div>` : ''}
                </div>
              ` : `
                <div style="color:var(--text-secondary);font-size:12px;margin-bottom:8px">Not flagged.</div>
                <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
                  <select class="kb-input crm-prop-ns-snooze" style="font-size:12px">
                    <option value="30d">30 days</option>
                    <option value="90d">90 days</option>
                    <option value="6m">6 months</option>
                    <option value="1y">1 year</option>
                    <option value="permanent">Permanent</option>
                  </select>
                  <input class="kb-input crm-prop-ns-reason" type="text" placeholder="Reason (optional)" style="flex:1;font-size:12px">
                  <button class="crm-prop-set-ns-btn kb-add-offer-btn">Mark</button>
                </div>
              `}
            </div>
          </div>

          <div class="crm-modal-section crm-section-collapsible" data-section="deals">
            <div class="crm-modal-section-title crm-section-header">
              <span class="crm-section-header-left"><span class="crm-section-chev">▾</span> Deals <span class="crm-section-count">(${propertyDeals.length})</span></span>
              ${closedCount ? `<span class="crm-section-meta" style="font-size:11px;color:var(--muted)">(history: ${closedCount} closed)</span>` : ''}
            </div>
            <div class="crm-section-body">
              ${inParcel && !propertyDeals.length ? '<div class="crm-empty" style="padding:10px 0;color:var(--text-secondary);font-size:12px">Deals for properties in a parcel are tracked at the parcel level.</div>' : ''}
              ${propertyDeals.length ? propertyDeals.map(d => `
                <div class="crm-deal-row">
                  <a href="#" class="crm-deal-open" data-deal-id="${d.id}">${d.id}</a>
                  <span class="crm-deal-badge crm-deal-badge-workflow">${workflowLabels[d.workflow] || d.workflow}</span>
                  <span class="crm-deal-badge crm-deal-badge-stage">${d.stage}</span>
                  <span class="crm-deal-badge crm-deal-badge-stage">${d.status}</span>
                </div>`).join('') : (inParcel ? '' : '<div class="crm-empty">No deals on this property</div>')}
            </div>
          </div>

          <!-- V76.4.5: read-only vendor terms & offers history aggregated from
               all deals attached to this property (and the parent parcel, if any). -->
          <div class="crm-modal-section crm-section-collapsible" data-section="vendor-history" ${vendorHistory.length ? '' : 'data-collapsed="1"'}>
            <div class="crm-modal-section-title crm-section-header">
              <span class="crm-section-header-left"><span class="crm-section-chev">${vendorHistory.length ? '▾' : '▸'}</span> Vendor Terms &amp; Offers <span class="crm-section-count">(${vendorHistory.length})</span></span>
            </div>
            <div class="crm-section-body" ${vendorHistory.length ? '' : 'style="display:none"'}>
              ${buildVendorHistoryHtml(vendorHistory)}
            </div>
          </div>

          <div class="crm-modal-section crm-section-collapsible" data-section="contacts">
            <div class="crm-modal-section-title crm-section-header">
              <span class="crm-section-header-left"><span class="crm-section-chev">▾</span> Contacts <span class="crm-section-count">(${propContacts.length})</span></span>
            </div>
            <div class="crm-section-body">
              ${propContacts.length ? propContacts.map(c => `
                <div class="crm-prop-row">
                  <a href="#" class="crm-org-contact-open" data-contact-id="${c.id}">${displayName(c)}</a>
                  <span class="crm-org-contact-meta">${[c.mobile, c.email].filter(Boolean).join(' · ')}</span>
                  <span style="font-size:11px;color:var(--text-secondary)">${c.role || ''}</span>
                </div>`).join('') : '<div class="crm-empty">No contacts linked to this property</div>'}
            </div>
          </div>

          <div class="crm-modal-section crm-section-collapsible" data-section="notes">
            <div class="crm-modal-section-title crm-section-header">
              <span class="crm-section-header-left"><span class="crm-section-chev">▾</span> Notes <span class="crm-section-count">(${propNotes.length})</span></span>
              <button class="crm-prop-add-note-btn kb-add-offer-btn">+ Add Note</button>
            </div>
            <div class="crm-section-body">
              <div class="crm-prop-note-input" style="display:none;margin-bottom:10px">
                <div class="v77-note-form-mount-property-modal"></div>
              </div>
              <div class="crm-prop-notes-list">
                ${propNotes.length ? propNotes.map(n => {
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

          <div class="crm-modal-section crm-section-collapsible" data-section="map" ${property.lat != null && property.lng != null ? '' : 'data-collapsed="1"'}>
            <div class="crm-modal-section-title crm-section-header">
              <span class="crm-section-header-left"><span class="crm-section-chev">${property.lat != null ? '▾' : '▸'}</span> Map Location</span>
            </div>
            <div class="crm-section-body" ${property.lat != null ? '' : 'style="display:none"'}>
              ${property.lat != null && property.lng != null
                ? `<div class="crm-prop-map" style="height:240px;border-radius:6px;overflow:hidden;border:1px solid var(--border)"></div>
                   <div style="font-size:11px;color:var(--text-secondary);margin-top:4px">Click the pin to view on the main map.</div>`
                : '<div class="crm-empty">No coordinates stored</div>'}
            </div>
          </div>

        </div>`;

      // ── Wire up modal interactions ─────────────────────────────────────────

      // Close
      modal.querySelector('.crm-modal-close').addEventListener('click', () => onDone());

      // Collapsible sections
      modal.querySelectorAll('.crm-section-header').forEach(h => {
        h.addEventListener('click', (e) => {
          // Don't toggle if clicking a button inside the header
          if (e.target.closest('button, a')) return;
          const section = h.closest('.crm-section-collapsible');
          const body = section.querySelector('.crm-section-body');
          const chev = h.querySelector('.crm-section-chev');
          if (body.style.display === 'none') {
            body.style.display = '';
            if (chev) chev.textContent = '▾';
            section.removeAttribute('data-collapsed');
          } else {
            body.style.display = 'none';
            if (chev) chev.textContent = '▸';
            section.setAttribute('data-collapsed', '1');
          }
        });
      });

      // Details edit — Save button appears on any change
      const addrInput  = modal.querySelector('.crm-prop-address-input');
      const subInput   = modal.querySelector('.crm-prop-suburb-input');
      const stateInput = modal.querySelector('.crm-prop-state-input');
      const lotInput   = modal.querySelector('.crm-prop-lotdp-input');
      const saveBtn    = modal.querySelector('.crm-prop-save-btn');
      const origAddr   = property.address || '';
      const origSub    = property.suburb || '';
      const origState  = property.state || 'NSW';
      const origLot    = property.lot_dps || '';
      const toggleSave = () => {
        const dirty = addrInput.value.trim()  !== origAddr
                   || subInput.value.trim()   !== origSub
                   || stateInput.value        !== origState
                   || lotInput.value.trim()   !== origLot;
        saveBtn.style.display = dirty ? '' : 'none';
      };
      addrInput.addEventListener('input', toggleSave);
      subInput.addEventListener('input',  toggleSave);
      stateInput.addEventListener('change', toggleSave);
      lotInput.addEventListener('input',  toggleSave);
      saveBtn.addEventListener('click', async () => {
        await fetch('/api/properties', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id:      property.id,
            address: addrInput.value.trim() || null,
            suburb:  subInput.value.trim()  || null,
            state:   stateInput.value       || null,
            lot_dps: lotInput.value.trim()  || null,
          }),
        });
        // V76.7 — broadcast to pipeline / map so they refresh stale copies
        window.CRM?.notifyPropertyChanged?.(property.id);
        // Re-render modal to refresh
        renderPropertyModal(modal, propertyId, onDone);
      });

      // Delete property
      // V75.5.2: Delete property — confirm, then DELETE. API refuses if has deals.
      modal.querySelector('.crm-prop-delete-btn')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        if (btn.disabled) return;
        // V76.7+ — site-styled confirm modal (matches kanban + parcel delete UX).
        const propLabel = property.address
          ? `${property.address}${property.suburb ? ', ' + property.suburb : ''}`
          : property.id;
        if (!window.openConfirmModal) {
          if (!confirm(`Delete ${propLabel}?`)) return;
          await _doDeleteProperty();
        } else {
          window.openConfirmModal({
            title:        'Delete this property?',
            subject:      propLabel,
            bodyHtml:     'This is <strong style="color:#c0392b">permanent</strong> — it deletes the property record and any data attached to it.<br><br>It cannot be undone from the UI.',
            confirmLabel: 'Delete',
            onConfirm:    _doDeleteProperty,
          });
        }
        async function _doDeleteProperty() {
          const r = await fetch(`/api/properties?id=${encodeURIComponent(property.id)}`, { method: 'DELETE' });
          if (r.ok) {
            // Sync in-memory pipeline dict, map pins, and CRM caches
            _syncAfterEntityDelete({ propertyId: property.id });
            onDone();
          } else {
            const err = await r.json().catch(() => ({}));
            alert(`Failed to delete: ${err.error || r.status}`);
          }
        }
      });

      // Not-suitable set/clear
      modal.querySelector('.crm-prop-set-ns-btn')?.addEventListener('click', async () => {
        const snoozeVal = modal.querySelector('.crm-prop-ns-snooze').value;
        const reason    = modal.querySelector('.crm-prop-ns-reason').value.trim() || null;
        const until = snoozeVal === 'permanent' ? 'permanent' :
          new Date(Date.now() + ({ '30d': 30, '90d': 90, '6m': 180, '1y': 365 }[snoozeVal] * 86400000)).toISOString();
        await fetch('/api/properties', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'set_not_suitable', id: property.id, until, reason }),
        });
        window.CRM?.notifyPropertyChanged?.(property.id);
        renderPropertyModal(modal, propertyId, onDone);
      });
      modal.querySelector('.crm-prop-clear-ns-btn')?.addEventListener('click', async () => {
        await fetch('/api/properties', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'clear_not_suitable', id: property.id }),
        });
        window.CRM?.notifyPropertyChanged?.(property.id);
        renderPropertyModal(modal, propertyId, onDone);
      });

      // Open active deal / open any deal link
      modal.querySelector('.crm-prop-open-deal-btn')?.addEventListener('click', (e) => {
        const dealId = e.currentTarget.dataset.dealId;
        if (dealId && typeof window.openPipelineItem === 'function') {
          onDone();
          window.openPipelineItem(dealId);
        }
      });
      modal.querySelectorAll('.crm-deal-open').forEach(a => {
        a.addEventListener('click', (e) => {
          e.preventDefault();
          const dealId = a.dataset.dealId;
          if (dealId && typeof window.openPipelineItem === 'function') {
            onDone();
            window.openPipelineItem(dealId);
          }
        });
      });

      // V76.4.5: vendor terms & offers history — deal-id links open the deal modal
      modal.querySelectorAll('.crm-vendor-history-deal-link').forEach(a => {
        a.addEventListener('click', (e) => {
          e.preventDefault();
          const dealId = a.dataset.dealId;
          if (dealId && typeof window.openPipelineItem === 'function') {
            onDone();
            window.openPipelineItem(dealId);
          }
        });
      });

      // New deal on property
      modal.querySelector('.crm-prop-new-deal-btn')?.addEventListener('click', async () => {
        const r = await fetch('/api/deals', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'new_on_property', property_id: property.id, workflow: 'acquisition', stage: 'shortlisted' }),
        });
        if (r.ok) {
          const { id: newDealId } = await r.json();
          if (newDealId && typeof window.openPipelineItem === 'function') {
            onDone();
            window.openPipelineItem(newDealId);
          }
        } else {
          const err = await r.json().catch(() => ({}));
          alert(`Failed to create deal: ${err.error || r.status}`);
        }
      });

      // Open parcel from the details grid link
      modal.querySelector('.crm-prop-open-parcel')?.addEventListener('click', (e) => {
        e.preventDefault();
        const pid = e.currentTarget.dataset.parcelId;
        if (pid && window.CRM?.navigateTo) {
          onDone();
          window.CRM.navigateTo('parcels', pid);
        }
      });

      // V76.5: Attach Domain listing — open the inline popover.
      modal.querySelector('.crm-prop-attach-domain-btn')?.addEventListener('click', () => {
        const popover = modal.querySelector('.crm-prop-attach-domain-popover');
        if (popover) {
          popover.style.display = 'block';
          popover.querySelector('.crm-prop-attach-domain-input')?.focus();
        }
      });
      modal.querySelector('.crm-prop-attach-domain-cancel')?.addEventListener('click', () => {
        const popover = modal.querySelector('.crm-prop-attach-domain-popover');
        if (popover) popover.style.display = 'none';
      });
      // V76.5: Confirm-link — extracts the Domain id from the input (URL or
      // bare number), checks for prior link conflict, asks the user to
      // confirm if there is one, then POSTs the link action.
      modal.querySelector('.crm-prop-attach-domain-confirm')?.addEventListener('click', async () => {
        const input = modal.querySelector('.crm-prop-attach-domain-input');
        if (!input) return;
        const raw = (input.value || '').trim();
        if (!raw) { input.focus(); return; }
        // Accept either a Domain URL (extract trailing numeric path segment)
        // or a bare numeric id. Anything else is rejected with a hint.
        let domainId = null;
        const numMatch = raw.match(/(\d{6,})/);
        if (numMatch) domainId = numMatch[1];
        if (!domainId) {
          alert('Could not parse a Domain listing id from that input. Paste the Domain URL or the numeric id.');
          return;
        }
        // Build a derived listing URL from the id if no explicit URL was pasted
        const listingUrl = /^https?:\/\//.test(raw) ? raw : `https://www.domain.com.au/${domainId}`;

        // Conflict check — is this listing already linked to another property?
        let conflictWith = null;
        try {
          const r = await fetch(`/api/properties?by_domain_listing=${encodeURIComponent(domainId)}`);
          if (r.ok) {
            const other = await r.json();
            if (other && other.id && other.id !== property.id) {
              conflictWith = other;
            }
          }
        } catch (_) { /* fall through; server will accept the link either way */ }

        if (conflictWith) {
          const ok = confirm(
            `This Domain listing is currently linked to:\n\n` +
            `  ${conflictWith.address || conflictWith.id}` +
            (conflictWith.suburb ? `, ${conflictWith.suburb}` : '') +
            `\n\nLink it to this property instead? The other property will be unlinked.`
          );
          if (!ok) return;
        }

        // POST the link action
        const r = await fetch('/api/properties', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action:            'link_listing',
            property_id:       property.id,
            domain_listing_id: domainId,
            listing_url:       listingUrl,
          }),
        });
        if (!r.ok) {
          const err = await r.json().catch(() => ({}));
          alert(`Failed to link listing: ${err.error || r.status}`);
          return;
        }
        // Refresh CRM cache + redraw the property modal so it picks up the
        // new domain_listing_id / listing_url, the listings panel and any
        // map pins (refreshed automatically via cache invalidation listeners).
        if (window.CRM?.invalidatePropertiesCache) window.CRM.invalidatePropertiesCache();
        if (typeof window.refreshListings === 'function') window.refreshListings();
        window.CRM?.notifyPropertyChanged?.(property.id);
        renderPropertyModal(modal, property.id, onDone);
      });

      // V76.5: Unlink Domain listing — confirms then POSTs unlink.
      modal.querySelector('.crm-prop-unlink-domain-btn')?.addEventListener('click', async () => {
        if (!confirm('Unlink this Domain listing from this property? The listing will reappear as unlinked on the map.')) return;
        const r = await fetch('/api/properties', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'unlink_listing', property_id: property.id }),
        });
        if (!r.ok) {
          const err = await r.json().catch(() => ({}));
          alert(`Failed to unlink: ${err.error || r.status}`);
          return;
        }
        if (window.CRM?.invalidatePropertiesCache) window.CRM.invalidatePropertiesCache();
        if (typeof window.refreshListings === 'function') window.refreshListings();
        window.CRM?.notifyPropertyChanged?.(property.id);
        renderPropertyModal(modal, property.id, onDone);
      });

      // Contact link — use existing openContactDrawer if available
      modal.querySelectorAll('.crm-org-contact-open').forEach(a => {
        a.addEventListener('click', (e) => {
          e.preventDefault();
          const cid = a.dataset.contactId;
          if (cid && typeof openContactDrawer === 'function') openContactDrawer(cid);
        });
      });

      // V77.1 — Notes use the extended NoteForm.
      const addNoteBtn  = modal.querySelector('.crm-prop-add-note-btn');
      const noteInput   = modal.querySelector('.crm-prop-note-input');
      const noteMount   = modal.querySelector('.v77-note-form-mount-property-modal');
      let _propNoteFormHandle = null;
      addNoteBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        noteInput.style.display = '';
        if (window.NoteForm && noteMount && !_propNoteFormHandle) {
          _propNoteFormHandle = NoteForm.mount(noteMount, {
            placeholder: 'Add a note…',
            showContactTagger: true,
            onAdd: async (vals) => {
              const text = (vals.note_text || '').trim();
              if (!text) return;
              const body = {
                entity_type: 'property',
                entity_id:   property.id,
                note_text:   text,
              };
              if (vals.tagged_contact_id) body.tagged_contact_id = vals.tagged_contact_id;
              if (vals.interaction_type)  body.interaction_type  = vals.interaction_type;
              if (vals.source)            body.source            = vals.source;
              await fetch('/api/notes', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify(body),
              });
              renderPropertyModal(modal, propertyId, onDone);
            },
          });
        }
        if (_propNoteFormHandle?.focus) _propNoteFormHandle.focus();
      });
      modal.querySelectorAll('.crm-note-delete').forEach(btn => {
        btn.addEventListener('click', async () => {
          const nid = btn.dataset.id;
          if (!nid || !confirm('Delete this note?')) return;
          await fetch(`/api/notes?id=${encodeURIComponent(nid)}`, { method: 'DELETE' });
          renderPropertyModal(modal, propertyId, onDone);
        });
      });

      // Render the map preview if we have coords
      if (property.lat != null && property.lng != null) {
        const mapEl = modal.querySelector('.crm-prop-map');
        if (mapEl && typeof L !== 'undefined') {
          // Defer to next tick so the container has layout
          setTimeout(() => {
            try {
              const miniMap = L.map(mapEl, {
                center: [property.lat, property.lng],
                zoom: 16,               // V75.5: one step out from 17
                zoomControl: true,      // +/- buttons (matches main map)
                attributionControl: false,
                dragging: true,
                scrollWheelZoom: true,  // match main map interactivity
                doubleClickZoom: true,
                boxZoom: false,
                keyboard: false,
              });
              L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png', {
                maxZoom: 19,
              }).addTo(miniMap);

              // Look for rings in the property's parcels JSONB (normalized shape
              // from V75.4c/d onward: parcels[0].rings = [[[lng,lat],...]])
              const firstParcel = Array.isArray(property.parcels) ? property.parcels[0] : null;
              const rings = firstParcel?.rings;
              if (Array.isArray(rings) && rings.length && Array.isArray(rings[0]) && rings[0].length) {
                const leafletRings = rings.map(ring => ring.map(([lng, lat]) => [lat, lng]));
                const poly = L.polygon(leafletRings, {
                  color:       '#1a6b3a',
                  weight:      2,
                  fillColor:   '#1a6b3a',
                  fillOpacity: 0.15,
                }).addTo(miniMap);
                // Size to polygon but bounded by zoom 17 so we're not pixel-glued
                miniMap.fitBounds(poly.getBounds(), { padding: [20, 20], maxZoom: 17 });
              } else {
                L.marker([property.lat, property.lng]).addTo(miniMap);
              }
              // Leaflet needs a size recalc when it initialises inside a
              // currently-hidden container (collapsed section)
              setTimeout(() => miniMap.invalidateSize(), 100);
            } catch (err) {
              console.warn('[property-modal] mini-map render failed:', err);
            }
          }, 50);
        }
      }
    } catch (err) {
      console.error('[property-modal]', err);
      modal.innerHTML = '<div class="crm-modal-loading">Error loading property</div>';
    }
  }

  // ── Public navigation hook for router deep links ───────────────────────────
  // window.CRM.navigateTo('parcels', 'parcel-123') → switches to Parcels tab
  // and opens the parcel modal. Called from router.js for /crm/parcels/:id and
  // future /crm/contacts/:id, /crm/properties/:id, /crm/organisations/:id.
  // V76.7+ — properties branch added so the map's "+ Property" button can route
  // straight to an existing property record (replaces the "lands in V75.5/later"
  // placeholder).
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
    } else if (tabName === 'properties') {
      openModal(modal => renderPropertyModal(modal, entityId, () => closeModal()));
    }
    // organisations deep-linking still pending
  };

  // Initial load
  loadContactsPane();
}
