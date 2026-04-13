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

// ─── State ────────────────────────────────────────────────────────────────────
let _activeFilters = {
  propertyTypes:          [],   // e.g. ['House', 'Land']
  listingType:            'Sale',
  minBeds:                null,
  maxBeds:                null,
  minBaths:               null,
  minCars:                null,
  minPrice:               null,
  maxPrice:               null,
  minLand:                null,
  maxLand:                null,
  features:               [],   // e.g. ['AirConditioning', 'SwimmingPool']
  listingAttributes:      [],   // e.g. ['HasPhotos']
  establishedType:        null, // 'New' | 'Established'
  excludePriceWithheld:   false,
  excludeDepositTaken:    true,
  newDevOnly:             false,
};
let activeZone   = 'all';
let showListings = true;
let markers      = {};

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

// ─── Restore last viewport from localStorage (deferred to after layout) ───────
window.addEventListener('load', function restoreViewport() {
  try {
    const saved = localStorage.getItem('propmap_viewport');
    if (saved) {
      const { lat, lng, zoom } = JSON.parse(saved);
      if (lat && lng && zoom) map.setView([lat, lng], zoom, { animate: false });
    }
  } catch (e) { /* ignore */ }
});

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
const baseToggle = L.control({ position: 'bottomleft' });
baseToggle.onAdd = function () {
  const div = L.DomUtil.create('div', 'basemap-toggle');
  div.innerHTML = `
    <button class="basemap-btn active" data-base="map">Map</button>
    <button class="basemap-btn" data-base="satellite">Satellite</button>
    <button class="basemap-btn" data-base="topo">Topography</button>
  `;
  L.DomEvent.disableClickPropagation(div);
  div.querySelectorAll('.basemap-btn').forEach(btn => {
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
        div.querySelectorAll('.basemap-btn').forEach(b => b.classList.toggle('active', b.dataset.base === target));
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
        lga:   a.City || ''
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
// Handles both live Domain shape { display, from, to } and static string prices.
function formatPrice(price) {
  if (!price) return 'Price Unavailable';
  if (typeof price === 'string') return price;
  if (typeof price === 'object') {
    const { display, from, to } = price;

    // Build a numeric range string if we have from/to
    const rangeStr = from && to
      ? `$${Number(from).toLocaleString()} – $${Number(to).toLocaleString()}`
      : from
        ? `From $${Number(from).toLocaleString()}`
        : to
          ? `To $${Number(to).toLocaleString()}`
          : null;

    // If display is a real number string (e.g. "$850,000"), use it
    // If display is text-only (e.g. "Contact Agent"), prefer the numeric range
    const displayIsNumeric = display && /\d/.test(display);
    if (displayIsNumeric) return display;
    if (rangeStr) return rangeStr;
    // Text-only display (e.g. "Contact Agent", "Price on Application") with no range
    return 'Price Unavailable';
  }
  return 'Price Unavailable';
}

function buildPopupInner(label, lga, lotDP, areaSqm, zoneCode, overlayBlock, listing = null) {
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

  return `
    ${priceSection}
    <div style="font-weight:600;margin-bottom:6px;font-size:13px">${label}</div>
    ${lga      ? `<div style="${rowStyle}"><span style="${lblStyle}">LGA</span><span>${lga}</span></div>` : ''}
    <div style="${rowStyle}"><span style="${lblStyle}">Lot/DP</span><span id="lotdp-cell">${lotDisplay}</span></div>
    ${areaSqm  ? `<div style="${rowStyle}"><span style="${lblStyle}">Lot Size</span><span>${areaSqm.toLocaleString()} m²</span></div>` : ''}
    ${zoneCode ? `<div style="${rowStyle}"><span style="${lblStyle}">Zoning</span><span style="font-weight:600">${zoneCode}</span></div>` : ''}
    ${overlayBlock}
    ${domainLink}`;
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

  // Helper: wrap inner content in the outer popup shell
  function popupHtml(inner) {
    return `<div style="${popupStyle}">${inner}</div>`;
  }

  const pinNum   = addToSelection ? _selectedParcels.length + 1 : null;
  const pinColor = addToSelection ? '#1a4a8a' : '#1a6b3a';
  const pinHtml  = addToSelection
    ? `<div class="search-pin" style="background:${pinColor};display:flex;align-items:center;justify-content:center;color:#fff;font-size:10px;font-weight:700;width:28px;height:28px;border-radius:50% 50% 50% 0;transform:rotate(-45deg)"><span style="transform:rotate(45deg)">${pinNum}</span></div>`
    : `<div class="search-pin" style="background:${pinColor}"></div>`;

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
  .addTo(map)
  .openPopup();

  if (addToSelection) {
    const entry = { lat, lng, label: '', lotDP: null, areaSqm: null, zoneCode: null, listing, marker: newMarker, parcelLayer: null };
    _selectedParcels.push(entry);
  } else {
    clickMarker = newMarker;
  }

  const activeMarker = addToSelection ? newMarker : clickMarker;

  // Stage 1 — if we have a known listing use its address directly; otherwise reverse geocode
  let label, lga;
  if (listing) {
    label = `${listing.address}, ${listing.suburb}`;
    lga   = '';
  } else {
    const geo = await reverseGeocode(lat, lng);
    label = geo ? geo.label : `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
    lga   = geo ? geo.lga   : '';
  }

  // Reference to whichever marker we just placed
  
  if (activeMarker) {
    activeMarker.setPopupContent(popupHtml(buildPopupInner(label, lga, 'Loading…', null, null, '', listing)));
    activeMarker.openPopup();
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
    clickMarkerData = { lat, lng, label, lga, lotDP, areaSqm, zoneCode, listing, parcelLayer };
    renderMultiSelectBar();
  }

  // Final popup update
  if (activeMarker) {
    activeMarker.setPopupContent(popupHtml(buildPopupInner(label, lga, lotDP || 'Not found', areaSqm, zoneCode, srlupBlock + zoningBlock + floodBlock + roadsBlock, listing)));
    activeMarker.openPopup();
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
  } else if (clickMarker) {
    const d = clickMarkerData || { lat: clickMarker.getLatLng().lat, lng: clickMarker.getLatLng().lng, label: '', lga: '', lotDP: null, areaSqm: null, zoneCode: null, listing: null, parcelLayer: null };
    const pinHtml1 = `<div class="search-pin" style="background:#1a4a8a;display:flex;align-items:center;justify-content:center;color:#fff;font-size:10px;font-weight:700;width:22px;height:22px;border-radius:50% 50% 50% 0;transform:rotate(-45deg)"><span style="transform:rotate(45deg)">1</span></div>`;
    clickMarker.setIcon(L.divIcon({ className: '', html: pinHtml1, iconSize: [28, 28], iconAnchor: [14, 28], popupAnchor: [0, -30] }));
    if (d.parcelLayer) { parcelLayer = null; }
    _selectedParcels.push({ lat: d.lat, lng: d.lng, label: d.label, lga: d.lga, lotDP: d.lotDP, areaSqm: d.areaSqm, zoneCode: d.zoneCode, listing: d.listing, marker: clickMarker, parcelLayer: d.parcelLayer });
    clickMarker = null;
    clickMarkerData = null;
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
  // Tiled cache layer — uses L.tileLayer (e.g. Biodiversity Values)
  if (def.wms && def.wms.tiled) {
    return L.tileLayer(def.wms.url, {
      opacity:     def.opacity ?? 0.65,
      attribution: '© NSW Government',
      maxZoom:     19,
      tileSize:    256
    });
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
  card.innerHTML = `
    ${pinBadge}
    ${thumbHtml}
    <div class="listing-top">
      <div class="listing-price">${formatPrice(l.price)}</div>
      <div style="display:flex;align-items:center;gap:6px">
        <div class="listing-type">${l.type}</div>
        ${domBadge}
      </div>
    </div>
    <div class="listing-address">${l.address}</div>
    <div class="listing-suburb">${l.suburb} NSW</div>
  `;
  card.addEventListener('click', () => selectListing(l.id));
  return card;
}

// ─── Listings ─────────────────────────────────────────────────────────────────

function renderListings() {
  const list = document.getElementById('listingsList');
  list.innerHTML = '';
  Object.values(markers).forEach(m => map.removeLayer(m));
  markers = {};

  const bounds = map.getBounds();
  const filtered = listings.filter(l => {
    const inView   = bounds.contains(L.latLng(l.lat, l.lng));
    const typeMatch = _activeFilters.propertyTypes.length === 0
      || _activeFilters.propertyTypes.some(t => l.type === t.toLowerCase());
    return inView && typeMatch;
  });

  document.getElementById('listingCount').textContent = filtered.length;

  filtered.forEach(l => {
    const card = makeListingCard(l);
    list.appendChild(card);

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
  const sidebar = document.querySelector('.sidebar');
  let bar = document.getElementById('multi-select-bar');

  const hasSingle = !!clickMarkerData;
  const hasMulti  = _selectedParcels.length > 0;

  if (!hasSingle && !hasMulti) {
    if (bar) bar.remove();
    return;
  }

  const parcels    = hasMulti ? _selectedParcels : [clickMarkerData];
  const merged     = buildMergedAddress(parcels);

  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'multi-select-bar';
    bar.className = 'multi-select-bar';
    sidebar.appendChild(bar);
  }

  const count      = parcels.length;
  const isParcel   = count > 1;
  const countLabel = isParcel ? `Parcel — ${count} properties selected` : `1 property selected`;
  const addLabel   = isParcel ? `+ Add to Pipeline as parcel` : `+ Add to Pipeline`;
  const addrLabel  = isParcel ? 'Parcel address' : 'Address';

  bar.innerHTML = `
    <div class="msb-header">
      <span class="msb-count">${countLabel}</span>
      <button class="msb-clear" id="msbClear">✕ Clear</button>
    </div>
    <div class="msb-label">${addrLabel}</div>
    <input class="msb-input" id="msbAddress" type="text" value="${merged}" />
    <button class="msb-add" id="msbAdd">${addLabel}</button>
  `;

  document.getElementById('msbClear').addEventListener('click', () => {
    clearParcelSelection();
  });

  document.getElementById('msbAdd').addEventListener('click', () => {
    if (typeof addToPipeline !== 'function') return;
    const address    = document.getElementById('msbAddress').value.trim();
    const parts      = address.split(',');
    const streetPart = parts[0]?.trim() || address;
    const suburbPart = parts[1]?.trim() || parcels[0]?.label?.split(',')[1]?.trim() || '';

    const totalArea = parcels.reduce((s, p) => s + (p.areaSqm || 0), 0);
    const avgLat    = parcels.reduce((s, p) => s + p.lat, 0) / count;
    const avgLng    = parcels.reduce((s, p) => s + p.lng, 0) / count;
    const lotDPs    = parcels.map(p => p.lotDP).filter(Boolean).join(', ');

    addToPipeline({
      id:           (isParcel ? 'parcel-' : 'property-') + Date.now(),
      address:      streetPart,
      suburb:       suburbPart,
      price:        'Unknown',
      type:         'land',
      beds: 0, baths: 0, cars: 0,
      lat:          avgLat,
      lng:          avgLng,
      waterStatus:  'outside',
      zone:         'all',
      _lotDPs:      lotDPs,
      _areaSqm:     totalArea || null,
      _propertyCount: count,
      _parcels:     parcels.map(p => ({ lat: p.lat, lng: p.lng, label: p.label }))
    });
    // Do NOT clear selection — leave pin and parcel on map after adding to pipeline
  });
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
  if (!clickLatLng) map.setView([listing.lat, listing.lng], 15, { animate: false });

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
      document.getElementById(containerId).querySelectorAll('.filter-chip').forEach(chip => {
        chip.classList.toggle('active', values.includes(chip.dataset.value));
      });
    }
    document.getElementById('filterListingType').querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
    const ltChip = document.querySelector(`#filterListingType [data-value="${f.listingType || 'Sale'}"]`);
    if (ltChip) ltChip.classList.add('active');
    setChips('filterPropertyTypes', f.propertyTypes || []);
    setChips('filterFeatures',      f.features || []);
    setChips('filterAttributes',    f.listingAttributes || []);
    if (f.establishedType) setChips('filterEstablished', [f.establishedType]);
    const setSelect = (id, val) => { if (val != null) document.getElementById(id).value = String(val); };
    setSelect('filterMinBeds',  f.minBeds);  setSelect('filterMaxBeds',  f.maxBeds);
    setSelect('filterMinBaths', f.minBaths); setSelect('filterMinCars',  f.minCars);
    setSelect('filterMinPrice', f.minPrice); setSelect('filterMaxPrice', f.maxPrice);
    setSelect('filterMinLand',  f.minLand);  setSelect('filterMaxLand',  f.maxLand);
    document.getElementById('filterExcludePriceWithheld').checked = !!f.excludePriceWithheld;
    document.getElementById('filterExcludeDepositTaken').checked  = !!f.excludeDepositTaken;
    document.getElementById('filterNewDevOnly').checked           = !!f.newDevOnly;
  } catch (e) { /* ignore */ }
}

(function initFilterPanel() {
  const toggleBtn   = document.getElementById('filterToggleBtn');
  const panel       = document.getElementById('filterPanel');
  const closeBtn    = document.getElementById('filterPanelClose');
  const clearBtn    = document.getElementById('filterClearBtn');
  const applyBtn    = document.getElementById('filterApplyBtn');
  const activeCount = document.getElementById('filterActiveCount');

  restoreFilters();

  // Toggle panel open/close
  toggleBtn.addEventListener('click', () => {
    panel.classList.toggle('open');
  });
  closeBtn.addEventListener('click', () => panel.classList.remove('open'));

  // Multi-select chip groups
  function initChipGroup(containerId, key) {
    document.getElementById(containerId).querySelectorAll('.filter-chip').forEach(chip => {
      chip.addEventListener('click', () => chip.classList.toggle('active'));
    });
  }
  initChipGroup('filterPropertyTypes', 'propertyTypes');
  initChipGroup('filterFeatures',      'features');
  initChipGroup('filterAttributes',    'listingAttributes');
  initChipGroup('filterEstablished',   'establishedType');

  // Single-select listing type
  document.getElementById('filterListingType').querySelectorAll('.filter-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      document.getElementById('filterListingType').querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
    });
  });

  // Clear all
  clearBtn.addEventListener('click', () => {
    panel.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
    document.querySelector('#filterListingType [data-value="Sale"]').classList.add('active');
    panel.querySelectorAll('select').forEach(s => s.value = '');
    panel.querySelectorAll('input[type="checkbox"]').forEach(c => c.checked = false);
    _activeFilters = {
      propertyTypes: [], listingType: 'Sale',
      minBeds: null, maxBeds: null, minBaths: null, minCars: null,
      minPrice: null, maxPrice: null, minLand: null, maxLand: null,
      features: [], listingAttributes: [], establishedType: null,
      excludePriceWithheld: false, excludeDepositTaken: true, newDevOnly: false,
    };
    saveFilters();
    updateActiveCount();
  });

  // Count active filters for badge
  function updateActiveCount() {
    let count = 0;
    panel.querySelectorAll('#filterPropertyTypes .filter-chip.active, #filterFeatures .filter-chip.active, #filterAttributes .filter-chip.active, #filterEstablished .filter-chip.active').forEach(() => count++);
    panel.querySelectorAll('select').forEach(s => { if (s.value) count++; });
    panel.querySelectorAll('input[type="checkbox"]').forEach(c => { if (c.checked) count++; });
    activeCount.textContent = count > 0 ? count : '';
    activeCount.style.display = count > 0 ? 'inline' : 'none';
  }
  updateActiveCount(); // sync badge with any restored state

  // Apply filters → read state, store in _activeFilters, trigger search
  applyBtn.addEventListener('click', () => {
    const getChips = id => [...document.getElementById(id).querySelectorAll('.filter-chip.active')].map(c => c.dataset.value);
    const selVal   = id => document.getElementById(id).value || null;
    const numVal   = id => { const v = selVal(id); return v ? Number(v) : null; };

    const established = getChips('filterEstablished');
    const listingTypeChip = document.querySelector('#filterListingType .filter-chip.active');

    _activeFilters = {
      propertyTypes:        getChips('filterPropertyTypes'),
      listingType:          listingTypeChip ? listingTypeChip.dataset.value : 'Sale',
      minBeds:              numVal('filterMinBeds'),
      maxBeds:              numVal('filterMaxBeds'),
      minBaths:             numVal('filterMinBaths'),
      minCars:              numVal('filterMinCars'),
      minPrice:             numVal('filterMinPrice'),
      maxPrice:             numVal('filterMaxPrice'),
      minLand:              numVal('filterMinLand'),
      maxLand:              numVal('filterMaxLand'),
      features:             getChips('filterFeatures'),
      listingAttributes:    getChips('filterAttributes'),
      establishedType:      established.length === 1 ? established[0] : null,
      excludePriceWithheld: document.getElementById('filterExcludePriceWithheld').checked,
      excludeDepositTaken:  document.getElementById('filterExcludeDepositTaken').checked,
      newDevOnly:           document.getElementById('filterNewDevOnly').checked,
    };

    updateActiveCount();
    saveFilters();
    panel.classList.remove('open');
    runDomainSearch();
  });
})();

// ─── Listings toggle ──────────────────────────────────────────────────────────

document.getElementById('listingsToggle').addEventListener('click', function () {
  showListings = !showListings;
  this.classList.toggle('active', showListings);
  Object.values(markers).forEach(m => {
    if (showListings) m.addTo(map); else map.removeLayer(m);
  });
  if (showListings) {
    renderListings();
  } else {
    const list = document.getElementById('listingsList');
    if (list) list.innerHTML = '';
    const count = document.getElementById('listingCount');
    if (count) count.textContent = '0';
  }
});

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

// Re-filter sidebar whenever the map moves or zooms
map.on('moveend zoomend', () => {
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
});

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
  // Priority 1: first selected parcel
  if (_selectedParcels.length > 0) {
    const p = _selectedParcels[0];
    const delta = 0.05; // ~5km radius box around selection
    return {
      box: {
        topLeft:     { lat: p.lat + delta, lon: p.lng - delta },
        bottomRight: { lat: p.lat - delta, lon: p.lng + delta },
      }
    };
  }
  // Priority 2: single click marker
  if (clickMarkerData) {
    const { lat, lng } = clickMarkerData;
    const delta = 0.05;
    return {
      box: {
        topLeft:     { lat: lat + delta, lon: lng - delta },
        bottomRight: { lat: lat - delta, lon: lng + delta },
      }
    };
  }
  // Priority 3: current map viewport
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
// ─── Domain search with debounce ─────────────────────────────────────────────
let _domainSearchTimer = null;

function debouncedDomainSearch() {
  if (_suppressNextDomainSearch) { _suppressNextDomainSearch = false; return; }
  clearTimeout(_domainSearchTimer);
  _domainSearchTimer = setTimeout(runDomainSearch, 1500);
}

async function runDomainSearch() {
  if (!window.DomainAPI || !DomainAPI.search) { renderListings(); return; }
  try {
    const geoWindow = buildDomainGeoWindow();
    console.log('[map] Domain search — geoWindow:', JSON.stringify(geoWindow));
    const domainListings = await DomainAPI.search({
      geoWindow,
      propertyTypes:        _activeFilters.propertyTypes,
      listingTypes:         [_activeFilters.listingType],
      minBeds:              _activeFilters.minBeds,
      maxBeds:              _activeFilters.maxBeds,
      minBaths:             _activeFilters.minBaths,
      minCars:              _activeFilters.minCars,
      minPrice:             _activeFilters.minPrice,
      maxPrice:             _activeFilters.maxPrice,
      minLand:              _activeFilters.minLand,
      maxLand:              _activeFilters.maxLand,
      propertyFeatures:     _activeFilters.features,
      listingAttributes:    _activeFilters.listingAttributes,
      establishedType:      _activeFilters.establishedType,
      excludePriceWithheld: _activeFilters.excludePriceWithheld,
      excludeDepositTaken:  _activeFilters.excludeDepositTaken,
      newDevOnly:           _activeFilters.newDevOnly,
    });
    listings.length = 0;
    domainListings.forEach(l => listings.push(l));
    console.log('[map] Domain API returned ' + listings.length + ' listings');
    renderListings();
  } catch (err) {
    console.error('[map] Domain API fetch failed:', err);
    showDomainError(err.message);
  }
}

function showDomainError(msg) {
  // Clear markers
  Object.values(markers).forEach(m => map.removeLayer(m));
  markers = {};

  const list = document.getElementById('listingsList');
  const isRateLimit = msg && msg.includes('429');
  list.innerHTML = `
    <div class="domain-error">
      <div class="domain-error-icon">⚠</div>
      <div class="domain-error-title">${isRateLimit ? 'Too many requests' : 'Domain connection error'}</div>
      <div class="domain-error-msg">${isRateLimit
        ? 'Domain API rate limit reached. Results will refresh automatically.'
        : 'Could not connect to Domain API. Please check your connection and try again.'
      }</div>
      <button class="domain-error-retry" onclick="runDomainSearch()">Retry</button>
    </div>
  `;
  document.getElementById('listingCount').textContent = '0';
}

// Initial load
runDomainSearch();

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
        outFields:   'StAddr,Neighborhood,City,Region,Postal',
        outSR:       '4326'
      });
      const r    = await fetch(`${BASE}/findAddressCandidates?${candParams}`);
      const json = await r.json();
      const c    = (json.candidates || [])[0];
      if (!c || c.score < 60) return null;
      const attr = c.attributes;
      // For Australian addresses ArcGIS returns suburb in Neighborhood, City = LGA
      const suburb = attr.Neighborhood || '';
      const lga    = attr.City || '';
      const state  = attr.Region || '';
      return {
        lat:          c.location.y,
        lon:          c.location.x,
        display_name: [attr.StAddr, suburb].filter(Boolean).join(', '),
        _sub:         [state, attr.Postal].filter(Boolean).join(' '),
        _lga:         lga,
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
    map.flyTo([lat, lng], 15, { animate: true, duration: 1.2 });
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

const PIPELINE_PIN_STAGES = new Set(['shortlisted', 'under-dd', 'offer', 'acquired']);
let _pipelinePinLayer = null;

window._renderPipelinePins = function () {
  // Remove existing pipeline pin layer
  if (_pipelinePinLayer) { map.removeLayer(_pipelinePinLayer); _pipelinePinLayer = null; }

  const pipelineData = window.getPipelineData ? window.getPipelineData() : null;
  console.log('[pipeline pins] pipelineData:', pipelineData);
  if (!pipelineData) return;

  const stages = window.getPipelineStages ? window.getPipelineStages() : [];
  const stageLabel = {};
  stages.forEach(s => { stageLabel[s.id] = s.label; });

  const markers = [];

  Object.entries(pipelineData).forEach(([id, item]) => {
    console.log('[pipeline pins] item', id, 'stage:', item?.stage, 'property:', item?.property);
    if (!item?.property) return;
    if (!PIPELINE_PIN_STAGES.has(item.stage)) return;

    const p   = item.property;
    // lat/lng stored on _parcels array, not directly on property
    const firstParcel = (p._parcels && p._parcels.length > 0) ? p._parcels[0] : null;
    const lat = firstParcel?.lat ?? null;
    const lng = firstParcel?.lng ?? null;
    console.log('[pipeline pins] id:', id, 'firstParcel:', firstParcel, 'lat:', lat, 'lng:', lng);
    if (!lat || !lng) return;

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

    const marker = L.marker([lat, lng], { icon, zIndexOffset: 500 });

    marker.on('click', () => {
      // Same behaviour as any other pin — selectPropertyAtPoint
      const srlupEntry  = overlayRegistry['nsw-srlup'];
      const zoningEntry = overlayRegistry['nsw-land-zoning'];
      const floodEntry  = overlayRegistry['nsw-flood'];
      const roadsEntry  = overlayRegistry['nsw-future-roads'];
      selectPropertyAtPoint(
        { lat, lng },
        !!(srlupEntry  && srlupEntry.def.enabled),
        !!(zoningEntry && zoningEntry.def.enabled),
        !!(floodEntry  && floodEntry.def.enabled),
        !!(roadsEntry  && roadsEntry.def.enabled),
        null
      );
    });

    markers.push(marker);
  });

  if (markers.length) {
    _pipelinePinLayer = L.layerGroup(markers).addTo(map);
  }
};

// ─── Public API for kanban ────────────────────────────────────────────────────
// Called by kanban.js when the address link is clicked for a multi-parcel entry.
window.matchListingByAddress = matchListingByAddress;
window.runDomainSearchAt = runDomainSearchAt;
window.getListings = () => listings;
window.fetchLotDP = fetchLotDP;

window.reSelectParcels = function(parcels) {
  if (!parcels || parcels.length === 0) return;
  clearParcelSelection();

  const srlupEntry  = overlayRegistry['nsw-srlup'];
  const zoningEntry = overlayRegistry['nsw-land-zoning'];
  const floodEntry  = overlayRegistry['nsw-flood'];
  const roadsEntry  = overlayRegistry['nsw-future-roads'];

  const avgLat = parcels.reduce((s, p) => s + p.lat, 0) / parcels.length;
  const avgLng = parcels.reduce((s, p) => s + p.lng, 0) / parcels.length;
  map.setView([avgLat, avgLng], 15, { animate: false });

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

(function () {
  let measureActive = false;
  let measureMode   = null; // 'distance' | 'area'
  let points        = [];
  let polyline      = null;
  let polygon       = null;
  let markers       = [];
  let tooltip       = null;
  let segmentLabels = [];

  // ── Wire up tools dropdown items directly ──
  // measureBtn opens a sub-picker; instead we replace it with direct distance/area
  // buttons injected into the tools dropdown menu.
  (function wireToolsMenu() {
    const menu = document.getElementById('toolsDropdownMenu');
    if (!menu) return;

    // Replace the measureBtn item with two direct action items
    const measureItem = document.getElementById('measureBtn');
    if (measureItem) {
      const distBtn = document.createElement('button');
      distBtn.className = 'tools-dropdown-item';
      distBtn.id = 'measureDistanceBtn';
      distBtn.innerHTML = '📏 Measure Distance';

      const areaBtn = document.createElement('button');
      areaBtn.className = 'tools-dropdown-item';
      areaBtn.id = 'measureAreaBtn';
      areaBtn.innerHTML = '⬡ Measure Area';

      const clearBtn = document.createElement('button');
      clearBtn.className = 'tools-dropdown-item';
      clearBtn.id = 'measureClearBtn';
      clearBtn.style.color = '#c0392b';
      clearBtn.innerHTML = '✕ Clear Measurement';
      clearBtn.style.display = 'none';

      measureItem.replaceWith(distBtn);
      distBtn.insertAdjacentElement('afterend', areaBtn);
      areaBtn.insertAdjacentElement('afterend', clearBtn);

      distBtn.addEventListener('click', () => {
        menu.classList.remove('open');
        startMeasure('distance');
      });
      areaBtn.addEventListener('click', () => {
        menu.classList.remove('open');
        startMeasure('area');
      });
      clearBtn.addEventListener('click', () => {
        menu.classList.remove('open');
        clearMeasure();
      });

      // Show/hide clear button based on active state
      window._updateMeasureClearBtn = function(active) {
        clearBtn.style.display = active ? '' : 'none';
      };
    }
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

  // ── Shoelace area (m²) ──
  function polygonArea(pts) {
    let area = 0;
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      // Convert to approximate metres using mean lat
      const lat = (pts[i].lat + pts[j].lat) / 2;
      const mPerLng = Math.cos(lat * Math.PI / 180) * 111320;
      const mPerLat = 111320;
      area += (pts[i].lng * mPerLng) * (pts[j].lat * mPerLat);
      area -= (pts[j].lng * mPerLng) * (pts[i].lat * mPerLat);
    }
    return Math.abs(area / 2);
  }

  function formatDist(m) {
    return m >= 1000 ? (m / 1000).toFixed(2) + ' km' : Math.round(m) + ' m';
  }

  function formatArea(m2) {
    if (m2 >= 1e6)  return (m2 / 1e6).toFixed(2) + ' km²';
    if (m2 >= 10000) return (m2 / 10000).toFixed(2) + ' ha';
    return Math.round(m2) + ' m²';
  }

  function startMeasure(mode) {
    clearMeasure();
    measureMode   = mode;
    measureActive = true;
    window._measureActive = true;
    map.getContainer().style.cursor = 'crosshair';
    if (window._updateMeasureClearBtn) window._updateMeasureClearBtn(true);

    // Tooltip
    tooltip = L.tooltip({ permanent: true, direction: 'top', className: 'measure-tooltip' })
      .setContent(mode === 'distance' ? 'Click to start measuring' : 'Click to start drawing area')
      .setLatLng(map.getCenter())
      .addTo(map);

    map.on('mousemove', onMouseMove);
    map.on('click',     onMapClick);
    map.on('dblclick',  onDblClick);
  }

  function onMouseMove(e) {
    if (!measureActive || points.length === 0) return;
    const allPts = [...points, e.latlng];

    if (measureMode === 'distance') {
      let total = 0;
      for (let i = 1; i < allPts.length; i++) total += haversine(allPts[i-1], allPts[i]);
      polyline.setLatLngs(allPts);
      tooltip.setLatLng(e.latlng).setContent(formatDist(total));
    } else {
      if (polygon) polygon.setLatLngs(allPts);
      else polyline.setLatLngs(allPts);
      if (allPts.length >= 3) {
        const area = polygonArea(allPts);
        tooltip.setLatLng(e.latlng).setContent(formatArea(area));
      } else {
        tooltip.setLatLng(e.latlng).setContent('Click to add points');
      }
    }
  }

  function onMapClick(e) {
    if (!measureActive) return;
    L.DomEvent.stopPropagation(e);

    points.push(e.latlng);

    // Place a small dot marker
    const dot = L.circleMarker(e.latlng, {
      radius: 4, color: '#e74c3c', fillColor: '#e74c3c',
      fillOpacity: 1, weight: 2, interactive: false
    }).addTo(map);
    markers.push(dot);

    if (points.length === 1) {
      // First point — create line/polygon
      if (measureMode === 'distance') {
        polyline = L.polyline([e.latlng], {
          color: '#e74c3c', weight: 2.5, dashArray: '6,4', interactive: false
        }).addTo(map);
      } else {
        polyline = L.polyline([e.latlng], {
          color: '#e74c3c', weight: 2, dashArray: '4,3', interactive: false
        }).addTo(map);
      }
      tooltip.setLatLng(e.latlng).setContent('Click to continue, double-click to finish');
    }
  }

  function onDblClick(e) {
    if (!measureActive || points.length < 2) return;
    L.DomEvent.stopPropagation(e);
    L.DomEvent.preventDefault(e);

    // Remove the last point added by the click that fired before dblclick
    points.pop();
    markers[markers.length - 1].remove();
    markers.pop();

    if (measureMode === 'distance') {
      let total = 0;
      for (let i = 1; i < points.length; i++) total += haversine(points[i-1], points[i]);
      polyline.setLatLngs(points);
      tooltip.setLatLng(points[points.length - 1])
        .setContent('Total: ' + formatDist(total));
    } else {
      if (points.length >= 3) {
        if (polyline) { map.removeLayer(polyline); polyline = null; }
        polygon = L.polygon(points, {
          color: '#e74c3c', weight: 2, fillColor: '#e74c3c',
          fillOpacity: 0.15, interactive: false
        }).addTo(map);
        const area = polygonArea(points);
        tooltip.setLatLng(polygon.getBounds().getCenter())
          .setContent('Area: ' + formatArea(area));

        // Add segment length labels on each side (including closing side)
        const closed = [...points, points[0]];
        for (let i = 0; i < closed.length - 1; i++) {
          const a = closed[i];
          const b = closed[i + 1];
          const midLat = (a.lat + b.lat) / 2;
          const midLng = (a.lng + b.lng) / 2;
          const dist = haversine(a, b);
          const lbl = L.tooltip({
            permanent: true, direction: 'center',
            className: 'measure-tooltip measure-seg-label',
            interactive: false
          })
            .setContent(formatDist(dist))
            .setLatLng([midLat, midLng])
            .addTo(map);
          segmentLabels.push(lbl);
        }
      }
    }

    // Stop capturing — leave result on map
    map.off('mousemove', onMouseMove);
    map.off('click',     onMapClick);
    map.off('dblclick',  onDblClick);
    map.getContainer().style.cursor = '';
    measureActive = false;
    window._measureActive = false;
    if (window._updateMeasureClearBtn) window._updateMeasureClearBtn(false);
  }

  function clearMeasure() {
    map.off('mousemove', onMouseMove);
    map.off('click',     onMapClick);
    map.off('dblclick',  onDblClick);
    map.getContainer().style.cursor = '';
    if (polyline) { map.removeLayer(polyline); polyline = null; }
    if (polygon)  { map.removeLayer(polygon);  polygon  = null; }
    if (tooltip)  { map.removeLayer(tooltip);  tooltip  = null; }
    segmentLabels.forEach(l => map.removeLayer(l));
    segmentLabels = [];
    markers.forEach(m => map.removeLayer(m));
    markers = [];
    points  = [];
    measureActive = false;
    measureMode   = null;
    window._measureActive = false;
    if (window._updateMeasureClearBtn) window._updateMeasureClearBtn(false);
  }
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
