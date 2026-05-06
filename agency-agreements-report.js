/**
 * agency-agreements-report.js — V77.1
 *
 * Settings → Agency Agreements report. Cross-deal sortable table showing
 * every agency agreement across all deals.
 *
 * Per build plan §5.1.1:
 *   - Sortable by any column header (click to sort, click again to reverse)
 *   - Default sort: created_at DESC (reverse chronological — newest first)
 *   - "Open deal" action = board switch (kanban switches to deal's board,
 *     opens its modal)
 *
 * Public API (window.AgencyAgreementsReport):
 *   AgencyAgreementsReport.render(containerEl)
 */

(function () {
  'use strict';

  // Backend-supported sort keys (must match the whitelist in api/agency-agreements.js)
  const SORT_KEYS = [
    { key: 'agreement_type',     label: 'Type' },
    { key: 'appointed_company',  label: 'Appointed Company' },
    { key: 'start_date',         label: 'Start' },
    { key: 'end_date',           label: 'End' },
    { key: 'rate_value',         label: 'Rate' },
    { key: 'created_at',         label: 'Created' },
    { key: 'updated_at',         label: 'Updated' },
    { key: 'status',             label: 'Status' },
  ];

  function esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtDate(d) {
    if (!d) return '—';
    const dt = new Date(d);
    if (isNaN(dt.getTime())) return '—';
    const pad = n => String(n).padStart(2, '0');
    return `${pad(dt.getDate())}/${pad(dt.getMonth()+1)}/${dt.getFullYear()}`;
  }

  function fmtRate(rate_type, rate_value) {
    if (rate_value == null) return '—';
    if (rate_type === 'percent_of_price' || rate_type === 'percent_of_rent') return `${Number(rate_value)}%`;
    if (rate_type === 'flat_fee') return `$${Number(rate_value).toLocaleString('en-AU')}`;
    return String(rate_value);
  }

  // ── State ─────────────────────────────────────────────────────────────────

  let _container = null;
  let _sortKey = 'created_at';
  let _sortDir = 'desc';

  async function render(containerEl) {
    _container = containerEl;
    containerEl.innerHTML = `
      <div class="aar-report">
        <div class="aar-table-wrap" data-role="table-wrap">
          <div class="aar-loading">Loading…</div>
        </div>
      </div>
    `;
    await renderTable();
  }

  async function renderTable() {
    const wrap = _container.querySelector('[data-role="table-wrap"]');
    wrap.innerHTML = '<div class="aar-loading">Loading…</div>';
    try {
      const url = `/api/agency-agreements?report=1&sort=${encodeURIComponent(_sortKey)}&dir=${encodeURIComponent(_sortDir)}`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(r.status);
      const rows = await r.json();
      if (!rows.length) {
        wrap.innerHTML = '<div class="aar-empty">No agency agreements yet.</div>';
        return;
      }

      let html = '<table class="params-table aar-table"><thead><tr>';
      for (const k of SORT_KEYS) {
        const arrow = _sortKey === k.key ? (_sortDir === 'asc' ? ' ▲' : ' ▼') : '';
        html += `<th class="params-th params-th-sortable" data-sort-key="${k.key}">${esc(k.label)}${arrow}</th>`;
      }
      html += '<th class="params-th">Property</th>';
      html += '<th class="params-th"></th>';
      html += '</tr></thead><tbody>';

      for (const ag of rows) {
        const property = ag.property_address
          ? `${ag.property_address}${ag.property_suburb ? ', ' + ag.property_suburb : ''}`
          : (ag.parcel_name || '—');
        html += `
          <tr class="params-tr">
            <td class="params-td"><span class="aa-type-badge aa-type-${esc(ag.agreement_type)}">${esc((ag.agreement_type || '').toUpperCase())}</span></td>
            <td class="params-td">${esc(ag.appointed_company_name || `Org #${ag.appointed_company_id}`)}</td>
            <td class="params-td">${esc(fmtDate(ag.start_date))}</td>
            <td class="params-td">${esc(fmtDate(ag.end_date))}</td>
            <td class="params-td">${esc(fmtRate(ag.rate_type, ag.rate_value))}</td>
            <td class="params-td">${esc(fmtDate(ag.created_at))}</td>
            <td class="params-td">${esc(fmtDate(ag.updated_at))}</td>
            <td class="params-td"><span class="aa-status-badge aa-status-${esc(ag.status || '')}">${esc(ag.status || '—')}</span></td>
            <td class="params-td">${esc(property)}</td>
            <td class="params-td params-td-actions">
              <button class="params-edit-btn aar-open-btn" data-deal-id="${esc(ag.deal_id)}" data-board-id="${esc(ag.deal_board_id || '')}" title="Open deal">↗</button>
            </td>
          </tr>
        `;
      }
      html += '</tbody></table>';
      wrap.innerHTML = html;

      // Wire sort headers
      wrap.querySelectorAll('.params-th-sortable').forEach(th => {
        th.addEventListener('click', () => {
          const key = th.getAttribute('data-sort-key');
          if (_sortKey === key) {
            _sortDir = _sortDir === 'asc' ? 'desc' : 'asc';
          } else {
            _sortKey = key;
            _sortDir = 'asc';
          }
          renderTable();
        });
      });

      // Wire "Open deal" buttons → board switch
      wrap.querySelectorAll('.aar-open-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const dealId = btn.getAttribute('data-deal-id');
          const boardId = btn.getAttribute('data-board-id');
          openDealOnBoard(dealId, boardId);
        });
      });
    } catch (err) {
      wrap.innerHTML = `<div class="aar-error">Could not load report: ${esc(err.message)}</div>`;
    }
  }

  // ── Open deal action — board switch (per build plan §5.1.1) ──────────────
  // Switches kanban to the deal's board, then opens its modal.

  function openDealOnBoard(dealId, boardId) {
    // Close settings, navigate to kanban with target board, then open the deal modal
    if (window.toggleSettings) toggleSettings(false);
    if (window.Router) Router.navigate('/kanban');

    // Defer slightly to let kanban mount
    setTimeout(() => {
      // Switch kanban to the target board
      const sel = document.getElementById('kanbanBoardSelect');
      if (sel && boardId && sel.value !== boardId) {
        sel.value = boardId;
        sel.dispatchEvent(new Event('change'));
      }
      // Open the deal modal — kanban exposes openPipelineItem on window
      setTimeout(() => {
        if (typeof window.openPipelineItem === 'function') {
          window.openPipelineItem(dealId);
        } else {
          // Fallback: scroll to card if it's rendered
          const card = document.querySelector(`[data-pipeline-id="${dealId}"]`);
          if (card) {
            card.scrollIntoView({ behavior: 'smooth', block: 'center' });
            card.click();
          }
        }
      }, 300);
    }, 100);
  }

  window.AgencyAgreementsReport = { render };
})();
