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

const baseLayers = {
  map: L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    attribution: '© OpenStreetMap © CARTO',
    maxZoom: 19
  }),
  satellite: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    attribution: '© Esri, Maxar, Earthstar Geographics',
    maxZoom: 19
  }),
  topo: L.tileLayer('https://maps.six.nsw.gov.au/arcgis/rest/services/public/NSW_Topo_Map/MapServer/tile/{z}/{y}/{x}', {
    attribution: '© NSW Spatial Services',
    maxZoom: 16,
    minZoom: 5
  })
};

let activeBase = 'map';
baseLayers.map.addTo(map);

// ─── Basemap toggle ───────────────────────────────────────────────────────────
const baseToggle = L.control({ position: 'bottomleft' });
baseToggle.onAdd = function () {
  const div = L.DomUtil.create('div', 'basemap-toggle');
  div.innerHTML = `
    <button class="basemap-btn active" data-base="map">Map</button>
    <button class="basemap-btn" data-base="satellite">Satellite</button>
    <button class="basemap-btn" data-base="topo">Topo</button>
  `;
  L.DomEvent.disableClickPropagation(div);
  div.querySelectorAll('.basemap-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.base;
      if (target === activeBase) return;
      map.removeLayer(baseLayers[activeBase]);
      baseLayers[target].addTo(map);
      // Keep base below overlays
      baseLayers[target].bringToBack();
      activeBase = target;
      div.querySelectorAll('.basemap-btn').forEach(b => b.classList.toggle('active', b.dataset.base === target));
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
let clickMarker  = null;
let parcelLayer  = null;

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

function buildPopupInner(label, lga, lotDP, srlupBlock) {
  return `
    <div style="font-weight:600;margin-bottom:4px">${label}</div>
    ${lga ? `<div style="${rowStyle}"><span style="${lblStyle}">LGA</span><span>${lga}</span></div>` : ''}
    <div style="${rowStyle}"><span style="${lblStyle}">Lot/DP</span><span id="lotdp-cell">${lotDP}</span></div>
    ${srlupBlock}`;
}

const ZONING_BASE = 'https://mapprod3.environment.nsw.gov.au/arcgis/rest/services/Planning/EPI_Primary_Planning_Layers/MapServer';
const FLOOD_BASE  = 'https://mapprod3.environment.nsw.gov.au/arcgis/rest/services/Planning/Hazard/MapServer';

// ─── Fetch Lot/DP + parcel boundary from NSW Cadastre ────────────────────────
// Defined at module scope so selectPropertyAtPoint can call it directly.

async function fetchLotDP(lat, lng) {
  const params = new URLSearchParams({
    f:              'json',
    geometry:       `${lng},${lat}`,
    geometryType:   'esriGeometryPoint',
    inSR:           '4326',
    spatialRel:     'esriSpatialRelIntersects',
    outFields:      'lotidstring',
    returnGeometry: 'true',
    outSR:          '4326',
    resultRecordCount: '1'
  });

  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), 8000);

  try {
    const res  = await fetch(
      'https://maps.six.nsw.gov.au/arcgis/rest/services/public/NSW_Cadastre/MapServer/9/query?' + params,
      { signal: controller.signal }
    );
    clearTimeout(tid);
    const json = await res.json();
    const feat = (json.features || [])[0];
    if (feat) {
      const lotid = (feat.attributes || {}).lotidstring || null;
      let rings = null;
      if (feat.geometry && feat.geometry.rings) {
        rings = feat.geometry.rings.map(ring => ring.map(([x, y]) => [y, x]));
      }
      return { lotid, rings };
    }
  } catch (_) { clearTimeout(tid); }

  return { lotid: null, rings: null };
}

async function selectPropertyAtPoint(latlng, includeSrlup, includeZoning, includeFlood) {
  const { lat, lng } = latlng;

  if (clickMarker) { map.removeLayer(clickMarker); clickMarker = null; }
  if (parcelLayer) { map.removeLayer(parcelLayer); parcelLayer = null; }

  // Helper: wrap inner content in the outer popup shell
  function popupHtml(inner) {
    return `<div style="${popupStyle}">${inner}</div>`;
  }

  clickMarker = L.marker([lat, lng], {
    icon: L.divIcon({
      className: '',
      html: '<div class="search-pin" style="background:#1a6b3a"></div>',
      iconSize: [22, 22],
      iconAnchor: [11, 22],
      popupAnchor: [0, -24]
    })
  })
  .bindPopup(popupHtml('<span style="color:#888;font-size:12px">Loading…</span>'), { minWidth: 210 })
  .addTo(map)
  .openPopup();

  // Stage 1 — reverse geocode (fast ~300ms), update popup immediately
  const geo   = await reverseGeocode(lat, lng);
  const label = geo ? geo.label : `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
  const lga   = geo ? geo.lga   : '';

  if (clickMarker) {
    clickMarker.setPopupContent(popupHtml(buildPopupInner(label, lga, 'Loading…', '')));
    clickMarker.openPopup();
  }

  // Show in sidebar immediately with address (Lot/DP updates below)
  if (typeof showSearchCard === 'function') {
    showSearchCard({ label, lga, lotDP: null, lat, lng });
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

  if (includeZoning) {
    // Query the zoning layer directly via /query (not /identify) to avoid
    // minScale restrictions — identify won't return results when zoomed out past 1:100,000
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
  } else {
    slowFetches.push(Promise.resolve(null));
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

  const [cadastre, srlupJson, zoningJson, floodJson] = await Promise.all(slowFetches);
  const lotDP = cadastre ? cadastre.lotid : null;

  // Draw parcel boundary on map
  drawParcel(cadastre ? cadastre.rings : null);

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

  // Build Land Zoning section
  let zoningBlock = '';
  const zoningFeature = zoningJson && ((zoningJson.features || [])[0] || (zoningJson.results || [])[0]);
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

  // Update sidebar card with final Lot/DP
  if (typeof showSearchCard === 'function') {
    showSearchCard({ label, lga, lotDP: lotDP || null, lat, lng });
  }

  // Final popup update via setPopupContent — reliable after async gaps
  if (clickMarker) {
    clickMarker.setPopupContent(popupHtml(buildPopupInner(label, lga, lotDP || 'Not found', srlupBlock + zoningBlock + floodBlock)));
    clickMarker.openPopup();
  }
}

map.on('click', function (e) {
  // Ignore clicks on existing markers and popups
  if (e.originalEvent.target.closest('.leaflet-marker-icon') ||
      e.originalEvent.target.closest('.leaflet-popup')) return;

  const srlupEntry   = overlayRegistry['nsw-srlup'];
  const zoningEntry  = overlayRegistry['nsw-land-zoning'];
  const floodEntry   = overlayRegistry['nsw-flood'];
  const srlupEnabled  = !!(srlupEntry  && srlupEntry.def.enabled);
  const zoningEnabled = !!(zoningEntry && zoningEntry.def.enabled);
  const floodEnabled  = !!(floodEntry  && floodEntry.def.enabled);

  selectPropertyAtPoint(e.latlng, srlupEnabled, zoningEnabled, floodEnabled);
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
    { key: 'zoning',        label: 'Zoning' },
    { key: 'services',      label: 'Services' },
    { key: 'environmental', label: 'Environmental' },
    { key: 'other',         label: 'Other' },
  ];

  // Group entries, skip groups with no entries
  const byGroup = {};
  entries.forEach(e => {
    // Resolve group: explicit field > type default > 'other'
    const TYPE_GROUP = {
      zoning:       'zoning',
      srlup:        'zoning',
      ilp:          'zoning',
      wastewater:   'services',
      potable:      'services',
      flood:        'environmental',
      biodiversity: 'environmental',
      bushfire:     'environmental',
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
    // Enrich with Domain API data if available
    const dl = window.DomainAPI ? DomainAPI.getEnrichedListing(l.id) : null;

    const card = document.createElement('div');
    card.className = 'listing-card';
    card.dataset.id = l.id;

    const statsHtml = l.type !== 'land'
      ? `<div class="stat">🛏 ${l.beds}</div><div class="stat">🚿 ${l.baths}</div><div class="stat">🚗 ${l.cars}</div>`
      : `<div class="stat">Land</div>`;

    const domBadge = dl
      ? `<div class="domain-badge ${DomainAPI.isMock() ? 'mock' : ''}">
           ${DomainAPI.isMock() ? '⚡ Mock' : '<img src="https://ui-avatars.com/api/?name=D&size=12&background=e31837&color=fff&bold=true&rounded=true" style="width:12px;height:12px;border-radius:50%;vertical-align:middle"> Domain'}
           <span class="dom-days">${dl.daysOnMarket}d</span>
         </div>`
      : '';

    const agentHtml = dl
      ? `<div class="listing-agent">
           <img src="${dl.advertiser.agents[0].photoUrl}" class="agent-avatar" alt="">
           <span>${dl.advertiser.agents[0].firstName} ${dl.advertiser.agents[0].lastName}</span>
           <span class="agent-agency">${dl.advertiser.name}</span>
         </div>`
      : '';

    card.innerHTML = `
      <div class="listing-top">
        <div class="listing-price">${l.price}</div>
        <div style="display:flex;align-items:center;gap:6px">
          <div class="listing-type">${l.type}</div>
          ${domBadge}
        </div>
      </div>
      <div class="listing-address">${l.address}</div>
      <div class="listing-suburb">${l.suburb} NSW</div>
      <div class="listing-stats">${statsHtml}</div>
      ${agentHtml}
    `;
    card.addEventListener('click', () => selectListing(l.id));
    list.appendChild(card);

    // Popup — use Domain data if available
    const domainLink = dl
      ? dl.listingUrl
      : `https://www.domain.com.au/sale/?suburb=${encodeURIComponent(l.suburb)}`;
    const agentPopup = dl
      ? `<div style="margin-top:8px;font-size:11px;color:#888">${dl.advertiser.agents[0].firstName} ${dl.advertiser.agents[0].lastName} · ${dl.advertiser.name}</div>`
      : '';
    const mockTag = dl && DomainAPI.isMock()
      ? `<div style="font-size:10px;color:#999;margin-top:4px">⚡ Mock data — live when API key active</div>`
      : '';

    const marker = L.marker([l.lat, l.lng], { icon: makeIcon(MARKER_COLOR) })
      .bindPopup(`
        <div class="popup-price">${l.price}</div>
        <div class="popup-address">${l.address}, ${l.suburb}</div>
        <div class="popup-stats">
          ${l.type !== 'land'
            ? `<span>🛏 ${l.beds}</span><span>🚿 ${l.baths}</span><span>🚗 ${l.cars}</span>`
            : '<span>Land</span>'}
        </div>
        ${agentPopup}
        ${mockTag}
        <div style="margin-top:10px">
          <a href="${domainLink}" target="_blank"
            style="color:#c4841a;font-size:12px;text-decoration:none">
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

// ─── Fetch parcel boundary and draw it ───────────────────────────────────────

async function fetchAndDrawParcel(lat, lng) {
  if (parcelLayer) { map.removeLayer(parcelLayer); parcelLayer = null; }
  try {
    const params = new URLSearchParams({
      f:              'json',
      geometry:       `${lng},${lat}`,
      geometryType:   'esriGeometryPoint',
      inSR:           '4326',
      spatialRel:     'esriSpatialRelIntersects',
      outFields:      'lotidstring',
      returnGeometry: 'true',
      outSR:          '4326',
      resultRecordCount: '1'
    });
    const res  = await fetch(
      'https://maps.six.nsw.gov.au/arcgis/rest/services/public/NSW_Cadastre/MapServer/9/query?' + params
    );
    const json = await res.json();
    const feat = (json.features || [])[0];
    if (feat && feat.geometry && feat.geometry.rings) {
      const rings = feat.geometry.rings.map(ring => ring.map(([x, y]) => [y, x]));
      drawParcel(rings);
    }
  } catch (err) { console.warn('fetchAndDrawParcel error:', err); }
}

function selectListing(id) {
  document.querySelectorAll('.listing-card').forEach(c => c.classList.remove('active'));
  const card = document.querySelector(`.listing-card[data-id="${id}"]`);
  if (card) { card.classList.add('active'); card.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
  const listing = listings.find(l => l.id === id);
  if (!listing) return;

  // Clear any existing parcel + click marker
  if (parcelLayer)  { map.removeLayer(parcelLayer);  parcelLayer  = null; }
  if (clickMarker)  { map.removeLayer(clickMarker);  clickMarker  = null; }

  map.setView([listing.lat, listing.lng], 16, { animate: false });

  // Open popup if marker already in view, else re-render first
  if (markers[id]) {
    markers[id].openPopup();
  } else {
    renderListings();
    if (markers[id]) markers[id].openPopup();
  }

  // Fetch and draw parcel boundary
  fetchLotDP(listing.lat, listing.lng).then(cadastre => {
    if (cadastre && cadastre.rings) {
      drawParcel(cadastre.rings);
    }
  });
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

// ─── Persistent search card ──────────────────────────────────────────────────
// Stores the last search/click result so it survives renderListings() re-renders

let _lastSearchCardData = null;

function _injectSearchCard() {
  if (!_lastSearchCardData) return;
  const existing = document.getElementById('search-result-card');
  if (!existing) {
    // Re-build and insert — handled by showSearchCard which checks for existing
    // We call a lightweight re-inject directly
    const container = document.getElementById('listingsList');
    if (container && _lastSearchCardData._el) {
      container.insertBefore(_lastSearchCardData._el, container.firstChild);
    }
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────────

// Re-filter sidebar whenever the map moves or zooms
map.on('moveend zoomend', () => {
  renderListings();
  _injectSearchCard();
});

// Move overlay panel inside its anchor for relative positioning
(function () {
  const anchor = document.getElementById('overlayAnchor');
  const panel  = document.getElementById('overlayPanel');
  if (anchor && panel) anchor.appendChild(panel);
})();

buildZoneSelector();
renderOverlayPanel();
renderListings();

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
      searchExtent: '149.5,-35.5,152.0,-32.5'  // Greater Sydney bbox
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
      return {
        lat:          c.location.y,
        lon:          c.location.x,
        display_name: [attr.StAddr, suburb].filter(Boolean).join(', '),
        _sub:         ['NSW', attr.Postal].filter(Boolean).join(' '),
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

    // Remove previous search marker and any parcel outline
    if (searchMarker) map.removeLayer(searchMarker);
    if (parcelLayer)  { map.removeLayer(parcelLayer); parcelLayer = null; }

    // Show search result card in sidebar immediately
    showSearchCard({ label, lga, lotDP: null, lat, lng });

    // Place pin
    const popupStyle = `font-family:'DM Sans',sans-serif;font-size:13px;line-height:1.6`;
    const rowStyle   = `display:flex;justify-content:space-between;gap:16px;border-top:1px solid #eee;padding-top:4px;margin-top:4px`;
    const lblStyle   = `color:#888;font-size:11px;text-transform:uppercase;letter-spacing:0.05em`;

    searchMarker = L.marker([lat, lng], {
      icon: L.divIcon({
        className: '',
        html: '<div class="search-pin"></div>',
        iconSize: [22, 22],
        iconAnchor: [11, 22],
        popupAnchor: [0, -24]
      })
    })
    .bindPopup(`
      <div style="${popupStyle}">
        <div style="font-weight:600;margin-bottom:4px">${label}</div>
        ${lga ? `<div style="${rowStyle}"><span style="${lblStyle}">LGA</span><span>${lga}</span></div>` : ''}
        <div style="${rowStyle}"><span style="${lblStyle}">Lot/DP</span><span id="lotdp-val">Loading…</span></div>
      </div>`, { minWidth: 200 })
    .addTo(map)
    .openPopup();

    // Fetch Lot/DP + parcel geometry in parallel with fly animation
    const lotDPPromise = fetchLotDP(lat, lng);
    map.flyTo([lat, lng], 17, { animate: true, duration: 1.2 });

    const cadastre = await lotDPPromise;
    const lotDP    = cadastre ? cadastre.lotid : null;

    // Draw parcel boundary
    drawParcel(cadastre ? cadastre.rings : null);

    // Update popup
    const el = document.getElementById('lotdp-val');
    if (el) el.textContent = lotDP || 'Not found';

    // Update sidebar card with Lot/DP
    showSearchCard({ label, lga, lotDP, lat, lng });
  }

  // ── Inject searched property into sidebar ──────────────────────────────────
  function showSearchCard({ label, lga, lotDP, lat, lng }) {
    const container = document.getElementById('listingsList');

    // Remove any existing search card
    const existing = document.getElementById('search-result-card');
    if (existing) existing.remove();

    // Build search query strings for external links
    const addrEncoded  = encodeURIComponent(label + ' NSW');
    const domainUrl    = `https://www.domain.com.au/sale/?suburb=${encodeURIComponent(label.split(',')[1]?.trim() || label)}&excludeunderoffer=1`;
    const domainSoldUrl = `https://www.domain.com.au/sold-listings/?suburb=${encodeURIComponent(label.split(',')[1]?.trim() || label)}`;
    const reaUrl       = `https://www.realestate.com.au/sold/in-${encodeURIComponent((label.split(',')[1]?.trim() || label).toLowerCase().replace(/\s+/g,'-'))},+nsw/`;
    const pricefinderUrl = `https://www.pricefinder.com.au/`;

    const card = document.createElement('div');
    card.id = 'search-result-card';
    card.className = 'search-result-card';
    card.innerHTML = `
      <div class="src-badge">Search Result</div>
      <div class="src-address">${label}</div>
      ${lga ? `<div class="src-meta">${lga}</div>` : ''}
      <div class="src-lotdp" id="src-lotdp">${lotDP ? `Lot/DP: ${lotDP}` : 'Fetching Lot/DP…'}</div>
      <div class="src-links-title">View on external sites</div>
      <div class="src-links">
        <a href="${domainUrl}" target="_blank" class="src-link src-link-domain">
          Domain <span class="src-link-tag">For Sale</span>
        </a>
        <a href="${domainSoldUrl}" target="_blank" class="src-link src-link-domain">
          Domain <span class="src-link-tag">Sold</span>
        </a>
        <a href="${reaUrl}" target="_blank" class="src-link src-link-rea">
          REA <span class="src-link-tag">Sold</span>
        </a>
      </div>
      <div class="src-disclaimer">External links open Domain / REA search results for the suburb. Direct property matches depend on available listings.</div>
    `;

    // Pipeline button — only if kanban is loaded
    if (typeof addToPipeline === 'function') {
      const pipelineBtn = document.createElement('button');
      pipelineBtn.className = 'src-pipeline-btn';
      pipelineBtn.textContent = '+ Add to Pipeline';
      pipelineBtn.addEventListener('click', () => {
        // Build a pseudo-listing for pipeline
        const parts = label.split(',');
        addToPipeline({
          id:        'search-' + Date.now(),
          address:   parts[0]?.trim() || label,
          suburb:    parts[1]?.trim() || '',
          price:     'Unknown',
          type:      'other',
          beds: 0, baths: 0, cars: 0,
          lat, lng,
          waterStatus: 'outside',
          zone: 'all'
        });
      });
      card.appendChild(pipelineBtn);
    }

    // Insert at top of listings list
    container.insertBefore(card, container.firstChild);

    // Store so renderListings re-injects it after map moves
    _lastSearchCardData = { label, lga, lotDP, lat, lng, _el: card };

    // Update Lot/DP cell once available
    if (lotDP) {
      const cell = document.getElementById('src-lotdp');
      if (cell) cell.textContent = `Lot/DP: ${lotDP}`;
    }
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
    _lastSearchCardData = null;
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

// ─── Legend collapse ──────────────────────────────────────────────────────────
(function () {
  const legend = document.getElementById('legendPanel');
  const toggle = document.getElementById('legendToggle');
  if (!legend || !toggle) return;

  // Restore saved state
  if (localStorage.getItem('legendCollapsed') === 'true') {
    legend.classList.add('collapsed');
  }

  toggle.addEventListener('click', () => {
    legend.classList.toggle('collapsed');
    localStorage.setItem('legendCollapsed', legend.classList.contains('collapsed'));
  });
})();
