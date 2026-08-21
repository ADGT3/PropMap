/**
 * map.js
 * Leaflet map, multi-overlay rendering, zone filtering, and GeoTIFF upload manager.
 * Self-contained GeoTIFF parser — no external library required. Works from file:// URLs.
 * Depends on: overlays-meta.js, overlays-b64-*.js, domain-api.js, dd-risks.js
 */

// Merge b64 image data from split overlay files into OVERLAYS
OVERLAYS.forEach(o => { if (window.OVERLAY_B64?.[o.id]) o.b64 = window.OVERLAY_B64[o.id]; });

// ─── Listings — populated by Domain API ──────────────────────────────────────
let listings = [];

// Last successful Domain search options — used by Reveal Price button to
// replay the same search at price brackets.
let _lastDomainSearchOptions = null;
let _lastSearchBounds = null;  // Bounds at the time of the last domain search
// True while a viewport-level reveal probe is running (prevents duplicate
// clicks from kicking off parallel batches).
let _revealInFlight = false;

// ─── State ────────────────────────────────────────────────────────────────────
let _activeFilters = {
  // V76.3 — propertyCategory drives which API is used and which fields apply
  propertyCategory:       'residential',  // 'residential' (Domain) | 'commercial' (CoreLogic)

  propertyTypes:          [],   // Domain: e.g. ['House', 'Land']
  listingType:            'Sale',
  minBeds:                null,
  maxBeds:                null,
  minBaths:               null,
  minCars:                null,

  // Domain sale price / rent per week (V76.3 — separate ranges)
  minPrice:               null,
  maxPrice:               null,
  minRentWeek:            null,
  maxRentWeek:            null,

  minLand:                null,  // Shared: Domain minLandArea | CoreLogic siteAreaFrom
  maxLand:                null,  // Shared: Domain maxLandArea | CoreLogic siteAreaTo

  features:               [],   // e.g. ['AirConditioning', 'SwimmingPool']
  listingAttributes:      [],   // e.g. ['HasPhotos']
  establishedType:        null, // 'New' | 'Established'
  listedSince:            null, // null | 7 | 14 | 30 — days; converted to ISO at search time
  excludePriceWithheld:   false,
  excludeDepositTaken:    true,
  newDevOnly:             false,
  showSnoozed:            false,    // V75.1 — show properties marked Not Suitable

  // V76.3 — CoreLogic-only fields
  corelogicPropertyType:  null,  // e.g. 'Office'
  minFloor:               null,  // floorAreaFrom
  maxFloor:               null,  // floorAreaTo
  minYield:               null,  // advertisedYieldFrom
  maxYield:               null,  // advertisedYieldTo
  minRentAnnum:           null,  // askingRentPerAnnumFrom
  maxRentAnnum:           null,  // askingRentPerAnnumTo
  minRentSqm:             null,  // askingRentPerSqmFrom
  maxRentSqm:             null,  // askingRentPerSqmTo
  strataUnitFlag:         'Both', // 'Both' | 'Yes' | 'No'
};
let activeZone   = 'all';
let showListings = true;
let markers      = {};

// V75.1 — Not Suitable / snooze state.
// Map of (Domain listing id OR lat,lng key) → { property_id, until, reason }
// Loaded from /api/properties on map init; mutated by mark-not-suitable actions.
const _notSuitable = {
  byListingId: new Map(),   // domain_listing_id → { property_id, until, reason }
  byLatLng:    new Map(),   // 'lat,lng' rounded → { property_id, until, reason }
};

function _llKey(lat, lng) {
  return `${Number(lat).toFixed(5)},${Number(lng).toFixed(5)}`;
}

// True if the given listing OR lat/lng is currently flagged not-suitable.
function isNotSuitable(listingOrLatLng) {
  const now = Date.now();
  const check = (entry) => {
    if (!entry) return false;
    if (!entry.until) return false;
    // 'infinity' permanent — always block
    if (entry.until === 'infinity' || entry.until === 'Infinity') return true;
    return Date.parse(entry.until) > now;
  };
  if (listingOrLatLng?.id != null) {
    if (check(_notSuitable.byListingId.get(String(listingOrLatLng.id)))) return true;
  }
  if (listingOrLatLng?.lat != null && listingOrLatLng?.lng != null) {
    if (check(_notSuitable.byLatLng.get(_llKey(listingOrLatLng.lat, listingOrLatLng.lng)))) return true;
  }
  return false;
}

// V76.5: cache of properties keyed by their Domain listing id, for the
// listing card display swap. Populated by loadNotSuitable().
const _propertyByDomainId = new Map();

// Fetch all properties currently flagged not-suitable; populate _notSuitable lookup.
// V76.5: also populate _propertyByDomainId, a cache used by the listing card
// renderer to swap a listing's address for the linked property's address when
// a link exists.
async function loadNotSuitable() {
  try {
    const res = await fetch('/api/properties');
    if (!res.ok) throw new Error('properties fetch failed');
    const props = await res.json();
    _notSuitable.byListingId.clear();
    _notSuitable.byLatLng.clear();
    _propertyByDomainId.clear();
    const now = Date.now();
    props.forEach(p => {
      // Cache the property link for any property carrying a domain_listing_id.
      // Used by buildListingCard to display the property's address instead of
      // Domain's when a link exists.
      if (p.domain_listing_id) {
        _propertyByDomainId.set(String(p.domain_listing_id), {
          id:      p.id,
          address: p.address,
          suburb:  p.suburb,
          lot_dps: p.lot_dps,
        });
      }
      if (!p.not_suitable_until) return;
      const isPerm = p.not_suitable_until === 'infinity' || p.not_suitable_until === 'Infinity';
      const stillActive = isPerm || Date.parse(p.not_suitable_until) > now;
      if (!stillActive) return;
      const entry = { property_id: p.id, until: p.not_suitable_until, reason: p.not_suitable_reason };
      if (p.domain_listing_id) _notSuitable.byListingId.set(String(p.domain_listing_id), entry);
      if (p.lat != null && p.lng != null) _notSuitable.byLatLng.set(_llKey(p.lat, p.lng), entry);
    });
  } catch (err) {
    console.warn('[V75.1] loadNotSuitable failed:', err);
  }
}

// V76.5.7 — convenience alias used by the listings panel link/unlink handlers
// to rebuild _propertyByDomainId after a link change so the linked badge and
// address-swap take effect immediately.
async function refreshListingsCacheAfterLinkChange() {
  await loadNotSuitable();
}
window.refreshListingsCacheAfterLinkChange = refreshListingsCacheAfterLinkChange;

// Snooze options shown in the dropdown — value is sent as ISO string or 'permanent'
const SNOOZE_OPTIONS = [
  { label: '30 days',  ms: 30  * 86400000 },
  { label: '90 days',  ms: 90  * 86400000 },
  { label: '6 months', ms: 182 * 86400000 },
  { label: '1 year',   ms: 365 * 86400000 },
  { label: 'Permanent', permanent: true },
];

function snoozeUntil(option) {
  if (option.permanent) return 'permanent';
  return new Date(Date.now() + option.ms).toISOString();
}

// Mark a listing/property as Not Suitable. Creates the property row if it
// doesn't yet exist (no deal attached), then sets not_suitable_until.
// Returns the property row, or null on failure.
async function markNotSuitable(listing, optionIndex) {
  const opt = SNOOZE_OPTIONS[optionIndex];
  if (!opt) return null;
  const until = snoozeUntil(opt);

  // V76.5: stable property ID resolution.
  //   1. If a property already exists in the DB linked to this Domain listing
  //      via domain_listing_id, reuse it (the canonical lookup).
  //   2. If lat/lng-only marker (no Domain id), generate a notsuitable-* id.
  //   3. Otherwise let the server auto-generate a fresh prop_* id at create.
  let propertyId = null;
  let listingDomainId = listing?.id != null ? String(listing.id) : null;

  if (listingDomainId) {
    try {
      const r = await fetch(`/api/properties?by_domain_listing=${encodeURIComponent(listingDomainId)}`);
      if (r.ok) {
        const existing = await r.json();
        if (existing?.id) propertyId = existing.id;
      }
    } catch (_) { /* fall through */ }
    // propertyId left null → server will generate prop_* on POST
  } else if (listing?.lat != null && listing?.lng != null) {
    propertyId = `notsuitable-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  } else {
    return null;
  }

  // Create property if needed (POST is idempotent — ON CONFLICT DO NOTHING).
  // V76.5: if propertyId is null we omit `id` and the server returns a fresh
  // prop_* in the response — we capture it for the cascade below.
  try {
    const createRes = await fetch('/api/properties', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(propertyId ? { id: propertyId } : {}),
        address: listing.address || '',
        suburb:  listing.suburb  || '',
        lat:     listing.lat,
        lng:     listing.lng,
        domain_listing_id: listingDomainId,
        listing_url:       listing.listingUrl || null,
      }),
    });
    if (createRes.ok) {
      const created = await createRes.json();
      if (!propertyId && created?.id) propertyId = created.id;
    }
    if (!propertyId) return null;
    // Set not-suitable
    const setRes = await fetch('/api/properties', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'set_not_suitable', id: propertyId, until }),
    });
    if (!setRes.ok) throw new Error('set_not_suitable failed');
    // Update local lookup
    const entry = { property_id: propertyId, until: (until === 'permanent' ? 'infinity' : until), reason: null };
    if (listingDomainId) _notSuitable.byListingId.set(listingDomainId, entry);
    if (listing.lat != null && listing.lng != null) _notSuitable.byLatLng.set(_llKey(listing.lat, listing.lng), entry);
    return entry;
  } catch (err) {
    console.error('[V75.1] markNotSuitable failed:', err);
    return null;
  }
}

// Clear not-suitable flag.
async function clearNotSuitable(listing) {
  const entry =
    (listing?.id != null && _notSuitable.byListingId.get(String(listing.id))) ||
    (listing?.lat != null && _notSuitable.byLatLng.get(_llKey(listing.lat, listing.lng)));
  if (!entry) return false;
  try {
    await fetch('/api/properties', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'clear_not_suitable', id: entry.property_id }),
    });
    if (listing.id != null) _notSuitable.byListingId.delete(String(listing.id));
    if (listing.lat != null && listing.lng != null) _notSuitable.byLatLng.delete(_llKey(listing.lat, listing.lng));
    return true;
  } catch (err) {
    console.error('[V75.1] clearNotSuitable failed:', err);
    return false;
  }
}

// Expose to popup / kanban call sites
window.markNotSuitable    = markNotSuitable;
window.clearNotSuitable   = clearNotSuitable;
window.isNotSuitable      = isNotSuitable;
window.SNOOZE_OPTIONS     = SNOOZE_OPTIONS;
// V76.5: refreshListings now also re-loads the properties cache so that
// link/unlink mutations from the CRM modal are reflected immediately
// (the listing card's display swap depends on _propertyByDomainId).
window.refreshListings    = async () => {
  if (typeof loadNotSuitable === 'function') await loadNotSuitable();
  if (typeof renderListings  === 'function') renderListings();
};

// Live overlay registry: id → { def, layer }
const overlayRegistry = {};

// Single-select: tracks the most recently focused listing for popup/parcel display
let _activeListingId = null;
let _suppressNextDomainSearch = false;
let _pendingAddressMatch = null;

// Marker colour
const MARKER_COLOR = '#c4841a';

// Parsed GeoTIFF result cached from the current file input
let parsedGeoTiff = null;

// ─── Map init ─────────────────────────────────────────────────────────────────
const map = L.map('map', {
  center: [-33.87, 150.76],
  zoom: 10,
  zoomControl: true
});

// Custom pane for hillshade so it sits below the MapLibre GL vector layer
map.createPane('hillshade');
map.getPane('hillshade').style.zIndex = 150; // below tilePane (200) and MapLibre canvas

// ─── Restore last viewport from localStorage ──────────────────────────────────
// Run immediately (not deferred) so the map starts at the right position
// before the first Domain search fires.
(function restoreViewport() {
  try {
    const saved = localStorage.getItem('propmap_viewport');
    if (saved) {
      const { lat, lng, zoom } = JSON.parse(saved);
      if (lat && lng && zoom) map.setView([lat, lng], zoom, { animate: false });
    }
  } catch (e) { /* ignore */ }
})();

const baseLayers = {
  map: L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    attribution: '© OpenStreetMap © CARTO',
    maxZoom: 19
  }),
  satellite: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    attribution: '© Esri, Maxar, Earthstar Geographics',
    maxZoom: 19
  }),
  topo: null // lazy-initialised on first click — composite: hillshade raster + NSW vector hybrid
};

// Hillshade raster layer sits beneath the vector hybrid to give terrain relief
const hillshadeLayer = L.tileLayer('https://services.arcgisonline.com/arcgis/rest/services/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}', {
  attribution: '© Esri',
  maxNativeZoom: 16,
  maxZoom: 22,
  pane: 'hillshade'
});

const TOPO_STYLE_URL = 'https://portal.spatial.nsw.gov.au/vectortileservices/rest/services/Hosted/NSW_BaseMap_VectorTile_Hybrid/VectorTileServer/resources/styles/root.json';
const TOPO_RESOURCES_URL = 'https://portal.spatial.nsw.gov.au/vectortileservices/rest/services/Hosted/NSW_BaseMap_VectorTile_Hybrid/VectorTileServer/resources';
const TOPO_SERVER_URL = 'https://portal.spatial.nsw.gov.au/vectortileservices/rest/services/Hosted/NSW_BaseMap_VectorTile_Hybrid/VectorTileServer';

function resolveRelativeUrl(base, relative) {
  return new URL(relative, base + '/').href;
}

async function fetchPatchedTopoStyle() {
  const res = await fetch(TOPO_STYLE_URL);
  if (!res.ok) throw new Error(`Style fetch failed: ${res.status} ${res.statusText}`);
  const style = await res.json();
  // sprite: "../sprites/sprite" → resources/../sprites/sprite → resources/sprites/sprite
  if (style.sprite) {
    style.sprite = resolveRelativeUrl(TOPO_RESOURCES_URL + '/styles', style.sprite);
  }
  // glyphs: "../fonts/{fontstack}/{range}.pbf"
  if (style.glyphs) {
    style.glyphs = decodeURIComponent(resolveRelativeUrl(TOPO_RESOURCES_URL + '/styles', style.glyphs));
  }
  // sources: replace relative url with explicit tiles array via proxy to avoid CORS
  if (style.sources) {
    Object.values(style.sources).forEach(src => {
      if (src.url) {
        delete src.url;
        src.tiles = [`${window.location.origin}/api/tiles?z={z}&y={y}&x={x}`];
        src.minzoom = src.minzoom || 0;
        src.maxzoom = src.maxzoom || 20;
      }
    });
  }
  return style;
}

async function getTopoLayer() {
  if (!baseLayers.topo) {
    try {
      const style = await fetchPatchedTopoStyle();
      baseLayers.topo = L.maplibreGL({
        style,
        attribution: '© NSW Spatial Services'
      });
      // Suppress expected 404s from NSW tile server (missing tiles are normal)
      baseLayers.topo.once('add', () => {
        const ml = baseLayers.topo.getMaplibreMap?.();
        if (ml) {
          ml.on('error', (e) => {
            if (e.error?.status === 404 || e.error?.message?.includes('404')) return;
            console.error('[MapLibre]', e);
          });
        }
      });
    } catch (err) {
      console.error('[Topo] Failed to initialise vector tile layer:', err);
      baseLayers.topo = null;
      throw err;
    }
  }
  return baseLayers.topo;
}

let activeBase = 'map';
baseLayers.map.addTo(map);

// ─── Basemap toggle ───────────────────────────────────────────────────────────
// V75.2 — Overlays button added at the end as a 4th basemap-row item. It
// doesn't switch basemap; it opens the overlay panel (replaces the header
// button that was removed in V75.2).
const baseToggle = L.control({ position: 'bottomleft' });
baseToggle.onAdd = function () {
  const div = L.DomUtil.create('div', 'basemap-toggle');
  div.innerHTML = `
    <button class="basemap-btn active" data-base="map">Map</button>
    <button class="basemap-btn" data-base="satellite">Satellite</button>
    <button class="basemap-btn" data-base="topo">Topography</button>
    <button class="basemap-btn basemap-btn-overlays" data-overlays>🗺 Overlays <span class="badge" id="basemapOverlayBadge">0</span></button>
  `;
  L.DomEvent.disableClickPropagation(div);

  // Overlays button — opens the existing overlay panel
  const overlaysBtn = div.querySelector('[data-overlays]');
  overlaysBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (typeof togglePanel === 'function') {
      togglePanel('overlayPanel', 'overlayPanelBtn');
    }
  });

  div.querySelectorAll('.basemap-btn[data-base]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const target = btn.dataset.base;
      if (target === activeBase) return;
      // Remove current layers (including hillshade if switching away from topo)
      const current = baseLayers[activeBase];
      if (current) map.removeLayer(current);
      if (activeBase === 'topo' && map.hasLayer(hillshadeLayer)) map.removeLayer(hillshadeLayer);
      // Get layer (lazy-init topo if needed)
      try {
        const next = target === 'topo' ? await getTopoLayer() : baseLayers[target];
        if (!next) throw new Error('Layer not available');
        // For topo: add hillshade first, then vector hybrid on top
        if (target === 'topo') {
          hillshadeLayer.addTo(map);
        }
        next.addTo(map);
        // Ensure correct stacking: hillshade below everything, vector hybrid above it
        if (target === 'topo') {
          hillshadeLayer.bringToBack();
        } else if (next.bringToBack) {
          next.bringToBack();
        }
        activeBase = target;
        div.querySelectorAll('.basemap-btn[data-base]').forEach(b => b.classList.toggle('active', b.dataset.base === target));
      } catch (err) {
        console.error('[Basemap] Failed to switch to', target, err);
        // Re-add the previous layer so the map isn't blank
        if (current) current.addTo(map);
      }
    });
  });
  return div;
};
baseToggle.addTo(map);

// V75.2 — Mirror the legacy #overlayBadge into the basemap-row copy.
// The overlay code still writes to #overlayBadge in three places; rather
// than touching all of those, observe that node and mirror whenever it
// changes. Cheap and non-invasive.
(function mirrorOverlayBadge() {
  const src  = document.getElementById('overlayBadge');
  const sink = document.getElementById('basemapOverlayBadge');
  if (!src || !sink) return;
  const sync = () => { sink.textContent = src.textContent; };
  sync();
  new MutationObserver(sync).observe(src, { childList: true, characterData: true, subtree: true });
})();

// ─── Map click — property select + SRLUP identify ────────────────────────────

const SRLUP_BASE = 'https://mapprod3.environment.nsw.gov.au/arcgis/rest/services/EDP/SRLUP/MapServer';

// Reverse geocode a lat/lng to a street address using ArcGIS
async function reverseGeocode(lat, lng) {
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), 4000);
  try {
    const params = new URLSearchParams({
      location:           `${lng},${lat}`,
      outSR:              '4326',
      returnIntersection: 'false',
      f:                  'json'
    });
    const res  = await fetch(
      'https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/reverseGeocode?' + params,
      { signal: controller.signal }
    );
    clearTimeout(tid);
    const json = await res.json();
    if (json.address) {
      const a = json.address;
      return {
        label: [a.ShortLabel, a.Neighborhood || a.District || ''].filter(Boolean).join(', '),
        lga:   a.City || '',
        state: a.Region || '',
      };
    }
  } catch (_) { clearTimeout(tid); }
  return null;
}

// Shared popup style helpers
const popupStyle  = `font-family:'DM Sans',sans-serif;font-size:13px;line-height:1.6;min-width:200px`;
const rowStyle    = `display:flex;justify-content:space-between;gap:16px;border-top:1px solid #eee;padding-top:4px;margin-top:4px`;
const lblStyle    = `color:#888;font-size:11px;text-transform:uppercase;letter-spacing:0.05em;flex-shrink:0`;

// Place a click-selected property marker
let clickMarker     = null;
let clickMarkerData = null;
let parcelLayer     = null;
// V75.4d: separate layer for multi-polygon highlight when user clicks a
// parcel's pipeline star pin. Drawn fresh each click, cleared on any
// new single-property selection or clearParcelSelection.
let _parcelHighlightLayer = null;

// Multi-select: array of selected parcels { lat, lng, label, lotDP, areaSqm, zoneCode, listing, marker, parcelLayer }
const _selectedParcels = [];

function drawParcel(rings) {
  if (parcelLayer) { map.removeLayer(parcelLayer); parcelLayer = null; }
  if (!rings) return;
  parcelLayer = L.polygon(rings, {
    color:       '#1a6b3a',
    weight:      2.5,
    opacity:     1,
    fillColor:   '#1a6b3a',
    fillOpacity: 0.08,
    dashArray:   null,
    interactive: false
  }).addTo(map);
}

// ─── Format price for display ─────────────────────────────────────────────────
// Handles both live Domain shape { display, from, to, derived } and static string prices.
// Returns plain text — used in popups, kanban modals, and as the inner text
// of the listings-panel cards (when not a "Reveal Price" button).
function formatPrice(price) {
  if (!price) return 'Price Unavailable';
  if (typeof price === 'string') return price;
  if (typeof price === 'object') {
    const { display, from, to, derived } = price;
    const fmt = n => `$${Number(n).toLocaleString()}`;

    // Build numeric range string from from/to. Treat equal values as a single price.
    let rangeStr = null;
    if (from && to) {
      rangeStr = (from === to) ? fmt(from) : `${fmt(from)} – ${fmt(to)}`;
    } else if (from) {
      rangeStr = `From ${fmt(from)}`;
    } else if (to) {
      rangeStr = `To ${fmt(to)}`;
    }

    // Derived prices come from the Reveal Price bracket probe — prefix with ~
    // and prefer the numeric range over any text display field.
    if (derived) {
      // No bound found — Domain quirk where the listing was exempt from filtering
      if (!rangeStr) return 'Price withheld';
      return `~${rangeStr} (est.)`;
    }

    // Priority for non-derived:
    //   1. Numeric range from priceFrom/priceTo (most accurate)
    //   2. displayPrice if it contains a $ figure (e.g. "$850,000", "Offers above $3,500,000")
    //   3. displayPrice as text (e.g. "Auction", "Contact Agent") — at least informative
    //   4. "Price Unavailable" only when truly empty
    if (rangeStr) return rangeStr;
    const displayHasNumber = typeof display === 'string' && /\$\s?\d/.test(display);
    if (displayHasNumber) return display;
    if (display && display.trim()) return display;
    return 'Price Unavailable';
  }
  return 'Price Unavailable';
}

// Whether a listing's price is "withheld" (no numeric data, agent text only).
// Used to decide when to show the Reveal Price button instead of price text.
function isPriceWithheld(price) {
  if (!price || typeof price !== 'object') return false;
  if (price.derived) return false; // already attempted; show derived value/withheld text
  if (price.from || price.to) return false;
  if (typeof price.display === 'string' && /\$\s?\d/.test(price.display)) return false;
  return true;
}

// HTML for the price cell on a listings-panel card. If the price is withheld,
// render a "Reveal Price" button; otherwise render the formatted price text.
// Derived (estimated) prices are marked by the "(est.)" suffix from
// formatPrice — no separate visual style is applied.
function priceCellHtml(listing) {
  if (isPriceWithheld(listing.price)) {
    return `<button class="listing-reveal-price-btn" data-listing-id="${listing.id}" title="Probe Domain to estimate price range">Reveal Price</button>`;
  }
  return formatPrice(listing.price);
}


function buildPopupInner(label, lga, lotDP, areaSqm, zoneCode, overlayBlock, listing = null, pipelineIdOverride = null) {
  const dl = listing && window.DomainAPI && DomainAPI.getEnrichedListing ? DomainAPI.getEnrichedListing(listing.id) : null;

  // Price only — no house type line, no agent line
  const priceSection = listing ? `
    <div style="font-size:16px;font-weight:700;color:#c4841a;margin-bottom:6px">${formatPrice(listing.price)}</div>` : '';

  // Split lotidstring into Lot and DP if possible (format: "1//DP12345" or "1/DP12345")
  let lotDisplay = lotDP;
  if (lotDP && lotDP !== 'Loading…' && lotDP !== 'Not found') {
    const match = lotDP.match(/^([^/]+)\/{1,2}(DP\d+)$/i);
    if (match) lotDisplay = `Lot ${match[1]} &nbsp;${match[2]}`;
  }

  const domainLink = dl
    ? `<a href="${dl.listingUrl}" target="_blank" style="color:#c4841a;font-size:12px;text-decoration:none;display:block;margin-top:8px">View on Domain →</a>`
    : '';

  // V74.8: detect whether this location corresponds to an existing pipeline
  // item. If so, swap the "+ Pipeline" add button for an "Open in Pipeline"
  // link that jumps straight to that pipeline card.
  // V78i.5 — pipelineIdOverride: callers that already know the pipeline id
  // (e.g. the parcel pipeline-pin click handler — item.id is in scope) can
  // skip the listing-based match heuristic and tell us directly. Falls back
  // to the existing match logic for all other call sites.
  const matchedPipelineId = pipelineIdOverride || findPipelineMatchForClick(listing);

  // V76.7+ — "+ Property" button always available (creates property without a
  // deal — for not-suitable tracking, agency listings, linking to known
  // addresses, etc). Sits alongside the pipeline button.
  // V84 — Both add-buttons live in `.popup-pipeline-btn-slot`, each in its own
  // inner wrapper so they can be updated independently:
  //   .popup-pipeline-btn      — Pipeline button (resolved synchronously)
  //   .popup-property-btn-slot — Property button (starts "Loading…"; an async
  //     existence check after the popup opens resolves it to gold "View
  //     Property" or plain "+ Property"). See _resolvePopupPropertyBtn.
  const propertyBtn = `<span class="popup-property-btn-slot" style="display:block">${_btnLoadingHtml(6)}</span>`;
  const pipelineInner = matchedPipelineId
    ? _pipelineBtnOpenHtml(matchedPipelineId)
    : _pipelineBtnAddHtml();
  const pipelineBtn = `
    <div class="popup-pipeline-btn-slot">
      <span class="popup-pipeline-btn" style="display:block">${pipelineInner}</span>${propertyBtn}
    </div>`;

  // V75.1 — Not Suitable / snooze control. The popup is rendered as a string,
  // so we can't attach JS event listeners directly to its buttons. Instead we
  // stash the listing under a unique key on window._nsContext and use simple
  // onclick handlers that look up by key (avoids JSON-in-attribute escaping
  // issues that broke this in Safari).
  const nsListing = listing || (clickMarkerData ? {
    address: clickMarkerData.label?.split(',')[0]?.trim() || '',
    suburb:  clickMarkerData.label?.split(',')[1]?.trim() || '',
    lat:     clickMarkerData.lat,
    lng:     clickMarkerData.lng,
  } : null);
  let nsBtn = '';
  if (nsListing) {
    const ns  = isNotSuitable(nsListing);
    const key = 'k' + Math.random().toString(36).slice(2, 10);
    window._nsContext = window._nsContext || {};
    window._nsContext[key] = nsListing;

    if (ns) {
      nsBtn = `
        <button type="button"
          data-ns-clear="${key}"
          style="display:block;width:100%;margin-top:6px;padding:6px 10px;
                 background:#888;color:#fff;border:none;border-radius:4px;
                 font-size:11px;font-weight:600;cursor:pointer">
          🚫 Not Suitable — Click to Reinstate
        </button>`;
    } else {
      const opts = SNOOZE_OPTIONS.map((o, i) =>
        `<button type="button"
           data-ns-mark="${key}|${i}"
           style="display:block;width:100%;text-align:left;padding:5px 10px;
                  background:#fff;color:#333;border:none;border-bottom:1px solid #eee;
                  font-size:11px;cursor:pointer">${o.label}</button>`
      ).join('');
      nsBtn = `
        <div style="position:relative;margin-top:6px">
          <button type="button"
            data-ns-toggle
            style="display:block;width:100%;padding:6px 10px;
                   background:transparent;color:#888;border:1px solid #ccc;border-radius:4px;
                   font-size:11px;font-weight:500;cursor:pointer">
            Mark Not Suitable ▾
          </button>
          <div class="popup-ns-menu"
               style="display:none;position:absolute;top:100%;left:0;right:0;z-index:1000;
                      background:#fff;border:1px solid #ccc;border-radius:4px;margin-top:2px;
                      box-shadow:0 2px 8px rgba(0,0,0,0.15);overflow:hidden">${opts}</div>
        </div>`;
    }
  }

  return `
    ${priceSection}
    <div style="font-weight:600;margin-bottom:6px;font-size:13px">${label}</div>
    ${lga      ? `<div style="${rowStyle}"><span style="${lblStyle}">LGA</span><span>${lga}</span></div>` : ''}
    <div style="${rowStyle}"><span style="${lblStyle}">Lot/DP</span><span id="lotdp-cell">${lotDisplay}</span></div>
    ${areaSqm  ? `<div style="${rowStyle}"><span style="${lblStyle}">Lot Size</span><span>${areaSqm.toLocaleString()} m²</span></div>` : ''}
    ${zoneCode ? `<div style="${rowStyle}"><span style="${lblStyle}">Zoning</span><span style="font-weight:600">${zoneCode}</span></div>` : ''}
    ${overlayBlock}
    ${domainLink}
    ${pipelineBtn}
    ${nsBtn}`;
}

// V74.8: find the pipeline item (if any) that matches the currently-clicked
// map location. Match strategy, in priority order:
//   1. Listing id (exact match for Domain listings that were already saved)
//   2. Lot/DP overlap (any shared Lot/DP string between click and pipeline entry)
//   3. Lat/lng proximity (within ~25m of any parcel coordinate on a pipeline entry)
// Returns the pipeline item id, or null if no match.
function findPipelineMatchForClick(listing) {
  if (!window.getPipelineData) { console.log('[match] no getPipelineData'); return null; }
  const pipelineData = window.getPipelineData();
  if (!pipelineData) { console.log('[match] pipelineData null'); return null; }

  const entries = Object.entries(pipelineData);
  if (!entries.length) { console.log('[match] entries empty'); return null; }

  // 1. Listing-id match (Domain pins) — V76.5: match by domain_id stored on
  //    the property, not by listing.id-equals-pipeline-key (which no longer holds).
  if (listing?.id != null) {
    const needle = String(listing.id);
    const hit = entries.find(([, item]) =>
      item?.property?.domain_id != null && String(item.property.domain_id) === needle);
    if (hit) { console.log('[match] hit on domain_id:', hit[0]); return hit[0]; }
  }

  // Build a candidate click context: lot/DP set + lat/lng
  const clickLotDPs = new Set();
  let clickLat = null, clickLng = null;
  if (clickMarkerData) {
    clickLat = clickMarkerData.lat;
    clickLng = clickMarkerData.lng;
    if (clickMarkerData.lotDP) clickLotDPs.add(String(clickMarkerData.lotDP).toUpperCase());
  }
  if (_selectedParcels && _selectedParcels.length) {
    _selectedParcels.forEach(p => {
      if (p.lotDP) clickLotDPs.add(String(p.lotDP).toUpperCase());
    });
    if (!clickLat || !clickLng) {
      clickLat = _selectedParcels.reduce((s, p) => s + p.lat, 0) / _selectedParcels.length;
      clickLng = _selectedParcels.reduce((s, p) => s + p.lng, 0) / _selectedParcels.length;
    }
  }

  console.log('[match] click context:', { clickLat, clickLng, clickLotDPs: [...clickLotDPs], clickMarkerData });

  // 2. Lot/DP overlap
  if (clickLotDPs.size) {
    for (const [id, item] of entries) {
      const itemLotDPs = (item?.property?._lotDPs || '')
        .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
      if (itemLotDPs.some(l => clickLotDPs.has(l))) {
        console.log('[match] hit on lot/DP overlap:', id, itemLotDPs);
        return id;
      }
    }
    console.log('[match] no lot/DP overlap. Pipeline lots sample:',
      entries.slice(0, 3).map(([id, item]) => ({ id, lots: item?.property?._lotDPs })));
  }

  // 3. Lat/lng proximity — ~25m tolerance
  if (clickLat != null && clickLng != null) {
    const tol = 0.00025;
    for (const [id, item] of entries) {
      const parcels = item?.property?._parcels || [];
      for (const pc of parcels) {
        if (Math.abs(pc.lat - clickLat) <= tol && Math.abs(pc.lng - clickLng) <= tol) {
          console.log('[match] hit on lat/lng proximity:', id, { pcLat: pc.lat, pcLng: pc.lng, clickLat, clickLng });
          return id;
        }
      }
    }
    console.log('[match] no lat/lng proximity match');
  }

  console.log('[match] no match found');
  return null;
}

const ZONING_BASE = 'https://mapprod3.environment.nsw.gov.au/arcgis/rest/services/Planning/EPI_Primary_Planning_Layers/MapServer';
const FLOOD_BASE  = 'https://mapprod3.environment.nsw.gov.au/arcgis/rest/services/Planning/Hazard/MapServer';
const ROADS_BASE  = 'https://mapprod.environment.nsw.gov.au/arcgis/rest/services/Planning/EPI_Additional_Layers/MapServer';

// ─── Fetch Lot/DP + parcel boundary — state-aware ────────────────────────────
// Queries the appropriate state cadastre service based on lat/lng.
// Falls back gracefully (no boundary) for locations without a known service.

function detectAustralianState(lat, lng) {
  // Rough bounding boxes — good enough for cadastre routing
  if (lat > -29.0 && lat < -28.1 && lng > 153.2 && lng < 153.7) return 'QLD'; // SE QLD coast override
  if (lat > -29.5 && lng > 138.0 && lng < 154.0) return 'QLD';
  if (lat > -39.2 && lat < -33.9 && lng > 140.9 && lng < 149.9) return 'VIC';
  if (lat > -38.1 && lat < -25.9 && lng > 129.0 && lng < 141.0) return 'SA';
  if (lat > -35.2 && lat < -25.9 && lng > 112.9 && lng < 129.0) return 'WA';
  if (lat > -43.7 && lat < -39.5 && lng > 143.8 && lng < 148.5) return 'TAS';
  if (lat > -20.0 && lat < -11.0 && lng > 129.0 && lng < 138.1) return 'NT';
  if (lat > -35.9 && lat < -35.1 && lng > 148.8 && lng < 149.4) return 'ACT';
  return 'NSW'; // default
}

// fetchLotDP — NSW queries sixmaps directly (no CORS restriction, faster).
// Interstate queries go via api/cadastre.js proxy (state ArcGIS servers block browser CORS).
async function fetchLotDP(lat, lng) {
  const state = detectAustralianState(lat, lng);
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), 10000);

  try {
    let url;
    if (state === 'NSW') {
      // Direct browser call — sixmaps allows cross-origin requests
      const params = new URLSearchParams({
        f:              'json',
        geometry:       `${lng},${lat}`,
        geometryType:   'esriGeometryPoint',
        inSR:           '4326',
        spatialRel:     'esriSpatialRelIntersects',
        outFields:      'lotidstring',
        returnGeometry: 'true',
        outSR:          '4326',
      });
      url = `https://maps.six.nsw.gov.au/arcgis/rest/services/public/NSW_Cadastre/MapServer/9/query?${params}`;
      const res  = await fetch(url, { signal: controller.signal });
      clearTimeout(tid);
      const json = await res.json();
      const feat = (json.features || [])[0];
      if (!feat) return { lotid: null, areaSqm: null, rings: null };
      const attrs = feat.attributes || {};
      const lotid = attrs.lotidstring || null;
      let rings = null, areaSqm = null;
      if (feat.geometry && feat.geometry.rings) {
        rings = feat.geometry.rings.map(ring => ring.map(([x, y]) => [y, x]));
        const metersPerDegLat = 111320;
        const metersPerDegLng = 111320 * Math.cos(lat * Math.PI / 180);
        let area = 0;
        for (const ring of feat.geometry.rings) {
          let ringArea = 0;
          for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            ringArea += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
          }
          area += Math.abs(ringArea) / 2;
        }
        areaSqm = Math.round(area * metersPerDegLng * metersPerDegLat);
      }
      return { lotid, areaSqm, rings };
    } else {
      // Interstate — proxy via api/cadastre.js (CORS restricted servers)
      const res = await fetch(`/api/cadastre?state=${state}&lat=${lat}&lng=${lng}`, { signal: controller.signal });
      clearTimeout(tid);
      if (!res.ok) return { lotid: null, areaSqm: null, rings: null };
      return await res.json();
    }
  } catch (err) {
    clearTimeout(tid);
    return { lotid: null, areaSqm: null, rings: null };
  }
}

// ─── Sidebar property card ────────────────────────────────────────────────────
// Hoisted to module scope so selectPropertyAtPoint (map clicks) can call it,
// not just the address search IIFE.

function showSearchCard({ label, lga, lotDP, lat, lng, listing = null }) {
  const container = document.getElementById('listingsList');
  const existing = document.getElementById('search-result-card');
  if (existing) existing.remove();
  if (!listing) return;
  _lastSearchCardData = { label, lga, lotDP, lat, lng, listing };
  const inList = document.querySelector(`.listing-card[data-id="${String(listing.id)}"]`);
  if (inList) {
    document.querySelectorAll('.listing-card').forEach(c => c.classList.remove('active'));
    inList.classList.add('active');
    inList.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    return;
  }
  const card = makeListingCard(listing, { pinToTop: true });
  card.id = 'search-result-card';
  card.classList.add('active');
  container.insertBefore(card, container.firstChild);
}

// Incremented on every clearParcelSelection so stale async calls know to abort
let _selectionGeneration = 0;

function clearParcelSelection() {
  _selectionGeneration++;

  _selectedParcels.forEach(p => {
    if (p.marker)      map.removeLayer(p.marker);
    if (p.parcelLayer) map.removeLayer(p.parcelLayer);
  });
  _selectedParcels.length = 0;
  if (clickMarker)  { map.removeLayer(clickMarker);  clickMarker  = null; clickMarkerData = null; }
  if (parcelLayer)  { map.removeLayer(parcelLayer);  parcelLayer  = null; }
  if (_parcelHighlightLayer) { map.removeLayer(_parcelHighlightLayer); _parcelHighlightLayer = null; }
  // V78i.3 — Reset the parcel-pin popup suppression flag so the next
  // ordinary map click / single-property selection can open its popup normally.
  window._suppressBluePinPopups = false;
  renderMultiSelectBar();
}

// listing — optional enriched listing object (from data.js + DomainAPI) so the
// popup and sidebar card can show price/agent info when a known property is clicked.
async function selectPropertyAtPoint(latlng, includeSrlup, includeZoning, includeFlood, includeRoads, listing = null, addToSelection = false) {
  const { lat, lng } = latlng;
  const myGeneration = _selectionGeneration; // snapshot — if this changes we've been superseded

  // Clear previous single-select parcel boundary and marker in all cases.
  // When addToSelection, we keep _selectedParcels entries but still remove
  // the single-select parcelLayer so it doesn't linger under the new pins.
  if (clickMarker && !addToSelection) { map.removeLayer(clickMarker); clickMarker = null; }
  if (parcelLayer) { map.removeLayer(parcelLayer); parcelLayer = null; }
  // V75.4d: clear any parcel-children highlight from a previous pipeline-pin click
  if (_parcelHighlightLayer) { map.removeLayer(_parcelHighlightLayer); _parcelHighlightLayer = null; }

  // Helper: wrap inner content in the outer popup shell
  function popupHtml(inner) {
    return `<div style="${popupStyle}">${inner}</div>`;
  }

  const pinNum   = addToSelection ? _selectedParcels.length + 1 : null;
  const pinColor = addToSelection ? '#1a4a8a' : '#1a6b3a';
  const pinHtml  = addToSelection
    ? `<div class="search-pin" style="background:${pinColor};display:flex;align-items:center;justify-content:center;color:#fff;font-size:10px;font-weight:700;width:28px;height:28px;border-radius:50% 50% 50% 0;transform:rotate(-45deg)"><span style="transform:rotate(45deg)">${pinNum}</span></div>`
    : `<div class="search-pin" style="background:${pinColor}"></div>`;

  // V78i.3 — When triggered via a parcel-pipeline-pin click, blue lot pins
  // shouldn't auto-open popups (they'd race with and overwrite the combined
  // parcel popup). The parcel-pin handler sets this flag before calling
  // reSelectParcels and we honour it for addToSelection calls (the case
  // where multiple lots are being added at once).
  const suppressPopup = !!window._suppressBluePinPopups && addToSelection;

  const newMarker = L.marker([lat, lng], {
    icon: L.divIcon({
      className: '',
      html: pinHtml,
      iconSize: [28, 28],
      iconAnchor: [14, 28],
      popupAnchor: [0, -30]
    })
  })
  .bindPopup(popupHtml('<span style="color:#888;font-size:12px">Loading…</span>'), { minWidth: 210, autoPan: false })
  .addTo(map);
  if (!suppressPopup) newMarker.openPopup();

  if (addToSelection) {
    const entry = { lat, lng, label: '', lotDP: null, areaSqm: null, zoneCode: null, listing, marker: newMarker, parcelLayer: null };
    _selectedParcels.push(entry);
  } else {
    clickMarker = newMarker;
  }

  const activeMarker = addToSelection ? newMarker : clickMarker;

  // Stage 1 — if we have a known listing use its address directly; otherwise reverse geocode
  let label, lga, state;
  if (listing) {
    label = `${listing.address}, ${listing.suburb}`;
    lga   = '';
    state = listing.state || '';
  } else {
    const geo = await reverseGeocode(lat, lng);
    label = geo ? geo.label : `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
    lga   = geo ? geo.lga   : '';
    state = geo ? geo.state : '';
  }

  // Reference to whichever marker we just placed
  
  if (activeMarker) {
    activeMarker.setPopupContent(popupHtml(buildPopupInner(label, lga, 'Loading…', null, null, '', listing)));
    if (!suppressPopup) activeMarker.openPopup();
  }

  // Show in sidebar immediately with address (Lot/DP updates below).
  // Skip the search card when the listing card itself is the selection point.
  const useSearchCard = !addToSelection;
  if (useSearchCard) {
    showSearchCard({ label, lga, lotDP: null, lat, lng, listing });
  }

  // Stage 2 — Lot/DP + SRLUP in parallel (slower)
  const slowFetches = [fetchLotDP(lat, lng)];

  if (includeSrlup) {
    const size = map.getSize();
    const b    = map.getBounds();
    const params = new URLSearchParams({
      f:             'json',
      geometry:      `${lng},${lat}`,
      geometryType:  'esriGeometryPoint',
      sr:            '4326',
      layers:        'all:1',
      tolerance:     '6',
      mapExtent:     `${b.getWest()},${b.getSouth()},${b.getEast()},${b.getNorth()}`,
      imageDisplay:  `${size.x},${size.y},96`,
      returnGeometry:'false'
    });
    slowFetches.push(
      fetch(`${SRLUP_BASE}/identify?${params}`).then(r => r.json()).catch(() => null)
    );
  } else {
    slowFetches.push(Promise.resolve(null));
  }

  // Always fetch zoning so zone code appears in popup even when overlay is off
  {
    const zoningParams = new URLSearchParams({
      f:              'json',
      geometry:       `${lng},${lat}`,
      geometryType:   'esriGeometryPoint',
      inSR:           '4326',
      spatialRel:     'esriSpatialRelIntersects',
      outFields:      'SYM_CODE,LAY_CLASS,EPI_NAME,LGA_NAME,PURPOSE',
      returnGeometry: 'false',
      resultRecordCount: '1'
    });
    slowFetches.push(
      fetch(`${ZONING_BASE}/2/query?${zoningParams}`).then(r => r.json()).catch(() => null)
    );
  }

  if (includeFlood) {
    const floodParams = new URLSearchParams({
      f:              'json',
      geometry:       `${lng},${lat}`,
      geometryType:   'esriGeometryPoint',
      inSR:           '4326',
      spatialRel:     'esriSpatialRelIntersects',
      outFields:      'LAY_CLASS,EPI_NAME,SYM_CODE',
      returnGeometry: 'false',
      resultRecordCount: '1'
    });
    slowFetches.push(
      fetch(`${FLOOD_BASE}/1/query?${floodParams}`).then(r => r.json()).catch(() => null)
    );
  } else {
    slowFetches.push(Promise.resolve(null));
  }

  if (includeRoads) {
    const roadsParams = new URLSearchParams({
      f:              'json',
      geometry:       `${lng},${lat}`,
      geometryType:   'esriGeometryPoint',
      inSR:           '4326',
      spatialRel:     'esriSpatialRelIntersects',
      outFields:      '*',
      returnGeometry: 'false',
      resultRecordCount: '1'
    });
    slowFetches.push(
      fetch(`${ROADS_BASE}/10/query?${roadsParams}`).then(r => r.json()).catch(() => null)
    );
  } else {
    slowFetches.push(Promise.resolve(null));
  }

  const [cadastre, srlupJson, zoningJson, floodJson, roadsJson] = await Promise.all(slowFetches);
  const lotDP   = cadastre ? cadastre.lotid   : null;
  const areaSqm = cadastre ? cadastre.areaSqm : null;
  if (!listing && _pendingAddressMatch && lotDP && listings.length) {
    const lotMatch = matchListingByAddress(listings, _pendingAddressMatch.street, _pendingAddressMatch.suburb, lotDP);
    if (lotMatch) {
      listing = lotMatch;
      _activeListingId = String(lotMatch.id);
      document.querySelectorAll('.listing-card').forEach(c => c.classList.remove('active'));
      const mc = document.querySelector(`.listing-card[data-id="${_activeListingId}"]`);
      if (mc) { mc.classList.add('active'); mc.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
    }
    _pendingAddressMatch = null;
  }

  if (!listing && lotDP) {
    const hasStreetNumber = /^\d/.test(label);
    if (!hasStreetNumber) {
      const lotMatch = lotDP.match(/^([^/]+)/);
      if (lotMatch) label = `Lot ${lotMatch[1].trim()} ${label}`;
    }
  }

  // Extract zone code directly for inline popup display (works even if overlay is off)
  const zoningFeature = zoningJson && ((zoningJson.features || [])[0] || (zoningJson.results || [])[0]);
  const zoneCode = zoningFeature ? (zoningFeature.attributes || zoningFeature).SYM_CODE || null : null;

  // Build SRLUP section
  let srlupBlock = '';
  if (includeSrlup && srlupJson && (srlupJson.results || []).length > 0) {
    const attrs = srlupJson.results[0].attributes;
    const SKIP  = ['OBJECTID','Shape','Shape_Area','Shape_Length','FID'];
    const rows  = Object.entries(attrs)
      .filter(([k, v]) => !SKIP.includes(k) && v !== null && v !== '')
      .map(([k, v]) => `<tr>
        <td style="color:#666;padding:3px 8px 3px 0;font-size:11px;white-space:nowrap">${k.replace(/_/g,' ')}</td>
        <td style="font-size:12px;padding:3px 0">${v}</td>
      </tr>`).join('');
    if (rows) srlupBlock = `
      <div style="border-top:2px solid #e67e22;margin-top:8px;padding-top:6px">
        <div style="font-size:10px;font-weight:600;letter-spacing:0.07em;text-transform:uppercase;color:#e67e22;margin-bottom:4px">NSW Planning Zone</div>
        <table style="border-collapse:collapse;width:100%;font-family:'DM Sans',sans-serif">${rows}</table>
      </div>`;
  }

  // Build Land Zoning overlay block (only when overlay is enabled — full detail)
  let zoningBlock = '';
  if (includeZoning && zoningFeature) {
    const attrs = zoningFeature.attributes || zoningFeature;
    const zone  = attrs.SYM_CODE  || '';
    const desc  = attrs.LAY_CLASS || attrs.PURPOSE || '';
    const epi   = attrs.EPI_NAME  || '';
    zoningBlock = `
      <div style="border-top:2px solid #8B0000;margin-top:8px;padding-top:6px">
        <div style="font-size:10px;font-weight:600;letter-spacing:0.07em;text-transform:uppercase;color:#8B0000;margin-bottom:4px">Land Zoning (LEP)</div>
        <table style="border-collapse:collapse;width:100%;font-family:'DM Sans',sans-serif">
          ${zone ? '<tr><td style="color:#666;padding:3px 8px 3px 0;font-size:11px;white-space:nowrap">Zone</td><td style="font-size:12px;padding:3px 0;font-weight:600">' + zone + '</td></tr>' : ''}
          ${desc ? '<tr><td style="color:#666;padding:3px 8px 3px 0;font-size:11px;white-space:nowrap">Land Use</td><td style="font-size:12px;padding:3px 0">' + desc + '</td></tr>' : ''}
          ${epi  ? '<tr><td style="color:#666;padding:3px 8px 3px 0;font-size:11px;white-space:nowrap">LEP</td><td style="font-size:12px;padding:3px 0">' + epi + '</td></tr>'  : ''}
        </table>
      </div>`;
  }

  // Build Flood Planning section
  let floodBlock = '';
  const floodFeature = floodJson && ((floodJson.features || [])[0]);
  if (includeFlood && floodFeature) {
    const attrs    = floodFeature.attributes || {};
    const layClass = attrs.LAY_CLASS || '';
    const epiName  = attrs.EPI_NAME  || '';
    floodBlock = `
      <div style="border-top:2px solid #2471a3;margin-top:8px;padding-top:6px">
        <div style="font-size:10px;font-weight:600;letter-spacing:0.07em;text-transform:uppercase;color:#2471a3;margin-bottom:4px">Flood Planning (EPI)</div>
        <table style="border-collapse:collapse;width:100%;font-family:'DM Sans',sans-serif">
          ${layClass ? '<tr><td style="color:#666;padding:3px 8px 3px 0;font-size:11px;white-space:nowrap">Classification</td><td style="font-size:12px;padding:3px 0;font-weight:600">' + layClass + '</td></tr>' : ''}
          ${epiName  ? '<tr><td style="color:#666;padding:3px 8px 3px 0;font-size:11px;white-space:nowrap">LEP</td><td style="font-size:12px;padding:3px 0">' + epiName + '</td></tr>'  : ''}
        </table>
      </div>`;
  } else if (includeFlood && floodJson && (floodJson.features || []).length === 0) {
    floodBlock = `
      <div style="border-top:2px solid #2471a3;margin-top:8px;padding-top:6px">
        <div style="font-size:10px;font-weight:600;letter-spacing:0.07em;text-transform:uppercase;color:#2471a3;margin-bottom:4px">Flood Planning (EPI)</div>
        <div style="font-size:12px;color:#666">No flood planning affectation</div>
      </div>`;
  }

  // Build Future Road Reservations section
  let roadsBlock = '';
  const roadsFeature = roadsJson && ((roadsJson.features || [])[0]);
  if (includeRoads && roadsFeature) {
    const attrs = roadsFeature.attributes || {};
    const SKIP  = ['OBJECTID','Shape','Shape_Area','Shape_Length','FID'];
    const rows  = Object.entries(attrs)
      .filter(([k, v]) => !SKIP.includes(k) && v !== null && v !== '' && v !== ' ')
      .map(([k, v]) => `<tr>
        <td style="color:#666;padding:3px 8px 3px 0;font-size:11px;white-space:nowrap">${k.replace(/_/g,' ')}</td>
        <td style="font-size:12px;padding:3px 0">${v}</td>
      </tr>`).join('');
    roadsBlock = `
      <div style="border-top:2px solid #922b21;margin-top:8px;padding-top:6px">
        <div style="font-size:10px;font-weight:600;letter-spacing:0.07em;text-transform:uppercase;color:#922b21;margin-bottom:4px">⚠ Future Road Reservation</div>
        <table style="border-collapse:collapse;width:100%;font-family:'DM Sans',sans-serif">${rows || '<tr><td colspan="2" style="font-size:12px;color:#666">Reservation details unavailable</td></tr>'}</table>
      </div>`;
  } else if (includeRoads && roadsJson && (roadsJson.features || []).length === 0) {
    roadsBlock = `
      <div style="border-top:2px solid #922b21;margin-top:8px;padding-top:6px">
        <div style="font-size:10px;font-weight:600;letter-spacing:0.07em;text-transform:uppercase;color:#922b21;margin-bottom:4px">Future Road Reservations</div>
        <div style="font-size:12px;color:#666">No road reservation on this parcel</div>
      </div>`;
  }

  // Update sidebar card with final Lot/DP
  if (useSearchCard) {
    showSearchCard({ label, lga, lotDP: lotDP || null, lat, lng, listing });
  }

  if (_selectionGeneration !== myGeneration) {

    return;
  }


  if (addToSelection) {
    const entry = _selectedParcels.find(p => p.marker === newMarker);
    if (entry) {
      entry.label      = label;
      entry.lga        = lga;
      entry.lotDP      = lotDP;
      entry.areaSqm    = areaSqm;
      entry.zoneCode   = zoneCode;
      if (cadastre && cadastre.rings) {
        entry.parcelLayer = L.polygon(cadastre.rings, {
          color: '#1a6b3a', weight: 2.5, opacity: 1,
          fillColor: '#1a4a8a', fillOpacity: 0.08,
          dashArray: null, interactive: false
        }).addTo(map);
      }
      renderMultiSelectBar();
    }
  } else {
    if (parcelLayer) { map.removeLayer(parcelLayer); parcelLayer = null; }
    if (cadastre && cadastre.rings) {
      parcelLayer = L.polygon(cadastre.rings, {
        color: '#1a6b3a', weight: 2.5, opacity: 1,
        fillColor: '#1a6b3a', fillOpacity: 0.08,
        dashArray: null, interactive: false
      }).addTo(map);
    }
    clickMarkerData = { lat, lng, label, lga, state, lotDP, areaSqm, zoneCode, listing, parcelLayer };
    renderMultiSelectBar();
  }

  // Final popup update
  if (activeMarker) {
    activeMarker.setPopupContent(popupHtml(buildPopupInner(label, lga, lotDP || 'Not found', areaSqm, zoneCode, srlupBlock + zoningBlock + floodBlock + roadsBlock, listing)));
    if (!suppressPopup) activeMarker.openPopup();
    // V84 — resolve the Property button (gold "View Property" if already in CRM).
    _resolvePopupPropertyBtn({
      id:      listing ? String(listing.id) : null,
      address: (listing && listing.address) || String(label || '').split(',')[0].trim(),
      _lotDPs: (lotDP && lotDP !== 'Not found') ? lotDP : '',
    });
  }
}

map.on('click', function (e) {
  // Ignore clicks when measurement tool is active
  if (window._measureActive) return;

  // Ignore clicks on existing markers and popups
  if (e.originalEvent.target.closest('.leaflet-marker-icon') ||
      e.originalEvent.target.closest('.leaflet-popup')       ||
      e.originalEvent.target.classList.contains('search-pin')) return;

  const isMeta = e.originalEvent.metaKey || e.originalEvent.ctrlKey;

  if (!isMeta) {
    clearParcelSelection();
    _activeListingId = null;
    document.querySelectorAll('.listing-card').forEach(c => c.classList.remove('active'));
  } else if (_selectedParcels.length === 0 && (clickMarker || clickMarkerData)) {
    // V75.4: promote the provisional single-click selection into _selectedParcels[0]
    // BEFORE the new meta-click adds its pin. Handles the case where async
    // reverse-geocode has nulled `clickMarker` — we reconstruct from the
    // persisted data and re-drop the pin as blue-#1.
    let marker = clickMarker;
    let d = clickMarkerData;

    if (!marker && d) {
      // Reconstruct the first pin from persisted data
      const pinHtml1 = `<div class="search-pin" style="background:#1a4a8a;display:flex;align-items:center;justify-content:center;color:#fff;font-size:10px;font-weight:700;width:22px;height:22px;border-radius:50% 50% 50% 0;transform:rotate(-45deg)"><span style="transform:rotate(45deg)">1</span></div>`;
      marker = L.marker([d.lat, d.lng], {
        icon: L.divIcon({ className: '', html: pinHtml1, iconSize: [28, 28], iconAnchor: [14, 28], popupAnchor: [0, -30] }),
      }).addTo(map);
    } else if (marker) {
      // Repaint existing green pin as blue-#1
      if (!d) d = { lat: marker.getLatLng().lat, lng: marker.getLatLng().lng, label: '', lga: '', state: '', lotDP: null, areaSqm: null, zoneCode: null, listing: null, parcelLayer: null };
      const pinHtml1 = `<div class="search-pin" style="background:#1a4a8a;display:flex;align-items:center;justify-content:center;color:#fff;font-size:10px;font-weight:700;width:22px;height:22px;border-radius:50% 50% 50% 0;transform:rotate(-45deg)"><span style="transform:rotate(45deg)">1</span></div>`;
      marker.setIcon(L.divIcon({ className: '', html: pinHtml1, iconSize: [28, 28], iconAnchor: [14, 28], popupAnchor: [0, -30] }));
    }

    if (d && marker) {
      if (d.parcelLayer) { parcelLayer = null; }
      _selectedParcels.push({ lat: d.lat, lng: d.lng, label: d.label, lga: d.lga, state: d.state, lotDP: d.lotDP, areaSqm: d.areaSqm, zoneCode: d.zoneCode, listing: d.listing, marker, parcelLayer: d.parcelLayer });
      clickMarker = null;
      clickMarkerData = null;
    }
    renderMultiSelectBar();
  }

  const srlupEntry   = overlayRegistry['nsw-srlup'];
  const zoningEntry  = overlayRegistry['nsw-land-zoning'];
  const floodEntry   = overlayRegistry['nsw-flood'];
  const roadsEntry   = overlayRegistry['nsw-future-roads'];

  selectPropertyAtPoint(
    e.latlng,
    !!(srlupEntry  && srlupEntry.def.enabled),
    !!(zoningEntry && zoningEntry.def.enabled),
    !!(floodEntry  && floodEntry.def.enabled),
    !!(roadsEntry  && roadsEntry.def.enabled),
    null,
    isMeta  // addToSelection flag
  );
});

// ─── GeoTIFF parser (no external library — works from file:// URLs) ───────────

/**
 * Minimal GeoTIFF parser.
 * Reads bounds from ModelTiepointTag + ModelPixelScaleTag (or ModelTransformationTag),
 * and renders the image to a PNG via canvas.
 * Supports: RGB, RGBA, Grayscale, single-band. Strips LZW/PackBits compression via
 * the browser's native TIFF support where available, falls back to raw strips.
 */
async function parseGeoTiff(file) {
  const arrayBuffer = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Failed to read file.'));
    reader.readAsArrayBuffer(file);
  });

  const buf  = arrayBuffer;
  const view = new DataView(buf);

  // --- Byte order ---
  const byteOrder = view.getUint16(0);
  if (byteOrder !== 0x4949 && byteOrder !== 0x4D4D) {
    throw new Error('Not a valid TIFF file.');
  }
  const le = byteOrder === 0x4949; // little-endian

  const r16 = (o) => view.getUint16(o, le);
  const r32 = (o) => view.getUint32(o, le);
  const ri32 = (o) => view.getInt32(o, le);
  const rf64 = (o) => view.getFloat64(o, le);
  const rf32 = (o) => view.getFloat32(o, le);

  // --- IFD ---
  const ifdOffset = r32(4);
  const numEntries = r16(ifdOffset);

  const tags = {};
  for (let i = 0; i < numEntries; i++) {
    const base = ifdOffset + 2 + i * 12;
    const tag   = r16(base);
    const type  = r16(base + 2);
    const count = r32(base + 4);
    const valueOffset = base + 8;

    // type sizes: 1=BYTE, 2=ASCII, 3=SHORT, 4=LONG, 5=RATIONAL, 11=FLOAT, 12=DOUBLE
    const typeSizes = { 1:1, 2:1, 3:2, 4:4, 5:8, 6:1, 7:1, 8:2, 9:4, 10:8, 11:4, 12:8 };
    const sz = typeSizes[type] || 1;
    const totalBytes = sz * count;
    const dataOffset = totalBytes > 4 ? r32(valueOffset) : valueOffset;

    const readVal = (off) => {
      if (type === 3)  return r16(off);
      if (type === 4)  return r32(off);
      if (type === 9)  return ri32(off);
      if (type === 11) return rf32(off);
      if (type === 12) return rf64(off);
      if (type === 5)  return r32(off) / r32(off + 4); // RATIONAL
      if (type === 10) return ri32(off) / ri32(off + 4);
      return view.getUint8(off);
    };

    const values = [];
    for (let j = 0; j < count; j++) values.push(readVal(dataOffset + j * sz));
    tags[tag] = count === 1 ? values[0] : values;
  }

  // --- Image dimensions ---
  const width  = tags[256]; // ImageWidth
  const height = tags[257]; // ImageLength
  if (!width || !height) throw new Error('Could not read image dimensions from TIFF.');

  // --- Geographic bounds from GeoTIFF tags ---
  // ModelPixelScaleTag = 33550, ModelTiepointTag = 33922
  const pixelScale = tags[33550]; // [scaleX, scaleY, scaleZ]
  const tiepoints  = tags[33922]; // [i,j,k, x,y,z, ...]

  let bounds = null;

  if (pixelScale && tiepoints) {
    const scaleX = Array.isArray(pixelScale) ? pixelScale[0] : pixelScale;
    const scaleY = Array.isArray(pixelScale) ? pixelScale[1] : pixelScale;
    // Tiepoint: pixel (i,j) maps to geo (x,y)
    const tpI = tiepoints[0], tpJ = tiepoints[1];
    const tpX = tiepoints[3], tpY = tiepoints[4];
    // Top-left geo coordinate
    const lonMin = tpX - tpI * scaleX;
    const latMax = tpY + tpJ * scaleY;
    const lonMax = lonMin + width  * scaleX;
    const latMin = latMax - height * scaleY;
    bounds = { lonMin, lonMax, latMin, latMax };
  }

  // ModelTransformationTag = 34264 fallback
  if (!bounds && tags[34264]) {
    const m = tags[34264];
    const lonMin = m[3];
    const latMax = m[7];
    const lonMax = lonMin + width  * m[0];
    const latMin = latMax + height * m[5]; // m[5] is negative
    bounds = { lonMin, lonMax, latMin, latMax };
  }

  if (!bounds) {
    throw new Error('No georeferencing data found in this TIFF. Make sure it is a GeoTIFF exported in WGS84 (EPSG:4326).');
  }

  // Sanity check for projected CRS
  const looksProjected =
    Math.abs(bounds.lonMin) > 180 || Math.abs(bounds.latMin) > 90 ||
    Math.abs(bounds.lonMax) > 180 || Math.abs(bounds.latMax) > 90;
  if (looksProjected) {
    throw new Error(
      'This GeoTIFF uses a projected coordinate system (e.g. MGA/UTM). ' +
      'Please re-export it in WGS84 (EPSG:4326) before uploading.'
    );
  }

  // --- Render image to canvas ---
  // Use the browser's native image decoder where possible (handles compression)
  const b64 = await renderTiffToB64(file, buf, tags, width, height);

  return { bounds, b64 };
}

/**
 * Render TIFF pixel data to a base64 PNG.
 * Tries native browser decode first (handles LZW etc), falls back to raw strip read.
 */
async function renderTiffToB64(file, buf, tags, width, height) {
  // Try native browser Image decode (works for uncompressed and some compressed TIFFs)
  try {
    const blob    = new Blob([buf], { type: 'image/tiff' });
    const blobUrl = URL.createObjectURL(blob);
    const b64 = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width  = img.naturalWidth  || width;
        canvas.height = img.naturalHeight || height;
        canvas.getContext('2d').drawImage(img, 0, 0);
        URL.revokeObjectURL(blobUrl);
        resolve(canvas.toDataURL('image/png').split(',')[1]);
      };
      img.onerror = () => { URL.revokeObjectURL(blobUrl); reject(new Error('native decode failed')); };
      img.src = blobUrl;
    });
    return b64;
  } catch (_) {
    // Fall through to manual strip decode
  }

  // Manual raw strip decode (uncompressed TIFFs only)
  const compression    = tags[259] || 1;
  const samplesPerPixel = tags[277] || 1;
  const bitsPerSample  = Array.isArray(tags[258]) ? tags[258][0] : (tags[258] || 8);

  if (compression !== 1) {
    throw new Error(
      'This GeoTIFF uses compression (' + compression + ') that requires a web server to decode. ' +
      'Please open index.html via a local server, or re-export the GeoTIFF as uncompressed.'
    );
  }

  const view = new DataView(buf);
  const le   = view.getUint16(0) === 0x4949;
  const stripOffsets = Array.isArray(tags[273]) ? tags[273] : [tags[273]];
  const stripByteCounts = Array.isArray(tags[279]) ? tags[279] : [tags[279]];

  const canvas  = document.createElement('canvas');
  canvas.width  = width;
  canvas.height = height;
  const ctx     = canvas.getContext('2d');
  const imgData = ctx.createImageData(width, height);
  const pxData  = imgData.data;

  let pixelIndex = 0;
  for (let s = 0; s < stripOffsets.length; s++) {
    let off = stripOffsets[s];
    const end = off + stripByteCounts[s];
    while (off < end && pixelIndex < width * height) {
      const base = pixelIndex * 4;
      if (samplesPerPixel >= 3) {
        pxData[base]     = view.getUint8(off);
        pxData[base + 1] = view.getUint8(off + 1);
        pxData[base + 2] = view.getUint8(off + 2);
        pxData[base + 3] = samplesPerPixel >= 4 ? view.getUint8(off + 3) : 255;
      } else {
        const v = view.getUint8(off);
        pxData[base] = pxData[base+1] = pxData[base+2] = v;
        pxData[base + 3] = 255;
      }
      off += samplesPerPixel;
      pixelIndex++;
    }
  }

  ctx.putImageData(imgData, 0, 0);
  return canvas.toDataURL('image/png').split(',')[1];
}

// ─── Overlay helpers ──────────────────────────────────────────────────────────

function buildLeafletLayer(def) {
  // Tiled cache layer — uses L.tileLayer (e.g. Biodiversity Values, TessaDEM elevation)
  if (def.wms && def.wms.tiled) {
    // V75.6 — TessaDEM elevation: viewport-adaptive ramp.
    // We override getTileUrl below to inject the current viewport min/max, so the
    // URL template need only contain {z}/{x}/{y} for Leaflet's standard substitution.
    const isElevation = def.id === 'tessadem-elevation';
    const layerOpts = {
      opacity:     def.opacity ?? 0.65,
      attribution: isElevation ? '© TessaDEM' : '© NSW Government',
      maxZoom:     19,
      tileSize:    256
    };

    // For elevation, we build a URL template with just z/x/y; min/max come from
    // local state (rangeMin/rangeMax) and are appended in our getTileUrl override.
    const baseUrl = isElevation
      ? '/api/elevation-tile?z={z}&x={x}&y={y}'
      : def.wms.url;

    const layer = L.tileLayer(baseUrl, layerOpts);

    if (isElevation) {
      // Track whether we have a valid probe yet — we suppress tile loads until then.
      let hasValidRange = false;
      let rangeMin = 0;
      let rangeMax = 1;
      let probeInFlight = null;
      let probeDebounce = null;
      let quotaTripped = false;

      // Override getTileUrl: until we have a valid probe, return a transparent
      // placeholder so Leaflet doesn't fetch real tiles. After probe, append
      // &min=&max= to each tile URL so the server can render at the current scale.
      const baseGetTileUrl = layer.getTileUrl.bind(layer);
      layer.getTileUrl = function (coords) {
        if (!hasValidRange) {
          // Transparent 1x1 GIF — fully cached by browser, never hits network twice.
          return 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
        }
        const baseUrl = baseGetTileUrl(coords);
        return `${baseUrl}&min=${rangeMin}&max=${rangeMax}`;
      };

      /**
       * Probe TessaDEM for current viewport min/max, then update the layer's
       * range options and redraw tiles. Debounced so rapid pan/zoom doesn't burn quota.
       */
      function probeAndRefresh() {
        if (quotaTripped) return;
        if (!map.hasLayer(layer)) return;
        if (probeDebounce) clearTimeout(probeDebounce);
        probeDebounce = setTimeout(async () => {
          if (!map.hasLayer(layer)) return;
          const b = map.getBounds();
          let south = b.getSouth();
          let west  = b.getWest();
          let north = b.getNorth();
          let east  = b.getEast();
          // Guard against invalid / degenerate bounds (uninitialised map, dateline wrap)
          if (![south, west, north, east].every(Number.isFinite)) {
            console.warn('[elevation probe] non-finite bounds; skipping', { south, west, north, east });
            return;
          }
          if (south >= north || west >= east) {
            console.warn('[elevation probe] degenerate bounds; skipping', { south, west, north, east });
            return;
          }
          // Clamp to valid lat/lng (TessaDEM coverage is 80°S..84°N)
          south = Math.max(-80, Math.min(80, south));
          north = Math.max(-80, Math.min(84, north));
          west  = Math.max(-180, Math.min(180, west));
          east  = Math.max(-180, Math.min(180, east));
          if (south >= north || west >= east) return;

          const params = new URLSearchParams({
            mode:  'probe',
            south: south.toFixed(5),
            west:  west.toFixed(5),
            north: north.toFixed(5),
            east:  east.toFixed(5),
          });
          const url = `/api/elevation-tile?${params.toString()}`;
          try {
            // Cancel any in-flight previous probe (we only care about latest viewport)
            if (probeInFlight) probeInFlight.abort();
            const ctrl = new AbortController();
            probeInFlight = ctrl;
            const r = await fetch(url, { signal: ctrl.signal, credentials: 'same-origin' });
            probeInFlight = null;
            if (!r.ok) {
              if (r.status === 402) {
                quotaTripped = true;
                if (typeof window.showElevationQuotaBanner === 'function') {
                  window.showElevationQuotaBanner();
                }
                try {
                  map.removeLayer(layer);
                  if (typeof window.setOverlayEnabled === 'function') {
                    window.setOverlayEnabled('tessadem-elevation', false);
                  }
                } catch {}
                return;
              }
              if (r.status === 401) {
                console.error('[elevation] TessaDEM API key rejected');
                return;
              }
              // Surface the server's reason so we can debug 400/500 responses
              let detail = '';
              try { detail = await r.text(); } catch {}
              console.warn('[elevation probe] failed:', r.status, detail.slice(0, 300), 'url:', url);
              return;
            }
            const data = await r.json();
            if (typeof data.min !== 'number' || typeof data.max !== 'number') return;
            // Round so tiny noise in min/max doesn't bust the cache key on every move.
            // 1m granularity is fine — the ramp re-renders if range changes meaningfully.
            const newMin = Math.floor(data.min);
            const newMax = Math.ceil(data.max);
            if (newMin === rangeMin && newMax === rangeMax && hasValidRange) {
              return; // No change → no redraw needed
            }
            rangeMin = newMin;
            rangeMax = newMax;
            hasValidRange = true;
            layer.redraw();
          } catch (err) {
            if (err.name !== 'AbortError') {
              console.warn('[elevation probe] error:', err.message);
            }
          }
        }, 400); // debounce 400ms
      }

      // Hook moveend — only listen while the layer is actually on the map.
      // We attach on 'add' and detach on 'remove' so we don't probe when off.
      layer.on('add', () => {
        map.on('moveend', probeAndRefresh);
        probeAndRefresh(); // initial fetch on enable
      });
      layer.on('remove', () => {
        map.off('moveend', probeAndRefresh);
        if (probeInFlight) { try { probeInFlight.abort(); } catch {} }
        if (probeDebounce) { clearTimeout(probeDebounce); probeDebounce = null; }
        // Reset range so re-enabling forces a fresh probe
        hasValidRange = false;
      });

      // Tile-error fallback for the rare case where a tile 402's individually
      // (e.g. quota crossed mid-viewport)
      layer.on('tileerror', (e) => {
        if (quotaTripped) return;
        const url = e.tile && e.tile.src;
        if (!url || url.startsWith('data:')) return;
        fetch(url, { credentials: 'same-origin' })
          .then((r) => {
            if (r.status === 402) {
              quotaTripped = true;
              if (typeof window.showElevationQuotaBanner === 'function') {
                window.showElevationQuotaBanner();
              }
              try {
                map.removeLayer(layer);
                if (typeof window.setOverlayEnabled === 'function') {
                  window.setOverlayEnabled('tessadem-elevation', false);
                }
              } catch {}
            }
          })
          .catch(() => {});
      });
    }

    return layer;
  }

  // ArcGIS MapServer dynamic layer (uses /export endpoint per tile bbox)
  if (def.wms) {
    return buildArcGISDynamicLayer(def);
  }

  // Vector GeoJSON layer — driven by an addGSPLayer-style function
  if (def.vector && def.vectorFn) {
    const fn = window[def.vectorFn];
    if (typeof fn !== 'function') {
      console.warn(`[overlay] vector fn "${def.vectorFn}" not found for "${def.id}"`);
      return null;
    }
    // addGSPLayer(map) creates the layer AND adds it to the map immediately.
    // We capture the returned layer so the panel can toggle/opacity it.
    const geoJsonLayer = fn(map);
    // Patch setOpacity so the opacity slider works (GeoJSON uses setStyle)
    geoJsonLayer.setOpacity = function(v) {
      this.setStyle({ opacity: v, fillOpacity: v * 0.6 });
    };
    // If not enabled by default, remove it straight away
    if (!def.enabled) map.removeLayer(geoJsonLayer);
    return geoJsonLayer;
  }

  // Vector GeoJSON overlay — fetched from a URL (planning proposals etc.)
  if (def.vector && def.vectorUrl) {
    const layerGroup = L.layerGroup();
    fetch(def.vectorUrl)
      .then(r => r.json())
      .then(gj => {
        L.geoJSON(gj, {
          style: feat => {
            const p = feat.properties;
            let s = {};
            if (def.vectorStyleMap && def.vectorStyleProp) {
              s = def.vectorStyleMap[p[def.vectorStyleProp]] || {};
            } else if (def.vectorStyle) {
              s = def.vectorStyle[p.zone] || {};
            } else {
              s = { color: p.stroke || '#666', fillColor: p.fill || '#aaa',
                    fillOpacity: p['fill-opacity'] ?? 0.5, weight: p['stroke-width'] ?? 1 };
            }
            const noFill = s.fillColor === 'none' || s.fillOpacity === 0;
            return {
              color:       s.color       || p.stroke || '#666',
              fillColor:   noFill ? '#000' : (s.fillColor || s.color || '#aaa'),
              fillOpacity: noFill ? 0 : (s.fillOpacity ?? 0.5) * (def.opacity ?? 1),
              fill:        !noFill,
              weight:      s.weight      || p['stroke-width'] || 1.5,
              opacity:     s.opacity     ?? def.opacity ?? 0.9
            };
          },
          onEachFeature: (feat, layer) => {
            const p = feat.properties;
            const label       = p.name || p.zone || p.elevation || p.flood_depth || p.road || '';
            const description = p.description || '';
            const source      = p.source || def.source || '';
            // V76.10: Bind popup but DO NOT auto-open on left-click. Overlay
            // features used to call `layer.bindPopup(...)` which makes Leaflet
            // open the popup on left-click — that consumed the click before it
            // reached the map, breaking the measure tool and property selection
            // whenever an overlay was visible.
            //
            // New behaviour: left-click passes through to the map (measure /
            // property select work normally even with overlays on); right-click
            // (contextmenu) opens the feature's info popup at the cursor.
            const popupHtml =
              `<b>${label}</b>` +
              (description ? `<br>${description}` : '') +
              (source ? `<br><small style="color:#888">${source}</small>` : '');
            layer.bindPopup(popupHtml);
            layer.off('click');  // prevent Leaflet's default click-to-open
            layer.on('contextmenu', e => {
              L.DomEvent.preventDefault(e.originalEvent);
              L.DomEvent.stopPropagation(e);
              layer.openPopup(e.latlng);
            });
          }
        }).addTo(layerGroup);
      })
      .catch(err => console.error(`[overlay] failed to load "${def.id}":`, err));
    layerGroup.setOpacity = function(v) {
      this.eachLayer(l => { if (l.setStyle) l.setStyle({ opacity: v, fillOpacity: v * 0.6 }); });
    };
    return layerGroup;
  }

  // GeoTIFF image overlay
  if (!def.b64 || !def.bounds) return null;
  const leafletBounds = [
    [def.bounds.latMin, def.bounds.lonMin],
    [def.bounds.latMax, def.bounds.lonMax]
  ];
  return L.imageOverlay(
    'data:image/png;base64,' + def.b64,
    leafletBounds,
    { opacity: def.opacity ?? 0.4, interactive: false }
  );
}

/**
 * Projects WGS84 lng/lat → Web Mercator (EPSG:3857).
 */
function toMercator(lng, lat) {
  const R = 6378137;
  const x = lng * Math.PI / 180 * R;
  const y = Math.log(Math.tan((90 + lat) * Math.PI / 360)) * R;
  return { x, y };
}

/**
 * Dynamic ArcGIS layer using a single full-viewport ImageOverlay.
 * Requests one image sized exactly to the map container on every moveend/zoomend.
 * This is pixel-perfect because we pass the exact viewport bbox and pixel dimensions
 * to the ArcGIS export endpoint — no tile boundary math required.
 */
function buildArcGISDynamicLayer(def) {
  let currentOpacity = def.opacity ?? 0.55;
  let visible = false;

  let slots = [
    L.imageOverlay('', [[0,0],[0,0]], { opacity: currentOpacity, attribution: '© NSW Dept of Environment' }),
    L.imageOverlay('', [[0,0],[0,0]], { opacity: 0 })
  ];
  let active = 0;

  function buildUrl(b, size) {
    const sw = toMercator(b.getWest(),  b.getSouth());
    const ne = toMercator(b.getEast(),  b.getNorth());
    const params = new URLSearchParams({
      f:           'image',
      format:      'png32',
      transparent: 'true',
      layers:      def.wms.layers,
      bbox:        `${sw.x},${sw.y},${ne.x},${ne.y}`,
      bboxSR:      '3857',
      imageSR:     '3857',
      size:        `${size.x},${size.y}`,
      dpi:         '96'
    });
    return `${def.wms.url}?${params.toString()}`;
  }

  function refresh() {
    if (!visible) return;
    const b    = map.getBounds();
    const size = map.getSize();
    const url  = buildUrl(b, size);
    const next = 1 - active;
    const incoming = slots[next];
    const img = new Image();
    img.onload = () => {
      if (!visible) return; // layer was hidden while loading
      incoming.setUrl(url);
      incoming.setBounds(b);
      incoming.setOpacity(currentOpacity);
      slots[active].setOpacity(0);
      active = next;
    };
    img.onerror = () => {
      if (!visible) return;
      slots[active].setUrl(url);
      slots[active].setBounds(b);
    };
    img.src = url;
  }

  // Debounced refresh — waits for zoom animation to fully settle before fetching
  let refreshTimer = null;
  function debouncedRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, 150);
  }

  // Single persistent listeners — always attached, guarded by `visible` flag
  map.on('moveend', debouncedRefresh);
  map.on('zoomend', debouncedRefresh);

  const facade = {
    addTo(m) {
      slots.forEach(s => s.addTo(m));
      visible = true;
      setTimeout(refresh, 50);
      return this;
    },
    show() {
      slots.forEach(s => { try { s.addTo(map); } catch(_) {} });
      visible = true;
      refresh();
      return this;
    },
    hide() {
      visible = false;
      slots.forEach(s => s.setOpacity(0));
      return this;
    },
    remove() {
      visible = false;
      clearTimeout(refreshTimer);
      map.off('moveend', debouncedRefresh);
      map.off('zoomend', debouncedRefresh);
      slots.forEach(s => { try { map.removeLayer(s); } catch(_) {} });
      return this;
    },
    onRemove() { return this.remove(); },
    setOpacity(v) {
      currentOpacity = v;
      if (visible) slots[active].setOpacity(v);
      return this;
    },
    _leaflet_id: 'arcgis-dynamic-' + Math.random()
  };

  return facade;
}

function registerOverlay(def) {
  const layer = buildLeafletLayer(def);
  const isWms = !!(def.wms && !def.wms.tiled);
  overlayRegistry[def.id] = { def, layer, isWms };
  if (layer && def.enabled) layer.addTo(map);
}

OVERLAYS.forEach(registerOverlay);

// ─── Overlay panel UI ─────────────────────────────────────────────────────────

function renderOverlayPanel() {
  const container = document.getElementById('overlayList');
  container.innerHTML = '';

  const entries = Object.values(overlayRegistry);
  const activeCount = entries.filter(e => e.def.enabled && e.layer).length;
  document.getElementById('overlayBadge').textContent = activeCount;
  const anyOn = entries.some(e => e.def.enabled);
  const toggleAllBtn = document.getElementById('overlayToggleAll');
  if (toggleAllBtn) toggleAllBtn.textContent = anyOn ? 'Hide all' : 'Show all';

  if (entries.length === 0) {
    container.innerHTML = '<p style="padding:16px;font-size:13px;color:var(--muted)">No overlays defined. Use Upload Map to add a GeoTIFF.</p>';
    return;
  }

  const GROUPS = [
    { key: 'zoning',                label: 'Zoning' },
    { key: 'services',              label: 'Services' },
    { key: 'environmental',         label: 'Environmental' },
    { key: 'transport',             label: 'Transport' },
    { key: 'western-parkland-city', label: 'SEPP — Western Parkland City 2021' },
    { key: 'central-river-city',    label: 'SEPP — Central River City 2021' },
    { key: 'other',                 label: 'Other' },
  ];

  // Group entries, skip groups with no entries
  const byGroup = {};
  entries.forEach(e => {
    // Resolve group: explicit field > type default > 'other'
    const TYPE_GROUP = {
      zoning:       'zoning',
      srlup:        'zoning',
      ilp:          'zoning',
      electricity:  'services',
      wastewater:   'services',
      potable:      'services',
      flood:        'environmental',
      biodiversity: 'environmental',
      bushfire:     'environmental',
      'airport-noise':       'environmental',
      'future-roads':        'transport',
      'transport-corridors': 'transport',
      'rail-corridors':      'transport',
      'wpc':                 'western-parkland-city',
      'crc':                 'central-river-city',
      other:        'other',
    };
    const g = e.def.group || TYPE_GROUP[e.def.type] || 'other';
    if (!byGroup[g]) byGroup[g] = [];
    byGroup[g].push(e);
  });

  function makeOverlayRow({ def, layer, isWms }) {
    const hasImage   = !!layer || isWms;
    const typeMeta   = OVERLAY_TYPE_META[def.type] || OVERLAY_TYPE_META.other;
    const opacityPct = Math.round((def.opacity ?? 0.4) * 100);

    const row = document.createElement('div');
    row.className = 'overlay-row';
    row.innerHTML = `
      <input type="checkbox" id="ov-${def.id}"
        ${def.enabled && hasImage ? 'checked' : ''}
        ${!hasImage ? 'disabled title="Upload a GeoTIFF to enable this overlay"' : ''} />
      <div class="overlay-info">
        <div class="overlay-label">${def.label}</div>
        ${!hasImage ? '<div class="overlay-meta"><span class="no-image-note">No image loaded</span></div>' : ''}
      </div>
      <div class="overlay-opacity">
        <input type="range" min="0" max="100" value="${opacityPct}"
          ${!hasImage ? 'disabled' : ''} data-id="${def.id}" />
        <span id="opv-${def.id}">${opacityPct}%</span>
      </div>
    `;

    row.querySelector(`#ov-${def.id}`).addEventListener('change', function () {
      def.enabled = this.checked;
      if (layer) {
        if (isWms) {
          if (def.enabled) layer.show();
          else layer.hide();
        } else {
          if (def.enabled) layer.addTo(map);
          else map.removeLayer(layer);
        }
      }
      document.getElementById('overlayBadge').textContent =
        Object.values(overlayRegistry).filter(e => e.def.enabled && e.layer).length;
      // Redraw easement buffers if electricity overlay toggled
      if (def.id === 'electricity-transmission') {
        if (def.enabled) drawEasementBuffers();
        else if (easementLayer) { map.removeLayer(easementLayer); easementLayer = null; }
      }
    });

    row.querySelector(`input[type=range][data-id="${def.id}"]`).addEventListener('input', function () {
      const v = this.value / 100;
      def.opacity = v;
      document.getElementById(`opv-${def.id}`).textContent = this.value + '%';
      if (layer) layer.setOpacity(v);
    });

    return row;
  }

  GROUPS.forEach(({ key, label }) => {
    const groupEntries = byGroup[key];
    if (!groupEntries || groupEntries.length === 0) return;

    const heading = document.createElement('div');
    heading.className = 'overlay-group-heading';
    heading.textContent = label;
    container.appendChild(heading);

    groupEntries.forEach(entry => container.appendChild(makeOverlayRow(entry)));
  });
}

// ─── Toggle all overlays ─────────────────────────────────────────────────────

document.getElementById('overlayToggleAll').addEventListener('click', function () {
  const entries = Object.values(overlayRegistry);
  const anyOn   = entries.some(e => e.def.enabled);

  entries.forEach(({ def, layer, isWms }) => {
    def.enabled = !anyOn;
    if (isWms) {
      if (def.enabled) layer.show(); else layer.hide();
    } else if (layer) {
      if (def.enabled) layer.addTo(map); else map.removeLayer(layer);
    }
  });

  this.textContent = anyOn ? 'Show all' : 'Hide all';
  document.getElementById('overlayBadge').textContent =
    anyOn ? 0 : entries.filter(e => e.layer).length;

  // Sync checkboxes in the panel
  document.querySelectorAll('#overlayList input[type=checkbox]').forEach(cb => {
    cb.checked = !anyOn;
  });
});

// ─── Zone selector ────────────────────────────────────────────────────────────

function buildZoneSelector() {
  const select = document.getElementById('zoneSelect');
  if (!select) return; // element removed from UI
  select.innerHTML = '';
  ZONES.forEach(z => {
    const opt = document.createElement('option');
    opt.value = z.id;
    opt.textContent = z.label;
    select.appendChild(opt);
  });

  select.addEventListener('change', () => {
    activeZone = select.value;
    const zone = ZONES.find(z => z.id === activeZone);
    if (zone && zone.bounds) {
      map.fitBounds([
        [zone.bounds.latMin, zone.bounds.lonMin],
        [zone.bounds.latMax, zone.bounds.lonMax]
      ], { padding: [32, 32], animate: true });
    }
    renderListings();
  });
}


// ─── Marker icon ──────────────────────────────────────────────────────────────

function makeIcon(color) {
  return L.divIcon({
    className: '',
    html: `<div style="
      width:28px;height:28px;
      border-radius:50% 50% 50% 0;
      transform:rotate(-45deg);
      background:${color};
      border:2px solid rgba(255,255,255,0.8);
      box-shadow:0 2px 8px rgba(0,0,0,0.5);
    "></div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 28],
    popupAnchor: [0, -30]
  });
}

// ─── Shared listing card builder ─────────────────────────────────────────────
// Used by both renderListings() and showSearchCard() so the card format is identical.

function makeListingCard(l, { pinToTop = false } = {}) {
  const dl = (window.DomainAPI && DomainAPI.getEnrichedListing ? DomainAPI.getEnrichedListing(l.id) : null) || l;

  const isMock = window.DomainAPI && DomainAPI.isMock && DomainAPI.isMock();
  const listingUrl = l.listingUrl || dl.listingUrl || null;
  const daysOnMarket = l.daysOnMarket ?? dl.daysOnMarket ?? null;

  const domBadge = listingUrl
    ? `<a href="${listingUrl}" target="_blank" rel="noopener" class="domain-badge ${isMock ? 'mock' : ''}" onclick="event.stopPropagation()">
         ${isMock ? '⚡ Mock' : '<img src="https://ui-avatars.com/api/?name=D&size=12&background=1ea765&color=fff&bold=true&rounded=true" style="width:12px;height:12px;border-radius:50%;vertical-align:middle"> Domain'}
         <span class="dom-days">${daysOnMarket != null ? daysOnMarket + 'd' : ''}</span>
       </a>`
    : '';

  const thumbUrl = l.photos?.[0]?.url || null;
  const thumbHtml = thumbUrl
    ? `<div class="listing-thumb"><img src="${thumbUrl}" alt="" loading="lazy"></div>`
    : '';

  const pinBadge = pinToTop
    ? `<div class="src-badge" style="margin-bottom:6px">Search Result</div>`
    : '';

  const card = document.createElement('div');
  card.className = 'listing-card';
  card.dataset.id = l.id;

  // V76.5: if this Domain listing is linked to a property in our system,
  // display the property's address (the source of truth) instead of Domain's
  // (which may be wrong — that's the whole reason linking exists). The Domain
  // badge / URL / photos / agent / price all stay sourced from Domain.
  const linkedProperty = _propertyByDomainId.get(String(l.id)) || null;
  const displayAddress = linkedProperty?.address || l.address;
  const displaySuburb  = linkedProperty?.suburb  || l.suburb;
  const linkedBadge = linkedProperty
    ? `<span class="listing-linked-badge" title="Linked to property ${linkedProperty.id}"
         style="font-size:10px;padding:1px 6px;border-radius:3px;background:var(--accent,#c4841a);color:#fff;font-weight:600;margin-left:6px">Linked</span>`
    : '';

  // V75.1 — Not Suitable inline control
  // V76.5.7 — Link/Unlink to property inline control (mirrors CRM Property
  // modal's Attach Domain affordance from the other direction). When the
  // listing is already linked, shows Unlink. When not, shows Link → opens
  // an inline search popover, user picks a property, link is recorded.
  const ns = isNotSuitable(l);
  const linkBtn = linkedProperty
    ? `<button class="listing-link-toggle listing-link-toggle--unlink" type="button"
               data-listing-id="${l.id}"
               data-property-id="${linkedProperty.id}"
               title="Unlink from ${linkedProperty.address || linkedProperty.id}">Unlink</button>`
    : `<button class="listing-link-toggle" type="button"
               data-listing-id="${l.id}"
               title="Link this listing to an existing property in the CRM">Link to property</button>`;
  const linkPopover = `
    <div class="listing-link-popover" style="display:none">
      <input type="text" class="listing-link-search kb-input" placeholder="Search address, suburb, lot/DP…">
      <div class="listing-link-results"></div>
      <div class="listing-link-actions">
        <button type="button" class="listing-link-cancel">Cancel</button>
      </div>
    </div>`;
  const nsBlock = ns
    ? `<div class="listing-not-suitable-banner">
         🚫 Not Suitable
         <button class="listing-ns-clear" type="button" title="Mark as suitable again">✓ Reinstate</button>
       </div>
       <div class="listing-actions-row">
         ${linkBtn}
         ${linkPopover}
       </div>`
    : `<div class="listing-actions-row">
         <div class="listing-ns-wrap">
           <button class="listing-ns-toggle" type="button">Not Suitable ▾</button>
           <div class="listing-ns-menu" style="display:none">
             ${SNOOZE_OPTIONS.map((o, i) => `<button type="button" data-idx="${i}">${o.label}</button>`).join('')}
           </div>
         </div>
         ${linkBtn}
         ${linkPopover}
       </div>`;

  card.innerHTML = `
    ${pinBadge}
    ${thumbHtml}
    <div class="listing-top">
      <div class="listing-price">${priceCellHtml(l)}</div>
      <div style="display:flex;align-items:center;gap:6px">
        ${domBadge}
        ${linkedBadge}
      </div>
    </div>
    <div class="listing-address">${displayAddress}</div>
    <div class="listing-suburb">${displaySuburb}${l.state ? ' ' + l.state : ''}</div>
    ${nsBlock}
  `;
  card.addEventListener('click', (e) => {
    // Don't navigate when user clicked the Reveal Price button
    if (e.target.closest('.listing-reveal-price-btn')) return;
    selectListing(l.id);
  });

  // V75.1 — Not Suitable handlers (stop propagation so they don't trigger card click)
  if (ns) {
    card.querySelector('.listing-ns-clear')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      const ok = await clearNotSuitable(l);
      if (ok) renderListings();
    });
  } else {
    const toggle = card.querySelector('.listing-ns-toggle');
    const menu   = card.querySelector('.listing-ns-menu');
    toggle?.addEventListener('click', (e) => {
      e.stopPropagation();
      // Close any other open menus
      document.querySelectorAll('.listing-ns-menu').forEach(m => { if (m !== menu) m.style.display = 'none'; });
      menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
    });
    menu?.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.idx);
        await markNotSuitable(l, idx);
        renderListings();
      });
    });
  }

  // V76.5.7 — Link/Unlink handlers
  const linkToggle = card.querySelector('.listing-link-toggle');
  const linkPop    = card.querySelector('.listing-link-popover');
  linkToggle?.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (linkedProperty) {
      // Unlink path: confirm, then POST unlink_listing.
      const ok = confirm(`Unlink this Domain listing from "${linkedProperty.address || linkedProperty.id}"?`);
      if (!ok) return;
      try {
        const r = await fetch('/api/properties', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'unlink_listing', property_id: linkedProperty.id }),
        });
        if (!r.ok) {
          const err = await r.json().catch(() => ({}));
          alert('Unlink failed: ' + (err.error || r.status));
          return;
        }
        await refreshListingsCacheAfterLinkChange();
        renderListings();
      } catch (err) {
        alert('Unlink failed: ' + err.message);
      }
      return;
    }
    // Link path: open the search popover.
    document.querySelectorAll('.listing-link-popover').forEach(p => { if (p !== linkPop) p.style.display = 'none'; });
    document.querySelectorAll('.listing-ns-menu').forEach(m => { m.style.display = 'none'; });
    linkPop.style.display = 'block';
    linkPop.querySelector('.listing-link-search')?.focus();
  });

  // Search-as-you-type within the popover
  const searchInput   = card.querySelector('.listing-link-search');
  const resultsHost   = card.querySelector('.listing-link-results');
  const cancelBtn     = card.querySelector('.listing-link-cancel');
  let _linkSearchTimer = null;
  searchInput?.addEventListener('click', (e) => e.stopPropagation());
  searchInput?.addEventListener('input', () => {
    clearTimeout(_linkSearchTimer);
    const q = (searchInput.value || '').trim();
    if (q.length < 2) { resultsHost.innerHTML = ''; return; }
    _linkSearchTimer = setTimeout(async () => {
      try {
        const r = await fetch(`/api/properties?search=${encodeURIComponent(q)}`);
        if (!r.ok) { resultsHost.innerHTML = '<div class="listing-link-empty">Search failed</div>'; return; }
        const rows = await r.json();
        if (!Array.isArray(rows) || !rows.length) {
          resultsHost.innerHTML = '<div class="listing-link-empty">No matches</div>';
          return;
        }
        resultsHost.innerHTML = rows.map(p => {
          const lot = p.lot_dps ? ` · ${p.lot_dps}` : '';
          const hasLink = p.domain_listing_id ? ' · already linked' : '';
          return `<button type="button" class="listing-link-result"
                           data-property-id="${p.id}"
                           data-already-linked="${p.domain_listing_id ? 'true' : 'false'}">
                    <div class="listing-link-result-addr">${p.address || '(no address)'}</div>
                    <div class="listing-link-result-meta">${p.suburb || ''}${lot}${hasLink}</div>
                  </button>`;
        }).join('');
        // Wire each result button
        resultsHost.querySelectorAll('.listing-link-result').forEach(btn => {
          btn.addEventListener('click', async (ev) => {
            ev.stopPropagation();
            const propertyId = btn.dataset.propertyId;
            const alreadyLinked = btn.dataset.alreadyLinked === 'true';
            if (alreadyLinked) {
              const ok = confirm(
                'This property is already linked to a different Domain listing. ' +
                'Linking this listing will replace the existing link. Continue?'
              );
              if (!ok) return;
            }
            try {
              const r2 = await fetch('/api/properties', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  action:            'link_listing',
                  property_id:       propertyId,
                  domain_listing_id: String(l.id),
                  listing_url:       l.listingUrl || `https://www.domain.com.au/${l.id}`,
                }),
              });
              if (!r2.ok) {
                const err = await r2.json().catch(() => ({}));
                alert('Link failed: ' + (err.error || r2.status));
                return;
              }
              linkPop.style.display = 'none';
              await refreshListingsCacheAfterLinkChange();
              renderListings();
            } catch (err) {
              alert('Link failed: ' + err.message);
            }
          });
        });
      } catch (err) {
        resultsHost.innerHTML = '<div class="listing-link-empty">Search error</div>';
      }
    }, 200);
  });
  cancelBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    linkPop.style.display = 'none';
    if (searchInput) searchInput.value = '';
    if (resultsHost) resultsHost.innerHTML = '';
  });

  return card;
}

// ─── Listings ─────────────────────────────────────────────────────────────────

function renderListings() {
  const list = document.getElementById('listingsList');
  list.innerHTML = '';
  Object.values(markers).forEach(m => map.removeLayer(m));
  markers = {};

  // Always filter the sidebar + markers to the *visible* map boundary so the
  // right-hand pane matches what the user is looking at. Search still uses
  // the viewport at request time; any listings that fall outside after a
  // concurrent pan are simply hidden until the next viewport search.
  const bounds = map.getBounds();
  // V76.3: CoreLogic listings may lack coordinates; keep those in the sidebar
  // but don't require them to be in the viewport.
  const filtered = listings.filter(l => {
    if (l._noCoords) return true;
    const inView   = bounds.contains(L.latLng(l.lat, l.lng));
    // propertyTypes is Domain-only — skip this check for CoreLogic listings
    const typeMatch = (l._source === 'corelogic')
      || _activeFilters.propertyTypes.length === 0
      || _activeFilters.propertyTypes.some(t => l.type === t.toLowerCase());
    const suitabilityOk = _activeFilters.showSnoozed || !isNotSuitable(l);
    return inView && typeMatch && suitabilityOk;
  });

  document.getElementById('listingCount').textContent = filtered.length;

  filtered.forEach(l => {
    const card = (l._source === 'corelogic')
      ? makeCoreLogicListingCard(l)
      : makeListingCard(l);
    list.appendChild(card);

    // Skip marker for no-coord CoreLogic listings
    if (l._noCoords || l.lat == null || l.lng == null) return;

    const marker = L.marker([l.lat, l.lng], {
      icon: makeIcon(MARKER_COLOR)
    }).addTo(map);

    marker.on('click', (e) => {
      L.DomEvent.stopPropagation(e);
      selectListing(l.id, e.latlng);
    });
    markers[l.id] = marker;
  });

  if (!showListings) Object.values(markers).forEach(m => map.removeLayer(m));

  // Restore active highlight
  if (_activeListingId) {
    const activeCard = document.querySelector(`.listing-card[data-id="${_activeListingId}"]`);
    if (activeCard) {
      activeCard.classList.add('active');
      activeCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  renderMultiSelectBar();
}

// V76.3 — CoreLogic listing card. Different shape from Domain: no thumbnail,
// no price (sandbox doesn't return it), show agency/source badges/unit number.
function makeCoreLogicListingCard(l) {
  const card = document.createElement('div');
  card.className = 'listing-card listing-card-corelogic';
  card.dataset.id = l.id;

  const unitPart = l._unitNumber ? ` Unit ${_escapeHtmlSafe(l._unitNumber)}` : '';
  const strataPart = l._strata ? '<span class="cl-tag cl-tag-strata">Strata</span>' : '';
  const noCoordsPart = l._noCoords ? '<span class="cl-tag cl-tag-nocoords" title="No coordinates in source data">📍?</span>' : '';
  const sourceBadge = l._dataSource
    ? `<span class="cl-tag cl-tag-source cl-tag-${l._dataSource.toLowerCase()}">${l._dataSource}</span>` : '';
  // typeBadge removed — was crowding the price/badge row, derivable from address area context

  const agentLines = (l._agencies || []).slice(0, 3)
    .map(a => `<div class="cl-agency">${_escapeHtmlSafe(a)}</div>`).join('');

  const dateStr = l._listingDate ? new Date(l._listingDate).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }) : '';

  card.innerHTML = `
    <div class="listing-top">
      <div class="listing-price listing-price-tbd">Enquire</div>
      <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
        ${strataPart}
        ${sourceBadge}
        ${noCoordsPart}
      </div>
    </div>
    <div class="listing-address">${_escapeHtmlSafe(l.address)}${unitPart}</div>
    <div class="listing-suburb">${_escapeHtmlSafe(l.suburb)}${l.state ? ' ' + _escapeHtmlSafe(l.state) : ''}</div>
    ${agentLines ? `<div class="cl-agencies">${agentLines}</div>` : ''}
    ${dateStr ? `<div class="cl-listing-date">Listed ${dateStr}</div>` : ''}
  `;
  card.addEventListener('click', () => selectListing(l.id));
  return card;
}

// Local HTML escape — avoids dependency on external util if one isn't in scope
function _escapeHtmlSafe(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ─── Electricity easement buffers ────────────────────────────────────────────
// Draws semi-transparent corridor polygons around transmission lines when the
// electricity overlay is enabled. Buffer widths from TransGrid Easement Guidelines.

const EASEMENT_WIDTHS = {
  500: 80,
  330: 60,
  220: 50,
  132: 45,
  66:  20,
  0:   30  // unknown / default
};

const EASEMENT_COLOURS = {
  500: '#ff0000',
  330: '#ff6600',
  220: '#ffaa00',
  132: '#00aa00',
  66:  '#0088cc',
  0:   '#aaaaaa'
};

let easementLayer = null;

function metresToDeg(metres, lat) {
  // Approximate: 1 degree lat ≈ 111,320m; 1 degree lng varies with cos(lat)
  return metres / 111320;
}

function bufferLinestring(coords, halfWidthDeg) {
  // Simple perpendicular offset buffer for a polyline
  // Returns a closed polygon ring [lng, lat] pairs
  if (coords.length < 2) return null;
  const left = [], right = [];
  for (let i = 0; i < coords.length; i++) {
    const p = coords[i];
    let dx, dy;
    if (i < coords.length - 1) {
      dx = coords[i+1][0] - p[0];
      dy = coords[i+1][1] - p[1];
    } else {
      dx = p[0] - coords[i-1][0];
      dy = p[1] - coords[i-1][1];
    }
    const len = Math.sqrt(dx*dx + dy*dy);
    if (len === 0) continue;
    const nx = -dy / len * halfWidthDeg;
    const ny =  dx / len * halfWidthDeg;
    left.push([p[0] + nx, p[1] + ny]);
    right.push([p[0] - nx, p[1] - ny]);
  }
  return [...left, ...right.reverse(), left[0]];
}

async function drawEasementBuffers() {
  if (easementLayer) { map.removeLayer(easementLayer); easementLayer = null; }

  const entry = overlayRegistry['electricity-transmission'];
  if (!entry || !entry.def.enabled) return;

  const b = map.getBounds();
  const params = new URLSearchParams({
    f:              'json',
    geometry:       `${b.getWest()},${b.getSouth()},${b.getEast()},${b.getNorth()}`,
    geometryType:   'esriGeometryEnvelope',
    inSR:           '4326',
    spatialRel:     'esriSpatialRelIntersects',
    outFields:      'CAPACITYKV',
    returnGeometry: 'true',
    outSR:          '4326',
    resultRecordCount: '100'
  });

  try {
    const res  = await fetch(
      `https://services.ga.gov.au/gis/rest/services/National_Electricity_Infrastructure/MapServer/2/query?${params}`
    );
    const json = await res.json();
    const features = json.features || [];
    if (!features.length) return;

    const polygons = [];
    features.forEach(feat => {
      const kv = feat.attributes?.CAPACITYKV || 0;
      const paths = feat.geometry?.paths || [];
      const widthKey = [500, 330, 220, 132, 66].find(v => v === kv) || 0;
      const halfDeg = metresToDeg(EASEMENT_WIDTHS[widthKey] / 2, b.getCenter().lat);
      const colour  = EASEMENT_COLOURS[widthKey];

      paths.forEach(path => {
        const ring = bufferLinestring(path, halfDeg);
        if (!ring) return;
        const leafletRing = ring.map(([lng, lat]) => [lat, lng]);
        polygons.push(L.polygon(leafletRing, {
          color:       colour,
          weight:      0,
          fillColor:   colour,
          fillOpacity: 0.15,
          interactive: false,
        }));
      });
    });

    if (polygons.length) {
      easementLayer = L.layerGroup(polygons).addTo(map);
    }
  } catch (err) {
    console.warn('Easement buffer error:', err);
  }
}

// ─── Fetch parcel boundary and draw it ───────────────────────────────────────

async function fetchAndDrawParcel(lat, lng) {
  if (parcelLayer) { map.removeLayer(parcelLayer); parcelLayer = null; }
  try {
    const cadastre = await fetchLotDP(lat, lng);
    if (cadastre && cadastre.rings) {
      drawParcel(cadastre.rings);
    }
  } catch (err) { console.warn('fetchAndDrawParcel error:', err); }
}

// ─── Multi-select ─────────────────────────────────────────────────────────────

function buildMergedAddress(parcels) {
  if (parcels.length === 0) return '';
  if (parcels.length === 1) return parcels[0].label || '';

  // Group by suburb (extracted from label "address, suburb")
  const bySuburb = {};
  parcels.forEach(p => {
    const parts  = (p.label || '').split(',');
    const addr   = parts[0]?.trim() || p.label;
    const suburb = parts[1]?.trim() || '';
    if (!bySuburb[suburb]) bySuburb[suburb] = [];
    bySuburb[suburb].push(addr);
  });

  const parts = Object.entries(bySuburb).map(([suburb, addrs]) => {
    const numbers = addrs.map(a => { const m = a.match(/^[\d/]+/); return m ? m[0] : a; });
    const street  = addrs[0].replace(/^[\d/]+\s*/, '');
    const numericNums = numbers.map(n => parseInt(n)).filter(n => !isNaN(n)).sort((a, b) => a - b);
    const allNumeric  = numericNums.length === numbers.length;

    let addrStr;
    if (numbers.length === 1) {
      addrStr = `${numbers[0]} ${street}`;
    } else if (allNumeric && numericNums.length === 2) {
      addrStr = `${numericNums[0]}-${numericNums[1]} ${street}`;
    } else if (allNumeric) {
      addrStr = `${numericNums[0]}-${numericNums[numericNums.length - 1]} ${street}`;
    } else {
      addrStr = `${numbers.join(' & ')} ${street}`;
    }
    return suburb ? `${addrStr}, ${suburb}` : addrStr;
  });

  return parts.join(' + ');
}


function renderMultiSelectBar() {
  // V74.7: Add-to-Pipeline moved from sidebar bar into the map popup.
  // This function is retained as a no-op cleanup so legacy call sites
  // keep working; if a stale bar exists from a previous session, drop it.
  const bar = document.getElementById('multi-select-bar');
  if (bar) bar.remove();
}

// Central helper used by the popup "+ Pipeline" button. Constructs the
// same payload the old multi-select bar built, scoped to current map
// selection state (single click, multi-parcel, or listing pin).
//
// V75.4d:
//   - Multi-select (2+ ⌘-clicks) now takes the authoritative path:
//     client-side NSW lookup per selected lat/lng → POST to
//     /api/create-parcel-from-lookup → real Parcel + N Properties + Deal.
//     Aborts with a message if any lat/lng can't be resolved.
//   - Single selection (listing pin or blank click) still uses the legacy
//     addToPipeline() call, but we also trigger an NSW lookup to populate
//     lot_dps + state_prop_id on the created property. Domain's address/
//     suburb win for listings; NSW's address wins for blank clicks.
//
// Detection of "is this point in NSW" happens via _isNswLatLng() — roughly
// within the state's bounding box. Outside NSW we skip the NSW lookup
// entirely (SA flow is unchanged via the legacy api/cadastre.js path).
function _isNswLatLng(lat, lng) {
  if (typeof lat !== 'number' || typeof lng !== 'number') return false;
  return lat > -37.5 && lat < -28.0 && lng > 140.0 && lng < 154.0;
}

// Infer Australian state from coordinates using approximate bounding boxes.
// Used as a safety net when the geocoder didn't populate state on a selection
// (e.g. older _selectedParcels entries from before state-capture was added).
// Order matters — checks for the smaller territories first since they sit
// inside larger states. Returns '' if outside Australia.
function stateFromLatLng(lat, lng) {
  if (typeof lat !== 'number' || typeof lng !== 'number') return '';
  // ACT — small enclave inside NSW, check first
  if (lat > -35.92 && lat < -35.13 && lng > 148.76 && lng < 149.40) return 'ACT';
  // NT
  if (lat > -26.00 && lat < -10.97 && lng > 129.00 && lng < 138.00) return 'NT';
  // TAS — south of Bass Strait
  if (lat < -39.20 && lng > 143.80 && lng < 148.50) return 'TAS';
  // WA
  if (lng < 129.00) return 'WA';
  // SA
  if (lng < 141.00) return 'SA';
  // QLD — north of -29
  if (lat > -29.00) return 'QLD';
  // VIC — south of NSW
  if (lat < -34.00) return 'VIC';
  // Default — NSW (the bulk of the eastern seaboard between -29 and -34)
  return 'NSW';
}

// ── Popup add-buttons: unified state helpers (V84) ──────────────────────────
// A single "Loading…" state (spinner) covers ANY pending/unconfirmed state on
// either button. The spinner reuses the existing `listings-spin` keyframe
// (styles.css) via inline style, so no CSS changes are needed. Only one popup
// is open at a time, so the slot selectors are unambiguous.
const _POPUP_SPINNER = '<span style="display:inline-block;width:11px;height:11px;border:2px solid currentColor;border-top-color:transparent;border-radius:50%;animation:listings-spin 0.7s linear infinite;vertical-align:middle;margin-right:6px"></span>';

function _pipelineBtnAddHtml() {
  return `<button type="button"
      onclick="window.addCurrentSelectionToPipeline && window.addCurrentSelectionToPipeline()"
      style="display:block;width:100%;margin-top:10px;padding:7px 10px;background:#1a6b3a;color:#fff;border:none;border-radius:4px;font-size:12px;font-weight:600;cursor:pointer;letter-spacing:0.02em">
      + Pipeline
    </button>`;
}
function _pipelineBtnOpenHtml(pipelineId) {
  const pid = String(pipelineId).replace(/'/g, "\\'");
  return `<button type="button"
      onclick="window.openPipelineItem && window.openPipelineItem('${pid}')"
      style="display:block;width:100%;margin-top:10px;padding:7px 10px;background:#c4841a;color:#fff;border:none;border-radius:4px;font-size:12px;font-weight:600;cursor:pointer;letter-spacing:0.02em">
      ★ Open in Pipeline
    </button>`;
}
function _propertyBtnAddHtml() {
  return `<button type="button"
      onclick="window.addCurrentSelectionAsProperty && window.addCurrentSelectionAsProperty()"
      style="display:block;width:100%;margin-top:6px;padding:7px 10px;background:#fff;color:#1a6b3a;border:1px solid #1a6b3a;border-radius:4px;font-size:12px;font-weight:600;cursor:pointer;letter-spacing:0.02em">
      + Property
    </button>`;
}
function _propertyBtnViewHtml(propertyId) {
  const pid = String(propertyId).replace(/'/g, "\\'");
  return `<button type="button"
      onclick="window.openPropertyItem && window.openPropertyItem('${pid}')"
      style="display:block;width:100%;margin-top:6px;padding:7px 10px;background:#c4841a;color:#fff;border:none;border-radius:4px;font-size:12px;font-weight:600;cursor:pointer;letter-spacing:0.02em">
      View Property
    </button>`;
}
function _btnLoadingHtml(marginTop) {
  return `<button type="button" disabled
      style="display:block;width:100%;margin-top:${marginTop}px;padding:7px 10px;background:#e9e9e9;color:#777;border:none;border-radius:4px;font-size:12px;font-weight:600;cursor:default;letter-spacing:0.02em">
      ${_POPUP_SPINNER}Loading…
    </button>`;
}

// Slot setters — update each button independently without disturbing the other.
function _setPipelineBtn(html) {
  const el = document.querySelector('.leaflet-popup-content .popup-pipeline-btn');
  if (el) el.innerHTML = html;
}
function _setPropertyBtn(html) {
  const el = document.querySelector('.leaflet-popup-content .popup-property-btn-slot');
  if (el) el.innerHTML = html;
}

// Back-compat swap helpers (used after a successful add) → resolved gold buttons.
function _refreshPopupPipelineBtn(pipelineId) { _setPipelineBtn(_pipelineBtnOpenHtml(pipelineId)); }
function _refreshPopupPropertyBtn(propertyId) { _setPropertyBtn(_propertyBtnViewHtml(propertyId)); }

// V84: async-resolve the Property button when a popup opens. Shows gold
// "View Property" if a property already exists for this selection, else
// "+ Property". Popup-DOM only — never touches the map pin.
async function _resolvePopupPropertyBtn(probe) {
  const sel = '.leaflet-popup-content .popup-property-btn-slot';
  if (!document.querySelector(sel)) return;
  try {
    if (!probe || typeof window.findExistingProperty !== 'function') {
      _setPropertyBtn(_propertyBtnAddHtml());
      return;
    }
    const existing = await window.findExistingProperty(probe);
    if (!document.querySelector(sel)) return;               // popup closed/changed
    _setPropertyBtn(existing && existing.id ? _propertyBtnViewHtml(existing.id) : _propertyBtnAddHtml());
  } catch (_) {
    if (document.querySelector(sel)) _setPropertyBtn(_propertyBtnAddHtml());
  }
}

async function addCurrentSelectionToPipeline() {
  if (typeof addToPipeline !== 'function') return;

  const hasSingle = !!clickMarkerData;
  const hasMulti  = _selectedParcels.length > 0;
  if (!hasSingle && !hasMulti) return;

  const isMulti = _selectedParcels.length > 1;

  // ── MULTI-SELECT: V75.4d authoritative-NSW path ─────────────────────────
  if (isMulti) {
    return await _createParcelFromSelection(_selectedParcels);
  }

  // ── SINGLE: legacy path, with NSW lookup backfill ──────────────────────
  const parcels  = hasMulti ? _selectedParcels : [clickMarkerData];
  const count    = parcels.length;
  const isParcel = count > 1;  // still false here
  const merged   = buildMergedAddress(parcels);
  const parts    = merged.split(',');
  const streetPart = parts[0]?.trim() || merged;
  const suburbPart = parts[1]?.trim() || parcels[0]?.label?.split(',')[1]?.trim() || '';

  const totalArea = parcels.reduce((s, p) => s + (p.areaSqm || 0), 0);
  const avgLat    = parcels.reduce((s, p) => s + p.lat, 0) / count;
  const avgLng    = parcels.reduce((s, p) => s + p.lng, 0) / count;
  const lotDPs    = parcels.map(p => p.lotDP).filter(Boolean).join(', ');
  const listing   = parcels[0]?.listing || null;
  // V76.7 — pass state through: prefer the listing's own state (Domain/CoreLogic),
  // then the geocoded value captured on the click, then fall back to a bounding-box
  // inference so we don't silently default everything to NSW.
  const stateValue = listing?.state
                  || parcels[0]?.state
                  || stateFromLatLng(avgLat, avgLng)
                  || 'NSW';

  // V76.5: addToPipeline now generates fresh prop_*/deal_* ids itself.
  // For listings with a real Domain id, pass it through — addToPipeline will
  // detect it (purely numeric) and use it as the domain link. For map clicks
  // without a listing, pass id=null so it knows this is non-Domain.
  const incomingDomainId = listing ? String(listing.id) : null;

  _setPipelineBtn(_btnLoadingHtml(10));  // V84 — loading state during add
  // Push into the pipeline first (synchronous ish — await so we have the new
  // property id available before we try to PATCH it with NSW data below).
  await addToPipeline({
    id:           incomingDomainId,
    address:      listing?.address || streetPart,
    suburb:       listing?.suburb  || suburbPart,
    state:        stateValue,
    price:        listing?.price   || 'Unknown',
    type:         listing?.type    || 'land',
    beds:         listing?.beds    || 0,
    baths:        listing?.baths   || 0,
    cars:         listing?.cars    || 0,
    lat:          avgLat,
    lng:          avgLng,
    waterStatus:  'outside',
    zone:         'all',
    _lotDPs:      lotDPs,
    _areaSqm:     totalArea || null,
    _propertyCount: count,
    _parcels:     parcels.map(p => ({ lat: p.lat, lng: p.lng, label: p.label })),
  });

  // V76.9: Swap the popup's "+ Pipeline" button for "★ Open in Pipeline"
  // immediately after the add. We need the new deal id, which we look up
  // via the pipeline dict by the same matching rules findPipelineMatchForClick
  // uses (domain id first, then coord match for blank clicks). The pipeline
  // dict has been mutated synchronously by addToPipeline, so this is reliable.
  let _newDealId = null;
  if (incomingDomainId && typeof window.findPipelineByDomainId === 'function') {
    const hit = window.findPipelineByDomainId(incomingDomainId);
    if (hit) _newDealId = hit[0];
  }
  if (!_newDealId && typeof findPipelineMatchForClick === 'function') {
    _newDealId = findPipelineMatchForClick(listing || { lat: avgLat, lng: avgLng });
  }
  if (_newDealId) _refreshPopupPipelineBtn(_newDealId);
  else _setPipelineBtn(_pipelineBtnAddHtml());  // V84 — revert if no deal id resolved

  // V76.5: resolve the actual property id that addToPipeline created so the
  // NSW backfill below can target the right row. Look up via the pipeline
  // dict using the domain id (for Domain listings) or fall back to scanning
  // recent entries (for blank-click pipeline adds, where there's no domain id).
  let newPropertyId = null;
  if (incomingDomainId && typeof window.findPipelineByDomainId === 'function') {
    const hit = window.findPipelineByDomainId(incomingDomainId);
    if (hit) newPropertyId = hit[1]?.property?.id || null;
  }
  if (!newPropertyId) {
    // Non-Domain path: pick the most recently added pipeline entry whose
    // property has matching coords. Fragile but only used for blank clicks.
    const pipelineData = window.getPipelineData ? window.getPipelineData() : null;
    if (pipelineData) {
      const entries = Object.entries(pipelineData);
      entries.sort((a, b) => (b[1]?.addedAt || 0) - (a[1]?.addedAt || 0));
      for (const [, entry] of entries) {
        const p = entry.property;
        if (!p) continue;
        const firstParcel = Array.isArray(p._parcels) ? p._parcels[0] : null;
        const pLat = firstParcel?.lat ?? p.lat;
        const pLng = firstParcel?.lng ?? p.lng;
        if (pLat && pLng && Math.abs(pLat - avgLat) < 1e-6 && Math.abs(pLng - avgLng) < 1e-6) {
          newPropertyId = p.id;
          break;
        }
      }
    }
  }

  // Async NSW lookup to backfill lot_dps + state_prop_id (only NSW coords)
  if (newPropertyId && window.NSWLookup && _isNswLatLng(avgLat, avgLng)) {
    try {
      const lookup = await window.NSWLookup.lookupByLatLng(avgLat, avgLng);
      if (lookup?.lotidstring || lookup?.propid) {
        // Patch the property row server-side with whatever NSW returned.
        // For listings (Domain) we don't overwrite address/suburb — Domain wins.
        // For blank-click properties, we can populate address/suburb from NSW.
        const patchBody = {
          id:            newPropertyId,
          lot_dps:       lookup.lotidstring || undefined,
          state_prop_id: lookup.propid || undefined,
        };
        if (!listing && lookup.address) {
          patchBody.address = lookup.address;
          patchBody.suburb  = lookup.suburb || undefined;
        }
        await fetch('/api/properties', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patchBody),
        }).catch(() => {});
      }
    } catch (err) {
      console.warn('[pipeline] NSW lookup failed, keeping provisional data', err.message);
    }
  }
}

// V76.7+ — "+ Property" wrapper: same selection-resolution as
// addCurrentSelectionToPipeline, but creates ONLY a property record (no
// deal, no kanban entry). Used for property-management workflows that
// don't need a pipeline workflow yet — not-suitable tracking, agency
// listings before a deal is opened, linking Domain listings to known
// addresses, etc.
async function addCurrentSelectionAsProperty() {
  if (typeof addPropertyOnly !== 'function') {
    alert('Property helper not loaded. Reload the page and try again.');
    return;
  }

  const hasSingle = !!clickMarkerData;
  const hasMulti  = _selectedParcels.length > 0;
  if (!hasSingle && !hasMulti) return;

  const isMulti = _selectedParcels.length > 1;

  // ── MULTI-SELECT: route to parcel-creation endpoint with create_deal=false ──
  if (isMulti) {
    return await _createParcelFromSelection(_selectedParcels, { createDeal: false });
  }

  // ── SINGLE: build the same listing object addToPipeline would receive,
  //    but pass it to addPropertyOnly (no deal). NSW backfill follows.
  const parcels  = hasMulti ? _selectedParcels : [clickMarkerData];
  const count    = parcels.length;
  const merged   = buildMergedAddress(parcels);
  const parts    = merged.split(',');
  const streetPart = parts[0]?.trim() || merged;
  const suburbPart = parts[1]?.trim() || parcels[0]?.label?.split(',')[1]?.trim() || '';

  const totalArea = parcels.reduce((s, p) => s + (p.areaSqm || 0), 0);
  const avgLat    = parcels.reduce((s, p) => s + p.lat, 0) / count;
  const avgLng    = parcels.reduce((s, p) => s + p.lng, 0) / count;
  const lotDPs    = parcels.map(p => p.lotDP).filter(Boolean).join(', ');
  const listing   = parcels[0]?.listing || null;
  const stateValue = listing?.state
                  || parcels[0]?.state
                  || stateFromLatLng(avgLat, avgLng)
                  || 'NSW';

  const incomingDomainId = listing ? String(listing.id) : null;

  _setPropertyBtn(_btnLoadingHtml(6));  // V84 — loading state during add
  const result = await addPropertyOnly({
    id:           incomingDomainId,
    address:      listing?.address || streetPart,
    suburb:       listing?.suburb  || suburbPart,
    state:        stateValue,
    type:         listing?.type    || 'land',
    beds:         listing?.beds    || 0,
    baths:        listing?.baths   || 0,
    cars:         listing?.cars    || 0,
    lat:          avgLat,
    lng:          avgLng,
    _lotDPs:      lotDPs,
    _areaSqm:     totalArea || null,
    _propertyCount: count,
    _parcels:     parcels.map(p => ({ lat: p.lat, lng: p.lng, label: p.label })),
    agent:        listing?.agent || null,
    listingUrl:   listing?.listingUrl || null,
  });

  if (!result?.propertyId) { _setPropertyBtn(_propertyBtnAddHtml()); return; }

  // V84 — swap the popup's "+ Property" button to a gold "View Property"
  // button. Pin is intentionally left unchanged (property adds never restyle
  // the marker; only pipeline adds do).
  _refreshPopupPropertyBtn(result.propertyId);

  // NSW backfill — same logic as the pipeline path, just targeting the
  // property created by addPropertyOnly.
  if (result.isNew && window.NSWLookup && _isNswLatLng(avgLat, avgLng)) {
    try {
      const lookup = await window.NSWLookup.lookupByLatLng(avgLat, avgLng);
      if (lookup?.lotidstring || lookup?.propid) {
        const patchBody = {
          id:            result.propertyId,
          lot_dps:       lookup.lotidstring || undefined,
          state_prop_id: lookup.propid      || undefined,
        };
        if (!listing && lookup.address) {
          patchBody.address = lookup.address;
          patchBody.suburb  = lookup.suburb || undefined;
        }
        await fetch('/api/properties', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patchBody),
        }).catch(() => {});
      }
    } catch (err) {
      console.warn('[+Property] NSW lookup failed, keeping provisional data', err.message);
    }
  }
}

// Expose globally so the popup's inline onclick can reach it
window.addCurrentSelectionAsProperty = addCurrentSelectionAsProperty;

// V75.4d helper: create a real Parcel + N child Properties + Deal from a
// multi-selection. All NSW lookups happen client-side. Aborts (with alert)
// if any lat/lng fails to resolve — we don't want to create half-populated
// parcels that require later repair.
//
// Matches single-property "+ Pipeline" behaviour: stays on the map, shows
// the elegant bottom toast, does NOT auto-open the Kanban card modal.
async function _createParcelFromSelection(selections, opts = {}) {
  // V76.7+ — opts.createDeal: true (default) creates a deal alongside the parcel.
  //                            false skips deal creation (used by "+ Property").
  const createDeal = opts.createDeal !== false;
  if (!window.NSWLookup) {
    alert('NSW lookup helper not loaded. Reload the page and try again.');
    return;
  }

  // Verify all points are in NSW before we try the lookups
  for (const s of selections) {
    if (!_isNswLatLng(s.lat, s.lng)) {
      alert('Multi-select parcel creation is currently NSW-only in this release. Please select NSW properties.');
      return;
    }
  }

  // Lightweight feedback: disable the popup button + change label.
  // The user sees their popup stay in place with "Creating…" text, not a heavy
  // modal blocking the whole page.
  _setPipelineButtonState('creating', 'Looking up NSW…');

  try {
    // Look up each selected lat/lng
    const resolvedByLot = new Map();
    const failures = [];
    for (const [i, s] of selections.entries()) {
      _setPipelineButtonState('creating', `Lot ${i + 1} of ${selections.length}…`);
      try {
        const r = await window.NSWLookup.lookupByLatLng(s.lat, s.lng);
        if (!r || !r.lotidstring) {
          failures.push({ index: i + 1, reason: 'no lot match' });
          continue;
        }
        if (!resolvedByLot.has(r.lotidstring)) {
          resolvedByLot.set(r.lotidstring, {
            lot_dps:       r.lotidstring,
            address:       r.address,
            suburb:        r.suburb,
            state_prop_id: r.propid,
            lat:           s.lat,
            lng:           s.lng,
            area_sqm:      r.areaSqm || null,
            rings:         r.rings || null,
          });
        }
      } catch (err) {
        failures.push({ index: i + 1, reason: err.message });
      }
    }

    if (failures.length) {
      const msg = failures.map(f => `  • Pin #${f.index}: ${f.reason}`).join('\n');
      alert(`Could not resolve all selected points to NSW lots:\n${msg}\n\nAdjust your selection and try again.`);
      return;
    }

    const dedupedCount = selections.length - resolvedByLot.size;
    const properties = Array.from(resolvedByLot.values());

    if (properties.length < 2) {
      alert(`Only ${properties.length} unique lot${properties.length === 1 ? '' : 's'} in selection — a Parcel needs 2 or more. Your ${selections.length} clicks resolved to ${properties.length} unique lots.`);
      return;
    }

    if (dedupedCount > 0) {
      const ok = confirm(`Your ${selections.length} clicks resolved to ${properties.length} unique lots (${dedupedCount} duplicate${dedupedCount === 1 ? '' : 's'} collapsed).\n\nCreate Parcel?`);
      if (!ok) return;
    }

    _setPipelineButtonState('creating', 'Saving…');

    const r = await fetch('/api/create-parcel-from-lookup', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ properties, create_deal: createDeal }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      alert(`Failed to create parcel: ${err.error || r.status}`);
      return;
    }
    const result = await r.json();
    const newDealId = result?.deal?.id || result?.parcel?.id;

    // Refresh pipeline dict + map pins
    if (typeof dbLoad === 'function') {
      const dict = await dbLoad();
      if (dict && typeof pipeline !== 'undefined') {
        Object.keys(pipeline).forEach(k => delete pipeline[k]);
        Object.assign(pipeline, dict);
        if (typeof renderBoard === 'function') renderBoard();
        if (typeof window.refreshPipelinePins === 'function') window.refreshPipelinePins();
      }
    }

    // Invalidate CRM Parcels cache
    if (window.CRM?.invalidateParcelsCache) window.CRM.invalidateParcelsCache();
    // V75.5: new parcel came with N new child properties
    if (window.CRM?.invalidatePropertiesCache) window.CRM.invalidatePropertiesCache();

    // V75.4d: Auto-DD for the new parcel using the average centroid.
    // Matches the single-property flow which runs DD in addToPipeline().
    if (newDealId && window.queryDDRisks && pipeline?.[newDealId]?.property) {
      const p = pipeline[newDealId].property;
      const lat = p.lat;
      const lng = p.lng;
      if (lat && lng) {
        console.log('[DD] Querying risks for parcel', newDealId, lat, lng);
        queryDDRisks(lat, lng).then(dd => {
          if (!pipeline[newDealId]) return;
          pipeline[newDealId].dd = pipeline[newDealId].dd || {};
          // Don't overwrite user-set values (status set by user)
          for (const [key, val] of Object.entries(dd || {})) {
            if (!pipeline[newDealId].dd[key]?.status) {
              pipeline[newDealId].dd[key] = val;
            }
          }
          if (typeof savePipeline === 'function') savePipeline(newDealId);
        }).catch(err => console.warn('[DD] parcel query failed:', err));
      }
    }

    // Clear map selection so no stale pins linger
    if (typeof clearParcelSelection === 'function') clearParcelSelection();

    // Elegant toast — same as single-property "+ Pipeline" / "+ Property"
    if (typeof showKanbanToast === 'function') {
      const title = result?.parcel?.name || `${properties.length} properties`;
      const verb  = createDeal ? 'added to pipeline' : 'added to CRM';
      showKanbanToast(`${title} ${verb}`);
    }
  } catch (err) {
    console.error('[parcel-create]', err);
    alert(`Network error creating parcel: ${err.message}`);
  } finally {
    _setPipelineButtonState('idle');
  }
}

// Pipeline button state helper — lightweight in-place feedback for the map
// popup's "+ Pipeline" button during async parcel create. Matches the
// single-property "instant" feel but lets the user know multi-select
// creates are taking longer because of NSW lookups.
function _setPipelineButtonState(state, message) {
  // The button lives inside Leaflet popup HTML which we don't fully control;
  // match by inline-onclick attribute and class markers used in the popup.
  document.querySelectorAll('.map-popup-pipeline-btn, [data-pipeline-button], button[onclick*="addCurrentSelectionToPipeline"]').forEach(b => {
    if (state === 'creating') {
      // Remember original text once
      if (!b.dataset.origText) b.dataset.origText = b.textContent;
      b.disabled = true;
      b.style.opacity = '0.75';
      b.style.cursor = 'wait';
      b.textContent = message || 'Working…';
    } else {
      b.disabled = false;
      b.style.opacity = '';
      b.style.cursor = '';
      if (b.dataset.origText) { b.textContent = b.dataset.origText; delete b.dataset.origText; }
    }
  });
}

// Expose so the popup's inline onclick can call it
window.addCurrentSelectionToPipeline = addCurrentSelectionToPipeline;

// Focus the map on a lat/lng without arbitrarily changing zoom.
// - If the point is already on-screen at a useful zoom, do nothing.
// - If off-screen (or very zoomed out), pan/zoom to at least minZoom while
//   never zooming *out* from the user's current level.
function _focusMapOn(lat, lng, opts = {}) {
  if (lat == null || lng == null || !isFinite(lat) || !isFinite(lng)) return;
  const ll = L.latLng(lat, lng);
  const currentZoom = map.getZoom();
  const minZoom = opts.minZoom != null ? opts.minZoom : 14;
  // Slightly inset so points near the edge still get a gentle re-centre
  const inView = map.getBounds().pad(-0.08).contains(ll);
  if (inView && currentZoom >= minZoom) return;
  const targetZoom = Math.max(currentZoom, minZoom);
  if (opts.animate) {
    map.flyTo(ll, targetZoom, { animate: true, duration: opts.duration || 1.0 });
  } else {
    map.setView(ll, targetZoom, { animate: false });
  }
}

function selectListing(id, clickLatLng = null) {
  clearParcelSelection();
  _activeListingId = id;
  _lastSearchCardData = null;

  const existing = document.getElementById('search-result-card');
  if (existing) existing.remove();

  document.querySelectorAll('.listing-card').forEach(c => c.classList.remove('active'));
  const card = document.querySelector(`.listing-card[data-id="${id}"]`);
  if (card) { card.classList.add('active'); card.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }

  const listing = listings.find(l => String(l.id) === String(id));
  if (!listing) return;

  if (parcelLayer)  { map.removeLayer(parcelLayer);  parcelLayer  = null; }
  if (clickMarker)  { map.removeLayer(clickMarker);  clickMarker  = null; }

  _suppressNextDomainSearch = true;
  // Sidebar click: only move the map if the listing is off-screen or too zoomed out.
  // Marker clicks already have the map under the cursor — never force zoom 15.
  if (!clickLatLng) _focusMapOn(listing.lat, listing.lng, { minZoom: 14 });

  // Use actual click coordinates for cadastre query if available (listing coords are
  // approximate dummy data — real coords arrive with the Domain API key).
  // Fall back to listing coords when triggered from sidebar card click (no clickLatLng).
  const queryLatLng = clickLatLng || { lat: listing.lat, lng: listing.lng };

  const srlupEntry   = overlayRegistry['nsw-srlup'];
  const zoningEntry  = overlayRegistry['nsw-land-zoning'];
  const floodEntry   = overlayRegistry['nsw-flood'];
  const roadsEntry   = overlayRegistry['nsw-future-roads'];
  selectPropertyAtPoint(
    queryLatLng,
    !!(srlupEntry  && srlupEntry.def.enabled),
    !!(zoningEntry && zoningEntry.def.enabled),
    !!(floodEntry  && floodEntry.def.enabled),
    !!(roadsEntry  && roadsEntry.def.enabled),
    listing
  );
}

// ─── Filter chips ─────────────────────────────────────────────────────────────

// ─── Filter panel ─────────────────────────────────────────────────────────────

// ─── Filter persistence ───────────────────────────────────────────────────────
const FILTER_KEY = 'propmap_filters';

function saveFilters() {
  try { localStorage.setItem(FILTER_KEY, JSON.stringify(_activeFilters)); } catch (e) { /* ignore */ }
}

function restoreFilters() {
  try {
    const saved = localStorage.getItem(FILTER_KEY);
    if (!saved) return;
    const f = JSON.parse(saved);
    Object.assign(_activeFilters, f);
    function setChips(containerId, values) {
      const el = document.getElementById(containerId);
      if (!el) return;
      el.querySelectorAll('.filter-chip').forEach(chip => {
        chip.classList.toggle('active', values.includes(chip.dataset.value));
      });
    }
    function setSingleChip(containerId, value) {
      const el = document.getElementById(containerId);
      if (!el) return;
      el.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
      const chip = el.querySelector(`[data-value="${value}"]`);
      if (chip) chip.classList.add('active');
    }

    // V76.3 — category + listing type
    setSingleChip('filterPropertyCategory', f.propertyCategory || 'residential');
    setSingleChip('filterListingType',      f.listingType || 'Sale');
    setSingleChip('filterStrata',           f.strataUnitFlag || 'Both');

    setChips('filterPropertyTypes', f.propertyTypes || []);
    setChips('filterFeatures',      f.features || []);
    setChips('filterAttributes',    f.listingAttributes || []);
    if (f.establishedType) setChips('filterEstablished', [f.establishedType]);

    const setSelect = (id, val) => {
      const el = document.getElementById(id);
      if (el && val != null) el.value = String(val);
    };
    setSelect('filterMinBeds',          f.minBeds);
    setSelect('filterMaxBeds',          f.maxBeds);
    setSelect('filterMinBaths',         f.minBaths);
    setSelect('filterMinCars',          f.minCars);
    setSelect('filterMinPriceSale',     f.minPrice);
    setSelect('filterMaxPriceSale',     f.maxPrice);
    setSelect('filterMinRentWeek',      f.minRentWeek);
    setSelect('filterMaxRentWeek',      f.maxRentWeek);
    setSelect('filterMinLand',          f.minLand);
    setSelect('filterMaxLand',          f.maxLand);
    setSelect('filterListedSince',      f.listedSince);
    setSelect('filterMinFloor',         f.minFloor);
    setSelect('filterMaxFloor',         f.maxFloor);
    setSelect('filterMinYield',         f.minYield);
    setSelect('filterMaxYield',         f.maxYield);
    setSelect('filterMinRentAnnum',     f.minRentAnnum);
    setSelect('filterMaxRentAnnum',     f.maxRentAnnum);
    setSelect('filterMinRentSqm',       f.minRentSqm);
    setSelect('filterMaxRentSqm',       f.maxRentSqm);
    setSelect('filterCoreLogicType',    f.corelogicPropertyType);

    const pw = document.getElementById('filterExcludePriceWithheld');
    const dt = document.getElementById('filterExcludeDepositTaken');
    const nd = document.getElementById('filterNewDevOnly');
    if (pw) pw.checked = !!f.excludePriceWithheld;
    if (dt) dt.checked = !!f.excludeDepositTaken;
    if (nd) nd.checked = !!f.newDevOnly;
    const ssEl = document.getElementById('filterShowSnoozed');
    if (ssEl) ssEl.checked = !!f.showSnoozed;
  } catch (e) { /* ignore */ }
}

// V76.3 — show/hide filter groups based on the current category + listing type.
// Each group has data-mode ("residential", "commercial", "both") and optionally
// data-listing-type ("Sale" or "Rent"). A group is visible only if BOTH match.
function updateFilterVisibility() {
  const panel = document.getElementById('filterPanel');
  if (!panel) return;
  const cat  = _activeFilters.propertyCategory || 'residential';
  const lt   = _activeFilters.listingType || 'Sale';
  panel.querySelectorAll('.filter-group[data-mode]').forEach(g => {
    const modeAttr = g.dataset.mode;
    const ltAttr   = g.dataset.listingType;
    const modeOk   = (modeAttr === 'both') || (modeAttr === cat);
    const ltOk     = !ltAttr || (ltAttr === lt);
    g.style.display = (modeOk && ltOk) ? '' : 'none';
  });
}

(function initFilterPanel() {
  const toggleBtn   = document.getElementById('filterToggleBtn');
  const panel       = document.getElementById('filterPanel');
  const closeBtn    = document.getElementById('filterPanelClose');
  const clearBtn    = document.getElementById('filterClearBtn');
  const applyBtn    = document.getElementById('filterApplyBtn');
  const activeCount = document.getElementById('filterActiveCount');

  restoreFilters();
  updateFilterVisibility();

  // Toggle panel open/close
  toggleBtn.addEventListener('click', () => {
    panel.classList.toggle('open');
  });
  closeBtn.addEventListener('click', () => panel.classList.remove('open'));

  // Multi-select chip groups
  function initChipGroup(containerId) {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.querySelectorAll('.filter-chip').forEach(chip => {
      chip.addEventListener('click', () => chip.classList.toggle('active'));
    });
  }
  initChipGroup('filterPropertyTypes');
  initChipGroup('filterFeatures');
  initChipGroup('filterAttributes');
  initChipGroup('filterEstablished');

  // Single-select chip groups (one at a time)
  function initSingleSelect(containerId, onChange) {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.querySelectorAll('.filter-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        el.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        if (onChange) onChange(chip.dataset.value);
      });
    });
  }

  // Listing Type — drives price-range visibility live
  initSingleSelect('filterListingType', (v) => {
    _activeFilters.listingType = v;
    updateFilterVisibility();
  });

  // Property Category — drives full residential/commercial split
  initSingleSelect('filterPropertyCategory', (v) => {
    _activeFilters.propertyCategory = v;
    updateFilterVisibility();
  });

  // Strata flag (commercial-only)
  initSingleSelect('filterStrata');

  // Clear all
  clearBtn.addEventListener('click', () => {
    panel.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
    const resDefault = document.querySelector('#filterPropertyCategory [data-value="residential"]');
    const saleDefault = document.querySelector('#filterListingType [data-value="Sale"]');
    const strataDefault = document.querySelector('#filterStrata [data-value="Both"]');
    if (resDefault)    resDefault.classList.add('active');
    if (saleDefault)   saleDefault.classList.add('active');
    if (strataDefault) strataDefault.classList.add('active');

    panel.querySelectorAll('select').forEach(s => s.value = '');
    panel.querySelectorAll('input[type="checkbox"]').forEach(c => c.checked = false);

    _activeFilters = {
      propertyCategory: 'residential',
      propertyTypes: [], listingType: 'Sale',
      minBeds: null, maxBeds: null, minBaths: null, minCars: null,
      minPrice: null, maxPrice: null,
      minRentWeek: null, maxRentWeek: null,
      minLand: null, maxLand: null,
      features: [], listingAttributes: [], establishedType: null,
      excludePriceWithheld: false, excludeDepositTaken: true, newDevOnly: false,
      showSnoozed: false,
      corelogicPropertyType: null,
      minFloor: null, maxFloor: null,
      minYield: null, maxYield: null,
      minRentAnnum: null, maxRentAnnum: null,
      minRentSqm: null, maxRentSqm: null,
      strataUnitFlag: 'Both',
    };
    saveFilters();
    updateFilterVisibility();
    updateActiveCount();
  });

  // Count active filters for badge — only counts visible groups
  function updateActiveCount() {
    let count = 0;
    panel.querySelectorAll('.filter-group').forEach(g => {
      if (g.style.display === 'none') return;
      g.querySelectorAll('.filter-chip.active').forEach(c => {
        // Don't count the default-active category/listing-type/strata chips
        const parent = c.closest('.filter-chips');
        if (parent && ['filterPropertyCategory','filterListingType','filterStrata'].includes(parent.id)) return;
        count++;
      });
      g.querySelectorAll('select').forEach(s => { if (s.value) count++; });
      g.querySelectorAll('input[type="checkbox"]').forEach(c => { if (c.checked) count++; });
    });
    activeCount.textContent = count > 0 ? count : '';
    activeCount.style.display = count > 0 ? 'inline' : 'none';
  }
  updateActiveCount();

  // Apply filters → read state, store in _activeFilters, trigger search
  applyBtn.addEventListener('click', () => {
    const getChips = id => {
      const el = document.getElementById(id);
      if (!el) return [];
      return [...el.querySelectorAll('.filter-chip.active')].map(c => c.dataset.value);
    };
    const selVal   = id => { const el = document.getElementById(id); return el && el.value ? el.value : null; };
    const numVal   = id => { const v = selVal(id); return v ? Number(v) : null; };

    const established   = getChips('filterEstablished');
    const categoryChip  = document.querySelector('#filterPropertyCategory .filter-chip.active');
    const listingTypeChip = document.querySelector('#filterListingType .filter-chip.active');
    const strataChip    = document.querySelector('#filterStrata .filter-chip.active');

    _activeFilters = {
      propertyCategory:     categoryChip ? categoryChip.dataset.value : 'residential',
      listingType:          listingTypeChip ? listingTypeChip.dataset.value : 'Sale',

      // Residential
      propertyTypes:        getChips('filterPropertyTypes'),
      minBeds:              numVal('filterMinBeds'),
      maxBeds:              numVal('filterMaxBeds'),
      minBaths:             numVal('filterMinBaths'),
      minCars:              numVal('filterMinCars'),

      // Sale price / rent per week
      minPrice:             numVal('filterMinPriceSale'),
      maxPrice:             numVal('filterMaxPriceSale'),
      minRentWeek:          numVal('filterMinRentWeek'),
      maxRentWeek:          numVal('filterMaxRentWeek'),

      // Shared
      minLand:              numVal('filterMinLand'),
      maxLand:              numVal('filterMaxLand'),

      features:             getChips('filterFeatures'),
      listingAttributes:    getChips('filterAttributes'),
      establishedType:      established.length === 1 ? established[0] : null,
      listedSince:          numVal('filterListedSince'),
      excludePriceWithheld: document.getElementById('filterExcludePriceWithheld')?.checked || false,
      excludeDepositTaken:  document.getElementById('filterExcludeDepositTaken')?.checked || false,
      newDevOnly:           document.getElementById('filterNewDevOnly')?.checked || false,
      showSnoozed:          document.getElementById('filterShowSnoozed')?.checked || false,

      // CoreLogic
      corelogicPropertyType: selVal('filterCoreLogicType'),
      minFloor:              numVal('filterMinFloor'),
      maxFloor:              numVal('filterMaxFloor'),
      minYield:              numVal('filterMinYield'),
      maxYield:              numVal('filterMaxYield'),
      minRentAnnum:          numVal('filterMinRentAnnum'),
      maxRentAnnum:          numVal('filterMaxRentAnnum'),
      minRentSqm:            numVal('filterMinRentSqm'),
      maxRentSqm:            numVal('filterMaxRentSqm'),
      strataUnitFlag:        strataChip ? strataChip.dataset.value : 'Both',
    };

    updateActiveCount();
    saveFilters();
    panel.classList.remove('open');
    runListingSearch();
    if (typeof refreshPipelinePins === 'function') refreshPipelinePins();
  });
})();

// ─── Listings toggle ──────────────────────────────────────────────────────────
// V75.2: the original listingsToggle button was moved from the top header
// into the sidebar's own header (id #listingsPanelToggle). Wire both so
// either element triggers the same show/hide logic. #listingsToggle stays
// as a hidden stub to keep legacy references happy.
//
// V75.7: clicking the Listings button also toggles the Domain API's is_active
// flag server-side (any signed-in user — special exception to admin-only rule).
// The button shows green when Domain is active, grey when inactive.

async function _toggleDomainApiActive(newActive) {
  try {
    const r = await fetch('/api/usage/active', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_name: 'domain', is_active: newActive }),
    });
    if (!r.ok) {
      console.warn('[listings] failed to toggle Domain API:', r.status);
      return false;
    }
    const data = await r.json();
    if (data.subscription) {
      window._apiState = window._apiState || {};
      window._apiState.domain = data.subscription;
      if (typeof window.syncApiDependentUi === 'function') window.syncApiDependentUi();
    }
    return true;
  } catch (err) {
    console.warn('[listings] toggle error:', err.message);
    return false;
  }
}

async function _listingsToggleHandler() {
  // Determine new state from current Domain API state if available; fall back to
  // the legacy showListings flag.
  const apiState = (window._apiState && window._apiState.domain) || null;
  const currentlyActive = apiState ? !!apiState.is_active : !!showListings;
  const newActive = !currentlyActive;

  // Persist to server first so we don't get out of sync. If the server fails,
  // fall back to client-only behaviour for the current session.
  await _toggleDomainApiActive(newActive);

  showListings = newActive;
  const stub = document.getElementById('listingsToggle');
  const live = document.getElementById('listingsPanelToggle');
  if (stub) stub.classList.toggle('active', showListings);
  if (live) live.classList.toggle('active', showListings);

  Object.values(markers).forEach(m => {
    if (showListings) m.addTo(map); else map.removeLayer(m);
  });
  if (showListings) {
    renderListings();
    // Trigger a fresh search now that API is back on
    if (typeof debouncedDomainSearch === 'function') debouncedDomainSearch();
  } else {
    const list = document.getElementById('listingsList');
    if (list) list.innerHTML = '';
    const count = document.getElementById('listingCount');
    if (count) count.textContent = '0';
  }
}

document.getElementById('listingsToggle')?.addEventListener('click', _listingsToggleHandler);
document.getElementById('listingsPanelToggle')?.addEventListener('click', _listingsToggleHandler);

// ─── Panel open/close ─────────────────────────────────────────────────────────

function togglePanel(panelId, btnId) {
  const panel  = document.getElementById(panelId);
  const btn    = document.getElementById(btnId);
  const isOpen = panel.classList.contains('visible');
  document.querySelectorAll('.overlay-panel').forEach(p => p.classList.remove('visible'));
  document.querySelectorAll('.panel-btn').forEach(b => b.classList.remove('open'));
  if (!isOpen) {
    panel.classList.add('visible');
    btn.classList.add('open');
    if (panelId === 'overlayPanel') renderOverlayPanel();
    if (panelId === 'uploadPanel')  renderManageList();
  }
}

document.getElementById('overlayPanelBtn').addEventListener('click',  () => togglePanel('overlayPanel', 'overlayPanelBtn'));
document.getElementById('overlayPanelClose').addEventListener('click', () => togglePanel('overlayPanel', 'overlayPanelBtn'));
document.getElementById('uploadPanelBtn').addEventListener('click',   () => togglePanel('uploadPanel',  'uploadPanelBtn'));
document.getElementById('uploadPanelClose').addEventListener('click', () => togglePanel('uploadPanel',  'uploadPanelBtn'));

document.addEventListener('click', e => {
  if (!e.target.closest('.overlay-panel') && !e.target.closest('.panel-btn')) {
    document.querySelectorAll('.overlay-panel').forEach(p => p.classList.remove('visible'));
    document.querySelectorAll('.panel-btn').forEach(b => b.classList.remove('open'));
  }
});

// ─── Reveal Price button (delegated handler on listings panel) ───────────────
// Click any "Reveal Price" button on a listing card → probe Domain at all
// price brackets within the user's active filter, derive ranges for ALL
// price-withheld listings in the viewport in one batch, and re-render.
// One click reveals every hidden price in the current view (same API cost
// regardless of listing count, per Reveal Price design).
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('.listing-reveal-price-btn');
  if (!btn) return;
  e.stopPropagation();
  if (_revealInFlight) return;
  if (!window.DomainAPI || !DomainAPI.revealHiddenPrices) return;
  if (!_lastDomainSearchOptions) {
    console.warn('[map] Reveal Price clicked before any Domain search ran');
    return;
  }

  // Find every listing currently in the panel that needs reveal
  const hiddenIds = listings
    .filter(l => isPriceWithheld(l.price))
    .map(l => String(l.id));
  if (!hiddenIds.length) return;

  // Replace all reveal buttons with a "Probing…" state
  document.querySelectorAll('.listing-reveal-price-btn').forEach(b => {
    b.disabled = true;
    b.textContent = 'Probing…';
  });

  _revealInFlight = true;
  try {
    const opts = _lastDomainSearchOptions;
    await DomainAPI.revealHiddenPrices({
      geoWindow:    opts.geoWindow,
      hiddenIds,
      userMinPrice: opts.minPrice || null,
      userMaxPrice: opts.maxPrice || null,
      baseOptions: {
        propertyTypes:        opts.propertyTypes,
        listingTypes:         opts.listingTypes,
        minBeds:              opts.minBeds,
        maxBeds:              opts.maxBeds,
        minBaths:             opts.minBaths,
        minCars:              opts.minCars,
        minLand:              opts.minLand,
        maxLand:              opts.maxLand,
        propertyFeatures:     opts.propertyFeatures,
        listingAttributes:    opts.listingAttributes,
        establishedType:      opts.establishedType,
        excludeDepositTaken:  opts.excludeDepositTaken,
        newDevOnly:           opts.newDevOnly,
        // Note: exclude listedSince and excludePriceWithheld from probe so we
        // don't filter out the listings we're trying to derive prices for.
      },
    });

    // DomainAPI updated the in-memory enrichment cache and persisted to the
    // server. Mirror those derived prices into our local `listings` array
    // (renderListings reads from there) and re-render.
    listings.forEach(l => {
      const enriched = DomainAPI.getEnrichedListing(l.id);
      if (enriched && enriched.price && enriched.price.derived) {
        l.price = enriched.price;
      }
    });
    renderListings();
  } catch (err) {
    console.error('[map] revealHiddenPrices failed:', err);
    document.querySelectorAll('.listing-reveal-price-btn').forEach(b => {
      b.disabled = false;
      b.textContent = 'Reveal Price';
    });
  } finally {
    _revealInFlight = false;
  }
});


// ─── Opacity preview slider ───────────────────────────────────────────────────

document.getElementById('upOpacity').addEventListener('input', function () {
  document.getElementById('upOpacityVal').textContent = this.value + '%';
});

// ─── GeoTIFF file input — parse on select ────────────────────────────────────

document.getElementById('upFile').addEventListener('change', async function () {
  const preview = document.getElementById('upBoundsPreview');
  parsedGeoTiff = null;
  preview.className = 'bounds-preview';

  const file = this.files[0];
  if (!file) { preview.textContent = ''; return; }

  preview.textContent = 'Reading GeoTIFF…';
  try {
    parsedGeoTiff = await parseGeoTiff(file);
    const b = parsedGeoTiff.bounds;
    preview.textContent =
      `✓ Bounds detected: ${b.latMin.toFixed(4)}°S → ${b.latMax.toFixed(4)}°S, ` +
      `${b.lonMin.toFixed(4)}°E → ${b.lonMax.toFixed(4)}°E`;
  } catch (err) {
    preview.textContent = '✕ ' + err.message;
    preview.className = 'bounds-preview error';
  }
});

// ─── Upload helpers ───────────────────────────────────────────────────────────

function setStatus(msg, isError = false) {
  const el = document.getElementById('upStatus');
  el.textContent = msg;
  el.className = 'up-status' + (isError ? ' error' : '');
}

function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function getFormValues() {
  const label   = document.getElementById('upLabel').value.trim();
  const type    = document.getElementById('upType').value;
  const zone    = document.getElementById('upZone').value.trim();
  const opacity = document.getElementById('upOpacity').value / 100;

  if (!label)         return { error: 'Please enter a label.' };
  if (!zone)          return { error: 'Please enter a zone id.' };
  if (!parsedGeoTiff) return { error: 'Please select a valid GeoTIFF file.' };

  return { label, type, zone, opacity };
}

function buildDef(form) {
  return {
    id:      slugify(form.label) + '-' + Date.now(),
    label:   form.label,
    type:    form.type,
    zone:    form.zone,
    enabled: true,
    opacity: form.opacity,
    bounds:  parsedGeoTiff.bounds,
    b64:     parsedGeoTiff.b64
  };
}

// ─── Add live ─────────────────────────────────────────────────────────────────

document.getElementById('upAddLive').addEventListener('click', () => {
  const form = getFormValues();
  if (form.error) return setStatus(form.error, true);

  const def = buildDef(form);
  registerOverlay(def);
  renderOverlayPanel();
  renderManageList();
  setStatus('✓ Overlay added to map for this session.');
});

// ─── Download updated overlay files ──────────────────────────────────────────

document.getElementById('upDownload').addEventListener('click', () => {
  const form = getFormValues();
  if (form.error) return setStatus(form.error, true);

  const def = buildDef(form);

  // 1. Download overlays-meta.js (all defs with b64 stripped to null)
  const allDefs = Object.values(overlayRegistry).map(e => e.def);
  const existingIdx = allDefs.findIndex(d => d.id === def.id);
  if (existingIdx >= 0) allDefs[existingIdx] = def;
  else allDefs.push(def);

  const metaContent = generateOverlaysMetaJs(allDefs);
  triggerDownload(metaContent, 'overlays-meta.js');

  // 2. Download overlays-b64-{id}.js for the new overlay only
  if (def.b64) {
    const b64Content = generateOverlayB64Js(def);
    triggerDownload(b64Content, `overlays-b64-${def.id}.js`);
  }

  setStatus(`✓ Downloaded overlays-meta.js${def.b64 ? ` and overlays-b64-${def.id}.js` : ''}. Add the new <script> tag to index.html.`);
});

function triggerDownload(content, filename) {
  const blob = new Blob([content], { type: 'text/javascript' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// ─── Generate overlays-meta.js content (no b64 data) ─────────────────────────

function generateOverlaysMetaJs(defs) {
  const overlaysStr = defs.map(def => {
    const b = def.bounds;
    const boundsStr = b
      ? `{ latMin: ${b.latMin}, latMax: ${b.latMax}, lonMin: ${b.lonMin}, lonMax: ${b.lonMax} }`
      : 'null';
    const wmsStr = def.wms
      ? `,\n    wms: ${JSON.stringify(def.wms, null, 2).replace(/\n/g, '\n    ')}`
      : '';
    return `  {
    id: ${JSON.stringify(def.id)},
    label: ${JSON.stringify(def.label)},
    type: ${JSON.stringify(def.type)},
    group: ${JSON.stringify(def.group || 'services')},
    zone: ${JSON.stringify(def.zone)},
    enabled: ${def.enabled},
    opacity: ${def.opacity},
    bounds: ${boundsStr},
    b64: null${wmsStr}
  }`;
  }).join(',\n');

  const zonesStr = ZONES.map(z => {
    const b = z.bounds;
    const boundsStr = b
      ? `{ latMin: ${b.latMin}, latMax: ${b.latMax}, lonMin: ${b.lonMin}, lonMax: ${b.lonMax} }`
      : 'null';
    return `  { id: ${JSON.stringify(z.id)}, label: ${JSON.stringify(z.label)}, bounds: ${boundsStr} }`;
  }).join(',\n');

  const typeMetaStr = JSON.stringify(OVERLAY_TYPE_META, null, 2);

  return `/**
 * overlays-meta.js — generated by Sydney Property Map upload manager.
 * b64 image data is stored separately in overlays-b64-{id}.js files.
 * See original file comments for manual editing instructions.
 */

const OVERLAYS = [
${overlaysStr}
];

const ZONES = [
${zonesStr}
];

const OVERLAY_TYPE_META = ${typeMetaStr};
`;
}

// ─── Generate overlays-b64-{id}.js content ───────────────────────────────────

function generateOverlayB64Js(def) {
  return `// Auto-generated by Sydney Property Map upload manager.
// b64 image data for overlay: "${def.id}"
// Include this file after overlays-meta.js in index.html:
//   <script src="overlays-b64-${def.id}.js"></script>

(function () {
  if (typeof window.OVERLAY_B64 === 'undefined') window.OVERLAY_B64 = {};
  window.OVERLAY_B64[${JSON.stringify(def.id)}] = "${def.b64}";
})();
`;
}

// ─── Manage overlays (delete) ─────────────────────────────────────────────────

function renderManageList() {
  const container = document.getElementById('manageList');
  container.innerHTML = '';
  const entries = Object.values(overlayRegistry);

  if (entries.length === 0) {
    container.innerHTML = '<p style="font-size:12px;color:var(--muted);padding:8px 0">No overlays to manage.</p>';
    return;
  }

  entries.forEach(({ def, layer }) => {
    const row = document.createElement('div');
    row.className = 'manage-row';
    row.innerHTML = `
      <span class="manage-row-label">${def.label}</span>
      <button class="btn-delete" data-id="${def.id}">✕ Remove</button>
    `;
    row.querySelector('.btn-delete').addEventListener('click', () => {
      if (layer) map.removeLayer(layer);
      delete overlayRegistry[def.id];
      renderManageList();
      renderOverlayPanel();
    });
    container.appendChild(row);
  });
}

// ─── Persistent search card ──────────────────────────────────────────────────
// Stores the last search/click result so it survives renderListings() re-renders

let _lastSearchCardData = null;

function _injectSearchCard() {
  if (!_lastSearchCardData || !_lastSearchCardData.listing) return;
  const { label, lga, lotDP, lat, lng, listing } = _lastSearchCardData;
  const inList = document.querySelector(`.listing-card[data-id="${String(listing.id)}"]`);
  if (inList) {
    const src = document.getElementById('search-result-card');
    if (src) src.remove();
    document.querySelectorAll('.listing-card').forEach(c => c.classList.remove('active'));
    inList.classList.add('active');
    inList.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    return;
  }
  const existing = document.getElementById('search-result-card');
  if (!existing) showSearchCard({ label, lga, lotDP, lat, lng, listing });
}

// ─── Init ─────────────────────────────────────────────────────────────────────

// V76.7 — Debounce both the sidebar render AND the Domain API search on
// moveend/zoomend. Previously renderListings() fired immediately on every
// zoomend, causing visible "flashing" when the user clicked a zoom button
// multiple times in quick succession. 300ms absorbs typical multi-click
// rhythm while staying responsive on a single pan/zoom action.
let _viewportRefreshTimer = null;
function _debouncedViewportRefresh() {
  clearTimeout(_viewportRefreshTimer);
  _viewportRefreshTimer = setTimeout(() => {
    if (showListings) renderListings();
    if (_activeListingId) {
      const _ac = document.querySelector(`.listing-card[data-id="${_activeListingId}"]`);
      if (_ac) { _ac.classList.add('active'); _ac.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
    }
    _injectSearchCard();
    // Refresh easement buffers if electricity overlay is active
    const elecEntry = overlayRegistry['electricity-transmission'];
    if (elecEntry && elecEntry.def.enabled) drawEasementBuffers();
    // Re-fetch Domain listings for the new viewport
    if (showListings && window.DomainAPI) debouncedDomainSearch();
    // Persist viewport
    try {
      const c = map.getCenter();
      localStorage.setItem('propmap_viewport', JSON.stringify({ lat: c.lat, lng: c.lng, zoom: map.getZoom() }));
    } catch (e) { /* ignore */ }
  }, 300);
}

map.on('moveend zoomend', _debouncedViewportRefresh);

// Move overlay panel inside its anchor for relative positioning
(function () {
  const anchor = document.getElementById('overlayAnchor');
  const panel  = document.getElementById('overlayPanel');
  if (anchor && panel) anchor.appendChild(panel);
})();

buildZoneSelector();
renderOverlayPanel();

// ─── Domain API: build geoWindow from current map state ──────────────────────
// Uses the selected property (or first of multi-select) as centre if available,
// otherwise uses the current map viewport bounds.

function buildDomainGeoWindow() {
  // Always search the *visible* map boundary so listings in the right-hand
  // pane stay in sync with what the user is looking at. Parcel / click-marker
  // centred boxes (fixed ~5km) previously caused the sidebar to show results
  // outside the current viewport after a selection.
  // Intentional point searches (address bar) still use runDomainSearchAt().
  const b = map.getBounds();
  return {
    box: {
      topLeft:     { lat: b.getNorth(), lon: b.getWest() },
      bottomRight: { lat: b.getSouth(), lon: b.getEast() },
    }
  };
}

// ─── Address-string matching helper ──────────────────────────────────────────
function normaliseStreet(s) {
  if (!s) return '';
  return s.toLowerCase()
    .replace(/\brd\b/g, 'road').replace(/\bst\b/g, 'street').replace(/\bave?\b/g, 'avenue')
    .replace(/\bdr\b/g, 'drive').replace(/\bcrt?\b/g, 'court').replace(/\bpl\b/g, 'place')
    .replace(/\bpde\b/g, 'parade').replace(/\bcl\b/g, 'close').replace(/\bln\b/g, 'lane')
    .replace(/\bhwy\b/g, 'highway').replace(/\bblvd\b/g, 'boulevard')
    .replace(/[.,]/g, '').replace(/\s+/g, ' ').trim();
}
function matchListingByAddress(listingsArr, streetAddress, suburb, lotDP) {
  if (!listingsArr || !listingsArr.length) return null;
  const normSearch = normaliseStreet(streetAddress);
  const subSearch  = (suburb || '').toLowerCase().trim();
  if (normSearch) {
    const hit = listingsArr.find(l => {
      const normL  = normaliseStreet(l.address);
      const subL   = (l.suburb || '').toLowerCase().trim();
      const streetOk = normL === normSearch || normL.startsWith(normSearch) || normSearch.startsWith(normL);
      const subOk    = !subSearch || !subL || subL === subSearch || subL.includes(subSearch) || subSearch.includes(subL);
      return streetOk && subOk;
    });
    if (hit) return hit;
    const hit2 = listingsArr.find(l => normaliseStreet(l.address) === normSearch);
    if (hit2) return hit2;
  }
  if (lotDP) {
    const normLot = lotDP.toLowerCase().replace(/\s/g, '');
    const hit3 = listingsArr.find(l => {
      const lLots = (l._lotDPs || '').toLowerCase().replace(/\s/g, '');
      return lLots && lLots.includes(normLot);
    });
    if (hit3) return hit3;
  }
  return null;
}
async function runDomainSearchAt(lat, lng, searchAddress, searchSuburb) {
  if (!window.DomainAPI || !DomainAPI.search) return null;
  const delta = 0.05;
  const geoWindow = { box: { topLeft: { lat: lat + delta, lon: lng - delta }, bottomRight: { lat: lat - delta, lon: lng + delta } } };
  const listedSinceISO = _activeFilters.listedSince
    ? new Date(Date.now() - _activeFilters.listedSince * 86400000).toISOString()
    : null;
  try {
    const domainListings = await DomainAPI.search({
      geoWindow,
      propertyTypes: _activeFilters.propertyTypes, listingTypes: [_activeFilters.listingType],
      minBeds: _activeFilters.minBeds, maxBeds: _activeFilters.maxBeds,
      minBaths: _activeFilters.minBaths, minCars: _activeFilters.minCars,
      minPrice: _activeFilters.minPrice, maxPrice: _activeFilters.maxPrice,
      minLand: _activeFilters.minLand, maxLand: _activeFilters.maxLand,
      propertyFeatures: _activeFilters.features, listingAttributes: _activeFilters.listingAttributes,
      establishedType: _activeFilters.establishedType,
      excludePriceWithheld: _activeFilters.excludePriceWithheld,
      excludeDepositTaken: _activeFilters.excludeDepositTaken,
      newDevOnly: _activeFilters.newDevOnly,
      listedSince: listedSinceISO,
    });
    listings.length = 0;
    domainListings.forEach(l => listings.push(l));
    renderListings();
    if (window.backfillAgentFromCache) backfillAgentFromCache();
    return matchListingByAddress(listings, searchAddress, searchSuburb, null);
  } catch (err) {
    console.error('[map] runDomainSearchAt failed:', err);
    return null;
  }
}
// ─── Listing search (Domain + CoreLogic dispatch, V76.3) ──────────────────────
// runListingSearch() is the canonical entry point. It dispatches to either
// runDomainSearch() or runCoreLogicSearch() based on _activeFilters.propertyCategory.
// debouncedDomainSearch() is kept as an alias for pre-V76.3 callers.

let _domainSearchTimer = null;

function debouncedDomainSearch() {
  if (_suppressNextDomainSearch) { _suppressNextDomainSearch = false; return; }
  clearTimeout(_domainSearchTimer);
  // V76.7 — 100ms small buffer. The viewport refresh wrapper that calls us
  // already debounces by 500ms on moveend/zoomend, so most bursts are absorbed
  // before reaching here. The inner timer just deduplicates if multiple
  // callers (e.g. filter changes happening alongside a viewport change) all
  // hit within the same tick.
  _domainSearchTimer = setTimeout(runListingSearch, 100);
}

function runListingSearch() {
  if (_activeFilters.propertyCategory === 'commercial') {
    _lastSearchBounds = null;  // CoreLogic uses live bounds
    return runCoreLogicSearch();
  }
  return runDomainSearch();
}

async function runDomainSearch() {
  if (!window.DomainAPI || !DomainAPI.search) { renderListings(); return; }
  const loadingEl = document.getElementById('listingsLoadingindicator');
  if (loadingEl) loadingEl.style.display = 'inline';
  try {
    const geoWindow = buildDomainGeoWindow();
    const isRent = _activeFilters.listingType === 'Rent';
    // V76.3 — use rent-per-week range when Rent, sale range when Sale
    const priceMin = isRent ? _activeFilters.minRentWeek : _activeFilters.minPrice;
    const priceMax = isRent ? _activeFilters.maxRentWeek : _activeFilters.maxPrice;
    // Convert listedSince days → ISO datetime for Domain API
    const listedSinceISO = _activeFilters.listedSince
      ? new Date(Date.now() - _activeFilters.listedSince * 86400000).toISOString()
      : null;
    console.log('[map] Domain search — geoWindow:', JSON.stringify(geoWindow),
                'listingType:', _activeFilters.listingType, 'priceRange:', priceMin, '-', priceMax,
                'listedSince:', listedSinceISO);
    const searchOptions = {
      geoWindow,
      propertyTypes:        _activeFilters.propertyTypes,
      listingTypes:         [_activeFilters.listingType],
      minBeds:              _activeFilters.minBeds,
      maxBeds:              _activeFilters.maxBeds,
      minBaths:             _activeFilters.minBaths,
      minCars:              _activeFilters.minCars,
      minPrice:             priceMin,
      maxPrice:             priceMax,
      minLand:              _activeFilters.minLand,
      maxLand:              _activeFilters.maxLand,
      propertyFeatures:     _activeFilters.features,
      listingAttributes:    _activeFilters.listingAttributes,
      establishedType:      _activeFilters.establishedType,
      excludePriceWithheld: _activeFilters.excludePriceWithheld,
      excludeDepositTaken:  _activeFilters.excludeDepositTaken,
      newDevOnly:           _activeFilters.newDevOnly,
      listedSince:          listedSinceISO,
    };
    // Stash so the Reveal Price handler can replay this search at price brackets
    _lastDomainSearchOptions = searchOptions;
    // Record search bounds for diagnostics / reveal-price replay. Sidebar
    // filtering always uses live map.getBounds() so the pane tracks the view.
    const gw = geoWindow.box;
    _lastSearchBounds = L.latLngBounds(
      L.latLng(gw.bottomRight.lat, gw.topLeft.lon),
      L.latLng(gw.topLeft.lat,     gw.bottomRight.lon)
    );
    const domainListings = await DomainAPI.search(searchOptions);
    listings.length = 0;
    domainListings.forEach(l => listings.push(l));
    console.log('[map] Domain API returned ' + listings.length + ' listings');
    if (loadingEl) loadingEl.style.display = 'none';
    renderListings();
  } catch (err) {
    if (loadingEl) loadingEl.style.display = 'none';
    console.error('[map] Domain API fetch failed:', err);
    showListingError(err.message, 'Domain');
  }
}

// V76.3 — CoreLogic commercial search. Calls our /api/corelogic-search proxy
// with the current viewport as a polygon ring plus any configured filters.
// Maps response rows into the same `listing` shape used by renderListings().
async function runCoreLogicSearch() {
  try {
    const isRent   = _activeFilters.listingType === 'Rent';
    const polygon  = buildCoreLogicPolygon();
    const query    = {
      listingStatus: 'Current',
      limit:         100,
      sortBy:        'relevance',
    };

    // propertyType key differs per endpoint: sale uses "propertyType", lease uses "spaceType"
    if (_activeFilters.corelogicPropertyType) {
      if (isRent) query.spaceType    = _activeFilters.corelogicPropertyType;
      else        query.propertyType = _activeFilters.corelogicPropertyType;
    }

    // Land / site area → CoreLogic siteArea
    if (_activeFilters.minLand != null) query.siteAreaFrom = _activeFilters.minLand;
    if (_activeFilters.maxLand != null) query.siteAreaTo   = _activeFilters.maxLand;

    // Floor area
    if (_activeFilters.minFloor != null) query.floorAreaFrom = _activeFilters.minFloor;
    if (_activeFilters.maxFloor != null) query.floorAreaTo   = _activeFilters.maxFloor;

    // Strata
    if (_activeFilters.strataUnitFlag && _activeFilters.strataUnitFlag !== 'Both') {
      query.strataUnitFlag = _activeFilters.strataUnitFlag;
    }

    // Sale-only fields
    if (!isRent) {
      if (_activeFilters.minPrice != null) query.askingPriceFrom = _activeFilters.minPrice;
      if (_activeFilters.maxPrice != null && _activeFilters.maxPrice < 999999999) {
        query.askingPriceTo = _activeFilters.maxPrice;
      }
      if (_activeFilters.minYield != null) query.advertisedYieldFrom = _activeFilters.minYield;
      if (_activeFilters.maxYield != null) query.advertisedYieldTo   = _activeFilters.maxYield;
    }

    // Lease-only fields
    if (isRent) {
      if (_activeFilters.minRentAnnum != null) query.askingRentPerAnnumFrom = _activeFilters.minRentAnnum;
      if (_activeFilters.maxRentAnnum != null) query.askingRentPerAnnumTo   = _activeFilters.maxRentAnnum;
      if (_activeFilters.minRentSqm   != null) query.askingRentPerSqmFrom   = _activeFilters.minRentSqm;
      if (_activeFilters.maxRentSqm   != null) query.askingRentPerSqmTo     = _activeFilters.maxRentSqm;
    }

    console.log('[map] CoreLogic search — listingType:', isRent ? 'lease' : 'sale',
                'query:', query, 'polygon points:', polygon[0]?.length);

    const res = await fetch('/api/corelogic-search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        listingType: isRent ? 'lease' : 'sale',
        query,
        polygon,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`CoreLogic API error (${res.status}): ${err.error || 'unknown'}`);
    }

    const data = await res.json();
    const rows = Array.isArray(data.results) ? data.results : [];
    console.log('[map] CoreLogic API returned', rows.length, 'of', data.count, 'total');

    listings.length = 0;
    rows.forEach(r => {
      const mapped = mapCoreLogicListing(r, isRent);
      listings.push(mapped);
    });
    renderListings();
  } catch (err) {
    console.error('[map] CoreLogic API fetch failed:', err);
    showListingError(err.message, 'CoreLogic');
  }
}

// V76.3 — map a CoreLogic listing row to the common PropMap listing shape so
// renderListings() and the map marker code can handle both sources uniformly.
// CoreLogic listings that lack coordinates (latitude/longitude == null) are
// still included in the array but marked with _noCoords so renderListings()
// will show them in the sidebar but skip placing a marker.
function mapCoreLogicListing(r, isLease) {
  const addr   = r.streetAddress || '';
  // Strip trailing "SUBURB STATE postcode" — everything after the last 3 uppercase tokens
  // Quick heuristic: split on " NSW " or similar — fall back to full string
  const suburbMatch = addr.match(/([A-Z][A-Z\s]+)\s+(NSW|VIC|QLD|WA|SA|TAS|ACT|NT)\s+\d{4}$/);
  const suburb = suburbMatch ? suburbMatch[1].trim() : '';
  const state  = suburbMatch ? suburbMatch[2] : '';
  const street = suburbMatch ? addr.slice(0, addr.length - suburbMatch[0].length).trim() : addr;

  const agents = Array.isArray(r.leasingAgency) ? r.leasingAgency.map(a => a.leasingAgency).filter(Boolean) : [];
  const hasCoords = r.latitude != null && r.longitude != null;

  return {
    id:               'CL-' + r.listingId,
    _source:          'corelogic',
    _listingType:     isLease ? 'Rent' : 'Sale',
    _confidence:      r.confidence || null,
    _dataSource:      r.source || null,      // "CITYSCOPE" | "PIM"
    _cityscopeRef:    r.properties?.[0]?.cityscopeReference || null,
    _unitNumber:      r.unitNumber || null,
    _strata:          r.strataUnitFlag === 'Yes',
    _listingDate:     r.listingDate || null,
    _listingStatus:   r.listingStatus || null,
    _agencies:        agents,
    _noCoords:        !hasCoords,

    address:          street || addr,
    suburb,
    state,
    lat:              r.latitude,
    lng:              r.longitude,
    type:             (r.spaceType || r.propertyType || 'Commercial').toLowerCase(),
    price:            null,   // CoreLogic doesn't return price in the list endpoint
    bedrooms:         null,
    bathrooms:        null,
    carspaces:        null,
  };
}

// V76.3 — build a viewport polygon ring for CoreLogic's polygon body param.
// Uses the current map bounds (or selected parcel, if any). Ring must be
// closed (first point == last point). CoreLogic expects [[ [lng,lat], ... ]].
function buildCoreLogicPolygon() {
  // Always use the visible map boundary (same rationale as buildDomainGeoWindow).
  const b = map.getBounds();
  const n = b.getNorth(), s = b.getSouth(), w = b.getWest(), e = b.getEast();
  return [[
    [w, n], [e, n], [e, s], [w, s], [w, n],
  ]];
}

function showListingError(msg, provider) {
  Object.values(markers).forEach(m => map.removeLayer(m));
  markers = {};

  const list = document.getElementById('listingsList');
  const isRateLimit = msg && msg.includes('429');
  list.innerHTML = `
    <div class="domain-error">
      <div class="domain-error-icon">⚠</div>
      <div class="domain-error-title">${isRateLimit ? 'Too many requests' : (provider || 'Listings') + ' connection error'}</div>
      <div class="domain-error-msg">${isRateLimit
        ? 'API rate limit reached. Results will refresh automatically.'
        : `Could not connect to ${provider || 'the listings'} API. Please check your connection and try again.`
      }</div>
      <button class="domain-error-retry" onclick="runListingSearch()">Retry</button>
    </div>
  `;
  document.getElementById('listingCount').textContent = '0';
}

// Kept for backward compat with any remaining callers
function showDomainError(msg) { showListingError(msg, 'Domain'); }

// Initial load — dispatches based on restored propertyCategory
runListingSearch();

// ─── Address search (Nominatim geocoder) ─────────────────────────────────────

(function () {
  const input      = document.getElementById('addressInput');
  const suggestions= document.getElementById('searchSuggestions');
  const clearBtn   = document.getElementById('searchClear');

  let debounceTimer  = null;
  let focusedIndex   = -1;
  let currentResults = [];
  let searchMarker   = null;

  // ── Nominatim fetch ──
  async function geocode(query) {
    // ArcGIS World Geocoding Service (Esri) — suggest + candidates two-step.
    // Handles full Australian street addresses including house numbers.
    // Free for non-commercial display use; no API key required for suggest.
    const BASE = 'https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer';

    // Step 1: suggest — returns lightweight candidates as user types
    const sugParams = new URLSearchParams({
      text:        query,
      f:           'json',
      maxSuggestions: '8',
      countryCode: 'AUS',
    });

    const sugRes  = await fetch(`${BASE}/suggest?${sugParams}`);
    const sugJson = await sugRes.json();
    const suggestions = (sugJson.suggestions || []).filter(s => !s.isCollection);

    if (suggestions.length === 0) return [];

    // Step 2: findAddressCandidates for each suggestion to get coordinates
    // Batch the top suggestions (limit to 6 to avoid too many requests)
    const top = suggestions.slice(0, 6);
    const candidates = await Promise.all(top.map(async s => {
      const candParams = new URLSearchParams({
        SingleLine:  s.text,
        magicKey:    s.magicKey,
        f:           'json',
        outFields:   'StAddr,Nbrhd,City,Region,Postal',
        outSR:       '4326'
      });
      const r    = await fetch(`${BASE}/findAddressCandidates?${candParams}`);
      const json = await r.json();
      const c    = (json.candidates || [])[0];
      if (!c || c.score < 60) return null;
      const attr = c.attributes;
      // For Australian addresses ArcGIS returns the suburb in Nbrhd; City = metro/LGA.
      const suburb = attr.Nbrhd || attr.Neighborhood || '';
      const lga    = attr.City || '';
      const state  = attr.Region || '';
      return {
        lat:          c.location.y,
        lon:          c.location.x,
        display_name: [attr.StAddr, suburb].filter(Boolean).join(', '),
        _sub:         state,
        _lga:         lga,
        _state:       state,
        _postcode:    attr.Postal || ''
      };
    }));

    return candidates.filter(Boolean);
  }

  // ── Render suggestions ──
  function showSuggestions(items) {
    currentResults = items;
    focusedIndex   = -1;
    suggestions.innerHTML = '';

    if (items.length === 0) {
      const li = document.createElement('li');
      li.className = 'sug-empty';
      li.textContent = 'No results found';
      suggestions.appendChild(li);
    } else {
      items.forEach((item, i) => {
        const main = item.display_name;
        const sub  = item._sub || '';
        const li   = document.createElement('li');
        li.innerHTML = `<div class="sug-main">${main}</div>${sub ? `<div class="sug-sub">${sub}</div>` : ''}`;
        li.addEventListener('mousedown', (e) => {
          e.preventDefault();
          selectResult(item);
        });
        suggestions.appendChild(li);
      });
    }

    suggestions.classList.add('visible');
  }

  function hideSuggestions() {
    suggestions.classList.remove('visible');
    focusedIndex = -1;
  }

  // fetchLotDP is defined at module scope above — accessible here

  // ── Place marker and fly to result ──
  async function selectResult(item) {
    const lat   = parseFloat(item.lat);
    const lng   = parseFloat(item.lon);
    const label = item.display_name;
    const lga   = item._lga || '';

    input.value = label;
    clearBtn.classList.add('visible');
    hideSuggestions();

    if (searchMarker) { map.removeLayer(searchMarker); searchMarker = null; }
    if (parcelLayer)  { map.removeLayer(parcelLayer);  parcelLayer  = null; }
    if (clickMarker)  { map.removeLayer(clickMarker);  clickMarker  = null; }

    _activeListingId = null;
    _pendingAddressMatch = null;
    _suppressNextDomainSearch = true;
    // Fly to the address without zooming *out* of the user's current level
    const addrZoom = Math.max(map.getZoom(), 15);
    map.flyTo([lat, lng], addrZoom, { animate: true, duration: 1.2 });
    await new Promise(resolve => map.once('moveend', resolve));
    const _street = label.split(',')[0].trim();
    const _suburb = label.split(',').slice(1).join(',').trim();
    const nearbyListing = await runDomainSearchAt(lat, lng, _street, _suburb);
    if (nearbyListing) {
      _activeListingId = String(nearbyListing.id);
      document.querySelectorAll('.listing-card').forEach(c => c.classList.remove('active'));
      const matchCard = document.querySelector(`.listing-card[data-id="${_activeListingId}"]`);
      if (matchCard) { matchCard.classList.add('active'); matchCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
    } else {
      _pendingAddressMatch = { street: _street, suburb: _suburb };
    }

    const srlupEntry   = overlayRegistry['nsw-srlup'];
    const zoningEntry  = overlayRegistry['nsw-land-zoning'];
    const floodEntry   = overlayRegistry['nsw-flood'];
    const roadsEntry   = overlayRegistry['nsw-future-roads'];
    selectPropertyAtPoint(
      { lat, lng },
      !!(srlupEntry  && srlupEntry.def.enabled),
      !!(zoningEntry && zoningEntry.def.enabled),
      !!(floodEntry  && floodEntry.def.enabled),
      !!(roadsEntry  && roadsEntry.def.enabled),
      nearbyListing || null
    );
  }

  // ── Keyboard navigation ──
  input.addEventListener('keydown', (e) => {
    const items = suggestions.querySelectorAll('li:not(.sug-empty):not(.sug-loading)');
    if (!suggestions.classList.contains('visible')) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      focusedIndex = Math.min(focusedIndex + 1, items.length - 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      focusedIndex = Math.max(focusedIndex - 1, -1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (focusedIndex >= 0 && currentResults[focusedIndex]) {
        selectResult(currentResults[focusedIndex]);
      } else if (currentResults.length > 0) {
        selectResult(currentResults[0]);
      }
      return;
    } else if (e.key === 'Escape') {
      hideSuggestions();
      input.blur();
      return;
    } else {
      return;
    }

    items.forEach((li, i) => li.classList.toggle('focused', i === focusedIndex));
  });

  // ── Input handler with debounce ──
  input.addEventListener('input', () => {
    const val = input.value.trim();
    clearBtn.classList.toggle('visible', val.length > 0);

    clearTimeout(debounceTimer);

    if (val.length < 2) { hideSuggestions(); return; }

    // Show loading state immediately
    suggestions.innerHTML = '<li class="sug-loading">Searching…</li>';
    suggestions.classList.add('visible');

    debounceTimer = setTimeout(async () => {
      try {
        const results = await geocode(val);
        showSuggestions(results);
      } catch (_) {
        suggestions.innerHTML = '<li class="sug-empty">Search unavailable</li>';
      }
    }, 300);
  });

  // ── Clear button ──
  clearBtn.addEventListener('click', () => {
    input.value = '';
    clearBtn.classList.remove('visible');
    hideSuggestions();
    if (searchMarker) { map.removeLayer(searchMarker); searchMarker = null; }
    if (parcelLayer)  { map.removeLayer(parcelLayer);  parcelLayer  = null; }
    if (clickMarker)  { map.removeLayer(clickMarker);  clickMarker  = null; }
    _activeListingId = null;
    _lastSearchCardData = null;
    document.querySelectorAll('.listing-card').forEach(c => c.classList.remove('active'));
    const src = document.getElementById('search-result-card');
    if (src) src.remove();
    input.focus();
  });

  // ── Close on outside click ──
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#addressSearch')) hideSuggestions();
  });

  input.addEventListener('focus', () => {
    if (input.value.trim().length >= 2 && currentResults.length > 0) {
      suggestions.classList.add('visible');
    }
  });

})();

// ─── Pipeline map pins ────────────────────────────────────────────────────────

// V75.6: fallback stage set — used only if boards haven't loaded or the
// entry predates the board model. The real source of truth is the current
// board's columns with their `show_on_map` flags.
const PIPELINE_PIN_STAGES_FALLBACK = new Set(['shortlisted', 'under-dd', 'offer', 'acquired']);
let _pipelinePinLayer = null;

// Decide whether a pipeline entry's current column should render a star pin.
// Uses window.getPipelineStages() (exposed by kanban.js) which returns the
// CURRENT board's columns[] with their show_on_map flags. Falls back to the
// legacy stage-slug check if no stages are available.
function _shouldRenderPipelinePin(item) {
  const stages = (window.getPipelineStages && window.getPipelineStages()) || [];
  if (!stages.length) {
    return PIPELINE_PIN_STAGES_FALLBACK.has(item.stage);
  }
  // Match by column id first (V75.6 entries have _columnId), then by stage slug
  const col = stages.find(s => s.id === item._columnId)
           || stages.find(s => s.stage_slug === item.stage);
  if (!col) return PIPELINE_PIN_STAGES_FALLBACK.has(item.stage);
  return col.show_on_map !== false;  // default to true if not specified
}

window._renderPipelinePins = function () {
  // Remove existing pipeline pin layer
  if (_pipelinePinLayer) { map.removeLayer(_pipelinePinLayer); _pipelinePinLayer = null; }

  // V78i.1 — Ensure the pipeline-pin pane exists. Custom pane with a
  // z-index above markerPane (600) so gold-star pipeline pins always render
  // AND receive clicks ahead of blue lot pins added later by
  // selectPropertyAtPoint via reSelectParcels. Without this, the blue pins
  // (added to markerPane after the gold star) capture clicks at overlapping
  // coordinates because they're later in the DOM.
  //
  // V78i.2 — Use 650 (not 700). The Leaflet default popupPane sits at 700;
  // putting our pin pane at 700 caused popups to render BEHIND pins. 650
  // keeps pins above all standard markers but below popups.
  if (!map.getPane('pipelinePinPane')) {
    const pane = map.createPane('pipelinePinPane');
    pane.style.zIndex = 650;
    // V80.1 — pointer-events on the PANE must be `none` so the empty space
    // around pin icons (the pane is a full-size <div> covering the map) lets
    // events fall through to the overlay polygons in panes below (e.g. NSW
    // zoning right-click contextmenu). Individual marker icons inside this
    // pane still receive events because their own DOM elements get
    // pointer-events:auto via Leaflet's marker styling.
    pane.style.pointerEvents = 'none';
  }

  const pipelineData = window.getPipelineData ? window.getPipelineData() : null;
  console.log('[pipeline pins] pipelineData:', pipelineData);
  if (!pipelineData) return;

  const stages = window.getPipelineStages ? window.getPipelineStages() : [];
  const stageLabel = {};
  stages.forEach(s => { stageLabel[s.id] = s.label; });

  const markers = [];

  Object.entries(pipelineData).forEach(([id, item]) => {
    if (!item?.property) return;
    // V75.6: per-column map visibility
    if (!_shouldRenderPipelinePin(item)) return;

    const p = item.property;
    const isParcel = !!item._isParcel;

    // V75.4d: one star pin per deal. For parcels, use the centroid (p.lat/p.lng
    // — dealRowToInternal computes this as the average of children). Clicking
    // the pin will highlight ALL constituent polygons (see click handler below).
    let pinLat = null, pinLng = null;
    if (isParcel) {
      pinLat = (typeof p.lat === 'number') ? p.lat : null;
      pinLng = (typeof p.lng === 'number') ? p.lng : null;
    } else {
      const firstParcel = (p._parcels && p._parcels.length > 0) ? p._parcels[0] : null;
      pinLat = firstParcel?.lat ?? null;
      pinLng = firstParcel?.lng ?? null;
    }
    if (pinLat == null || pinLng == null) return;

    // V75.1 — hide pin if property is flagged not-suitable (unless toggle is on)
    if (!_activeFilters.showSnoozed) {
      if (isNotSuitable({ id: p.domain_id, lat: pinLat, lng: pinLng })) return;
    }

    const address = p.address || '';
    const suburb  = p.suburb  || '';
    const stage   = stageLabel[item.stage] || item.stage;

    // Same gold teardrop as standard listing pins, with a star to indicate pipeline property
    const pinHtml = `<div style="width:28px;height:28px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);background:${MARKER_COLOR};border:2px solid rgba(255,255,255,0.8);box-shadow:0 2px 8px rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;color:#fff;font-size:12px"><span style="transform:rotate(45deg);line-height:1">★</span></div>`;

    const icon = L.divIcon({
      html:      pinHtml,
      iconSize:  [28, 28],
      iconAnchor:[14, 28],
      className: 'pipeline-map-pin',
    });

    const marker = L.marker([pinLat, pinLng], { icon, zIndexOffset: 1500, pane: 'pipelinePinPane' });

    marker.on('click', async () => {
      const srlupEntry  = overlayRegistry['nsw-srlup'];
      const zoningEntry = overlayRegistry['nsw-land-zoning'];
      const floodEntry  = overlayRegistry['nsw-flood'];
      const roadsEntry  = overlayRegistry['nsw-future-roads'];
      const includeSrlup  = !!(srlupEntry  && srlupEntry.def.enabled);
      const includeZoning = !!(zoningEntry && zoningEntry.def.enabled);
      const includeFlood  = !!(floodEntry  && floodEntry.def.enabled);
      const includeRoads  = !!(roadsEntry  && roadsEntry.def.enabled);

      // ── SINGLE PROPERTY ────────────────────────────────────────────────
      // Unchanged: existing single-point selection flow.
      if (!isParcel || !Array.isArray(p._parcels) || !p._parcels.length) {
        selectPropertyAtPoint(
          { lat: pinLat, lng: pinLng },
          includeSrlup, includeZoning, includeFlood, includeRoads, null
        );
        return;
      }

      // ── PARCEL ─────────────────────────────────────────────────────────
      // V78h.5 — Parcel popup uses the SAME buildPopupInner function as
      // single-property popups, with aggregated inputs across all child
      // lots. Outlines + numbered blue pins are drawn by the existing
      // reSelectParcels flow (same as the deal modal's address click).
      //
      // Open a placeholder popup immediately so the agent sees feedback
      // while the per-lot overlay queries are in flight.
      marker.unbindPopup();
      marker.bindPopup(
        `<div style="${popupStyle}"><span style="color:#888;font-size:12px">Loading parcel details…</span></div>`,
        { minWidth: 210, autoPan: true }
      ).openPopup();

      // Run reSelectParcels to render outlines + numbered blue pins. Same
      // function the deal modal uses — don't reinvent it.
      // V78i.5 — Pass suppressPopups so the per-lot selectPropertyAtPoint
      // calls don't auto-open popups. (Previously we set the flag here
      // before calling reSelectParcels, but reSelectParcels' first action
      // is clearParcelSelection which wiped the flag — so blue-pin popups
      // opened anyway and won the race against our combined popup. Setting
      // the option here means reSelectParcels sets the flag AFTER its clear.)
      if (typeof window.reSelectParcels === 'function') {
        window.reSelectParcels(p._parcels, { suppressPopups: true });
      }

      // Fetch overlay + cadastre data per child lot in parallel.
      // V78h.6 — Also pull cadastre per lot so we can sum the measured polygon
      // areas authoritatively (p._areaSqm from the DB can be stale or
      // missing some lots). The cadastre area is what the user trusts.
      const perLotResults = await Promise.all(
        p._parcels.map(par => _fetchOverlaysForPoint(
          par.lat, par.lng, includeSrlup, includeZoning, includeFlood, includeRoads, map
        ))
      );

      // Aggregate cross-lot values:
      //   - lga:       union of distinct LGA names (usually one)
      //   - zoneCode:  unique SYM_CODE values joined " · "
      //   - overlay blocks: union from all lots
      //   - area: sum of cadastre-measured polygon areas across lots
      const lgas      = new Set();
      const zoneCodes = new Set();
      let cadastreAreaSum = 0;
      for (const r of perLotResults) {
        if (r.lga) lgas.add(r.lga);
        if (r.zoneCode) zoneCodes.add(r.zoneCode);
        if (typeof r.cadastreArea === 'number' && r.cadastreArea > 0) {
          cadastreAreaSum += r.cadastreArea;
        }
      }
      const aggLga       = [...lgas].join(' · ');
      const aggZoneCode  = [...zoneCodes].join(' · ') || null;
      const aggOverlay   = _aggregateOverlayBlocks(perLotResults,
        includeSrlup, includeZoning, includeFlood, includeRoads);

      // V78h.7 — p.address for parcels is the aggregated title produced by
      // formatParcelTitle, which already includes the suburb. Don't append
      // p.suburb again or we double it ("Catherine Field, Catherine Field").
      const aggLabel  = p.address || '';
      const aggLotDP  = p._lotDPs || 'Not found';
      const aggArea   = cadastreAreaSum > 0
        ? cadastreAreaSum
        : ((typeof p._areaSqm === 'number' && p._areaSqm > 0) ? p._areaSqm : null);

      // Build with the SAME buildPopupInner function used for single-property
      // popups. Same fields, same UI style. The only difference for parcels
      // is that the overlay block area is height-constrained with scroll.
      // V78i.5 — Pass the pipeline entry key (id from the forEach) as the
      // pipelineIdOverride so buildPopupInner shows "★ Open in Pipeline"
      // instead of "+ Pipeline". (item.id is undefined — deal records from
      // dealRowToInternal don't have a top-level .id; the deal id is the
      // dict key.)
      const inner = buildPopupInner(aggLabel, aggLga, aggLotDP, aggArea, aggZoneCode, aggOverlay, null, id);
      const popupHtml = `<div style="${popupStyle}">${_wrapPopupForParcel(inner)}</div>`;
      marker.getPopup().setContent(popupHtml);
      // V78i.3 — Force our combined popup on top. selectPropertyAtPoint
      // popups from reSelectParcels (called above) are suppressed via the
      // _suppressBluePinPopups flag we set just before reSelectParcels —
      // see below.
      marker.openPopup();
      // V84 — resolve the Property button for the aggregate parcel popup.
      _resolvePopupPropertyBtn({
        id:      null,
        address: String(aggLabel || '').split(',')[0].trim(),
        _lotDPs: (aggLotDP && aggLotDP !== 'Not found') ? aggLotDP : '',
      });
    });

    markers.push(marker);
  });

  if (markers.length) {
    _pipelinePinLayer = L.layerGroup(markers).addTo(map);
  }
};

// V78h.5 — Per-point overlay fetcher used by parcel pipeline-pin click.
// Mirrors the slowFetches block in selectPropertyAtPoint, but extracted so
// it can be called per child lot in parallel from the parcel handler.
// Returns { lga, zoneCode, srlupJson, zoningJson, floodJson, roadsJson }.
async function _fetchOverlaysForPoint(lat, lng, includeSrlup, includeZoning, includeFlood, includeRoads, mapRef) {
  const fetches = [];

  // V78h.6 — Always fetch the cadastre per lot so we can sum measured areas
  // for the aggregated popup. Authoritative source (the same polygon area
  // shown for single-property popups), avoids relying on potentially stale
  // p._areaSqm from the DB.
  fetches.push(fetchLotDP(lat, lng).catch(() => null));

  if (includeSrlup) {
    const size = mapRef.getSize();
    const b    = mapRef.getBounds();
    const params = new URLSearchParams({
      f: 'json',
      geometry: `${lng},${lat}`,
      geometryType: 'esriGeometryPoint',
      sr: '4326',
      layers: 'all:1',
      tolerance: '6',
      mapExtent: `${b.getWest()},${b.getSouth()},${b.getEast()},${b.getNorth()}`,
      imageDisplay: `${size.x},${size.y},96`,
      returnGeometry: 'false',
    });
    fetches.push(fetch(`${SRLUP_BASE}/identify?${params}`).then(r => r.json()).catch(() => null));
  } else {
    fetches.push(Promise.resolve(null));
  }

  // Always fetch zoning so zone code appears even when overlay is off
  {
    const zp = new URLSearchParams({
      f: 'json',
      geometry: `${lng},${lat}`,
      geometryType: 'esriGeometryPoint',
      inSR: '4326',
      spatialRel: 'esriSpatialRelIntersects',
      outFields: 'SYM_CODE,LAY_CLASS,EPI_NAME,LGA_NAME,PURPOSE',
      returnGeometry: 'false',
      resultRecordCount: '1',
    });
    fetches.push(fetch(`${ZONING_BASE}/2/query?${zp}`).then(r => r.json()).catch(() => null));
  }

  if (includeFlood) {
    const fp = new URLSearchParams({
      f: 'json',
      geometry: `${lng},${lat}`,
      geometryType: 'esriGeometryPoint',
      inSR: '4326',
      spatialRel: 'esriSpatialRelIntersects',
      outFields: 'LAY_CLASS,EPI_NAME,SYM_CODE',
      returnGeometry: 'false',
      resultRecordCount: '1',
    });
    fetches.push(fetch(`${FLOOD_BASE}/1/query?${fp}`).then(r => r.json()).catch(() => null));
  } else {
    fetches.push(Promise.resolve(null));
  }

  if (includeRoads) {
    const rp = new URLSearchParams({
      f: 'json',
      geometry: `${lng},${lat}`,
      geometryType: 'esriGeometryPoint',
      inSR: '4326',
      spatialRel: 'esriSpatialRelIntersects',
      outFields: '*',
      returnGeometry: 'false',
      resultRecordCount: '1',
    });
    fetches.push(fetch(`${ROADS_BASE}/10/query?${rp}`).then(r => r.json()).catch(() => null));
  } else {
    fetches.push(Promise.resolve(null));
  }

  const [cadastre, srlupJson, zoningJson, floodJson, roadsJson] = await Promise.all(fetches);

  // Extract LGA + zone code from zoning result for header use
  const zFeat = zoningJson && ((zoningJson.features || [])[0] || (zoningJson.results || [])[0]);
  const zAttrs = zFeat ? (zFeat.attributes || zFeat) : null;
  const lga = zAttrs && zAttrs.LGA_NAME ? zAttrs.LGA_NAME : '';
  const zoneCode = zAttrs && zAttrs.SYM_CODE ? zAttrs.SYM_CODE : null;

  // V78h.6 — cadastre.areaSqm is the measured polygon area in m²
  const cadastreArea = (cadastre && typeof cadastre.areaSqm === 'number') ? cadastre.areaSqm : null;

  return { lga, zoneCode, cadastreArea, srlupJson, zoningJson, floodJson, roadsJson };
}

// V78h.5 — Aggregate the four overlay blocks across child lots. Output is a
// single HTML string in the same shape selectPropertyAtPoint builds for a
// single point — exactly what buildPopupInner expects as overlayBlock.
//
// Aggregation rules (locked with user):
//   - SRLUP: dedupe attribute key/value rows across all lots producing a hit
//   - Zoning: unique SYM_CODE / LAY_CLASS / EPI_NAME joined with " · "
//   - Flood: unique LAY_CLASS / EPI_NAME joined; "No affectation" if all empty
//   - Roads: union of all reservation rows from all lots
function _aggregateOverlayBlocks(perLotResults, includeSrlup, includeZoning, includeFlood, includeRoads) {
  const SKIP = ['OBJECTID','Shape','Shape_Area','Shape_Length','FID'];
  let out = '';

  // SRLUP
  if (includeSrlup) {
    const seen = new Map(); // key -> Set of distinct values
    for (const r of perLotResults) {
      const results = r.srlupJson && Array.isArray(r.srlupJson.results) ? r.srlupJson.results : [];
      for (const res of results) {
        const attrs = res.attributes || {};
        for (const [k, v] of Object.entries(attrs)) {
          if (SKIP.includes(k) || v === null || v === '') continue;
          if (!seen.has(k)) seen.set(k, new Set());
          seen.get(k).add(v);
        }
      }
    }
    if (seen.size) {
      const rows = [...seen.entries()].map(([k, vs]) => `
        <tr>
          <td style="color:#666;padding:3px 8px 3px 0;font-size:11px;white-space:nowrap">${k.replace(/_/g,' ')}</td>
          <td style="font-size:12px;padding:3px 0">${[...vs].join(' · ')}</td>
        </tr>`).join('');
      out += `
        <div style="border-top:2px solid #e67e22;margin-top:8px;padding-top:6px">
          <div style="font-size:10px;font-weight:600;letter-spacing:0.07em;text-transform:uppercase;color:#e67e22;margin-bottom:4px">NSW Planning Zone</div>
          <table style="border-collapse:collapse;width:100%;font-family:'DM Sans',sans-serif">${rows}</table>
        </div>`;
    }
  }

  // Zoning (only when the overlay is enabled — same rule as the single-property flow)
  if (includeZoning) {
    const zones = new Set();
    const purposes = new Set();
    const epis = new Set();
    for (const r of perLotResults) {
      const f = r.zoningJson && ((r.zoningJson.features || [])[0] || (r.zoningJson.results || [])[0]);
      if (!f) continue;
      const a = f.attributes || f;
      if (a.SYM_CODE) zones.add(a.SYM_CODE);
      const purpose = a.LAY_CLASS || a.PURPOSE;
      if (purpose) purposes.add(purpose);
      if (a.EPI_NAME) epis.add(a.EPI_NAME);
    }
    if (zones.size || purposes.size || epis.size) {
      out += `
        <div style="border-top:2px solid #8B0000;margin-top:8px;padding-top:6px">
          <div style="font-size:10px;font-weight:600;letter-spacing:0.07em;text-transform:uppercase;color:#8B0000;margin-bottom:4px">Land Zoning (LEP)</div>
          <table style="border-collapse:collapse;width:100%;font-family:'DM Sans',sans-serif">
            ${zones.size    ? '<tr><td style="color:#666;padding:3px 8px 3px 0;font-size:11px;white-space:nowrap">Zone</td><td style="font-size:12px;padding:3px 0;font-weight:600">' + [...zones].join(' · ') + '</td></tr>'    : ''}
            ${purposes.size ? '<tr><td style="color:#666;padding:3px 8px 3px 0;font-size:11px;white-space:nowrap">Land Use</td><td style="font-size:12px;padding:3px 0">' + [...purposes].join(' · ') + '</td></tr>' : ''}
            ${epis.size     ? '<tr><td style="color:#666;padding:3px 8px 3px 0;font-size:11px;white-space:nowrap">LEP</td><td style="font-size:12px;padding:3px 0">' + [...epis].join(' · ') + '</td></tr>'         : ''}
          </table>
        </div>`;
    }
  }

  // Flood
  if (includeFlood) {
    const classes = new Set();
    const epis = new Set();
    let anyQueried = false;
    for (const r of perLotResults) {
      if (r.floodJson) anyQueried = true;
      const f = r.floodJson && ((r.floodJson.features || [])[0]);
      if (!f) continue;
      const a = f.attributes || {};
      if (a.LAY_CLASS) classes.add(a.LAY_CLASS);
      if (a.EPI_NAME)  epis.add(a.EPI_NAME);
    }
    if (classes.size || epis.size) {
      out += `
        <div style="border-top:2px solid #2471a3;margin-top:8px;padding-top:6px">
          <div style="font-size:10px;font-weight:600;letter-spacing:0.07em;text-transform:uppercase;color:#2471a3;margin-bottom:4px">Flood Planning (EPI)</div>
          <table style="border-collapse:collapse;width:100%;font-family:'DM Sans',sans-serif">
            ${classes.size ? '<tr><td style="color:#666;padding:3px 8px 3px 0;font-size:11px;white-space:nowrap">Classification</td><td style="font-size:12px;padding:3px 0;font-weight:600">' + [...classes].join(' · ') + '</td></tr>' : ''}
            ${epis.size    ? '<tr><td style="color:#666;padding:3px 8px 3px 0;font-size:11px;white-space:nowrap">LEP</td><td style="font-size:12px;padding:3px 0">' + [...epis].join(' · ') + '</td></tr>'         : ''}
          </table>
        </div>`;
    } else if (anyQueried) {
      out += `
        <div style="border-top:2px solid #2471a3;margin-top:8px;padding-top:6px">
          <div style="font-size:10px;font-weight:600;letter-spacing:0.07em;text-transform:uppercase;color:#2471a3;margin-bottom:4px">Flood Planning (EPI)</div>
          <div style="font-size:12px;color:#666">No flood planning affectation</div>
        </div>`;
    }
  }

  // Future roads — union rows across lots, deduped by key
  if (includeRoads) {
    const seen = new Map();
    let anyQueried = false;
    for (const r of perLotResults) {
      if (r.roadsJson) anyQueried = true;
      const f = r.roadsJson && ((r.roadsJson.features || [])[0]);
      if (!f) continue;
      const attrs = f.attributes || {};
      for (const [k, v] of Object.entries(attrs)) {
        if (SKIP.includes(k) || v === null || v === '' || v === ' ') continue;
        if (!seen.has(k)) seen.set(k, new Set());
        seen.get(k).add(v);
      }
    }
    if (seen.size) {
      const rows = [...seen.entries()].map(([k, vs]) => `
        <tr>
          <td style="color:#666;padding:3px 8px 3px 0;font-size:11px;white-space:nowrap">${k.replace(/_/g,' ')}</td>
          <td style="font-size:12px;padding:3px 0">${[...vs].join(' · ')}</td>
        </tr>`).join('');
      out += `
        <div style="border-top:2px solid #922b21;margin-top:8px;padding-top:6px">
          <div style="font-size:10px;font-weight:600;letter-spacing:0.07em;text-transform:uppercase;color:#922b21;margin-bottom:4px">⚠ Future Road Reservation</div>
          <table style="border-collapse:collapse;width:100%;font-family:'DM Sans',sans-serif">${rows}</table>
        </div>`;
    } else if (anyQueried) {
      out += `
        <div style="border-top:2px solid #922b21;margin-top:8px;padding-top:6px">
          <div style="font-size:10px;font-weight:600;letter-spacing:0.07em;text-transform:uppercase;color:#922b21;margin-bottom:4px">Future Road Reservations</div>
          <div style="font-size:12px;color:#666">No road reservation on this parcel</div>
        </div>`;
    }
  }

  return out;
}

// V78h.5 — Constrain parcel popup to ~10 lines of content. Single-property
// popups already fit in 8 lines naturally; this adds a max-height container
// with internal scroll so a parcel popup can't blow up the screen. The
// content from buildPopupInner is inserted as-is — we only wrap the outer
// container with a max-height + overflow:auto.
function _wrapPopupForParcel(innerHtml) {
  // 10 lines * ~22px per line ≈ 220px. Inner already has its own padding/
  // line-height; just clip to height and let it scroll.
  return `<div style="max-height:220px;overflow-y:auto;overflow-x:hidden">${innerHtml}</div>`;
}

// V75.4d: multi-polygon outline for parcel pipeline pins. Draws green
// outlines around every constituent property's polygon that has rings
// stored. Children without rings get a pulsing centroid dot as a fallback.
// The layer is cleared and redrawn on each call.
function _highlightParcelChildren(parcelsArr, item) {
  if (_parcelHighlightLayer) {
    map.removeLayer(_parcelHighlightLayer);
    _parcelHighlightLayer = null;
  }
  // Also clear single-parcel outline so we don't have stacked strokes
  if (parcelLayer) { map.removeLayer(parcelLayer); parcelLayer = null; }
  if (clickMarker) { map.removeLayer(clickMarker); clickMarker = null; clickMarkerData = null; }

  const layers = [];
  const bounds = L.latLngBounds([]);

  for (const par of parcelsArr) {
    if (!par) continue;

    if (Array.isArray(par.rings) && par.rings.length) {
      // Leaflet expects [lat, lng] per vertex; source is [lng, lat]
      const leafletRings = par.rings.map(ring =>
        ring.map(([lng, lat]) => [lat, lng])
      );
      const poly = L.polygon(leafletRings, {
        color:       '#1a6b3a',
        weight:      2.5,
        opacity:     1,
        fillColor:   '#1a6b3a',
        fillOpacity: 0.08,
        dashArray:   null,
        interactive: false,
      });
      layers.push(poly);
      leafletRings.forEach(r => r.forEach(([lat, lng]) => bounds.extend([lat, lng])));
    } else if (typeof par.lat === 'number' && typeof par.lng === 'number') {
      // Fallback: small green dot at the centroid (for children without rings)
      const dot = L.circleMarker([par.lat, par.lng], {
        radius:      8,
        color:       '#1a6b3a',
        weight:      2,
        fillColor:   '#1a6b3a',
        fillOpacity: 0.3,
        interactive: false,
      });
      layers.push(dot);
      bounds.extend([par.lat, par.lng]);
    }
  }

  if (!layers.length) return;
  _parcelHighlightLayer = L.layerGroup(layers).addTo(map);
  if (bounds.isValid()) map.fitBounds(bounds, { padding: [50, 50], maxZoom: 18 });
}

// ─── Public API for kanban ────────────────────────────────────────────────────
// Called by kanban.js when the address link is clicked for a multi-parcel entry.
window.matchListingByAddress = matchListingByAddress;
window.runDomainSearchAt = runDomainSearchAt;
window.getListings = () => listings;
window.fetchLotDP = fetchLotDP;

window.reSelectParcels = function(parcels, opts) {
  if (!parcels || parcels.length === 0) return;
  clearParcelSelection();
  // V78i.5 — Set the popup-suppression flag AFTER clearParcelSelection, not
  // before. clearParcelSelection resets the flag to false, so any flag set
  // by the caller before invoking reSelectParcels gets wiped out and the
  // blue lot pins open their popups anyway (winning the race against the
  // gold-pin's combined popup). Setting it here, post-clear, means the
  // suppression actually reaches the selectPropertyAtPoint calls below.
  if (opts && opts.suppressPopups) {
    window._suppressBluePinPopups = true;
  }

  const srlupEntry  = overlayRegistry['nsw-srlup'];
  const zoningEntry = overlayRegistry['nsw-land-zoning'];
  const floodEntry  = overlayRegistry['nsw-flood'];
  const roadsEntry  = overlayRegistry['nsw-future-roads'];

  const avgLat = parcels.reduce((s, p) => s + p.lat, 0) / parcels.length;
  const avgLng = parcels.reduce((s, p) => s + p.lng, 0) / parcels.length;
  // Keep current zoom when possible; only zoom in if needed for parcel context
  _focusMapOn(avgLat, avgLng, { minZoom: 15 });

  if (parcels.length === 1) {
    // Single parcel — plain select (green pin, normal popup)
    selectPropertyAtPoint(
      { lat: parcels[0].lat, lng: parcels[0].lng },
      !!(srlupEntry  && srlupEntry.def.enabled),
      !!(zoningEntry && zoningEntry.def.enabled),
      !!(floodEntry  && floodEntry.def.enabled),
      !!(roadsEntry  && roadsEntry.def.enabled),
      null,
      false
    );
  } else {
    // Multi-parcel — addToSelection for all (numbered blue pins)
    parcels.forEach(p => {
      selectPropertyAtPoint(
        { lat: p.lat, lng: p.lng },
        !!(srlupEntry  && srlupEntry.def.enabled),
        !!(zoningEntry && zoningEntry.def.enabled),
        !!(floodEntry  && floodEntry.def.enabled),
        !!(roadsEntry  && roadsEntry.def.enabled),
        null,
        true
      );
    });
  }
};
(function () {
  const legend = document.getElementById('legendPanel');
  const toggle = document.getElementById('legendToggle');
  if (!legend || !toggle) return;

  // Always start collapsed
  legend.classList.add('collapsed');

  toggle.addEventListener('click', () => {
    legend.classList.toggle('collapsed');
  });
})();

// ─── Measurement Tool ─────────────────────────────────────────────────────────
// V78h — Unified Measure (replaces separate Distance / Area items).
// While active: each click adds a vertex; double-click closes the current
// shape. A shape with ≥3 points becomes a polygon (counted toward the running
// total area). A shape with 2 points stays as a distance-only line. After
// closing one, the tool stays active so the agent can draw another shape —
// click "📐 Measure" in the tools menu again (or press Escape) to stop,
// which leaves all results visible on the map until Clear.

(function () {
  let measureActive = false;
  // In-progress shape state
  let points        = [];
  let polyline      = null;            // working polyline (during draw)
  let liveSegLabels = [];               // segment labels for the in-progress shape,
                                        // shown immediately after each click
  let tooltip       = null;             // running-total tooltip at cursor

  // Completed shapes — kept on the map until Clear. Each entry:
  //   { kind: 'polygon'|'line', layers: [...], areaM2: number, vertices: [latlng] }
  let completed     = [];

  // ── Wire up tools dropdown item directly ──
  (function wireToolsMenu() {
    const menu = document.getElementById('toolsDropdownMenu');
    if (!menu) return;
    const measureItem = document.getElementById('measureBtn');
    if (!measureItem) return;

    // Single unified Measure button replaces the separate Distance/Area items.
    const measureBtn = document.createElement('button');
    measureBtn.className = 'tools-dropdown-item';
    measureBtn.id = 'measureToolBtn';
    measureBtn.innerHTML = '📐 Measure';

    const clearBtn = document.createElement('button');
    clearBtn.className = 'tools-dropdown-item';
    clearBtn.id = 'measureClearBtn';
    clearBtn.style.color = '#c0392b';
    clearBtn.innerHTML = '✕ Clear Measurement';
    clearBtn.style.display = 'none';

    measureItem.replaceWith(measureBtn);
    measureBtn.insertAdjacentElement('afterend', clearBtn);

    measureBtn.addEventListener('click', () => {
      menu.classList.remove('open');
      // Toggle: clicking while active stops the tool (keeps results on map).
      if (measureActive) stopMeasure();
      else startMeasure();
    });
    clearBtn.addEventListener('click', () => {
      menu.classList.remove('open');
      clearMeasure();
    });

    // Show/hide clear button based on whether anything is on the map
    window._updateMeasureClearBtn = function(visible) {
      clearBtn.style.display = visible ? '' : 'none';
    };
  })();

  // ── Haversine distance between two latlngs (metres) ──
  function haversine(a, b) {
    const R  = 6371000;
    const φ1 = a.lat * Math.PI / 180;
    const φ2 = b.lat * Math.PI / 180;
    const dφ = (b.lat - a.lat) * Math.PI / 180;
    const dλ = (b.lng - a.lng) * Math.PI / 180;
    const s  = Math.sin(dφ/2) * Math.sin(dφ/2) +
               Math.cos(φ1) * Math.cos(φ2) *
               Math.sin(dλ/2) * Math.sin(dλ/2);
    return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
  }

  // ── Shoelace area (m²) — equirectangular projection around centroid ──
  // V75.5.3: previous version multiplied each vertex's lng by a per-edge
  // mPerLng, which is not a valid planar projection — the shoelace
  // cross-terms don't cancel correctly. Projecting all vertices into a
  // single flat metre plane (anchored at the polygon's own centroid) gives
  // accurate results to well under 0.1% for property-scale polygons at
  // Sydney latitudes.
  function polygonArea(pts) {
    const n = pts.length;
    if (n < 3) return 0;
    let sumLat = 0, sumLng = 0;
    for (const p of pts) { sumLat += p.lat; sumLng += p.lng; }
    const cLat = sumLat / n;
    const cLng = sumLng / n;
    const mPerLat = 111320;
    const mPerLng = Math.cos(cLat * Math.PI / 180) * 111320;
    const xy = pts.map(p => ({
      x: (p.lng - cLng) * mPerLng,
      y: (p.lat - cLat) * mPerLat,
    }));
    let area = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      area += xy[i].x * xy[j].y;
      area -= xy[j].x * xy[i].y;
    }
    return Math.abs(area / 2);
  }

  function formatDist(m) {
    return m >= 1000 ? (m / 1000).toFixed(2) + ' km' : Math.round(m) + ' m';
  }

  function formatArea(m2) {
    // V75.5.5: always m² with acres in brackets.
    // 1 acre = 4046.8564224 m²
    const acres = m2 / 4046.8564224;
    const acreStr = acres >= 10
      ? acres.toFixed(1) + ' ac'
      : acres.toFixed(2) + ' ac';
    return Math.round(m2).toLocaleString() + ' m² (' + acreStr + ')';
  }

  // Running total area across completed polygons.
  function totalAreaM2() {
    return completed.reduce((sum, c) => sum + (c.areaM2 || 0), 0);
  }
  function polygonCount() {
    return completed.filter(c => c.kind === 'polygon').length;
  }

  // Build the cursor tooltip content for the live shape.
  // When ≥3 points and we have completed polygons too, show "this shape /
  // running total" so the agent sees both. When ≥3 points and no completed
  // polygons yet, just show this shape's area. When <3 points, show
  // running distance of the line so far (single distance measurement).
  function liveTooltipContent(allPts) {
    if (allPts.length < 2) {
      return polygonCount() > 0
        ? 'Total: ' + formatArea(totalAreaM2()) + ' · ' + polygonCount() + ' area' + (polygonCount() === 1 ? '' : 's')
        : 'Click to start measuring';
    }
    if (allPts.length === 2) {
      // Single segment — distance measurement
      const d = haversine(allPts[0], allPts[1]);
      const base = formatDist(d);
      return polygonCount() > 0
        ? base + ' · Total area: ' + formatArea(totalAreaM2())
        : base + ' · double-click to finish';
    }
    // 3+ points — area mode
    const a = polygonArea(allPts);
    const thisShape = 'This: ' + formatArea(a);
    if (polygonCount() > 0) {
      const grand = totalAreaM2() + a;
      return thisShape + ' · Total: ' + formatArea(grand) + ' · ' + (polygonCount() + 1) + ' areas';
    }
    return thisShape + ' · double-click to finish';
  }

  function startMeasure() {
    // V78h — preserves any existing completed shapes (unlike Clear). Just
    // re-enters draw mode so the agent can add more polygons after stopping.
    measureActive = true;
    window._measureActive = true;
    map.getContainer().style.cursor = 'crosshair';
    if (window._updateMeasureClearBtn) window._updateMeasureClearBtn(true);

    tooltip = L.tooltip({ permanent: true, direction: 'top', className: 'measure-tooltip' })
      .setContent(liveTooltipContent([]))
      .setLatLng(map.getCenter())
      .addTo(map);

    map.on('mousemove', onMouseMove);
    map.on('click',     onMapClick);
    map.on('dblclick',  onDblClick);
    // V78h — Escape stops the tool (keeps results).
    document.addEventListener('keydown', onKeyDown);
  }

  function onKeyDown(e) {
    if (e.key === 'Escape' && measureActive) stopMeasure();
  }

  function onMouseMove(e) {
    if (!measureActive) return;
    const allPts = points.length ? [...points, e.latlng] : [];
    if (points.length >= 1 && polyline) polyline.setLatLngs(allPts);
    tooltip.setLatLng(e.latlng).setContent(liveTooltipContent(allPts));
  }

  function onMapClick(e) {
    if (!measureActive) return;
    L.DomEvent.stopPropagation(e);

    points.push(e.latlng);

    // Small vertex marker for the in-progress shape — these don't get cleared
    // when the shape is closed (they're absorbed into the completed shape's
    // layers), so we push them straight into a per-shape staging array.
    const dot = L.circleMarker(e.latlng, {
      radius: 4, color: '#e74c3c', fillColor: '#e74c3c',
      fillOpacity: 1, weight: 2, interactive: false,
    }).addTo(map);
    stagingLayers.push(dot);

    if (points.length === 1) {
      polyline = L.polyline([e.latlng], {
        color: '#e74c3c', weight: 2.5, dashArray: '6,4', interactive: false,
      }).addTo(map);
      stagingLayers.push(polyline);
    } else {
      // V78h — Add a segment-length label immediately when the segment is
      // committed (between the previous point and this one). Previously these
      // only appeared after the polygon closed; surfacing them on each click
      // gives the agent live segment lengths as they trace.
      const a = points[points.length - 2];
      const b = points[points.length - 1];
      const midLat = (a.lat + b.lat) / 2;
      const midLng = (a.lng + b.lng) / 2;
      const dist = haversine(a, b);
      const lbl = L.tooltip({
        permanent: true, direction: 'center',
        className: 'measure-tooltip measure-seg-label',
        interactive: false,
      })
        .setContent(formatDist(dist))
        .setLatLng([midLat, midLng])
        .addTo(map);
      liveSegLabels.push(lbl);
      stagingLayers.push(lbl);
    }
  }

  // Staging — layers belonging to the current in-progress shape. On
  // dblclick (or stop) these get absorbed into the completed[] entry.
  let stagingLayers = [];

  function onDblClick(e) {
    if (!measureActive || points.length < 2) return;
    L.DomEvent.stopPropagation(e);
    L.DomEvent.preventDefault(e);

    // Remove the duplicate point added by the click that fires before
    // dblclick. Also remove the staging marker + segment label that came
    // with that click (always the last two pushed: marker, then segment
    // label — except the very first point has no segment label).
    points.pop();
    // The last layer pushed for that click was either a segment label
    // (if there had already been a point) or a marker (for first point,
    // but dblclick guards points.length < 2 so we always have a label here).
    const lastLayer = stagingLayers.pop();
    if (lastLayer) map.removeLayer(lastLayer);
    const lblIdx = liveSegLabels.indexOf(lastLayer);
    if (lblIdx >= 0) liveSegLabels.splice(lblIdx, 1);
    // And the marker for that aborted click
    const markerLayer = stagingLayers.pop();
    if (markerLayer) map.removeLayer(markerLayer);

    if (points.length >= 3) {
      // Close into a polygon: remove the open polyline, add the filled poly.
      if (polyline) {
        map.removeLayer(polyline);
        const plIdx = stagingLayers.indexOf(polyline);
        if (plIdx >= 0) stagingLayers.splice(plIdx, 1);
        polyline = null;
      }
      const poly = L.polygon(points, {
        color: '#e74c3c', weight: 2, fillColor: '#e74c3c',
        fillOpacity: 0.15, interactive: false,
      }).addTo(map);
      stagingLayers.push(poly);

      // Add the closing-edge segment label (last point back to first).
      const a = points[points.length - 1];
      const b = points[0];
      const midLat = (a.lat + b.lat) / 2;
      const midLng = (a.lng + b.lng) / 2;
      const dist = haversine(a, b);
      const lbl = L.tooltip({
        permanent: true, direction: 'center',
        className: 'measure-tooltip measure-seg-label',
        interactive: false,
      })
        .setContent(formatDist(dist))
        .setLatLng([midLat, midLng])
        .addTo(map);
      liveSegLabels.push(lbl);
      stagingLayers.push(lbl);

      const areaM2 = polygonArea(points);

      // V78h.1 — Per-polygon area label at the polygon's centroid. Visible
      // for the lifetime of this shape (until Clear). Distinct class so we
      // can style larger / bolder than segment labels.
      const polyBounds = poly.getBounds();
      const center = polyBounds.getCenter();
      const areaLbl = L.tooltip({
        permanent: true, direction: 'center',
        className: 'measure-tooltip measure-area-label',
        interactive: false,
      })
        .setContent(formatArea(areaM2))
        .setLatLng(center)
        .addTo(map);
      stagingLayers.push(areaLbl);

      completed.push({
        kind:    'polygon',
        layers:  stagingLayers.slice(),
        areaM2,
        vertices: points.slice(),
      });
    } else {
      // 2-point case = distance-only line. Keep it as-is.
      if (polyline) polyline.setLatLngs(points);
      completed.push({
        kind:    'line',
        layers:  stagingLayers.slice(),
        areaM2:  0,
        vertices: points.slice(),
      });
    }

    // Reset in-progress state for the next shape (tool stays active).
    points        = [];
    polyline      = null;
    liveSegLabels = [];
    stagingLayers = [];

    // Update tooltip to reflect the new running total at the dblclick spot.
    tooltip.setLatLng(e.latlng).setContent(liveTooltipContent([]));
  }

  // V78h — stop draw mode but keep all completed shapes on the map.
  function stopMeasure() {
    map.off('mousemove', onMouseMove);
    map.off('click',     onMapClick);
    map.off('dblclick',  onDblClick);
    document.removeEventListener('keydown', onKeyDown);
    map.getContainer().style.cursor = '';

    // Abort any in-progress shape — discard its staging layers.
    stagingLayers.forEach(l => { try { map.removeLayer(l); } catch (_) {} });
    stagingLayers = [];
    points = [];
    polyline = null;
    liveSegLabels = [];

    if (tooltip) {
      // Replace the moving cursor tooltip with a parked one near map centre
      // showing the final total, so the result stays visible after the tool
      // is dismissed.
      if (completed.length) {
        const grand = totalAreaM2();
        const n = polygonCount();
        const content = n > 0
          ? 'Total: ' + formatArea(grand) + ' · ' + n + ' area' + (n === 1 ? '' : 's')
          : 'Measurement complete';
        tooltip.setContent(content);
        // Park it at the centroid of the last completed shape so it doesn't
        // float over the map centre disconnected from the result.
        const last = completed[completed.length - 1];
        if (last && last.vertices.length) {
          const lats = last.vertices.map(p => p.lat);
          const lngs = last.vertices.map(p => p.lng);
          const cLat = lats.reduce((a, b) => a + b, 0) / lats.length;
          const cLng = lngs.reduce((a, b) => a + b, 0) / lngs.length;
          tooltip.setLatLng([cLat, cLng]);
        }
      } else {
        map.removeLayer(tooltip);
        tooltip = null;
      }
    }

    measureActive = false;
    window._measureActive = false;
    if (window._updateMeasureClearBtn) window._updateMeasureClearBtn(completed.length > 0);
  }

  function clearMeasure() {
    map.off('mousemove', onMouseMove);
    map.off('click',     onMapClick);
    map.off('dblclick',  onDblClick);
    document.removeEventListener('keydown', onKeyDown);
    map.getContainer().style.cursor = '';

    // Drop all completed shapes' layers
    completed.forEach(c => c.layers.forEach(l => { try { map.removeLayer(l); } catch (_) {} }));
    completed = [];
    // Drop in-progress shape
    stagingLayers.forEach(l => { try { map.removeLayer(l); } catch (_) {} });
    stagingLayers = [];
    points        = [];
    polyline      = null;
    liveSegLabels = [];
    if (tooltip)  { try { map.removeLayer(tooltip); } catch (_) {} tooltip = null; }

    measureActive = false;
    window._measureActive = false;
    if (window._updateMeasureClearBtn) window._updateMeasureClearBtn(false);
  }
})();


// ─── Right-click overlay identify ─────────────────────────────────────────────
// V80.1 — Right-click anywhere on the map to identify all currently-enabled
// WMS / ArcGIS-MapServer overlays at that point. Each overlay's `wms.url`
// points at the `/export` endpoint (which renders coloured tiles); the same
// MapServer's `/identify` endpoint returns the underlying feature attributes
// at a given lat/lng. We derive the identify URL by stripping `/export`,
// and pass the visible-layer id from `wms.layers` ("show:N" → "all:N").
//
// Tile-only overlays (where `wms.tiled === true` or the URL points at a
// non-MapServer tile pattern like /{z}/{x}/{y}) are skipped — their tiles
// are pre-rendered so no identify endpoint exists.
//
// GeoJSON vector overlays already have their own per-feature contextmenu
// handler (see line 1754); Leaflet's event bubbling stops there so this
// map-level handler doesn't fire when right-clicking a GeoJSON polygon.
(function () {
  const SKIP_ATTR_FIELDS = new Set([
    'OBJECTID', 'Shape', 'Shape_Area', 'Shape_Length', 'FID',
    'Shape.STArea()', 'Shape.STLength()', 'Shape_Length_', 'Shape_Area_',
  ]);

  // Dwelling Density (SEPP Precincts—Central River City 2021, layer 16):
  // the service returns only a symbol letter (SYM_CODE / "Code") — the actual
  // dwellings-per-hectare figure lives in the SEPP density-map legend, not the
  // API. Map the confirmed legend codes here. Codes not listed are shown as
  // "density not specified" (no value is guessed).
  const DWELLING_DENSITY_BY_CODE = {
    'M': 12.5, 'O': 15, 'P': 18, 'Q': 20, 'T': 25, 'U': 30, 'W': 40, 'X': 45,
  };

  // Convert overlay's wms.url + wms.layers into an identify URL + layer spec.
  // Returns null for overlays that can't be identified (tiled rasters etc.).
  function _identifyEndpointFor(def) {
    if (!def.wms || !def.wms.url) return null;
    if (def.wms.tiled) return null;                  // pre-rendered tile sets
    const url = String(def.wms.url);
    // Only ArcGIS MapServer /export URLs are identifiable here
    if (!/MapServer\/export(\?|$)/.test(url) && !/MapServer\/export$/.test(url)) {
      if (!/MapServer\/export/.test(url)) return null;
    }
    const base = url.replace(/\/export(\?.*)?$/, '');
    // wms.layers shape: "show:N" or "show:N,M" — take the first id for identify
    const layers = String(def.wms.layers || '');
    const m = layers.match(/show:(\d+)/);
    const layerId = m ? m[1] : '0';
    return { base, layerId };
  }

  // Query one overlay's identify endpoint at (lat, lng).
  // Uses ArcGIS REST identify with all:<layer> so we get a uniform shape.
  async function _identifyOverlay(def, lat, lng) {
    const ep = _identifyEndpointFor(def);
    if (!ep) return { def, ok: false, reason: 'not-identifiable' };

    const size = map.getSize();
    const b    = map.getBounds();
    const params = new URLSearchParams({
      f:             'json',
      geometry:      `${lng},${lat}`,
      geometryType:  'esriGeometryPoint',
      sr:            '4326',
      layers:        `all:${ep.layerId}`,
      tolerance:     '6',
      mapExtent:     `${b.getWest()},${b.getSouth()},${b.getEast()},${b.getNorth()}`,
      imageDisplay:  `${size.x},${size.y},96`,
      returnGeometry:'false',
    });

    try {
      const res  = await fetch(`${ep.base}/identify?${params}`);
      if (!res.ok) return { def, ok: false, reason: 'http-' + res.status };
      const json = await res.json();
      const results = (json && json.results) || [];
      if (!results.length) return { def, ok: true, attrs: null };
      return { def, ok: true, attrs: results[0].attributes || {} };
    } catch (err) {
      return { def, ok: false, reason: err.message };
    }
  }

  // Render a single overlay's identify result as one block. Mirrors the
  // visual style used by selectPropertyAtPoint's srlupBlock / roadsBlock.
  function _renderIdentifyBlock(def, attrs) {
    const colour = '#1a4a8a';
    const labelHtml = def.label || def.id;

    if (!attrs) {
      return `
        <div style="border-top:2px solid ${colour};margin-top:8px;padding-top:6px">
          <div style="font-size:10px;font-weight:600;letter-spacing:0.07em;text-transform:uppercase;color:${colour};margin-bottom:4px">${labelHtml}</div>
          <div style="font-size:12px;color:#666">No affectation at this point</div>
        </div>`;
    }

    // Dwelling Density: surface the actual density for mapped legend codes.
    let densityHtml = '';
    if (def.id === 'crc-dwelling-density') {
      const rawCode = attrs['Code'] ?? attrs['SYM_CODE'] ?? attrs['Type'] ?? attrs['LABEL'] ?? '';
      const code = String(rawCode).trim();
      if (code) {
        // Strip a trailing numeric suffix so variants inherit their base code's
        // density: O1/O2 -> O, T1/T2 -> T, etc. Exact code still wins if listed.
        const baseCode = code.replace(/\d+$/, '');
        const dph = DWELLING_DENSITY_BY_CODE[code] ?? DWELLING_DENSITY_BY_CODE[baseCode];
        const text = (dph !== undefined)
          ? `${dph} dwellings/ha (code ${code})`
          : `code ${code} — density not specified`;
        densityHtml = `<div style="font-size:13px;font-weight:600;color:${colour};margin-bottom:4px">Dwelling Density: ${text}</div>`;
      }
    }

    const rows = Object.entries(attrs)
      .filter(([k, v]) => !SKIP_ATTR_FIELDS.has(k) && v !== null && v !== '' && v !== ' ' && String(v).toLowerCase() !== 'null')
      .map(([k, v]) => `<tr>
        <td style="color:#666;padding:3px 8px 3px 0;font-size:11px;white-space:nowrap">${k.replace(/_/g, ' ')}</td>
        <td style="font-size:12px;padding:3px 0">${v}</td>
      </tr>`).join('');

    if (!rows) {
      return `
        <div style="border-top:2px solid ${colour};margin-top:8px;padding-top:6px">
          <div style="font-size:10px;font-weight:600;letter-spacing:0.07em;text-transform:uppercase;color:${colour};margin-bottom:4px">${labelHtml}</div>
          <div style="font-size:12px;color:#666">No affectation at this point</div>
        </div>`;
    }

    return `
      <div style="border-top:2px solid ${colour};margin-top:8px;padding-top:6px">
        <div style="font-size:10px;font-weight:600;letter-spacing:0.07em;text-transform:uppercase;color:${colour};margin-bottom:4px">${labelHtml}</div>
        ${densityHtml}
        <table style="border-collapse:collapse;width:100%;font-family:'DM Sans',sans-serif">${rows}</table>
      </div>`;
  }

  async function _onMapContextMenu(e) {
    // Don't fire while the measure tool is active — right-click during
    // measure should fall through to its own behaviour (currently no
    // contextmenu binding, but be defensive).
    if (window._measureActive) return;

    const { lat, lng } = e.latlng;

    // Pick up enabled WMS overlays that are identifiable.
    const targets = Object.values(overlayRegistry)
      .filter(({ def, isWms }) => isWms && def.enabled && _identifyEndpointFor(def));

    if (!targets.length) {
      // Nothing to identify — give a small hint popup so the agent knows
      // the right-click registered but there's no overlay to query.
      L.popup({ minWidth: 220, maxWidth: 320, autoPan: true })
        .setLatLng(e.latlng)
        .setContent(`<div style="${popupStyle}"><div style="font-size:12px;color:#888">No identifiable overlays enabled. Turn on an overlay (e.g. NSW Land Zoning) then right-click again.</div></div>`)
        .openOn(map);
      return;
    }

    // Loading placeholder.
    const loadingPopup = L.popup({ minWidth: 240, maxWidth: 360, autoPan: true })
      .setLatLng(e.latlng)
      .setContent(`<div style="${popupStyle}"><div style="font-size:12px;color:#888">Identifying ${targets.length} overlay${targets.length === 1 ? '' : 's'} at this point…</div></div>`)
      .openOn(map);

    const results = await Promise.all(targets.map(({ def }) => _identifyOverlay(def, lat, lng)));

    const blocks = results
      .filter(r => r.ok)
      .map(r => _renderIdentifyBlock(r.def, r.attrs))
      .join('');

    const failed = results.filter(r => !r.ok);
    const failNote = failed.length
      ? `<div style="font-size:11px;color:#999;margin-top:8px;padding-top:6px;border-top:1px solid #eee">Couldn't query ${failed.length} overlay${failed.length === 1 ? '' : 's'} (tiled or unsupported)</div>`
      : '';

    const header = `<div style="font-size:13px;font-weight:600;color:#222">Overlay info at this point</div>
      <div style="font-size:10px;color:#888;margin-top:2px">${lat.toFixed(6)}, ${lng.toFixed(6)}</div>`;

    const inner = `<div style="${popupStyle}">${header}${blocks}${failNote}</div>`;

    // Re-open at the same lat/lng so the popup tracks the cursor click point
    L.popup({ minWidth: 240, maxWidth: 380, autoPan: true })
      .setLatLng(e.latlng)
      .setContent(inner)
      .openOn(map);
  }

  map.on('contextmenu', _onMapContextMenu);
})();


// ─── Deferred pipeline pin render ────────────────────────────────────────────
// kanban.js may load and call refreshPipelinePins before map.js registers
// _renderPipelinePins. Poll briefly after load to catch that case.
(function () {
  let attempts = 0;
  const interval = setInterval(() => {
    attempts++;
    const data = typeof window.getPipelineData === 'function' ? window.getPipelineData() : null;
    console.log('[pipeline pins] attempt', attempts, 'data keys:', data ? Object.keys(data).length : 'null');
    if (data && Object.keys(data).length > 0) {
      console.log('[pipeline pins] pipeline loaded, rendering pins');
      window._renderPipelinePins();
      clearInterval(interval);
    } else if (attempts > 40) {
      // Pipeline loaded but empty — still try render (will just place no pins)
      console.log('[pipeline pins] pipeline empty or timeout, rendering anyway');
      if (typeof window._renderPipelinePins === 'function') window._renderPipelinePins();
      clearInterval(interval);
    }
  }, 200);
})();

// V75.1 — Load Not Suitable property flags on init so listings/pins can be
// filtered immediately. Re-runs after each pipeline load to stay current.
loadNotSuitable().then(() => {
  if (showListings && typeof renderListings === 'function') renderListings();
});

// V75.1 — close any open Not Suitable dropdown when clicking outside
document.addEventListener('click', (e) => {
  if (!e.target.closest('.listing-ns-wrap')) {
    document.querySelectorAll('.listing-ns-menu').forEach(m => { m.style.display = 'none'; });
  }
});

// V75.1 — global delegate handlers for popup Not Suitable buttons.
// The popup is a string-rendered HTML blob; inline onclicks call these by
// short key into window._nsContext to avoid JSON-in-attribute escaping.
window._nsMark = async function(key, optionIndex) {
  const listing = window._nsContext && window._nsContext[key];
  if (!listing) return;
  await markNotSuitable(listing, optionIndex);
  // Close any open menu
  document.querySelectorAll('.popup-ns-menu').forEach(m => { m.style.display = 'none'; });
  // Refresh listings + pipeline pins
  if (typeof renderListings === 'function') renderListings();
  if (typeof window.refreshPipelinePins === 'function') window.refreshPipelinePins();
  // Close any open Leaflet popup so the user gets immediate feedback
  if (typeof map !== 'undefined' && map.closePopup) map.closePopup();
};
window._nsClear = async function(key) {
  const listing = window._nsContext && window._nsContext[key];
  if (!listing) return;
  await clearNotSuitable(listing);
  if (typeof renderListings === 'function') renderListings();
  if (typeof window.refreshPipelinePins === 'function') window.refreshPipelinePins();
  if (typeof map !== 'undefined' && map.closePopup) map.closePopup();
};

// V75.1a fix — Leaflet popups parse inline `onclick` strings inconsistently
// across browsers (Safari especially), and popup HTML gets re-rendered when
// async cadastre data resolves — so per-popup listeners would also become
// stale. Use event delegation on the map container so listeners survive both
// fresh opens and content swaps.
//
// The popup HTML uses data-* attributes:
//   data-ns-toggle           → button that opens the snooze menu
//   data-ns-mark="key|idx"   → menu items that call markNotSuitable
//   data-ns-clear="key"      → reinstate button
document.addEventListener('click', (ev) => {
  const target = ev.target;

  // Toggle menu
  const toggle = target.closest('[data-ns-toggle]');
  if (toggle) {
    ev.stopPropagation();
    const menu = toggle.parentElement.querySelector('.popup-ns-menu');
    if (menu) menu.style.display = (menu.style.display === 'none' ? 'block' : 'none');
    return;
  }

  // Pick a snooze duration
  const markBtn = target.closest('[data-ns-mark]');
  if (markBtn) {
    ev.stopPropagation();
    const [key, idxStr] = markBtn.dataset.nsMark.split('|');
    const idx = parseInt(idxStr, 10);
    const listing = window._nsContext && window._nsContext[key];
    if (!listing) return;
    (async () => {
      await markNotSuitable(listing, idx);
      if (typeof renderListings === 'function') renderListings();
      if (typeof window.refreshPipelinePins === 'function') window.refreshPipelinePins();
      if (typeof map !== 'undefined' && map.closePopup) map.closePopup();
      // V75.1c — also clear any temporary click marker placed by selectPropertyAtPoint
      // so a marker dropped on bare ground (not a listing pin) disappears too.
      if (typeof clearParcelSelection === 'function') clearParcelSelection();
    })();
    return;
  }

  // Clear (reinstate)
  const clearBtn = target.closest('[data-ns-clear]');
  if (clearBtn) {
    ev.stopPropagation();
    const key = clearBtn.dataset.nsClear;
    const listing = window._nsContext && window._nsContext[key];
    if (!listing) return;
    (async () => {
      await clearNotSuitable(listing);
      if (typeof renderListings === 'function') renderListings();
      if (typeof window.refreshPipelinePins === 'function') window.refreshPipelinePins();
      if (typeof map !== 'undefined' && map.closePopup) map.closePopup();
      if (typeof clearParcelSelection === 'function') clearParcelSelection();
    })();
    return;
  }
});
