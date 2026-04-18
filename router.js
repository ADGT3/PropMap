/**
 * router.js — V75.2 client-side router
 *
 * Owns top-level navigation state. Replaces the individual per-button click
 * listeners that used to fire toggleKanban/toggleCRM/toggleFinance directly.
 * Now the buttons just navigate to a URL; the router reads the URL and
 * drives the module toggles so everything stays consistent with the browser
 * back button.
 *
 * Routes:
 *   /                              → Mapping (default)
 *   /mapping                       → Mapping
 *   /pipeline                      → Pipeline
 *   /pipeline/deal/:id             → Pipeline, with deal modal open
 *   /crm                           → CRM (Contacts)
 *   /crm/contacts                  → CRM Contacts tab
 *   /crm/contacts/:id              → CRM Contacts tab, drawer open
 *   /crm/organisations             → CRM Organisations tab
 *   /crm/organisations/:id         → CRM Organisations tab, drawer open
 *   /finance                       → Finance
 *   /tools                         → Tools (placeholder module — currently tools is a dropdown)
 *   /settings                      → System Settings (empty scaffold in V75.2)
 *
 * Modules coordinate via these globals (all already exist from V74/V75.0):
 *   - toggleKanban(show)            — opens/closes Pipeline view
 *   - toggleCRM(show)               — opens/closes CRM view
 *   - window.FinanceModule.toggle() — opens/closes Finance view
 *   - toggleSettings(show)          — opens/closes Settings view (new in V75.2)
 *
 * Only one data-centric module is shown at a time. Mapping is the "empty"
 * state where all data-centric views are closed and the map is the main
 * content.
 */

(function () {
  const TITLES = {
    mapping:  'Sydney Property Map',
    pipeline: 'Pipeline — Sydney Property Map',
    crm:      'CRM — Sydney Property Map',
    finance:  'Finance — Sydney Property Map',
    tools:    'Tools — Sydney Property Map',
    settings: 'System Settings — Sydney Property Map',
  };

  // Parse a URL path into a normalised route descriptor.
  // Returns { module, subRoute, entityId } — any of those may be null.
  function parsePath(path) {
    if (!path || path === '/' || path === '') return { module: 'mapping', subRoute: null, entityId: null };
    const parts = path.replace(/^\//, '').split('/').filter(Boolean);
    const module = parts[0];
    const validModules = ['mapping', 'pipeline', 'crm', 'finance', 'tools', 'settings'];
    if (!validModules.includes(module)) return { module: 'mapping', subRoute: null, entityId: null };

    return {
      module,
      subRoute: parts[1] || null,
      entityId: parts[2] || null,
    };
  }

  // Close every data-centric module first; then open the one we want.
  // This centralisation means any previously-open module is dismissed when
  // navigating somewhere else, regardless of how the user got there.
  function closeAllModules() {
    if (typeof toggleKanban   === 'function') toggleKanban(false);
    if (typeof toggleCRM      === 'function') toggleCRM(false);
    if (window.FinanceModule && typeof window.FinanceModule.toggle === 'function') {
      window.FinanceModule.toggle(false);
    } else {
      // Fallback: direct class removal if the module didn't expose a toggle
      document.getElementById('financeView')?.classList.remove('visible');
      document.getElementById('financeNavBtn')?.classList.remove('active');
    }
    if (typeof toggleSettings === 'function') toggleSettings(false);
  }

  // Render a route — apply module visibility, update nav highlight, set title.
  function render(route) {
    closeAllModules();

    switch (route.module) {
      case 'pipeline':
        if (typeof toggleKanban === 'function') toggleKanban(true);
        // Deep link: open a specific deal modal
        if (route.subRoute === 'deal' && route.entityId && typeof openCardModal === 'function') {
          // Small delay so the Kanban board has rendered first
          setTimeout(() => openCardModal(route.entityId), 100);
        }
        break;

      case 'crm':
        if (typeof toggleCRM === 'function') toggleCRM(true);
        // Deep link: switch CRM sub-tab and open drawer
        if (route.subRoute && window.CRM && typeof window.CRM.navigateTo === 'function') {
          setTimeout(() => window.CRM.navigateTo(route.subRoute, route.entityId), 100);
        }
        break;

      case 'finance':
        // finance-module.js attaches a click listener to #financeNavBtn that
        // calls renderFinanceView() then toggleFinance(). Triggering that
        // click programmatically is the cleanest way to open finance from
        // the router without duplicating the render/toggle logic here.
        document.getElementById('financeNavBtn')?.click();
        break;

      case 'settings':
        if (typeof toggleSettings === 'function') toggleSettings(true);
        break;

      case 'tools':
        // Tools is still a dropdown — for now /tools just shows the dropdown
        // open on the Mapping view. Real Tools module may come later.
        document.getElementById('toolsDropdownMenu')?.classList.add('open');
        break;

      case 'mapping':
      default:
        // Nothing to do — all modules closed = Mapping visible
        break;
    }

    // Highlight active nav button
    document.querySelectorAll('[data-module-nav]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.moduleNav === route.module);
    });

    // Secondary bar — show the one matching this module, hide others
    document.querySelectorAll('[data-module-bar]').forEach(bar => {
      bar.style.display = (bar.dataset.moduleBar === route.module) ? '' : 'none';
    });

    // Body data-route attribute lets CSS target per-route states
    // (e.g. hide secondary bar on Mapping, adjust inset for views)
    document.body.dataset.route = route.module;

    // Document title
    document.title = TITLES[route.module] || TITLES.mapping;

    // Emit event so modules can react (e.g. CRM refreshes list on re-entry)
    window.dispatchEvent(new CustomEvent('modulechange', { detail: route }));
  }

  // Public navigation API — pushes a new history entry and renders.
  function navigate(path, replace = false) {
    const route = parsePath(path);
    const url = buildUrl(route);
    if (replace) {
      history.replaceState({ route }, '', url);
    } else {
      history.pushState({ route }, '', url);
    }
    render(route);
  }

  function buildUrl(route) {
    if (route.module === 'mapping') return '/';
    let url = '/' + route.module;
    if (route.subRoute) url += '/' + route.subRoute;
    if (route.entityId) url += '/' + route.entityId;
    return url;
  }

  // Back/forward button handling
  window.addEventListener('popstate', (e) => {
    const route = (e.state && e.state.route) || parsePath(location.pathname);
    render(route);
  });

  // Initial render on page load
  function init() {
    const route = parsePath(location.pathname);
    // Replace initial history entry so back button works naturally
    history.replaceState({ route }, '', buildUrl(route));
    render(route);
  }

  // Public API
  window.Router = {
    navigate,
    parsePath,
    current: () => parsePath(location.pathname),
    init,
  };

  // Auto-init once the page is interactive — after other scripts have defined
  // toggleKanban, toggleCRM, etc.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
