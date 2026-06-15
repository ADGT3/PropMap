/**
 * marketing-settings-page.js — V82.b
 *
 * System Settings → Marketing page.
 *
 * Section: Marketing Categories
 *   - Sortable table (click column header to sort)
 *   - + Add button → inline form
 *   - Edit (✎) on each row → inline form replaces row
 *   - Delete (✕) → confirmation showing how many contacts are assigned
 *   - No system rows — all categories are user-managed
 *
 * Public API (window.MarketingSettingsPage):
 *   MarketingSettingsPage.render(containerEl)
 *   MarketingSettingsPage.refresh()
 *
 * Depends on: /api/contact-marketing-categories (GET all, POST per-contact not used here)
 * Uses new admin endpoints: /api/marketing-categories (GET all, POST add, PATCH rename, DELETE)
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

  function sortRows(rows, key, dir) {
    const f = dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      let av = a[key], bv = b[key];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (key === 'contact_count') return (Number(av) - Number(bv)) * f;
      av = String(av).toLowerCase(); bv = String(bv).toLowerCase();
      if (av < bv) return -1 * f;
      if (av > bv) return  1 * f;
      return 0;
    });
  }

  let _container = null;
  const _state = { sortKey: 'category', sortDir: 'asc', editingCategory: null, adding: false };
  let _rows = [];

  // ── API helpers ────────────────────────────────────────────────────────────

  async function fetchCategories() {
    const r = await fetch('/api/marketing-categories');
    if (!r.ok) throw new Error(`Failed to load categories: ${r.status}`);
    return r.json();
  }

  async function addCategory(category) {
    const r = await fetch('/api/marketing-categories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category }),
    });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  }

  async function renameCategory(oldName, newName) {
    const r = await fetch('/api/marketing-categories', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ old_name: oldName, new_name: newName }),
    });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  }

  async function deleteCategory(category) {
    const r = await fetch(`/api/marketing-categories?category=${encodeURIComponent(category)}`, {
      method: 'DELETE',
    });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  function renderTable() {
    const wrap = _container.querySelector('[data-table-wrap="categories"]');
    if (!wrap) return;

    const sorted = sortRows(_rows, _state.sortKey, _state.sortDir);

    const thSort = (key, label) => {
      const active = _state.sortKey === key;
      const arrow  = active ? (_state.sortDir === 'asc' ? ' ▲' : ' ▼') : '';
      return `<th class="params-th${active ? ' params-th-active' : ''}" data-sort="${key}" style="cursor:pointer">${label}${arrow}</th>`;
    };

    let html = `
      <table class="params-table">
        <thead><tr>
          ${thSort('category', 'Category')}
          ${thSort('contact_count', 'Contacts')}
          <th class="params-th">Actions</th>
        </tr></thead>
        <tbody>`;

    if (_state.adding) {
      html += `
        <tr class="params-row params-row-editing" data-adding="1">
          <td><input type="text" class="kb-input params-edit-input" id="mktCatAddInput" placeholder="Category name…" style="width:100%"></td>
          <td>—</td>
          <td style="white-space:nowrap">
            <button class="params-save-btn" data-action="confirm-add">Save</button>
            <button class="params-cancel-btn" data-action="cancel-add">Cancel</button>
          </td>
        </tr>`;
    }

    for (const row of sorted) {
      const isEditing = _state.editingCategory === row.category;
      if (isEditing) {
        html += `
          <tr class="params-row params-row-editing" data-cat="${esc(row.category)}">
            <td><input type="text" class="kb-input params-edit-input" data-edit-input value="${esc(row.category)}" style="width:100%"></td>
            <td>${row.contact_count ?? 0}</td>
            <td style="white-space:nowrap">
              <button class="params-save-btn" data-action="confirm-edit" data-cat="${esc(row.category)}">Save</button>
              <button class="params-cancel-btn" data-action="cancel-edit">Cancel</button>
            </td>
          </tr>`;
      } else {
        html += `
          <tr class="params-row" data-cat="${esc(row.category)}">
            <td>${esc(row.category)}</td>
            <td>${row.contact_count ?? 0}</td>
            <td style="white-space:nowrap">
              <button class="params-action-btn" data-action="edit" data-cat="${esc(row.category)}" title="Rename">✎</button>
              <button class="params-action-btn params-delete-btn" data-action="delete" data-cat="${esc(row.category)}" data-count="${row.contact_count ?? 0}" title="Delete">✕</button>
            </td>
          </tr>`;
      }
    }

    if (!sorted.length && !_state.adding) {
      html += `<tr><td colspan="3" class="params-empty">No marketing categories yet. Click + Add Category to create one.</td></tr>`;
    }

    html += `</tbody></table>`;
    wrap.innerHTML = html;

    // Sort headers
    wrap.querySelectorAll('th[data-sort]').forEach(th => {
      th.addEventListener('click', () => {
        const key = th.getAttribute('data-sort');
        if (_state.sortKey === key) {
          _state.sortDir = _state.sortDir === 'asc' ? 'desc' : 'asc';
        } else {
          _state.sortKey = key;
          _state.sortDir = 'asc';
        }
        renderTable();
      });
    });

    // Add row
    const addInput = wrap.querySelector('#mktCatAddInput');
    if (addInput) {
      addInput.focus();
      addInput.addEventListener('keydown', e => { if (e.key === 'Enter') confirmAdd(); });
    }

    wrap.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const action = btn.getAttribute('data-action');
        const cat    = btn.getAttribute('data-cat');

        if (action === 'edit') {
          _state.editingCategory = cat;
          _state.adding = false;
          renderTable();
          wrap.querySelector('[data-edit-input]')?.focus();
        }

        if (action === 'cancel-edit') {
          _state.editingCategory = null;
          renderTable();
        }

        if (action === 'confirm-edit') {
          const input = wrap.querySelector('[data-edit-input]');
          const newName = input?.value.trim();
          if (!newName) return;
          btn.disabled = true; btn.textContent = '…';
          try {
            await renameCategory(cat, newName);
            _state.editingCategory = null;
            await refresh();
          } catch (err) {
            alert('Failed to rename: ' + err.message);
            btn.disabled = false; btn.textContent = 'Save';
          }
        }

        if (action === 'cancel-add') {
          _state.adding = false;
          renderTable();
        }

        if (action === 'confirm-add') {
          confirmAdd();
        }

        if (action === 'delete') {
          const count = parseInt(btn.getAttribute('data-count') ?? '0', 10);
          const msg = count > 0
            ? `Delete "${cat}"? It is assigned to ${count} contact${count === 1 ? '' : 's'}. Those contacts will lose this category.`
            : `Delete "${cat}"?`;
          if (!confirm(msg)) return;
          btn.disabled = true;
          try {
            await deleteCategory(cat);
            await refresh();
          } catch (err) {
            alert('Failed to delete: ' + err.message);
            btn.disabled = false;
          }
        }
      });
    });

    async function confirmAdd() {
      const input = wrap.querySelector('#mktCatAddInput');
      const name = input?.value.trim();
      if (!name) return;
      const saveBtn = wrap.querySelector('[data-action="confirm-add"]');
      if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = '…'; }
      try {
        await addCategory(name);
        _state.adding = false;
        await refresh();
      } catch (err) {
        alert('Failed to add: ' + err.message);
        if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save'; }
      }
    }
  }

  async function refresh() {
    if (!_container) return;
    try {
      const data = await fetchCategories();
      _rows = data.categories ?? [];
      renderTable();
    } catch (err) {
      const wrap = _container.querySelector('[data-table-wrap="categories"]');
      if (wrap) wrap.innerHTML = `<div class="params-error">Failed to load: ${esc(err.message)}</div>`;
    }
  }

  async function render(containerEl) {
    _container = containerEl;
    containerEl.innerHTML = `
      <div class="params-page">
        <div class="params-section" data-section="marketing-categories">
          <div class="params-section-header">
            <h2>Marketing Categories</h2>
            <p class="settings-section-sub">Categories used to segment and group contacts for marketing purposes. Assign categories to contacts via the contact detail modal.</p>
            <button class="params-add-btn" id="mktCatAddBtn">+ Add Category</button>
          </div>
          <div class="params-table-wrap" data-table-wrap="categories">
            <div class="params-loading">Loading…</div>
          </div>
        </div>
      </div>`;

    containerEl.querySelector('#mktCatAddBtn').addEventListener('click', () => {
      _state.adding = true;
      _state.editingCategory = null;
      renderTable();
    });

    await refresh();
  }

  window.MarketingSettingsPage = { render, refresh };

})();
