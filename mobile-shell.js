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
 *   3. The "Upcoming Inspections" full-screen panel triggered by the
 *      user-menu item. Lists listings with at least one upcoming inspection
 *      (today or later), one card per listing sorted by earliest upcoming
 *      time. Visible on every device size, not just mobile. Tapping a card
 *      opens the listing's deal modal.
 *
 * Activates on viewport changes; mobile-only features no-op on desktop.
 * All CSS for these features lives in mobile.css.
 *
 * Public API (window.MobileShell):
 *   isMobile()                          → boolean
 *   applyKanbanMobileLayout()           → called by kanban.js renderBoard()
 *   openUpcomingInspectionsPanel()      → manually open the panel
 *   closeDrawer()                       → close the hamburger drawer
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

  // ── Upcoming Inspections panel (triggered by user-menu item) ───────────

  let _upcomingDataCache = null;
  let _upcomingDataAt = 0;
  const UPCOMING_CACHE_MS = 60_000; // 60s

  async function fetchUpcomingInspections() {
    const now = Date.now();
    if (_upcomingDataCache && (now - _upcomingDataAt) < UPCOMING_CACHE_MS) {
      return _upcomingDataCache;
    }
    try {
      const r = await fetch(`/api/scheduled-inspections?date=upcoming`);
      if (!r.ok) {
        _upcomingDataCache = [];
        _upcomingDataAt = now;
        return [];
      }
      const data = await r.json();
      _upcomingDataCache = Array.isArray(data) ? data : [];
      _upcomingDataAt = now;
      return _upcomingDataCache;
    } catch (e) {
      console.warn('[v78] upcoming inspections fetch failed:', e);
      _upcomingDataCache = [];
      _upcomingDataAt = now;
      return [];
    }
  }

  // Group inspections by listing_deal_id, keep earliest per listing
  function groupInspectionsByListing(inspections) {
    const byListing = new Map();
    for (const insp of inspections) {
      const key = insp.listing_deal_id;
      if (!byListing.has(key)) {
        byListing.set(key, { listing_deal_id: key, inspections: [], earliest: insp });
      }
      const entry = byListing.get(key);
      entry.inspections.push(insp);
      // Compare scheduled_date + start_time; earliest wins
      const a = `${insp.scheduled_date} ${insp.start_time || '00:00'}`;
      const b = `${entry.earliest.scheduled_date} ${entry.earliest.start_time || '00:00'}`;
      if (a < b) entry.earliest = insp;
    }
    // Convert to array sorted by earliest inspection time
    const list = Array.from(byListing.values());
    list.sort((a, b) => {
      const ka = `${a.earliest.scheduled_date} ${a.earliest.start_time || '00:00'}`;
      const kb = `${b.earliest.scheduled_date} ${b.earliest.start_time || '00:00'}`;
      return ka.localeCompare(kb);
    });
    return list;
  }

  function fmtDate(iso) {
    if (!iso) return '';
    // scheduled_date may come back as either:
    //   - a date-only string "YYYY-MM-DD"
    //   - a full ISO timestamp "YYYY-MM-DDT00:00:00.000Z"
    // Strip to first 10 chars to get just the date portion.
    const datePart = String(iso).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return String(iso);
    const [y, m, d] = datePart.split('-');
    // Australian format: DD-MM-YYYY
    return `${d}-${m}-${y}`;
  }

  async function openUpcomingInspectionsPanel() {
    // Close user menu if open
    const userMenu = document.getElementById('userMenuDropdown');
    if (userMenu) userMenu.classList.remove('open');

    // Remove any existing panel
    const existing = document.querySelector('.v78-upcoming-panel');
    if (existing) existing.remove();

    const panel = document.createElement('div');
    panel.className = 'v78-upcoming-panel';
    panel.innerHTML = `
      <div class="v78-upcoming-panel-header">
        <button class="v78-upcoming-panel-back" aria-label="Back">←</button>
        <div class="v78-upcoming-panel-title">Upcoming Inspections</div>
        <button class="v78-upcoming-panel-close" aria-label="Close">✕</button>
      </div>
      <div class="v78-upcoming-panel-list">
        <div class="v78-upcoming-panel-loading">Loading…</div>
      </div>`;
    document.body.appendChild(panel);

    const close = () => panel.remove();
    panel.querySelector('.v78-upcoming-panel-back').addEventListener('click', close);
    panel.querySelector('.v78-upcoming-panel-close').addEventListener('click', close);

    const inspections = await fetchUpcomingInspections();
    const grouped = groupInspectionsByListing(inspections);

    const listEl = panel.querySelector('.v78-upcoming-panel-list');
    if (!grouped.length) {
      listEl.innerHTML = '<div class="v78-upcoming-panel-empty">No upcoming inspections scheduled.</div>';
      return;
    }

    listEl.innerHTML = '';
    grouped.forEach(group => {
      const insp = group.earliest;
      const card = document.createElement('div');
      card.className = 'v78-upcoming-card';
      const addr = insp.property_address || `Listing #${insp.listing_deal_id}`;
      const suburb = insp.property_suburb ? ` · ${insp.property_suburb}` : '';
      const time = `${fmtTime(insp.start_time)}${insp.end_time ? '–' + fmtTime(insp.end_time) : ''}`;
      const dateLabel = fmtDate(insp.scheduled_date);
      const typeLabel = (insp.inspection_type || '').replace(/_/g, ' ');
      const moreCount = group.inspections.length - 1;
      const moreBadge = moreCount > 0 ? `<span class="v78-upcoming-card-more">+${moreCount} more</span>` : '';

      card.innerHTML = `
        <div class="v78-upcoming-card-when">
          <span class="v78-upcoming-card-date">${escapeHtml(dateLabel)}</span>
          <span class="v78-upcoming-card-time">${escapeHtml(time)}</span>
          ${typeLabel ? `<span class="v78-upcoming-card-type">${escapeHtml(typeLabel)}</span>` : ''}
          ${moreBadge}
        </div>
        <div class="v78-upcoming-card-addr">${escapeHtml(addr)}${escapeHtml(suburb)}</div>
        <div class="v78-upcoming-card-meta">${insp.attendance_count ? insp.attendance_count + ' attendees registered' : 'No attendees yet'}</div>`;

      card.addEventListener('click', () => {
        close();
        jumpToListingDeal(group.listing_deal_id, insp.id);
      });
      listEl.appendChild(card);
    });
  }

  async function jumpToListingDeal(dealId, inspectionId) {
    // Make sure the deal is loaded into the kanban's in-memory pipeline before
    // opening its modal. openCardModal reads pipeline[dealId] and expects a
    // properly-shaped entry (with .property etc.) — so we delegate to
    // reloadPipelineEntryFromDb which handles the fetch + shape conversion.
    if (typeof window.openCardModal !== 'function') {
      alert('Pipeline not loaded yet — please open the Pipeline tab first, then try again.');
      return;
    }
    try {
      // Always re-fetch to ensure we have the latest data and the entry exists
      // in pipeline (it might already be there from a kanban render — that's
      // fine, this just refreshes it).
      if (typeof window.reloadPipelineEntryFromDb === 'function') {
        await window.reloadPipelineEntryFromDb(dealId);
      }
      // openCardModal reads from the kanban's internal `pipeline` dict; if
      // reloadPipelineEntryFromDb succeeded the entry is now there.
      window.openCardModal(dealId);
    } catch (err) {
      console.warn('[v78] jumpToListingDeal failed:', err);
      alert('Could not open deal — try opening it manually from the kanban.');
    }
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"]/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'
    })[c]);
  }

  // Wire user-menu click handler to open the panel.
  function initUpcomingMenuItem() {
    const btn = document.getElementById('userMenuUpcomingInspections');
    if (!btn) return;
    if (btn.dataset.v78Wired === '1') return;
    btn.dataset.v78Wired = '1';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      // Invalidate cache so the agent always sees fresh data when they open it
      _upcomingDataCache = null;
      _upcomingDataAt = 0;
      openUpcomingInspectionsPanel();
    });
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
    initUpcomingMenuItem();
    setTimeout(() => {
      applyKanbanMobileLayout();
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
    openUpcomingInspectionsPanel,
    closeDrawer,
  };
})();
