/**
 * notifications-page.js — V77.2
 *
 * System Settings → Notifications sub-page. Currently shows:
 *   - Email Configuration (5 settings from system_settings table, category='email')
 *   - Placeholder for V78 expansion: Subscriptions + Event Types
 *
 * Public API (attached to window.NotificationsPage):
 *   NotificationsPage.render(containerEl)
 *
 * Validation mirrors api/system-settings.js:
 *   - app_public_url:     URL format, no trailing slash
 *   - email_sending_domain: domain format
 *   - email_leasing_from / email_sales_from: email format AND must use sending domain
 *   - email_reply_to_handling: dropdown (route_to_from / no_reply)
 */
(function () {
  'use strict';

  const API = '/api/system-settings';

  function escapeHtml(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  async function render(container) {
    container.innerHTML = '<div class="params-loading">Loading…</div>';

    let settings = [];
    try {
      const r = await fetch(API + '?category=email');
      if (!r.ok) throw new Error(r.status);
      settings = await r.json();
    } catch (err) {
      container.innerHTML = '<div class="params-empty">Could not load settings: ' + escapeHtml(err.message) + '</div>';
      return;
    }

    // Index by key for stable order
    const byKey = {};
    settings.forEach(s => { byKey[s.key] = s; });

    const keysInOrder = [
      'app_public_url',
      'email_sending_domain',
      'email_leasing_from',
      'email_sales_from',
      'email_reply_to_handling',
    ];

    const rows = keysInOrder.map(k => byKey[k]).filter(Boolean);

    container.innerHTML = `
      <div class="notif-page">
        <div class="notif-section">
          <div class="notif-section-header">
            <h3>Email Configuration</h3>
            <p class="notif-section-sub">Used by V77.2 stub-mode (logs only) and V77.3+ live email dispatch (Resend).</p>
          </div>
          <div class="notif-form">
            ${rows.map(s => renderRow(s)).join('')}
          </div>
          <div class="notif-actions">
            <button class="params-cancel-btn notif-cancel-btn" type="button" disabled>Cancel</button>
            <button class="params-save-btn notif-save-btn" type="button" disabled>Save Changes</button>
            <span class="notif-save-status"></span>
          </div>
        </div>

        <div class="notif-section notif-section-placeholder">
          <div class="notif-section-header">
            <h3>Subscriptions</h3>
            <p class="notif-section-sub">Per-board, per-user opt-in for Lease Offer events, Action assignments, etc. — coming in next release.</p>
          </div>
        </div>

        <div class="notif-section notif-section-placeholder">
          <div class="notif-section-header">
            <h3>Event Types</h3>
            <p class="notif-section-sub">Configure which events trigger emails (New Cards, On Transition, On Action). — coming in next release.</p>
          </div>
        </div>
      </div>
    `;

    wire(container, byKey);
  }

  function renderRow(setting) {
    const k = setting.key;
    const v = setting.value;
    const label = setting.label || k;
    const desc = setting.description || '';

    if (k === 'email_reply_to_handling') {
      return `
        <div class="notif-row" data-key="${escapeHtml(k)}">
          <label class="notif-label">${escapeHtml(label)}</label>
          <select class="kb-input notif-input" data-key="${escapeHtml(k)}">
            <option value="route_to_from" ${v === 'route_to_from' ? 'selected' : ''}>route_to_from — replies route to from-address</option>
            <option value="no_reply" ${v === 'no_reply' ? 'selected' : ''}>no_reply — replies bounce</option>
          </select>
          <div class="notif-desc">${escapeHtml(desc)}</div>
          <div class="notif-row-error" data-key-error="${escapeHtml(k)}" style="display:none"></div>
        </div>`;
    }

    return `
      <div class="notif-row" data-key="${escapeHtml(k)}">
        <label class="notif-label">${escapeHtml(label)}</label>
        <input class="kb-input notif-input" type="text" data-key="${escapeHtml(k)}" value="${escapeHtml(v)}">
        <div class="notif-desc">${escapeHtml(desc)}</div>
        <div class="notif-row-error" data-key-error="${escapeHtml(k)}" style="display:none"></div>
      </div>`;
  }

  function wire(container, originalByKey) {
    const inputs = Array.from(container.querySelectorAll('.notif-input'));
    const saveBtn = container.querySelector('.notif-save-btn');
    const cancelBtn = container.querySelector('.notif-cancel-btn');
    const statusEl = container.querySelector('.notif-save-status');

    function snapshot() {
      const out = {};
      inputs.forEach(el => { out[el.getAttribute('data-key')] = el.value.trim(); });
      return out;
    }

    function isDirty() {
      const cur = snapshot();
      return Object.keys(cur).some(k => cur[k] !== (originalByKey[k]?.value || ''));
    }

    function refreshButtons() {
      const dirty = isDirty();
      saveBtn.disabled = !dirty;
      cancelBtn.disabled = !dirty;
      statusEl.textContent = '';
    }

    inputs.forEach(el => el.addEventListener('input', refreshButtons));
    inputs.forEach(el => el.addEventListener('change', refreshButtons));

    cancelBtn.addEventListener('click', () => {
      inputs.forEach(el => {
        const k = el.getAttribute('data-key');
        el.value = originalByKey[k]?.value || '';
      });
      // Clear errors
      container.querySelectorAll('.notif-row-error').forEach(e => { e.style.display = 'none'; e.textContent = ''; });
      refreshButtons();
    });

    saveBtn.addEventListener('click', async () => {
      const updates = snapshot();
      // Only send the keys that changed (smaller PUT)
      const changedOnly = {};
      Object.keys(updates).forEach(k => {
        if (updates[k] !== (originalByKey[k]?.value || '')) changedOnly[k] = updates[k];
      });
      if (!Object.keys(changedOnly).length) return;

      saveBtn.disabled = true;
      statusEl.textContent = 'Saving…';
      // Clear any prior errors
      container.querySelectorAll('.notif-row-error').forEach(e => { e.style.display = 'none'; e.textContent = ''; });

      try {
        const r = await fetch(API, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(changedOnly),
        });
        if (!r.ok) {
          const err = await r.json().catch(() => ({}));
          if (err.errors) {
            // Per-field errors
            Object.entries(err.errors).forEach(([key, msg]) => {
              const el = container.querySelector(`[data-key-error="${CSS.escape(key)}"]`);
              if (el) {
                el.style.display = '';
                el.textContent = msg;
              }
            });
          }
          statusEl.textContent = err.error || ('Save failed: ' + r.status);
          statusEl.style.color = '#b91c1c';
          saveBtn.disabled = false;
          return;
        }
        const result = await r.json();
        // Update originalByKey with the persisted server values
        if (Array.isArray(result.settings)) {
          result.settings.forEach(s => { originalByKey[s.key] = s; });
        }
        statusEl.textContent = 'Saved.';
        statusEl.style.color = '#15803d';
        refreshButtons();
      } catch (err) {
        statusEl.textContent = 'Save failed: ' + err.message;
        statusEl.style.color = '#b91c1c';
        saveBtn.disabled = false;
      }
    });
  }

  window.NotificationsPage = { render };
})();
