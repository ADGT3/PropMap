/**
 * parameters-page.js — V77.1
 *
 * System Settings → Parameters page. Three sub-sections (Roles, Sources,
 * Interaction Types) all stacked on a single page (per Q3 (c) decision).
 *
 * Each sub-section renders:
 *   - Sortable table (click any column header to sort, click again to reverse)
 *   - Default sort: created_at DESC (reverse chronological — newest first)
 *   - "+ Add" button → inline form
 *   - Edit (pencil) on each row → inline form replaces row
 *   - Delete (✕) → confirmation prompt that shows reference count
 *   - System rows display "system" badge and cannot be deleted (only deactivated)
 *
 * FK rules (locked from migration):
 *   - notes.interaction_type → ON DELETE SET NULL
 *   - notes.source           → ON DELETE SET NULL
 *   - contacts.source        → ON DELETE SET NULL
 *   - entity_contacts.role_id→ ON DELETE SET NULL
 * So delete with references is allowed; we just warn the user how many rows
 * will lose their assignment.
 *
 * Public API (window.ParametersPage):
 *   ParametersPage.render(containerEl)  → populates containerEl with the page
 *   ParametersPage.refresh()             → re-fetches all three lookups + re-renders
 *
 * Depends on: window.Lookups, /api/roles, /api/sources, /api/interaction-types.
 */

(function () {
  'use strict';

  function esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtDate(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    if (isNaN(d.getTime())) return '—';
    const pad = n => String(n).padStart(2, '0');
    return `${pad(d.getDate())}/${pad(d.getMonth()+1)}/${d.getFullYear()}`;
  }

  // ── Sort helper — handles null/undefined and dates ───────────────────────

  function sortRows(rows, sortKey, sortDir) {
    const factor = sortDir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      let av = a[sortKey];
      let bv = b[sortKey];
      // null/undefined sort to bottom regardless of direction
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      // Date detection — created_at / updated_at are ISO strings
      if (sortKey === 'created_at' || sortKey === 'updated_at') {
        return (new Date(av) - new Date(bv)) * factor;
      }
      // Numeric (sort_order)
      if (typeof av === 'number' && typeof bv === 'number') {
        return (av - bv) * factor;
      }
      // String comparison
      av = String(av).toLowerCase();
      bv = String(bv).toLowerCase();
      if (av < bv) return -1 * factor;
      if (av > bv) return  1 * factor;
      return 0;
    });
  }

  // ── Generic sub-section state ─────────────────────────────────────────────

  function makeSectionState(initialSortKey = 'created_at', initialSortDir = 'desc') {
    return {
      sortKey: initialSortKey,
      sortDir: initialSortDir,
      editingId: null,
      adding: false,
    };
  }

  // ── Render the whole page ─────────────────────────────────────────────────

  let _container = null;
  const _state = {
    roles:       makeSectionState(),
    disciplines: makeSectionState('label', 'asc'),
    sources:     makeSectionState(),
    types:       makeSectionState(),
  };
  // V77.2g — boards cache for the Roles "Board Default" multi-select.
  // Single fetch, cached for the page lifetime. Refresh by reloading the page.
  let _boardsCache = null;
  async function getBoardsForUI() {
    if (_boardsCache) return _boardsCache;
    try {
      const r = await fetch('/api/boards');
      if (!r.ok) throw new Error('boards fetch failed');
      _boardsCache = await r.json();
    } catch (err) {
      console.warn('[parameters] boards fetch failed', err);
      _boardsCache = [];
    }
    return _boardsCache;
  }
  function boardLabel(boardId) {
    if (!_boardsCache) return boardId;
    const b = _boardsCache.find(x => x.id === boardId);
    return b ? (b.name || b.id) : boardId;
  }

  async function render(containerEl) {
    _container = containerEl;
    containerEl.innerHTML = `
      <div class="params-page">
        <div class="params-section" data-section="roles">
          <div class="params-section-header">
            <h2>Roles</h2>
            <p class="settings-section-sub">Roles define how a contact relates to a property or deal (e.g. Vendor, Listing Agent, Enquirer). System roles cannot be deleted, only deactivated. Custom roles can be deleted with reference reassignment.</p>
            <button class="params-add-btn" data-action="add-role">+ Add Role</button>
          </div>
          <div class="params-table-wrap" data-table-wrap="roles">
            <div class="params-loading">Loading…</div>
          </div>
        </div>

        <div class="params-section" data-section="disciplines">
          <div class="params-section-header">
            <h2>Disciplines</h2>
            <p class="settings-section-sub">Contractor/consultant discipline types assigned to contacts. Each discipline has a base hourly rate used by the Finance module.</p>
            <button class="params-add-btn" data-action="add-discipline">+ Add Discipline</button>
          </div>
          <div class="params-table-wrap" data-table-wrap="disciplines">
            <div class="params-loading">Loading…</div>
          </div>
        </div>

        <div class="params-section" data-section="sources">
          <div class="params-section-header">
            <h2>Sources</h2>
            <p class="settings-section-sub">Lead sources used in contact records and inbound interaction notes (e.g. Realestate.com.au, Referral, EDM). System sources cannot be deleted, only deactivated.</p>
            <button class="params-add-btn" data-action="add-source">+ Add Source</button>
          </div>
          <div class="params-table-wrap" data-table-wrap="sources">
            <div class="params-loading">Loading…</div>
          </div>
        </div>

        <div class="params-section" data-section="types">
          <div class="params-section-header">
            <h2>Interaction Types</h2>
            <p class="settings-section-sub">Note interaction types and their direction (e.g. Phone In = inbound, Email Out = outbound, File Note = internal). The Source dropdown on Note forms only appears for inbound types. System types cannot be deleted, only deactivated.</p>
            <button class="params-add-btn" data-action="add-type">+ Add Interaction Type</button>
          </div>
          <div class="params-table-wrap" data-table-wrap="types">
            <div class="params-loading">Loading…</div>
          </div>
        </div>

        <div class="params-section" data-section="boards">
          <div class="params-section-header">
            <h2>Boards</h2>
            <p class="settings-section-sub">Default score (interest_level, 0–100) applied to new cards added to each board. Used by the default kanban sort. Higher means the card ranks higher in its column on first add.</p>
          </div>
          <div class="params-table-wrap" data-table-wrap="boards">
            <div class="params-loading">Loading…</div>
          </div>
        </div>
      </div>
    `;

    // Wire add buttons
    containerEl.querySelector('[data-action="add-role"]').addEventListener('click', () => {
      _state.roles.adding = true;
      renderRolesTable();
    });
    containerEl.querySelector('[data-action="add-discipline"]').addEventListener('click', () => {
      _state.disciplines.adding = true;
      renderDisciplinesTable();
    });
    containerEl.querySelector('[data-action="add-source"]').addEventListener('click', () => {
      _state.sources.adding = true;
      renderSourcesTable();
    });
    containerEl.querySelector('[data-action="add-type"]').addEventListener('click', () => {
      _state.types.adding = true;
      renderTypesTable();
    });

    await Promise.all([
      renderRolesTable(),
      renderDisciplinesTable(),
      renderSourcesTable(),
      renderTypesTable(),
      renderBoardsTable(),
    ]);
  }

  async function refresh() {
    Lookups.invalidate();
    if (_container) await render(_container);
  }

  // ── Roles table ───────────────────────────────────────────────────────────

  async function renderRolesTable() {
    const wrap = _container.querySelector('[data-table-wrap="roles"]');
    if (!wrap) return;
    Lookups.invalidateRoles();
    const [rows, boards] = await Promise.all([Lookups.getRoles(), getBoardsForUI()]);
    const sorted = sortRows(rows, _state.roles.sortKey, _state.roles.sortDir);

    const headers = [
      { key: 'id',           label: 'ID' },
      { key: 'label',        label: 'Label' },
      { key: 'scopes',       label: 'Scopes', sortable: false },
      { key: 'default_scope',label: 'Default Scope' },
      { key: 'board_ids',    label: 'Board Default', sortable: false },
      { key: 'sort_order',   label: 'Order' },
      { key: 'active',       label: 'Active' },
      { key: 'system',       label: 'System' },
      { key: 'created_at',   label: 'Created' },
      { key: '_actions',     label: '', sortable: false },
    ];

    let html = '<table class="params-table"><thead><tr>';
    for (const h of headers) {
      const sortable = h.sortable !== false;
      const arrow = (sortable && _state.roles.sortKey === h.key)
        ? (_state.roles.sortDir === 'asc' ? ' ▲' : ' ▼') : '';
      html += sortable
        ? `<th class="params-th params-th-sortable" data-sort-key="${h.key}">${esc(h.label)}${arrow}</th>`
        : `<th class="params-th">${esc(h.label)}</th>`;
    }
    html += '</tr></thead><tbody>';

    if (_state.roles.adding) {
      html += renderRoleEditRow(null);
    }

    for (const r of sorted) {
      if (_state.roles.editingId === r.id) {
        html += renderRoleEditRow(r);
      } else {
        const scopesStr = Array.isArray(r.scopes) ? r.scopes.join(', ') : '';
        const boardIds = Array.isArray(r.board_ids) ? r.board_ids : [];
        const boardChips = boardIds.length
          ? boardIds.map(bid => `<span class="params-board-chip">${esc(boardLabel(bid))}</span>`).join('')
          : '<span class="params-empty-marker">—</span>';
        html += `
          <tr class="params-tr">
            <td class="params-td params-td-mono">${esc(r.id)}</td>
            <td class="params-td">${esc(r.label)}</td>
            <td class="params-td">${esc(scopesStr)}</td>
            <td class="params-td">${esc(r.default_scope || '')}</td>
            <td class="params-td">${boardChips}</td>
            <td class="params-td">${r.sort_order ?? ''}</td>
            <td class="params-td">${r.active ? '✓' : '✕'}</td>
            <td class="params-td">${r.system ? '<span class="params-system-badge">system</span>' : ''}</td>
            <td class="params-td">${fmtDate(r.created_at)}</td>
            <td class="params-td params-td-actions">
              <button class="params-edit-btn" data-edit-role="${esc(r.id)}" title="Edit">✎</button>
              ${r.system ? '' : `<button class="params-delete-btn" data-delete-role="${esc(r.id)}" title="Delete">✕</button>`}
            </td>
          </tr>`;
      }
    }
    html += '</tbody></table>';
    wrap.innerHTML = html;

    // Wire sortable headers
    wrap.querySelectorAll('.params-th-sortable').forEach(th => {
      th.addEventListener('click', () => {
        const key = th.getAttribute('data-sort-key');
        if (_state.roles.sortKey === key) {
          _state.roles.sortDir = _state.roles.sortDir === 'asc' ? 'desc' : 'asc';
        } else {
          _state.roles.sortKey = key;
          _state.roles.sortDir = 'asc';
        }
        renderRolesTable();
      });
    });
    wireRoleEditRowEvents(wrap);
    wrap.querySelectorAll('[data-edit-role]').forEach(btn => {
      btn.addEventListener('click', () => {
        _state.roles.editingId = btn.getAttribute('data-edit-role');
        renderRolesTable();
      });
    });
    wrap.querySelectorAll('[data-delete-role]').forEach(btn => {
      btn.addEventListener('click', () => deleteRole(btn.getAttribute('data-delete-role')));
    });
  }

  function renderRoleEditRow(r) {
    const isNew = !r;
    const id            = isNew ? '' : r.id;
    const label         = isNew ? '' : (r.label || '');
    const scopesStr     = isNew ? '' : (Array.isArray(r.scopes) ? r.scopes.join(',') : '');
    const defaultScope  = isNew ? 'deal' : (r.default_scope || 'deal');
    const boardIds      = isNew ? [] : (Array.isArray(r.board_ids) ? r.board_ids : []);
    const sortOrder     = isNew ? 100  : (r.sort_order ?? 100);
    const active        = isNew ? true : !!r.active;
    const allBoards     = _boardsCache || [];

    // Render the checkbox dropdown for board selection. Closed state shows
    // chips of selected board names (or "Select boards…" if none).
    const selectedLabels = boardIds.length
      ? boardIds.map(bid => esc(boardLabel(bid))).join(', ')
      : '<span style="color:var(--muted)">Select boards…</span>';
    const optionsHtml = allBoards.map(b => `
      <label class="params-board-opt">
        <input type="checkbox" data-field="board_id" value="${esc(b.id)}" ${boardIds.includes(b.id) ? 'checked' : ''}>
        <span>${esc(b.name || b.id)}</span>
      </label>`).join('');

    return `
      <tr class="params-tr params-tr-edit" data-role-edit-row>
        <td class="params-td"><input class="kb-input" data-field="id" value="${esc(id)}" ${isNew ? '' : 'disabled'} placeholder="slug_id"></td>
        <td class="params-td"><input class="kb-input" data-field="label" value="${esc(label)}"></td>
        <td class="params-td"><input class="kb-input" data-field="scopes" value="${esc(scopesStr)}" placeholder="property,deal"></td>
        <td class="params-td">
          <select class="kb-input" data-field="default_scope">
            <option value="property"     ${defaultScope === 'property'     ? 'selected' : ''}>property</option>
            <option value="deal"         ${defaultScope === 'deal'         ? 'selected' : ''}>deal</option>
            <option value="organisation" ${defaultScope === 'organisation' ? 'selected' : ''}>organisation</option>
            <option value="listing"      ${defaultScope === 'listing'      ? 'selected' : ''}>listing</option>
          </select>
        </td>
        <td class="params-td">
          <div class="params-multi-select" data-field="board_ids">
            <button type="button" class="params-multi-select-trigger" data-role="ms-trigger">
              <span class="params-multi-select-label">${selectedLabels}</span>
              <span style="margin-left:6px">▾</span>
            </button>
            <div class="params-multi-select-popover" data-role="ms-popover" style="display:none">
              ${optionsHtml || '<div class="params-empty-marker" style="padding:8px">No boards available.</div>'}
            </div>
          </div>
        </td>
        <td class="params-td"><input class="kb-input" data-field="sort_order" type="number" value="${sortOrder}" style="width:80px"></td>
        <td class="params-td"><input type="checkbox" data-field="active" ${active ? 'checked' : ''}></td>
        <td class="params-td">${r && r.system ? '<span class="params-system-badge">system</span>' : ''}</td>
        <td class="params-td">${r ? fmtDate(r.created_at) : '—'}</td>
        <td class="params-td params-td-actions">
          <button class="params-save-btn" data-save-role>${isNew ? 'Add' : 'Save'}</button>
          <button class="params-cancel-btn" data-cancel-role>Cancel</button>
        </td>
      </tr>`;
  }

  function wireRoleEditRowEvents(wrap) {
    // V77.2g — toggle the boards multi-select popover and update the trigger
    // label as checkboxes change. Outside-click closes the popover.
    wrap.querySelectorAll('[data-role="ms-trigger"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const popover = btn.parentElement.querySelector('[data-role="ms-popover"]');
        if (!popover) return;
        const isOpen = popover.style.display !== 'none';
        // Close any other open popovers in this wrap first
        wrap.querySelectorAll('[data-role="ms-popover"]').forEach(p => { p.style.display = 'none'; });
        popover.style.display = isOpen ? 'none' : 'block';
      });
    });
    // Update label when checkboxes change
    wrap.querySelectorAll('input[data-field="board_id"]').forEach(cb => {
      cb.addEventListener('change', () => {
        const wrapper = cb.closest('.params-multi-select');
        if (!wrapper) return;
        const checked = Array.from(wrapper.querySelectorAll('input[data-field="board_id"]:checked'))
          .map(c => boardLabel(c.value));
        const labelEl = wrapper.querySelector('.params-multi-select-label');
        if (labelEl) {
          labelEl.innerHTML = checked.length
            ? checked.map(esc).join(', ')
            : '<span style="color:var(--muted)">Select boards…</span>';
        }
      });
    });
    // Close popovers when clicking outside the multi-select
    if (!wrap._msOutsideHandlerInstalled) {
      wrap._msOutsideHandlerInstalled = true;
      document.addEventListener('mousedown', (e) => {
        if (!e.target.closest('.params-multi-select')) {
          wrap.querySelectorAll('[data-role="ms-popover"]').forEach(p => { p.style.display = 'none'; });
        }
      });
    }

    wrap.querySelectorAll('[data-save-role]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const tr = btn.closest('tr');
        const id           = tr.querySelector('[data-field="id"]').value.trim();
        const label        = tr.querySelector('[data-field="label"]').value.trim();
        const scopesStr    = tr.querySelector('[data-field="scopes"]').value.trim();
        const defaultScope = tr.querySelector('[data-field="default_scope"]').value;
        const sortOrder    = parseInt(tr.querySelector('[data-field="sort_order"]').value, 10) || 100;
        const active       = tr.querySelector('[data-field="active"]').checked;
        if (!id || !label) return alert('id and label required');
        const scopes = scopesStr.split(/[,\s]+/).filter(Boolean);
        if (!scopes.length) return alert('scopes required (comma-separated)');
        if (!scopes.includes(defaultScope)) return alert('default_scope must be in scopes');
        // V77.2g — gather checked boards from the multi-select
        const boardIds = Array.from(tr.querySelectorAll('input[data-field="board_id"]:checked'))
          .map(cb => cb.value);

        const editingExisting = _state.roles.editingId !== null;

        try {
          if (editingExisting) {
            // PUT — id is fixed
            const r = await fetch('/api/roles', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id, label, scopes, default_scope: defaultScope, board_ids: boardIds, sort_order: sortOrder, active }),
            });
            if (!r.ok) throw new Error((await r.json()).error || r.status);
          } else {
            // POST — new role
            const r = await fetch('/api/roles', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id, label, scopes, default_scope: defaultScope, board_ids: boardIds, sort_order: sortOrder, active }),
            });
            if (!r.ok) throw new Error((await r.json()).error || r.status);
          }
          _state.roles.editingId = null;
          _state.roles.adding = false;
          await renderRolesTable();
        } catch (err) {
          alert('Save failed: ' + err.message);
        }
      });
    });
    wrap.querySelectorAll('[data-cancel-role]').forEach(btn => {
      btn.addEventListener('click', () => {
        _state.roles.editingId = null;
        _state.roles.adding = false;
        renderRolesTable();
      });
    });
  }

  async function deleteRole(id) {
    try {
      const r = await fetch(`/api/roles?id=${encodeURIComponent(id)}&ref_count=1`);
      if (!r.ok) throw new Error(r.status);
      const data = await r.json();
      const refs = data.references?.total ?? 0;
      const msg = refs > 0
        ? `Role "${data.label}" is currently assigned to ${refs} contact link(s). Deleting will set those role assignments to NULL (the contacts remain, but their role on those entities will be cleared). Continue?`
        : `Delete role "${data.label}"? This cannot be undone.`;
      if (!confirm(msg)) return;
      const del = await fetch(`/api/roles?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!del.ok) throw new Error((await del.json()).error || del.status);
      await renderRolesTable();
    } catch (err) {
      alert('Delete failed: ' + err.message);
    }
  }

  // ── Sources table ─────────────────────────────────────────────────────────

  async function renderDisciplinesTable() {
    const wrap = _container?.querySelector('[data-table-wrap="disciplines"]');
    if (!wrap) return;
    let disciplines;
    try {
      const r = await fetch('/api/disciplines');
      if (!r.ok) throw new Error(r.status);
      disciplines = await r.json();
    } catch (err) {
      wrap.innerHTML = `<div class="params-error">Failed to load: ${esc(err.message)}</div>`;
      return;
    }

    const st = _state.disciplines;
    const sorted = sortRows(disciplines, st.sortKey, st.sortDir);

    const thSort = (key, label) => {
      const active = st.sortKey === key;
      const arrow  = active ? (st.sortDir === 'asc' ? ' ▲' : ' ▼') : '';
      return `<th class="params-th${active ? ' params-th-active' : ''}" data-sort="${key}" style="cursor:pointer">${label}${arrow}</th>`;
    };

    let html = `<table class="params-table"><thead><tr>
      ${thSort('label', 'Discipline')}
      ${thSort('rate_per_hour', '$/hr')}
      ${thSort('active', 'Active')}
      ${thSort('contact_count', 'Contacts')}
      <th class="params-th">Actions</th>
    </tr></thead><tbody>`;

    if (st.adding) {
      html += `<tr class="params-row params-row-editing">
        <td><input type="text" class="kb-input params-edit-input" id="discAddLabel" placeholder="Discipline name…" style="width:100%"></td>
        <td><input type="number" class="kb-input params-edit-input" id="discAddRate" value="150" style="width:80px"></td>
        <td>—</td><td>—</td>
        <td style="white-space:nowrap">
          <button class="params-save-btn" data-action="confirm-add-disc">Save</button>
          <button class="params-cancel-btn" data-action="cancel-add-disc">Cancel</button>
        </td></tr>`;
    }

    for (const d of sorted) {
      const isEditing = st.editingId === d.id;
      if (isEditing) {
        html += `<tr class="params-row params-row-editing" data-id="${d.id}">
          <td><input type="text" class="kb-input params-edit-input" data-field="label" value="${esc(d.label)}" style="width:100%"></td>
          <td><input type="number" class="kb-input params-edit-input" data-field="rate" value="${d.rate_per_hour}" style="width:80px"></td>
          <td>${d.active ? 'Yes' : 'No'}</td>
          <td>${d.contact_count ?? 0}</td>
          <td style="white-space:nowrap">
            <button class="params-save-btn" data-action="confirm-edit-disc" data-id="${d.id}">Save</button>
            <button class="params-cancel-btn" data-action="cancel-edit-disc">Cancel</button>
          </td></tr>`;
      } else {
        html += `<tr class="params-row" data-id="${d.id}">
          <td>${esc(d.label)}</td>
          <td>$${Number(d.rate_per_hour).toFixed(2)}</td>
          <td>${d.active ? '<span class="params-active-badge">Active</span>' : '<span class="params-inactive-badge">Inactive</span>'}</td>
          <td>${d.contact_count ?? 0}</td>
          <td style="white-space:nowrap">
            <button class="params-action-btn" data-action="edit-disc" data-id="${d.id}" title="Edit">✎</button>
            <button class="params-action-btn params-delete-btn" data-action="delete-disc" data-id="${d.id}" data-count="${d.contact_count ?? 0}" title="Delete">✕</button>
          </td></tr>`;
      }
    }

    if (!sorted.length && !st.adding) {
      html += `<tr><td colspan="5" class="params-empty">No disciplines yet.</td></tr>`;
    }

    html += `</tbody></table>`;
    wrap.innerHTML = html;

    wrap.querySelectorAll('th[data-sort]').forEach(th => {
      th.addEventListener('click', () => {
        const key = th.getAttribute('data-sort');
        if (st.sortKey === key) st.sortDir = st.sortDir === 'asc' ? 'desc' : 'asc';
        else { st.sortKey = key; st.sortDir = 'asc'; }
        renderDisciplinesTable();
      });
    });

    const addLabel = wrap.querySelector('#discAddLabel');
    if (addLabel) { addLabel.focus(); addLabel.addEventListener('keydown', e => { if (e.key === 'Enter') confirmAddDisc(); }); }

    wrap.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const action = btn.getAttribute('data-action');
        const id     = parseInt(btn.getAttribute('data-id'));

        if (action === 'edit-disc') {
          st.editingId = id; st.adding = false; renderDisciplinesTable();
          wrap.querySelector('[data-field="label"]')?.focus();
        }
        if (action === 'cancel-edit-disc') { st.editingId = null; renderDisciplinesTable(); }
        if (action === 'cancel-add-disc')  { st.adding = false;   renderDisciplinesTable(); }

        if (action === 'confirm-edit-disc') {
          const row   = btn.closest('tr');
          const label = row.querySelector('[data-field="label"]')?.value.trim();
          const rate  = parseFloat(row.querySelector('[data-field="rate"]')?.value);
          if (!label) return;
          btn.disabled = true; btn.textContent = '…';
          try {
            await fetch('/api/disciplines', { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id, label, rate_per_hour: isNaN(rate) ? 150 : rate }) });
            st.editingId = null;
            await renderDisciplinesTable();
          } catch (err) { alert('Save failed: ' + err.message); btn.disabled = false; btn.textContent = 'Save'; }
        }

        if (action === 'confirm-add-disc') { confirmAddDisc(); }

        if (action === 'delete-disc') {
          const count = parseInt(btn.getAttribute('data-count') ?? '0', 10);
          const row = btn.closest('tr');
          const label = row?.querySelector('td')?.textContent?.trim() || id;
          const msg = count > 0
            ? `Delete "${label}"? It is assigned to ${count} contact${count === 1 ? '' : 's'}. Those contacts will have their discipline cleared.`
            : `Delete "${label}"?`;
          if (!confirm(msg)) return;
          btn.disabled = true;
          try {
            await fetch(`/api/disciplines?id=${id}`, { method: 'DELETE' });
            await renderDisciplinesTable();
          } catch (err) { alert('Delete failed: ' + err.message); btn.disabled = false; }
        }
      });
    });

    async function confirmAddDisc() {
      const label = wrap.querySelector('#discAddLabel')?.value.trim();
      const rate  = parseFloat(wrap.querySelector('#discAddRate')?.value) || 150;
      if (!label) return;
      const saveBtn = wrap.querySelector('[data-action="confirm-add-disc"]');
      if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = '…'; }
      try {
        await fetch('/api/disciplines', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label, rate_per_hour: rate }) });
        st.adding = false;
        await renderDisciplinesTable();
      } catch (err) { alert('Add failed: ' + err.message); if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save'; } }
    }
  }

  async function renderSourcesTable() {
    const wrap = _container.querySelector('[data-table-wrap="sources"]');
    if (!wrap) return;
    Lookups.invalidateSources();
    const rows = await Lookups.getSources();
    const sorted = sortRows(rows, _state.sources.sortKey, _state.sources.sortDir);

    const headers = [
      { key: 'id',         label: 'ID' },
      { key: 'label',      label: 'Label' },
      { key: 'sort_order', label: 'Order' },
      { key: 'active',     label: 'Active' },
      { key: 'system',     label: 'System' },
      { key: 'created_at', label: 'Created' },
      { key: '_actions',   label: '', sortable: false },
    ];

    let html = '<table class="params-table"><thead><tr>';
    for (const h of headers) {
      const sortable = h.sortable !== false;
      const arrow = (sortable && _state.sources.sortKey === h.key)
        ? (_state.sources.sortDir === 'asc' ? ' ▲' : ' ▼') : '';
      html += sortable
        ? `<th class="params-th params-th-sortable" data-sort-key="${h.key}">${esc(h.label)}${arrow}</th>`
        : `<th class="params-th">${esc(h.label)}</th>`;
    }
    html += '</tr></thead><tbody>';

    if (_state.sources.adding) {
      html += renderSourceEditRow(null);
    }

    for (const r of sorted) {
      if (_state.sources.editingId === r.id) {
        html += renderSourceEditRow(r);
      } else {
        html += `
          <tr class="params-tr">
            <td class="params-td params-td-mono">${esc(r.id)}</td>
            <td class="params-td">${esc(r.label)}</td>
            <td class="params-td">${r.sort_order ?? ''}</td>
            <td class="params-td">${r.active ? '✓' : '✕'}</td>
            <td class="params-td">${r.system ? '<span class="params-system-badge">system</span>' : ''}</td>
            <td class="params-td">${fmtDate(r.created_at)}</td>
            <td class="params-td params-td-actions">
              <button class="params-edit-btn" data-edit-source="${esc(r.id)}" title="Edit">✎</button>
              ${r.system ? '' : `<button class="params-delete-btn" data-delete-source="${esc(r.id)}" title="Delete">✕</button>`}
            </td>
          </tr>`;
      }
    }
    html += '</tbody></table>';
    wrap.innerHTML = html;

    wrap.querySelectorAll('.params-th-sortable').forEach(th => {
      th.addEventListener('click', () => {
        const key = th.getAttribute('data-sort-key');
        if (_state.sources.sortKey === key) {
          _state.sources.sortDir = _state.sources.sortDir === 'asc' ? 'desc' : 'asc';
        } else {
          _state.sources.sortKey = key;
          _state.sources.sortDir = 'asc';
        }
        renderSourcesTable();
      });
    });
    wireSourceEditRowEvents(wrap);
    wrap.querySelectorAll('[data-edit-source]').forEach(btn => {
      btn.addEventListener('click', () => {
        _state.sources.editingId = btn.getAttribute('data-edit-source');
        renderSourcesTable();
      });
    });
    wrap.querySelectorAll('[data-delete-source]').forEach(btn => {
      btn.addEventListener('click', () => deleteSource(btn.getAttribute('data-delete-source')));
    });
  }

  function renderSourceEditRow(r) {
    const isNew = !r;
    const id        = isNew ? '' : r.id;
    const label     = isNew ? '' : (r.label || '');
    const sortOrder = isNew ? 1000 : (r.sort_order ?? 1000);
    const active    = isNew ? true : !!r.active;
    return `
      <tr class="params-tr params-tr-edit" data-source-edit-row>
        <td class="params-td">${isNew
          ? '<span class="params-td-hint">(auto from label)</span>'
          : `<input class="kb-input" data-field="id" value="${esc(id)}" disabled>`}
        </td>
        <td class="params-td"><input class="kb-input" data-field="label" value="${esc(label)}"></td>
        <td class="params-td"><input class="kb-input" data-field="sort_order" type="number" value="${sortOrder}" style="width:80px"></td>
        <td class="params-td"><input type="checkbox" data-field="active" ${active ? 'checked' : ''}></td>
        <td class="params-td">${r && r.system ? '<span class="params-system-badge">system</span>' : ''}</td>
        <td class="params-td">${r ? fmtDate(r.created_at) : '—'}</td>
        <td class="params-td params-td-actions">
          <button class="params-save-btn" data-save-source>${isNew ? 'Add' : 'Save'}</button>
          <button class="params-cancel-btn" data-cancel-source>Cancel</button>
        </td>
      </tr>`;
  }

  function wireSourceEditRowEvents(wrap) {
    wrap.querySelectorAll('[data-save-source]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const tr = btn.closest('tr');
        const idInput = tr.querySelector('[data-field="id"]');
        const id = idInput ? idInput.value.trim() : null;
        const label = tr.querySelector('[data-field="label"]').value.trim();
        const sortOrder = parseInt(tr.querySelector('[data-field="sort_order"]').value, 10) || 1000;
        const active = tr.querySelector('[data-field="active"]').checked;
        if (!label) return alert('label required');

        try {
          if (_state.sources.editingId !== null) {
            const r = await fetch('/api/sources', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id, label, sort_order: sortOrder, active }),
            });
            if (!r.ok) throw new Error((await r.json()).error || r.status);
          } else {
            const r = await fetch('/api/sources', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ label, sort_order: sortOrder, active }),
            });
            if (!r.ok) throw new Error((await r.json()).error || r.status);
          }
          _state.sources.editingId = null;
          _state.sources.adding = false;
          await renderSourcesTable();
        } catch (err) {
          alert('Save failed: ' + err.message);
        }
      });
    });
    wrap.querySelectorAll('[data-cancel-source]').forEach(btn => {
      btn.addEventListener('click', () => {
        _state.sources.editingId = null;
        _state.sources.adding = false;
        renderSourcesTable();
      });
    });
  }

  async function deleteSource(id) {
    try {
      const r = await fetch(`/api/sources?id=${encodeURIComponent(id)}&ref_count=1`);
      if (!r.ok) throw new Error(r.status);
      const data = await r.json();
      const refs = data.references?.total ?? 0;
      const breakdown = data.references
        ? `${data.references.contacts ?? 0} contact(s), ${data.references.notes ?? 0} note(s)`
        : '';
      const msg = refs > 0
        ? `Source "${data.label}" is currently used by ${refs} record(s) (${breakdown}). Deleting will clear the source on those records (set to NULL). Continue?`
        : `Delete source "${data.label}"? This cannot be undone.`;
      if (!confirm(msg)) return;
      const del = await fetch(`/api/sources?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!del.ok) throw new Error((await del.json()).error || del.status);
      await renderSourcesTable();
    } catch (err) {
      alert('Delete failed: ' + err.message);
    }
  }

  // ── Interaction Types table ───────────────────────────────────────────────

  async function renderTypesTable() {
    const wrap = _container.querySelector('[data-table-wrap="types"]');
    if (!wrap) return;
    Lookups.invalidateInteractionTypes();
    const rows = await Lookups.getInteractionTypes();
    const sorted = sortRows(rows, _state.types.sortKey, _state.types.sortDir);

    const headers = [
      { key: 'id',         label: 'ID' },
      { key: 'label',      label: 'Label' },
      { key: 'direction',  label: 'Direction' },
      { key: 'sort_order', label: 'Order' },
      { key: 'active',     label: 'Active' },
      { key: 'system',     label: 'System' },
      { key: 'created_at', label: 'Created' },
      { key: '_actions',   label: '', sortable: false },
    ];

    let html = '<table class="params-table"><thead><tr>';
    for (const h of headers) {
      const sortable = h.sortable !== false;
      const arrow = (sortable && _state.types.sortKey === h.key)
        ? (_state.types.sortDir === 'asc' ? ' ▲' : ' ▼') : '';
      html += sortable
        ? `<th class="params-th params-th-sortable" data-sort-key="${h.key}">${esc(h.label)}${arrow}</th>`
        : `<th class="params-th">${esc(h.label)}</th>`;
    }
    html += '</tr></thead><tbody>';

    if (_state.types.adding) {
      html += renderTypeEditRow(null);
    }

    for (const r of sorted) {
      if (_state.types.editingId === r.id) {
        html += renderTypeEditRow(r);
      } else {
        html += `
          <tr class="params-tr">
            <td class="params-td params-td-mono">${esc(r.id)}</td>
            <td class="params-td">${esc(r.label)}</td>
            <td class="params-td">${esc(r.direction)}</td>
            <td class="params-td">${r.sort_order ?? ''}</td>
            <td class="params-td">${r.active ? '✓' : '✕'}</td>
            <td class="params-td">${r.system ? '<span class="params-system-badge">system</span>' : ''}</td>
            <td class="params-td">${fmtDate(r.created_at)}</td>
            <td class="params-td params-td-actions">
              <button class="params-edit-btn" data-edit-type="${esc(r.id)}" title="Edit">✎</button>
              ${r.system ? '' : `<button class="params-delete-btn" data-delete-type="${esc(r.id)}" title="Delete">✕</button>`}
            </td>
          </tr>`;
      }
    }
    html += '</tbody></table>';
    wrap.innerHTML = html;

    wrap.querySelectorAll('.params-th-sortable').forEach(th => {
      th.addEventListener('click', () => {
        const key = th.getAttribute('data-sort-key');
        if (_state.types.sortKey === key) {
          _state.types.sortDir = _state.types.sortDir === 'asc' ? 'desc' : 'asc';
        } else {
          _state.types.sortKey = key;
          _state.types.sortDir = 'asc';
        }
        renderTypesTable();
      });
    });
    wireTypeEditRowEvents(wrap);
    wrap.querySelectorAll('[data-edit-type]').forEach(btn => {
      btn.addEventListener('click', () => {
        _state.types.editingId = btn.getAttribute('data-edit-type');
        renderTypesTable();
      });
    });
    wrap.querySelectorAll('[data-delete-type]').forEach(btn => {
      btn.addEventListener('click', () => deleteType(btn.getAttribute('data-delete-type')));
    });
  }

  function renderTypeEditRow(r) {
    const isNew = !r;
    const id        = isNew ? '' : r.id;
    const label     = isNew ? '' : (r.label || '');
    const direction = isNew ? 'inbound' : (r.direction || 'inbound');
    const sortOrder = isNew ? 1000 : (r.sort_order ?? 1000);
    const active    = isNew ? true : !!r.active;
    return `
      <tr class="params-tr params-tr-edit" data-type-edit-row>
        <td class="params-td">${isNew
          ? '<span class="params-td-hint">(auto from label)</span>'
          : `<input class="kb-input" data-field="id" value="${esc(id)}" disabled>`}
        </td>
        <td class="params-td"><input class="kb-input" data-field="label" value="${esc(label)}"></td>
        <td class="params-td">
          <select class="kb-input" data-field="direction">
            <option value="inbound"  ${direction === 'inbound'  ? 'selected' : ''}>inbound</option>
            <option value="outbound" ${direction === 'outbound' ? 'selected' : ''}>outbound</option>
            <option value="internal" ${direction === 'internal' ? 'selected' : ''}>internal</option>
          </select>
        </td>
        <td class="params-td"><input class="kb-input" data-field="sort_order" type="number" value="${sortOrder}" style="width:80px"></td>
        <td class="params-td"><input type="checkbox" data-field="active" ${active ? 'checked' : ''}></td>
        <td class="params-td">${r && r.system ? '<span class="params-system-badge">system</span>' : ''}</td>
        <td class="params-td">${r ? fmtDate(r.created_at) : '—'}</td>
        <td class="params-td params-td-actions">
          <button class="params-save-btn" data-save-type>${isNew ? 'Add' : 'Save'}</button>
          <button class="params-cancel-btn" data-cancel-type>Cancel</button>
        </td>
      </tr>`;
  }

  function wireTypeEditRowEvents(wrap) {
    wrap.querySelectorAll('[data-save-type]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const tr = btn.closest('tr');
        const idInput = tr.querySelector('[data-field="id"]');
        const id = idInput ? idInput.value.trim() : null;
        const label = tr.querySelector('[data-field="label"]').value.trim();
        const direction = tr.querySelector('[data-field="direction"]').value;
        const sortOrder = parseInt(tr.querySelector('[data-field="sort_order"]').value, 10) || 1000;
        const active = tr.querySelector('[data-field="active"]').checked;
        if (!label) return alert('label required');
        if (!direction) return alert('direction required');

        try {
          if (_state.types.editingId !== null) {
            const r = await fetch('/api/interaction-types', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id, label, direction, sort_order: sortOrder, active }),
            });
            if (!r.ok) throw new Error((await r.json()).error || r.status);
          } else {
            const r = await fetch('/api/interaction-types', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ label, direction, sort_order: sortOrder, active }),
            });
            if (!r.ok) throw new Error((await r.json()).error || r.status);
          }
          _state.types.editingId = null;
          _state.types.adding = false;
          await renderTypesTable();
        } catch (err) {
          alert('Save failed: ' + err.message);
        }
      });
    });
    wrap.querySelectorAll('[data-cancel-type]').forEach(btn => {
      btn.addEventListener('click', () => {
        _state.types.editingId = null;
        _state.types.adding = false;
        renderTypesTable();
      });
    });
  }

  async function deleteType(id) {
    try {
      const r = await fetch(`/api/interaction-types?id=${encodeURIComponent(id)}&ref_count=1`);
      if (!r.ok) throw new Error(r.status);
      const data = await r.json();
      const refs = data.references?.total ?? 0;
      const msg = refs > 0
        ? `Interaction type "${data.label}" is currently used in ${refs} note(s). Deleting will clear the type on those notes (set to NULL). Continue?`
        : `Delete interaction type "${data.label}"? This cannot be undone.`;
      if (!confirm(msg)) return;
      const del = await fetch(`/api/interaction-types?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!del.ok) throw new Error((await del.json()).error || del.status);
      await renderTypesTable();
    } catch (err) {
      alert('Delete failed: ' + err.message);
    }
  }

  // ── Boards table (V78g: per-board default score editor) ──────────────────

  // Boards section is read+edit only on default_score. Boards themselves are
  // created/edited/deleted from the kanban toolbar — this page only configures
  // the score that new cards get when added via addToPipeline.
  async function renderBoardsTable() {
    const wrap = _container.querySelector('[data-table-wrap="boards"]');
    if (!wrap) return;
    wrap.innerHTML = '<div class="params-loading">Loading…</div>';

    let boards, settings;
    try {
      const [boardsRes, settingsRes] = await Promise.all([
        fetch('/api/boards'),
        fetch('/api/system-settings?category=boards'),
      ]);
      if (!boardsRes.ok) throw new Error('Boards: ' + boardsRes.status);
      if (!settingsRes.ok) throw new Error('Settings: ' + settingsRes.status);
      boards = await boardsRes.json();
      settings = await settingsRes.json();
    } catch (err) {
      wrap.innerHTML = '<div class="params-empty">Could not load boards: ' + esc(err.message) + '</div>';
      return;
    }

    // Build settings lookup keyed by board_id
    const scoreByBoardId = {};
    settings.forEach(s => {
      const m = String(s.key || '').match(/^board_default_score_(.+)$/);
      if (m) scoreByBoardId[m[1]] = s.value;
    });

    // Boards-table is sorted: system boards first (by sort_order), then user
    // boards alphabetical. Action boards excluded — they don't use interest_level.
    const eligibleBoards = boards
      .filter(b => b.board_type !== 'action')
      .sort((a, b) => {
        if (a.is_system !== b.is_system) return a.is_system ? -1 : 1;
        if (a.is_system) return (a.sort_order || 0) - (b.sort_order || 0);
        return String(a.name).toLowerCase().localeCompare(String(b.name).toLowerCase());
      });

    if (!eligibleBoards.length) {
      wrap.innerHTML = '<div class="params-empty">No boards configured.</div>';
      return;
    }

    wrap.innerHTML = `
      <table class="params-table">
        <thead>
          <tr>
            <th>Board</th>
            <th>Type</th>
            <th style="width:140px">Default Score</th>
            <th style="width:90px"></th>
          </tr>
        </thead>
        <tbody>
          ${eligibleBoards.map(b => `
            <tr data-board-id="${esc(b.id)}">
              <td>${esc(b.name)}${b.is_system ? ' <span class="params-system-badge">system</span>' : ''}</td>
              <td>${b.is_system ? 'System' : 'Custom'}</td>
              <td>
                <input type="number" min="0" max="100" step="1" class="params-board-score-input"
                       value="${esc(scoreByBoardId[b.id] != null ? scoreByBoardId[b.id] : '40')}"
                       data-board-id="${esc(b.id)}"
                       data-original="${esc(scoreByBoardId[b.id] != null ? scoreByBoardId[b.id] : '40')}">
                <span class="params-board-score-status" data-board-id="${esc(b.id)}"></span>
              </td>
              <td>
                <button class="params-save-btn params-board-save-btn" type="button" data-board-id="${esc(b.id)}" disabled>Save</button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;

    // Wire inputs — enable Save when changed, disable when reverted
    wrap.querySelectorAll('.params-board-score-input').forEach(inp => {
      const boardId = inp.getAttribute('data-board-id');
      const saveBtn = wrap.querySelector(`.params-board-save-btn[data-board-id="${cssEscape(boardId)}"]`);
      const statusEl = wrap.querySelector(`.params-board-score-status[data-board-id="${cssEscape(boardId)}"]`);
      inp.addEventListener('input', () => {
        const dirty = inp.value !== inp.getAttribute('data-original');
        saveBtn.disabled = !dirty;
        statusEl.textContent = '';
      });
    });

    // Wire Save buttons
    wrap.querySelectorAll('.params-board-save-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const boardId = btn.getAttribute('data-board-id');
        const inp = wrap.querySelector(`.params-board-score-input[data-board-id="${cssEscape(boardId)}"]`);
        const statusEl = wrap.querySelector(`.params-board-score-status[data-board-id="${cssEscape(boardId)}"]`);
        const v = String(inp.value).trim();
        // Client-side validation matching server pattern in api/system-settings.js
        if (!/^\d+$/.test(v)) { statusEl.textContent = 'Must be a whole number'; statusEl.className = 'params-board-score-status params-err'; return; }
        const n = parseInt(v, 10);
        if (n < 0 || n > 100) { statusEl.textContent = 'Must be 0–100'; statusEl.className = 'params-board-score-status params-err'; return; }

        btn.disabled = true;
        statusEl.textContent = 'Saving…';
        statusEl.className = 'params-board-score-status';
        try {
          const res = await fetch('/api/system-settings', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ['board_default_score_' + boardId]: v }),
          });
          if (!res.ok) {
            const errBody = await res.json().catch(() => ({}));
            const errMsg = errBody?.errors?.['board_default_score_' + boardId] || errBody?.error || res.status;
            throw new Error(errMsg);
          }
          inp.setAttribute('data-original', v);
          statusEl.textContent = 'Saved';
          statusEl.className = 'params-board-score-status params-ok';
          setTimeout(() => { statusEl.textContent = ''; }, 2000);
        } catch (err) {
          statusEl.textContent = 'Save failed: ' + err.message;
          statusEl.className = 'params-board-score-status params-err';
          btn.disabled = false;
        }
      });
    });
  }

  // CSS-escape an attribute value for use inside [data-attr="..."] selectors.
  // Board ids contain underscores and lowercase only, but defensive.
  function cssEscape(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return String(s).replace(/["\\]/g, '\\$&');
  }

  // ── Expose ────────────────────────────────────────────────────────────────

  window.ParametersPage = { render, refresh };
})();
