/**
 * map.js
 * Leaflet map, multi-overlay rendering, zone filtering, and GeoTIFF upload manager.
 * Self-contained GeoTIFF parser — no external library required. Works from file:// URLs.
 * Depends on: overlays.js, data.js
 */

// ─── State ────────────────────────────────────────────────────────────────────
let activeFilter = 'all';
let activeZone   = 'all';
let showListings = true;
let markers      = {};

// Live overlay registry: id → { def, layer }
const overlayRegistry = {};

// Parsed GeoTIFF result cached from the current file input
let parsedGeoTiff = null;

// ─── Map init ─────────────────────────────────────────────────────────────────
const map = L.map('map', {
  center: [-33.87, 150.76],
  zoom: 10,
  zoomControl: true
});

L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
  attribution: '© OpenStreetMap © CARTO',
  maxZoom: 19
}).addTo(map);

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

function registerOverlay(def) {
  const layer = buildLeafletLayer(def);
  overlayRegistry[def.id] = { def, layer };
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

  if (entries.length === 0) {
    container.innerHTML = '<p style="padding:16px;font-size:13px;color:var(--muted)">No overlays defined. Use Upload Map to add a GeoTIFF.</p>';
    return;
  }

  entries.forEach(({ def, layer }) => {
    const hasImage  = !!layer;
    const typeMeta  = OVERLAY_TYPE_META[def.type] || OVERLAY_TYPE_META.other;
    const opacityPct = Math.round((def.opacity ?? 0.4) * 100);

    const row = document.createElement('div');
    row.className = 'overlay-row';
    row.innerHTML = `
      <input type="checkbox" id="ov-${def.id}"
        ${def.enabled && hasImage ? 'checked' : ''}
        ${!hasImage ? 'disabled title="Upload a GeoTIFF to enable this overlay"' : ''} />
      <div class="overlay-info">
        <div class="overlay-label">${def.label}</div>
        <div class="overlay-meta">
          <span class="type-pill ${def.type}">${typeMeta.label}</span>
          ${!hasImage ? '<span class="no-image-note">No image loaded</span>' : ''}
        </div>
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
        if (def.enabled) layer.addTo(map);
        else map.removeLayer(layer);
      }
      document.getElementById('overlayBadge').textContent =
        Object.values(overlayRegistry).filter(e => e.def.enabled && e.layer).length;
    });

    row.querySelector(`input[type=range][data-id="${def.id}"]`).addEventListener('input', function () {
      const v = this.value / 100;
      def.opacity = v;
      document.getElementById(`opv-${def.id}`).textContent = this.value + '%';
      if (layer) layer.setOpacity(v);
    });

    container.appendChild(row);
  });
}

// ─── Zone selector ────────────────────────────────────────────────────────────

function buildZoneSelector() {
  const select = document.getElementById('zoneSelect');
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

const MARKER_COLOR = '#c4841a';

// ─── Listings ─────────────────────────────────────────────────────────────────

function renderListings() {
  const list = document.getElementById('listingsList');
  list.innerHTML = '';
  Object.values(markers).forEach(m => map.removeLayer(m));
  markers = {};

  const bounds = map.getBounds();
  const filtered = listings.filter(l => {
    const inView   = bounds.contains(L.latLng(l.lat, l.lng));
    const typeMatch = activeFilter === 'all' || l.type === activeFilter;
    return inView && typeMatch;
  });

  document.getElementById('listingCount').textContent = filtered.length;

  filtered.forEach(l => {
    const card = document.createElement('div');
    card.className = 'listing-card';
    card.dataset.id = l.id;

    const statsHtml = l.type !== 'land'
      ? `<div class="stat">🛏 ${l.beds}</div><div class="stat">🚿 ${l.baths}</div><div class="stat">🚗 ${l.cars}</div>`
      : `<div class="stat">Land</div>`;

    card.innerHTML = `
      <div class="listing-top">
        <div class="listing-price">${l.price}</div>
        <div class="listing-type">${l.type}</div>
      </div>
      <div class="listing-address">${l.address}</div>
      <div class="listing-suburb">${l.suburb} NSW</div>
      <div class="listing-stats">${statsHtml}</div>
    `;
    card.addEventListener('click', () => selectListing(l.id));
    list.appendChild(card);

    const marker = L.marker([l.lat, l.lng], { icon: makeIcon(MARKER_COLOR) })
      .bindPopup(`
        <div class="popup-price">${l.price}</div>
        <div class="popup-address">${l.address}, ${l.suburb}</div>
        <div class="popup-stats">
          ${l.type !== 'land'
            ? `<span>🛏 ${l.beds}</span><span>🚿 ${l.baths}</span><span>🚗 ${l.cars}</span>`
            : '<span>Land</span>'}
        </div>
        <div style="margin-top:10px">
          <a href="https://www.domain.com.au/sale/?suburb=${encodeURIComponent(l.suburb)}"
            target="_blank" style="color:#c4841a;font-size:12px;text-decoration:none">
            View on Domain →
          </a>
        </div>
      `)
      .addTo(map);

    marker.on('click', () => selectListing(l.id));
    markers[l.id] = marker;
  });

  if (!showListings) Object.values(markers).forEach(m => map.removeLayer(m));
}

function selectListing(id) {
  document.querySelectorAll('.listing-card').forEach(c => c.classList.remove('active'));
  const card = document.querySelector(`.listing-card[data-id="${id}"]`);
  if (card) { card.classList.add('active'); card.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
  const listing = listings.find(l => l.id === id);
  if (listing && markers[id]) {
    map.setView([listing.lat, listing.lng], 14, { animate: true });
    markers[id].openPopup();
  }
}

// ─── Filter chips ─────────────────────────────────────────────────────────────

document.querySelectorAll('.filter-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    activeFilter = chip.dataset.filter;
    renderListings();
  });
});

// ─── Listings toggle ──────────────────────────────────────────────────────────

document.getElementById('listingsToggle').addEventListener('click', function () {
  showListings = !showListings;
  this.classList.toggle('active', showListings);
  Object.values(markers).forEach(m => {
    if (showListings) m.addTo(map); else map.removeLayer(m);
  });
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

// ─── Download updated overlays.js ─────────────────────────────────────────────

document.getElementById('upDownload').addEventListener('click', () => {
  const form = getFormValues();
  if (form.error) return setStatus(form.error, true);

  const def = buildDef(form);

  // Merge into existing defs
  const allDefs = Object.values(overlayRegistry).map(e => e.def);
  const existingIdx = allDefs.findIndex(d => d.id === def.id);
  if (existingIdx >= 0) allDefs[existingIdx] = def;
  else allDefs.push(def);

  const content = generateOverlaysJs(allDefs);
  const blob = new Blob([content], { type: 'text/javascript' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = 'overlays.js'; a.click();
  URL.revokeObjectURL(url);
  setStatus('✓ overlays.js downloaded — replace your existing file with this one.');
});

// ─── Generate overlays.js content ────────────────────────────────────────────

function generateOverlaysJs(defs) {
  const overlaysStr = defs.map(def => {
    const b = def.bounds;
    const boundsStr = b
      ? `{ latMin: ${b.latMin}, latMax: ${b.latMax}, lonMin: ${b.lonMin}, lonMax: ${b.lonMax} }`
      : 'null';
    return `  {
    id: ${JSON.stringify(def.id)},
    label: ${JSON.stringify(def.label)},
    type: ${JSON.stringify(def.type)},
    zone: ${JSON.stringify(def.zone)},
    enabled: ${def.enabled},
    opacity: ${def.opacity},
    bounds: ${boundsStr},
    b64: ${def.b64 ? `"${def.b64}"` : 'null'}
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
 * overlays.js — generated by Sydney Property Map upload manager.
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

// ─── Init ─────────────────────────────────────────────────────────────────────

// Re-filter sidebar whenever the map moves or zooms
map.on('moveend zoomend', renderListings);

buildZoneSelector();
renderOverlayPanel();
renderListings();
