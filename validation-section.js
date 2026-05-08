/**
 * validation-section.js — V77.1
 *
 * Tenant validation checklist on Lease Enquiry deals. Per build plan §4.5
 * with the V77.1 addition of the 7th item ("Condition Report Completed").
 *
 * Stored on the Lease Enquiry deal as `data.validation`:
 *   {
 *     id_verified:                bool,
 *     income_evidence_reviewed:   bool,
 *     references_checked:         bool,
 *     rental_history_clean:       bool,
 *     affordability_confirmed:    bool,
 *     condition_report_completed: bool,
 *     notes:                      string,
 *     last_updated_at:            ISO string,
 *     last_updated_by:            user id (numeric, server-side)
 *   }
 *
 * Per Q3 (locked decision): validation is INFORMATIONAL — it does not block
 * an offer from being accepted. The agent has final discretion. The widget is
 * a checklist + free-text Notes field.
 *
 * Mounts via window.ValidationSection.mount(containerEl, dealId).
 *
 * Public API:
 *   ValidationSection.mount(containerEl, dealId) → { destroy, refresh }
 */

(function () {
  'use strict';

  const DEAL_API = '/api/deals';

  // The 7 items shown on the checklist.
  // Item #7 ("notes") is rendered as a textarea, not a checkbox.
  const CHECKBOXES = [
    { key: 'id_verified',                label: 'ID verified' },
    { key: 'income_evidence_reviewed',   label: 'Income evidence reviewed' },
    { key: 'references_checked',         label: 'References checked' },
    { key: 'rental_history_clean',       label: 'Rental history clean' },
    { key: 'affordability_confirmed',    label: 'Affordability confirmed' },
    { key: 'condition_report_completed', label: 'Condition Report Completed' },
  ];

  const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  function mount(containerEl, dealId) {
    if (!containerEl || !dealId) return { destroy() {}, refresh() {} };

    let validation = {};
    let dealData = {}; // full data block; we PATCH via /api/deals PUT

    containerEl.innerHTML = `
      <div class="val-section">
        <div class="kb-section-label" style="margin-top:16px">Validation</div>
        <div class="val-help">Informational checklist — does not block offer acceptance.</div>
        <div class="val-list" data-role="list"></div>
        <div class="kb-field-wrap" style="margin-top:8px">
          <label class="kb-field-label">Validation notes</label>
          <textarea class="kb-input val-notes" rows="2" placeholder="e.g. Two references received, awaiting third…"></textarea>
        </div>
        <div class="val-meta" data-role="meta" style="margin-top:6px;font-size:11px;color:var(--muted)"></div>
      </div>
    `;

    const listEl  = containerEl.querySelector('[data-role="list"]');
    const metaEl  = containerEl.querySelector('[data-role="meta"]');
    const notesEl = containerEl.querySelector('.val-notes');

    async function load() {
      try {
        const r = await fetch(`${DEAL_API}?id=${encodeURIComponent(dealId)}`);
        if (!r.ok) throw new Error(r.status);
        const deal = await r.json();
        dealData = deal.data || {};
        validation = dealData.validation || {};
      } catch (err) {
        console.warn('[Validation] load failed:', err);
        return;
      }
      render();
    }

    function render() {
      listEl.innerHTML = CHECKBOXES.map(item => {
        const checked = !!validation[item.key];
        return `
          <label class="val-item">
            <input type="checkbox" data-key="${esc(item.key)}" ${checked ? 'checked' : ''}>
            <span>${esc(item.label)}</span>
          </label>
        `;
      }).join('');
      notesEl.value = validation.notes || '';
      if (validation.last_updated_at) {
        const d = new Date(validation.last_updated_at);
        const fmt = !isNaN(d.getTime())
          ? `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`
          : '';
        metaEl.textContent = fmt ? `Last updated ${fmt}` : '';
      } else {
        metaEl.textContent = '';
      }

      // Wire checkbox toggles
      listEl.querySelectorAll('input[type="checkbox"]').forEach(cb => {
        cb.addEventListener('change', () => {
          const key = cb.getAttribute('data-key');
          validation[key] = cb.checked;
          save();
        });
      });
      // Wire notes blur
      notesEl.addEventListener('blur', () => {
        const next = notesEl.value.trim();
        if (next === (validation.notes || '')) return; // no change
        validation.notes = next;
        save();
      });
    }

    let _saveTimer = null;
    function save() {
      // Debounce in case user toggles multiple boxes quickly
      clearTimeout(_saveTimer);
      _saveTimer = setTimeout(async () => {
        validation.last_updated_at = new Date().toISOString();
        const nextData = { ...dealData, validation };
        try {
          const r = await fetch(DEAL_API, {
            method:  'PUT',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ id: dealId, data: nextData }),
          });
          if (!r.ok) throw new Error(r.status);
          dealData = nextData;
          // Refresh the meta line (last updated)
          if (metaEl) {
            const d = new Date(validation.last_updated_at);
            const fmt = `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
            metaEl.textContent = `Last updated ${fmt}`;
          }
        } catch (err) {
          console.warn('[Validation] save failed:', err);
          alert('Validation save failed — please retry.');
        }
      }, 250);
    }

    load();

    return {
      destroy: () => { containerEl.innerHTML = ''; },
      refresh: load,
    };
  }

  window.ValidationSection = { mount };
})();
