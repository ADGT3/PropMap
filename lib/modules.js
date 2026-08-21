/**
 * lib/modules.js
 *
 * Canonical application modules. Security (access_modules on contacts / JWT),
 * navigation, and API gating all use these ids.
 *
 * Legacy alias: 'propmap' is treated as full access to every module for
 * sessions created before module-scoped grants existed.
 */

export const APP_MODULES = Object.freeze([
  {
    id: 'mapping',
    label: 'Mapping',
    description: 'Map, listings search, overlays, parcels on the map',
    apiPrefixes: [
      '/api/domain-search',
      '/api/domain-price-estimates',
      '/api/elevation-tile',
      '/api/cadastre',
      '/api/nsw-',
      '/api/parcels',
      '/api/properties',
      '/api/tiles',
      '/api/parcel-format',
      '/api/create-parcel-from-lookup',
      '/api/backfill-parcel-rings',
      '/api/rebuild-parcel-by-lotdp',
      '/api/sources',
      '/api/usage',
    ],
  },
  {
    id: 'pipeline',
    label: 'Pipeline',
    description: 'Boards, deals, actions, inspections, agency agreements, lease offers',
    apiPrefixes: [
      '/api/boards',
      '/api/deals',
      '/api/deal-order',
      '/api/actions',
      '/api/pipeline',
      '/api/inspections',
      '/api/inspection-',
      '/api/scheduled-inspections',
      '/api/agency-agreements',
      '/api/applications',
      '/api/applicant-',
      '/api/lease',
      '/api/dd-',
      '/api/enquiry-card-meta',
      '/api/evidence-',
      '/api/attendee-registration',
    ],
  },
  {
    id: 'crm',
    label: 'CRM',
    description: 'Contacts, organisations, notes, roles, marketing',
    apiPrefixes: [
      '/api/contacts',
      '/api/contact-',
      '/api/notes',
      '/api/roles',
      '/api/marketing',
      '/api/interaction-',
      '/api/disciplines',
    ],
  },
  {
    id: 'finance',
    label: 'Finance',
    description: 'Feasibility, financials, valuations',
    apiPrefixes: [
      '/api/finance',
      '/api/property-financials',
    ],
  },
]);


export const APP_MODULE_IDS = APP_MODULES.map(m => m.id);

/** Legacy JWT/module grants that mean "all modules". */
export const LEGACY_FULL_ACCESS = new Set(['*', 'propmap']);

/**
 * Normalise a raw access_modules array from DB/JWT into the four module ids.
 * - ['*'] or ['propmap'] → all four modules
 * - unknown ids dropped
 * - empty → none
 */
export function expandAccessModules(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  if (raw.some(m => LEGACY_FULL_ACCESS.has(m))) return [...APP_MODULE_IDS];
  const set = new Set();
  for (const m of raw) {
    if (APP_MODULE_IDS.includes(m)) set.add(m);
  }
  return [...set];
}

export function sessionHasModule(session, moduleId) {
  if (!session) return false;
  if (session.isAdmin) return true;
  const expanded = expandAccessModules(session.modules || []);
  return expanded.includes(moduleId);
}

/**
 * Resolve which app module owns an API pathname (first match wins).
 * Returns null if the path is shared/auth/admin and should not be module-gated
 * at this layer.
 */
export function moduleForApiPath(pathname) {
  if (!pathname || !pathname.startsWith('/api/')) return null;
  // Shared / auth / admin — not module-scoped
  if (
    pathname.startsWith('/api/auth/') ||
    pathname.startsWith('/api/health') ||
    pathname.startsWith('/api/public/') ||
    pathname.startsWith('/api/system-settings') ||
    pathname.startsWith('/api/db-setup') ||
    pathname.startsWith('/api/migrate') ||
    pathname.startsWith('/api/repair') ||
    pathname.startsWith('/api/cleanup')
  ) {
    return null;
  }
  for (const mod of APP_MODULES) {
    for (const prefix of mod.apiPrefixes) {
      if (pathname === prefix || pathname.startsWith(prefix)) return mod.id;
    }
  }
  return null;
}
