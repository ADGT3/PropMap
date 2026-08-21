/**
 * lookups.js — V77.1
 *
 * Client-side cache for the three lookup tables: roles, contact_sources,
 * interaction_types. Replaces the hardcoded ROLES/SOURCES arrays in crm.js.
 *
 * Load order: this script must come before crm.js and kanban.js in index.html.
 *
 * Public API (attached to window.Lookups):
 *
 *   await Lookups.getRoles()           → [{ id, label, scopes, default_scope, sort_order, active, system }]
 *   await Lookups.getRoles({ scope: 'deal' })
 *   await Lookups.getRolesActive()    → active rows only (for dropdowns)
 *   Lookups.roleLabel(id)              → string (sync — uses cache or returns id)
 *   Lookups.rolesForScope(scope)       → sync filtered active rows from cache
 *
 *   await Lookups.getSources()         → [{ id, label, sort_order, active, system }]
 *   await Lookups.getSourcesActive()   → active only
 *   Lookups.sourceLabel(id)            → string (sync — uses cache or returns id)
 *
 *   await Lookups.getInteractionTypes()        → [{ id, label, direction, sort_order, active, system }]
 *   await Lookups.getInteractionTypesActive()  → active only
 *   Lookups.interactionTypeLabel(id)            → string (sync)
 *   Lookups.interactionDirection(id)            → 'inbound' | 'outbound' | 'internal' | null
 *
 *   Lookups.invalidate()              → clears all caches (call after Parameters page edits)
 *   Lookups.invalidateRoles() / invalidateSources() / invalidateInteractionTypes()
 *
 * The cache is populated lazily on first call. Each lookup is fetched once per
 * page load unless explicitly invalidated. After invalidation the next async
 * call refetches.
 *
 * Sync-by-id label methods (roleLabel, sourceLabel, interactionTypeLabel) are
 * for rendering — they need the cache pre-populated (via an earlier async call)
 * or they fall back to returning the raw id. In practice every UI surface that
 * displays labels also fetches the dropdown list nearby, so the cache is warm
 * by the time render code runs.
 */

(function () {
  'use strict';

  // Internal caches — null means "not yet fetched", [] means "fetched, empty"
  let _rolesCache             = null;
  let _sourcesCache           = null;
  let _interactionTypesCache  = null;

  // V77.2g — TTL for roles cache. Roles change rarely (only via System
  // Settings → Parameters), but other agents' edits don't push to this
  // browser. A short TTL ensures changes propagate within ~1 minute without
  // requiring a page reload. Manual edits in the same browser still call
  // invalidateRoles() for instant refresh.
  const ROLES_TTL_MS = 60_000;
  let _rolesCachedAt = 0;

  // In-flight promises so concurrent calls share one fetch
  let _rolesPromise            = null;
  let _sourcesPromise          = null;
  let _interactionTypesPromise = null;

  async function _fetchAndCache(url, setCache) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url} → ${r.status}`);
    const rows = await r.json();
    setCache(rows);
    return rows;
  }

  // ── Roles ─────────────────────────────────────────────────────────────────

  async function getRoles(opts = {}) {
    const stale = Date.now() - _rolesCachedAt > ROLES_TTL_MS;
    if (_rolesCache !== null && !stale) {
      return opts.scope ? _rolesCache.filter(r => Array.isArray(r.scopes) && r.scopes.includes(opts.scope)) : _rolesCache;
    }
    if (!_rolesPromise) {
      _rolesPromise = _fetchAndCache('/api/roles', rows => {
        _rolesCache = rows;
        _rolesCachedAt = Date.now();
      })
        .catch(err => { _rolesPromise = null; throw err; });
    }
    try {
      await _rolesPromise;
    } finally {
      _rolesPromise = null;  // allow next refresh
    }
    return opts.scope ? _rolesCache.filter(r => Array.isArray(r.scopes) && r.scopes.includes(opts.scope)) : _rolesCache;
  }

  async function getRolesActive(opts = {}) {
    const all = await getRoles(opts);
    return all.filter(r => r.active);
  }

  function roleLabel(id) {
    if (_rolesCache === null) return id;
    const r = _rolesCache.find(x => x.id === id);
    return r ? r.label : id;
  }

  // Sync filtered list — returns whatever's in cache (empty array if not loaded yet).
  // Caller should kick off getRolesActive() somewhere before relying on this.
  function rolesForScope(scope) {
    if (_rolesCache === null) return [];
    return _rolesCache.filter(r => r.active && Array.isArray(r.scopes) && r.scopes.includes(scope));
  }

  // V77.2g — Find the roles flagged for a given board (e.g. 'sys_lease_listings').
  // Returns an array of role objects (sorted by sort_order). Empty array if no
  // roles claim that board. Card creation should:
  //   - if list is empty → contact step optional, can be left blank
  //   - if list has items → contact step required, role dropdown shows these
  async function getDefaultRolesForBoard(boardId) {
    const rows = await getRoles();
    if (!Array.isArray(rows)) return [];
    return rows
      .filter(r => r.active && Array.isArray(r.board_ids) && r.board_ids.includes(boardId))
      .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  }

  function invalidateRoles() {
    _rolesCache    = null;
    _rolesCachedAt = 0;
    _rolesPromise  = null;
  }

  // ── Sources ───────────────────────────────────────────────────────────────

  async function getSources() {
    if (_sourcesCache !== null) return _sourcesCache;
    if (!_sourcesPromise) {
      _sourcesPromise = _fetchAndCache('/api/sources', rows => { _sourcesCache = rows; })
        .catch(err => { _sourcesPromise = null; throw err; });
    }
    await _sourcesPromise;
    return _sourcesCache;
  }

  async function getSourcesActive() {
    const all = await getSources();
    return all.filter(s => s.active);
  }

  function sourceLabel(id) {
    if (!id || _sourcesCache === null) return id || '';
    const s = _sourcesCache.find(x => x.id === id);
    return s ? s.label : id;
  }

  function invalidateSources() {
    _sourcesCache   = null;
    _sourcesPromise = null;
  }

  // ── Interaction Types ─────────────────────────────────────────────────────

  async function getInteractionTypes() {
    if (_interactionTypesCache !== null) return _interactionTypesCache;
    if (!_interactionTypesPromise) {
      _interactionTypesPromise = _fetchAndCache('/api/interaction-types', rows => { _interactionTypesCache = rows; })
        .catch(err => { _interactionTypesPromise = null; throw err; });
    }
    await _interactionTypesPromise;
    return _interactionTypesCache;
  }

  async function getInteractionTypesActive() {
    const all = await getInteractionTypes();
    return all.filter(t => t.active);
  }

  function interactionTypeLabel(id) {
    if (!id || _interactionTypesCache === null) return id || '';
    const t = _interactionTypesCache.find(x => x.id === id);
    return t ? t.label : id;
  }

  function interactionDirection(id) {
    if (!id || _interactionTypesCache === null) return null;
    const t = _interactionTypesCache.find(x => x.id === id);
    return t ? t.direction : null;
  }

  function invalidateInteractionTypes() {
    _interactionTypesCache   = null;
    _interactionTypesPromise = null;
  }

  // ── Combined invalidate ───────────────────────────────────────────────────

  function invalidate() {
    invalidateRoles();
    invalidateSources();
    invalidateInteractionTypes();
  }

  // ── Eager prefetch ────────────────────────────────────────────────────────
  // Kicks off all three fetches in parallel; can be called early to warm cache
  // before any UI renders, so synchronous label lookups work first time.
  async function preload() {
    await Promise.all([getRoles(), getSources(), getInteractionTypes()]);
  }

  // ── Expose ────────────────────────────────────────────────────────────────

  window.Lookups = {
    getRoles, getRolesActive, roleLabel, rolesForScope, getDefaultRolesForBoard, invalidateRoles,
    getSources, getSourcesActive, sourceLabel, invalidateSources,
    getInteractionTypes, getInteractionTypesActive, interactionTypeLabel, interactionDirection, invalidateInteractionTypes,
    invalidate, preload,
  };

  // Auto-preload on load (warms cache before any modal opens)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { preload().catch(() => {}); });
  } else {
    preload().catch(() => {});
  }
})();
