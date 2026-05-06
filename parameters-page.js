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
    return `${pad(d.getDate())}/${pad(d.getMonth()+1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
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
    roles: makeSectionState(),
    sources: makeSectionState(),
    types: makeSectionState(),
  };

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
      </div>
    `;

    // Wire add buttons
    containerEl.querySelector('[data-action="add-role"]').addEventListener('click', () => {
      _state.roles.adding = true;
      renderRolesTable();
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
      renderSourcesTable(),
      renderTypesTable(),
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
    const rows = await Lookups.getRoles();
    const sorted = sortRows(rows, _state.roles.sortKey, _state.roles.sortDir);

    const headers = [
      { key: 'id',           label: 'ID' },
      { key: 'label',        label: 'Label' },
      { key: 'scopes',       label: 'Scopes', sortable: false },
      { key: 'default_scope',label: 'Default Scope' },
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
        html += `
          <tr class="params-tr">
            <td class="params-td params-td-mono">${esc(r.id)}</td>
            <td class="params-td">${esc(r.label)}</td>
            <td class="params-td">${esc(scopesStr)}</td>
            <td class="params-td">${esc(r.default_scope || '')}</td>
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
    const sortOrder     = isNew ? 100  : (r.sort_order ?? 100);
    const active        = isNew ? true : !!r.active;
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

        const isNew = !tr.querySelector('[data-field="id"]').disabled === false ? false : (_state.roles.editingId === null);
        const editingExisting = _state.roles.editingId !== null;

        try {
          if (editingExisting) {
            // PUT — id is fixed
            const r = await fetch('/api/roles', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id, label, scopes, default_scope: defaultScope, sort_order: sortOrder, active }),
            });
            if (!r.ok) throw new Error((await r.json()).error || r.status);
          } else {
            // POST — new role
            const r = await fetch('/api/roles', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id, label, scopes, default_scope: defaultScope, sort_order: sortOrder, active }),
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

  // ── Expose ────────────────────────────────────────────────────────────────

  window.ParametersPage = { render, refresh };
})();
