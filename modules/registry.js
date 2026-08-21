/**
 * modules/registry.js
 *
 * Client-side application module registry (Mapping, Pipeline, CRM, Finance).
 * Gates top nav and route entry from session.modules.
 *
 * Loaded early from index.html. Exposes window.AppModules.
 *
 * Module ids match lib/modules.js / JWT access_modules.
 * Legacy grants: '*' and 'propmap' → all modules.
 */
(function (global) {
  const APP_MODULES = [
    { id: 'mapping',  label: 'Mapping',  nav: 'mapping',  path: '/mapping'  },
    { id: 'pipeline', label: 'Pipeline', nav: 'pipeline', path: '/pipeline' },
    { id: 'crm',      label: 'CRM',      nav: 'crm',      path: '/crm'      },
    { id: 'finance',  label: 'Finance',  nav: 'finance',  path: '/finance'  },
  ];
  const ALL_IDS = APP_MODULES.map(m => m.id);
  const LEGACY_FULL = new Set(['*', 'propmap']);

  // Board kind defaults (mirror lib/board-kinds.js for offline / pre-migration)
  const BOARD_ID_TO_KIND = {
    sys_acquisition:    'acquisition',
    sys_sales_enquiry:  'sales_enquiry',
    sys_lease_enquiry:  'lease_enquiry',
    sys_sales_listings: 'sales_listing',
    sys_lease_listings: 'lease_listing',
  };
  const BOARD_KIND_FEATURES = {
    acquisition:    ['dd', 'finance', 'vendor_terms', 'map_highlight', 'full_property_card', 'pipeline_map_stages'],
    sales_enquiry:  ['enquiry_contacts', 'interest_level', 'enquiry_card'],
    lease_enquiry:  ['enquiry_contacts', 'interest_level', 'enquiry_card', 'lease_offer', 'validation'],
    sales_listing:  ['vendor_terms', 'listing_summary', 'agency_agreements', 'listing_card'],
    lease_listing:  ['lease_terms', 'listing_summary', 'agency_agreements', 'lease_offers_received', 'listing_card', 'rent_display'],
    action:         ['actions_board'],
    custom:         ['full_property_card'],
  };

  let _granted = null; // null = unknown (not loaded yet); array of module ids

  function expand(raw) {
    if (!Array.isArray(raw) || !raw.length) return [];
    if (raw.some(m => LEGACY_FULL.has(m))) return ALL_IDS.slice();
    return ALL_IDS.filter(id => raw.includes(id));
  }

  function setFromSession(user) {
    if (!user) {
      _granted = [];
      applyNav();
      return;
    }
    if (user.isAdmin) {
      _granted = ALL_IDS.slice();
    } else {
      _granted = expand(user.modules || []);
    }
    applyNav();
  }

  function has(moduleId) {
    if (_granted === null) return true; // optimistic until /api/auth/me returns
    if (!_granted.length && _granted !== null) return false;
    return _granted.includes(moduleId);
  }

  function granted() {
    return _granted === null ? ALL_IDS.slice() : _granted.slice();
  }

  function applyNav() {
    document.querySelectorAll('[data-module-nav]').forEach(btn => {
      const nav = btn.getAttribute('data-module-nav');
      // mapping nav → mapping module; etc.
      const mod = APP_MODULES.find(m => m.nav === nav);
      if (!mod) return;
      const ok = has(mod.id);
      btn.hidden = !ok;
      btn.disabled = !ok;
      btn.setAttribute('aria-hidden', ok ? 'false' : 'true');
    });
  }

  function firstAllowedPath() {
    for (const m of APP_MODULES) {
      if (has(m.id)) return m.path;
    }
    return '/login.html';
  }

  function canEnterPath(path) {
    if (!path) return true;
    if (path === '/' || path === '/mapping') return has('mapping');
    if (path.startsWith('/pipeline') || path.startsWith('/deal')) return has('pipeline');
    if (path.startsWith('/crm')) return has('crm');
    if (path.startsWith('/finance')) return has('finance');
    return true;
  }

  // ── Board capabilities (client) ──────────────────────────────────────────
  function resolveBoardCapabilities(board) {
    if (!board) return { kind: null, features: [] };
    let kind = board.kind || BOARD_ID_TO_KIND[board.id] || null;
    if (!kind && board.board_type === 'action') kind = 'action';
    if (!kind) kind = 'custom';
    const defaults = BOARD_KIND_FEATURES[kind] || BOARD_KIND_FEATURES.custom;
    const override = Array.isArray(board.features) && board.features.length ? board.features : null;
    return { kind, features: (override || defaults).slice() };
  }

  function boardHasFeature(boardOrId, feature, boardsList) {
    let board = boardOrId;
    if (typeof boardOrId === 'string') {
      board = (boardsList || global.boards || []).find(b => b.id === boardOrId) || { id: boardOrId };
    }
    return resolveBoardCapabilities(board).features.includes(feature);
  }

  /**
   * Fetch /api/auth/me and apply module grants. Returns user or null.
   */
  async function initFromAuthMe() {
    try {
      const res = await fetch('/api/auth/me');
      const data = await res.json();
      if (data && data.authenticated && data.user) {
        setFromSession(data.user);
        global._sessionUser = data.user;
        global._pipelineIsAdmin = !!data.user.isAdmin;
        global._sessionUserId = data.user.id;
        return data.user;
      }
      setFromSession(null);
      return null;
    } catch (err) {
      console.warn('[AppModules] auth/me failed:', err);
      // Fail open for offline/dev so the UI remains usable
      _granted = ALL_IDS.slice();
      applyNav();
      return null;
    }
  }

  global.AppModules = {
    APP_MODULES,
    ALL_IDS,
    setFromSession,
    has,
    granted,
    applyNav,
    firstAllowedPath,
    canEnterPath,
    resolveBoardCapabilities,
    boardHasFeature,
    initFromAuthMe,
  };
})(typeof window !== 'undefined' ? window : globalThis);
