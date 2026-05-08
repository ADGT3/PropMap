/**
 * mobile-shell.js — V78
 *
 * iPhone/iPad responsive behaviour layer for PropMap. Provides:
 *
 *   1. A hamburger button + slide-down drawer for the module-nav buttons
 *      when the viewport is ≤ 600px wide (CSS hides the original .module-nav
 *      and shows it as a drawer when the .mobile-drawer-open class is added).
 *
 *   2. A single-column picker on the kanban board on mobile. Replaces the
 *      horizontal-scrolling columns with a dropdown selecting one column at
 *      a time. Selection persisted to localStorage per board.
 *
 *   3. A "Today's inspections" shortcut banner above the kanban board on
 *      mobile, with a tap-to-open full-screen panel listing today's
 *      inspections across all listings. Tapping a row jumps to the listing's
 *      deal modal with the Inspection Schedule section auto-expanded.
 *
 * Activates on viewport changes; no-op on desktop. All CSS for these
 * features lives in mobile.css.
 *
 * Public API (window.MobileShell):
 *   isMobile()                    → boolean
 *   applyKanbanMobileLayout()     → called by kanban.js renderBoard() to
 *                                    inject the column picker + active-col
 *   refreshTodayBanner()          → re-renders "Today's inspections" banner
 *                                    based on current data (called on board
 *                                    switch + after inspection edits)
 */

(function () {
  'use strict';

  const MOBILE_MAX = 600;

  // ── Helpers ─────────────────────────────────────────────────────────────

  function isMobile() {
    return window.matchMedia(`(max-width: ${MOBILE_MAX}px)`).matches;
  }

  function todayIso() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const da = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${da}`;
  }

  function fmtTime(t) {
    if (!t) return '';
    // input is HH:MM:SS or HH:MM — return H:MMam/pm
    const [hh, mm] = t.split(':');
    let h = parseInt(hh, 10);
    const ampm = h >= 12 ? 'pm' : 'am';
    h = h % 12; if (h === 0) h = 12;
    return `${h}:${mm}${ampm}`;
  }

  function debounce(fn, ms) {
    let t;
    return function () {
      clearTimeout(t);
      const args = arguments, ctx = this;
      t = setTimeout(() => fn.apply(ctx, args), ms);
    };
  }

  // ── Hamburger + module-nav drawer ───────────────────────────────────────

  function initHamburger() {
    const header = document.querySelector('header');
    const nav = document.querySelector('.module-nav');
    if (!header || !nav) return;
    if (header.querySelector('.v78-hamburger')) return; // already injected

    const btn = document.createElement('button');
    btn.className = 'v78-hamburger';
    btn.setAttribute('aria-label', 'Menu');
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="17" x2="20" y2="17"/></svg>';
    btn.style.display = 'none'; // CSS shows on mobile

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleDrawer();
    });

    // Insert hamburger as the first child of header (left of logo)
    const logo = header.querySelector('.logo');
    if (logo) {
      header.insertBefore(btn, logo);
    } else {
      header.prepend(btn);
    }

    // Close drawer when any nav button is clicked
    nav.addEventListener('click', (e) => {
      if (e.target.closest('.module-nav-btn')) {
        closeDrawer();
      }
    });

    // Close drawer on backdrop tap
    document.addEventListener('click', (e) => {
      if (!nav.classList.contains('mobile-drawer-open')) return;
      // Click anywhere outside the drawer or hamburger closes it
      if (e.target.closest('.module-nav')) return;
      if (e.target.closest('.v78-hamburger')) return;
      closeDrawer();
    });
  }

  function toggleDrawer() {
    const nav = document.querySelector('.module-nav');
    if (!nav) return;
    if (nav.classList.contains('mobile-drawer-open')) {
      closeDrawer();
    } else {
      openDrawer();
    }
  }

  function openDrawer() {
    const nav = document.querySelector('.module-nav');
    if (!nav) return;
    nav.classList.add('mobile-drawer-open');
    // Backdrop
    if (!document.querySelector('.v78-mobile-drawer-backdrop')) {
      const bd = document.createElement('div');
      bd.className = 'v78-mobile-drawer-backdrop';
      document.body.appendChild(bd);
    }
  }

  function closeDrawer() {
    const nav = document.querySelector('.module-nav');
    if (nav) nav.classList.remove('mobile-drawer-open');
    const bd = document.querySelector('.v78-mobile-drawer-backdrop');
    if (bd) bd.remove();
  }

  // ── Kanban single-column picker ─────────────────────────────────────────

  // Cache of which column is currently active per board on mobile
  const _mobileActiveCol = {};

  function applyKanbanMobileLayout() {
    if (!isMobile()) {
      // Desktop / tablet — strip mobile-only artifacts if any remain
      const board = document.getElementById('kanbanBoard');
      if (!board) return;
      board.querySelectorAll('.kb-col.v78-active-col').forEach(c => c.classList.remove('v78-active-col'));
      const wrap = document.querySelector('.v78-col-picker-wrap');
      if (wrap) wrap.remove();
      return;
    }

    const board = document.getElementById('kanbanBoard');
    if (!board) return;
    const cols = Array.from(board.querySelectorAll('.kb-col'));
    if (!cols.length) return;

    // Determine boardId — kanban.js sets currentBoardId on window? Use DOM fallback.
    const boardId = (window.currentBoardId)
      || (document.querySelector('.kb-board-select')?.value)
      || 'default';

    // Determine which column to activate
    const stored = localStorage.getItem(`v78_mobileCol_${boardId}`);
    let activeIdx = -1;
    if (stored) {
      activeIdx = cols.findIndex(c => (c.dataset.columnId || c.dataset.stage) === stored);
    }
    if (activeIdx < 0) {
      // Default to first column with cards, else first column
      activeIdx = cols.findIndex(c => c.querySelector('.kb-card')) ;
      if (activeIdx < 0) activeIdx = 0;
    }

    // Apply the active class
    cols.forEach((c, i) => c.classList.toggle('v78-active-col', i === activeIdx));

    // Build/refresh column picker dropdown
    let wrap = document.querySelector('.v78-col-picker-wrap');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.className = 'v78-col-picker-wrap';
      const select = document.createElement('select');
      select.className = 'v78-col-picker';
      wrap.appendChild(select);
      board.parentNode.insertBefore(wrap, board);
    }
    const select = wrap.querySelector('select');
    select.innerHTML = cols.map((c, i) => {
      const colId = c.dataset.columnId || c.dataset.stage || '';
      const colName = c.querySelector('.kb-stage-label')?.textContent?.trim()
                   || c.querySelector('.kb-col-title')?.textContent?.trim()
                   || `Column ${i + 1}`;
      const cardCount = c.querySelectorAll('.kb-card').length;
      return `<option value="${i}" ${i === activeIdx ? 'selected' : ''} data-col-id="${colId}">${colName} (${cardCount})</option>`;
    }).join('');

    // Wire change handler (re-bind on each render — old listener stays dead with old element)
    select.onchange = function () {
      const idx = parseInt(select.value, 10);
      const targetColId = cols[idx]?.dataset.columnId || cols[idx]?.dataset.stage;
      cols.forEach((c, i) => c.classList.toggle('v78-active-col', i === idx));
      if (targetColId) localStorage.setItem(`v78_mobileCol_${boardId}`, targetColId);
      // Scroll back to top
      board.scrollTop = 0;
    };

    _mobileActiveCol[boardId] = cols[activeIdx]?.dataset.columnId || cols[activeIdx]?.dataset.stage;
  }

  // ── Today's inspections banner ──────────────────────────────────────────

  let _todayDataCache = null;
  let _todayDataAt = 0;
  const TODAY_CACHE_MS = 60_000; // 60s

  async function fetchTodayInspections() {
    const now = Date.now();
    if (_todayDataCache && (now - _todayDataAt) < TODAY_CACHE_MS) {
      return _todayDataCache;
    }
    try {
      const r = await fetch(`/api/scheduled-inspections?date=today`);
      if (!r.ok) {
        // API may not yet support the date filter — degrade silently
        _todayDataCache = [];
        _todayDataAt = now;
        return [];
      }
      const data = await r.json();
      _todayDataCache = Array.isArray(data) ? data : [];
      _todayDataAt = now;
      return _todayDataCache;
    } catch (e) {
      console.warn('[v78] today inspections fetch failed:', e);
      _todayDataCache = [];
      _todayDataAt = now;
      return [];
    }
  }

  async function refreshTodayBanner() {
    if (!isMobile()) {
      const existing = document.querySelector('.v78-today-banner');
      if (existing) existing.remove();
      return;
    }

    const kanbanView = document.querySelector('.kanban-view.visible')
                    || document.getElementById('kanbanView');
    if (!kanbanView) return;
    if (!kanbanView.classList.contains('visible')) {
      const existing = document.querySelector('.v78-today-banner');
      if (existing) existing.remove();
      return;
    }

    const inspections = await fetchTodayInspections();
    const count = inspections.length;

    let banner = document.querySelector('.v78-today-banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.className = 'v78-today-banner';
      // Insert above kb-board (after kanban-header)
      const header = kanbanView.querySelector('.kanban-header');
      if (header && header.nextSibling) {
        kanbanView.insertBefore(banner, header.nextSibling);
      } else {
        kanbanView.appendChild(banner);
      }
    }

    if (count > 0) {
      banner.classList.remove('v78-today-banner-empty');
      banner.innerHTML = `
        <span>📋 Today's inspections</span>
        <span class="v78-today-banner-count">${count}</span>`;
      banner.onclick = () => openTodayPanel(inspections);
    } else {
      banner.classList.add('v78-today-banner-empty');
      banner.innerHTML = `<span>No inspections today</span>`;
      banner.onclick = null;
    }
  }

  function openTodayPanel(inspections) {
    let panel = document.querySelector('.v78-today-panel');
    if (panel) panel.remove();

    panel = document.createElement('div');
    panel.className = 'v78-today-panel';
    panel.innerHTML = `
      <div class="v78-today-panel-header">
        <button class="v78-today-panel-back" aria-label="Back">←</button>
        <div class="v78-today-panel-title">Today's inspections</div>
      </div>
      <div class="v78-today-panel-list"></div>`;

    // Sort by start_time
    const sorted = [...inspections].sort((a, b) => {
      return String(a.start_time || '').localeCompare(String(b.start_time || ''));
    });

    const listEl = panel.querySelector('.v78-today-panel-list');
    if (!sorted.length) {
      listEl.innerHTML = '<div class="v78-today-panel-empty">No inspections scheduled for today.</div>';
    } else {
      sorted.forEach(insp => {
        const row = document.createElement('div');
        row.className = 'v78-today-panel-row';
        const time = `${fmtTime(insp.start_time)}${insp.end_time ? '–' + fmtTime(insp.end_time) : ''}`;
        const addr = insp.property_address || insp.listing_address || insp.address || `Listing #${insp.listing_deal_id}`;
        const typeLabel = (insp.inspection_type || '').replace(/_/g, ' ');
        const status = insp.status || 'planned';
        row.innerHTML = `
          <div class="v78-today-panel-row-time">${time}${typeLabel ? ' · ' + typeLabel : ''}</div>
          <div class="v78-today-panel-row-addr">${escapeHtml(addr)}</div>
          <div class="v78-today-panel-row-meta">${insp.attendance_count ? insp.attendance_count + ' attendees' : 'No attendees yet'} · ${status}</div>`;
        row.addEventListener('click', () => {
          panel.remove();
          jumpToListingDeal(insp.listing_deal_id, insp.id);
        });
        listEl.appendChild(row);
      });
    }

    panel.querySelector('.v78-today-panel-back').addEventListener('click', () => {
      panel.remove();
    });

    document.body.appendChild(panel);
  }

  function jumpToListingDeal(dealId, inspectionId) {
    // We need the deal to be in the in-memory pipeline before openCardModal
    // can find it. If it's not, the deal is on a board we haven't loaded yet.
    // Fetch it, slot it in, then open.
    if (window.pipeline && window.pipeline[dealId]) {
      if (typeof window.openCardModal === 'function') {
        window.openCardModal(dealId);
      }
      return;
    }
    fetch(`/api/deals?id=${encodeURIComponent(dealId)}`).then(r => r.json()).then(deal => {
      if (!deal) {
        alert('Could not load deal — try navigating manually.');
        return;
      }
      // Wrap into a pipeline-shaped entry
      if (window.pipeline) {
        window.pipeline[dealId] = window.pipeline[dealId] || deal;
      }
      if (typeof window.openCardModal === 'function') {
        window.openCardModal(dealId);
      } else {
        alert('Navigation unavailable — please open the listing manually.');
      }
    }).catch(err => {
      console.warn('[v78] jumpToListingDeal fetch failed:', err);
      alert('Could not load deal — try navigating manually.');
    });
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"]/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'
    })[c]);
  }

  // ── Resize handling — re-render mobile layout when crossing breakpoint ─

  let _wasMobile = isMobile();
  const onResize = debounce(() => {
    const nowMobile = isMobile();
    if (nowMobile !== _wasMobile) {
      _wasMobile = nowMobile;
      // Re-trigger kanban render via existing renderBoard (CSS handles the rest)
      if (typeof window.renderBoard === 'function') {
        try { window.renderBoard(); } catch (_) {}
      }
      applyKanbanMobileLayout();
      refreshTodayBanner();
      if (!nowMobile) closeDrawer();
    } else if (nowMobile) {
      // Same-mobile resize — just tweak active column display
      applyKanbanMobileLayout();
    }
  }, 200);

  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', onResize);

  // ── Boot ────────────────────────────────────────────────────────────────

  function boot() {
    initHamburger();
    // Run once kanban view is ready. The view exists in DOM at load; just
    // refresh banner when a board is rendered.
    setTimeout(() => {
      applyKanbanMobileLayout();
      refreshTodayBanner();
    }, 600);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // ── Public API ──────────────────────────────────────────────────────────

  window.MobileShell = {
    isMobile,
    applyKanbanMobileLayout,
    refreshTodayBanner,
    openTodayPanel,
    closeDrawer,
  };
})();
