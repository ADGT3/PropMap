/**
 * overlays.js
 *
 * All map overlays and zone definitions for the Sydney Property Map.
 *
 * OVERLAY FIELDS:
 *   id       — unique string identifier
 *   label    — display name shown in the Overlays panel
 *   type     — "wastewater" | "potable" | "ilp" | "other"
 *   zone     — must match a zone id in the ZONES array below
 *   enabled  — true = visible by default
 *   opacity  — default opacity 0–1
 *   bounds   — { latMin, latMax, lonMin, lonMax } extracted automatically
 *              from GeoTIFF on upload. You can also set manually if needed.
 *   b64      — base64-encoded PNG (rendered from GeoTIFF on upload).
 *              Raw base64 only — no data URI prefix.
 *
 * TO ADD AN OVERLAY MANUALLY (without uploading):
 *   1. Copy an entry below.
 *   2. Set a unique id, label, type, zone, bounds, and b64.
 *   3. Save and reload.
 *
 * TO ADD VIA BROWSER:
 *   Use the "Upload Map" button — bounds are extracted automatically
 *   from the GeoTIFF metadata. Download the updated overlays.js to save permanently.
 */

const OVERLAYS = [
  {
    // NSW LEP Land Zoning — EPI Primary Planning Layers (NSW Planning Portal)
    id: "nsw-land-zoning",
    label: "NSW Land Zoning (LEP)",
    type: "zoning",
    group: "zoning",
    zone: "all",
    enabled: false,
    opacity: 0.55,
    bounds: null,
    b64: null,
    wms: {
      url: "https://mapprod3.environment.nsw.gov.au/arcgis/rest/services/Planning/EPI_Primary_Planning_Layers/MapServer/export",
      layers: "show:2"
    }
  },
  {
    // NSW EPI Flood Planning — live from NSW Planning Portal Hazard MapServer
    id: "nsw-flood",
    label: "NSW Flood Planning (EPI)",
    type: "flood",
    group: "environmental",
    zone: "all",
    enabled: false,
    opacity: 0.6,
    bounds: null,
    b64: null,
    wms: {
      url: "https://mapprod3.environment.nsw.gov.au/arcgis/rest/services/Planning/Hazard/MapServer/export",
      layers: "show:1"
    }
  },
  {
    // NSW Biodiversity Values Map — tiled cache from LMBC
    id: "nsw-biodiversity",
    label: "Biodiversity Values Map",
    type: "biodiversity",
    group: "environmental",
    zone: "all",
    enabled: false,
    opacity: 0.65,
    bounds: null,
    b64: null,
    wms: {
      url: "https://www.lmbc.nsw.gov.au/arcgis/rest/services/BV/BiodiversityValues/MapServer/tile/{z}/{y}/{x}",
      layers: null,
      tiled: true
    }
  },
  {
    // NSW Bushfire Prone Land — live from NSW Planning Portal
    id: "nsw-bushfire",
    label: "Bushfire Prone Land",
    type: "bushfire",
    group: "environmental",
    zone: "all",
    enabled: false,
    opacity: 0.55,
    bounds: null,
    b64: null,
    wms: {
      url: "https://mapprod3.environment.nsw.gov.au/arcgis/rest/services/ePlanning/Planning_Portal_Hazard/MapServer/export",
      layers: "show:229"
    }
  },
  // ── Catherine Park North — Land Use Zoning (Figure 40) ─────────────────────
  {
    id: "catherine-park-north-zoning",
    label: "Catherine Park North – Proposed Zoning",
    type: "zoning",
    group: "zoning",
    zone: "all",
    enabled: false,
    opacity: 0.7,
    bounds: null,
    b64: null,
    vector: true,
    vectorUrl: "/catherine_park_north_zoning_wgs84.geojson",
    source: "Figure 40 – Proposed Land Use Zoning, Catherine Park North Draft Planning Proposal, Sep 2025",
    vectorStyle: {
      R2:  { color: "#C8BC7A", fillColor: "#EAE3B8", fillOpacity: 0.70, weight: 1 },
      R3:  { color: "#C8B840", fillColor: "#EBDE8A", fillOpacity: 0.70, weight: 1 },
      SP2: { color: "#B8860B", fillColor: "#FFD700", fillOpacity: 0.70, weight: 1 }
    }
  },
  // ── Catherine Park North — Land Reservation Acquisition (Figure 43) ─────────
  {
    id: "catherine-park-north-land-reservation",
    label: "Catherine Park North – Land Reservation Acquisition",
    type: "zoning",
    group: "zoning",
    zone: "all",
    enabled: false,
    opacity: 0.7,
    bounds: null,
    b64: null,
    vector: true,
    vectorUrl: "/catherine_park_north_land_reservation_wgs84.geojson",
    source: "Figure 43 – Land Reservation Acquisition, Catherine Park North Draft Planning Proposal, Sep 2025",
    vectorStyleProp: "zone",
    vectorStyleMap: {
      RE1: { color: "#145214", fillColor: "#228B22", fillOpacity: 0.65, weight: 1.5 },
      SP2: { color: "#B8860B", fillColor: "#FFD700", fillOpacity: 0.65, weight: 1.5 }
    }
  },
  // ── Springfield Road ILP — Contours (from PDF vector layer) ─────────────────
  {
    id: "springfield-road-contours",
    label: "Springfield Road – Topography Contours",
    type: "environmental",
    group: "environmental",
    zone: "all",
    enabled: false,
    opacity: 0.8,
    bounds: null,
    b64: null,
    vector: true,
    vectorUrl: "/springfield_road_contours_wgs84.geojson",
    source: "Levels/Contour layer – Springfield Road Indicative Layout Plan Option B, 11 Dec 2024",
    vectorStyleProp: "type",
    vectorStyleMap: {
      "contour": { color: "#E28807", fillColor: "none", fillOpacity: 0, weight: 0.8, opacity: 0.8 }
    }
  },
  {
    id: "catherine-park-north-topography",
    label: "Catherine Park North – Topography",
    type: "environmental",
    group: "environmental",
    zone: "all",
    enabled: false,
    opacity: 0.65,
    bounds: null,
    b64: null,
    vector: true,
    vectorUrl: "/catherine_park_north_topography_wgs84.geojson",
    source: "Figure 7 – Topography, Catherine Park North Draft Planning Proposal, Sep 2025",
    vectorStyleProp: "elevation",
    vectorStyleMap: {
      "80-85m":   { color: "#87CEEB", fillColor: "#87CEEB", fillOpacity: 0.6, weight: 0.5 },
      "85-90m":   { color: "#00E5FF", fillColor: "#00E5FF", fillOpacity: 0.6, weight: 0.5 },
      "90-95m":   { color: "#40E0D0", fillColor: "#40E0D0", fillOpacity: 0.6, weight: 0.5 },
      "95-100m":  { color: "#7CFC00", fillColor: "#7CFC00", fillOpacity: 0.6, weight: 0.5 },
      "100-105m": { color: "#ADFF2F", fillColor: "#ADFF2F", fillOpacity: 0.6, weight: 0.5 },
      "105-110m": { color: "#FFFF00", fillColor: "#FFFF00", fillOpacity: 0.6, weight: 0.5 },
      "110-115m": { color: "#FFA500", fillColor: "#FFA500", fillOpacity: 0.6, weight: 0.5 },
      "115-120m": { color: "#FF7F50", fillColor: "#FF7F50", fillOpacity: 0.6, weight: 0.5 },
      "125-130m": { color: "#FF6B6B", fillColor: "#FF6B6B", fillOpacity: 0.6, weight: 0.5 }
    }
  },
  // ── Catherine Park North — 1% AEP Flood (Figure 22) ──────────────────────────
  {
    id: "catherine-park-north-flood",
    label: "Catherine Park North – 1% AEP Flood Depth",
    type: "environmental",
    group: "environmental",
    zone: "all",
    enabled: false,
    opacity: 0.65,
    bounds: null,
    b64: null,
    vector: true,
    vectorUrl: "/catherine_park_north_flood_wgs84.geojson",
    source: "Figure 22 – Existing Flood Conditions 1% AEP, Catherine Park North Draft Planning Proposal, Sep 2025",
    vectorStyleProp: "flood_depth",
    vectorStyleMap: {
      "0.0-0.5m": { color: "#1a1aff", fillColor: "#1a1aff", fillOpacity: 0.65, weight: 0.5 },
      "0.5-1.0m": { color: "#6666ff", fillColor: "#6666ff", fillOpacity: 0.65, weight: 0.5 },
      "1.0-1.5m": { color: "#87ceeb", fillColor: "#87ceeb", fillOpacity: 0.65, weight: 0.5 },
      "1.5-2.0m": { color: "#ffff00", fillColor: "#ffff00", fillOpacity: 0.65, weight: 0.5 },
      "2.0-3.0m": { color: "#ffa500", fillColor: "#ffa500", fillOpacity: 0.65, weight: 0.5 },
      "3.0-4.0m": { color: "#ffb6c1", fillColor: "#ffb6c1", fillOpacity: 0.65, weight: 0.5 },
      ">4.0m":    { color: "#ff0000", fillColor: "#ff0000", fillOpacity: 0.65, weight: 0.5 }
    }
  },
  // ── Catherine Park North — Rickard Road Alignment (Figure 31) ────────────────
  {
    id: "catherine-park-north-rickard-road",
    label: "Catherine Park North – Rickard Road Alignment",
    type: "future-roads",
    group: "transport",
    zone: "all",
    enabled: false,
    opacity: 0.75,
    bounds: null,
    b64: null,
    vector: true,
    vectorUrl: "/catherine_park_north_rickard_road_wgs84.geojson",
    source: "Figure 31 – Revised Rickard Road Alignment, Catherine Park North Draft Planning Proposal, Sep 2025",
    vectorStyleProp: "road",
    vectorStyleMap: {
      "road-yellow": { color: "#FFD700", fillColor: "#FFD700", fillOpacity: 0.7, weight: 2 },
      "road-aqua":   { color: "#00CED1", fillColor: "#00CED1", fillOpacity: 0.7, weight: 2 }
    }
  },
  // ── Springfield Road ILP — Land Use Zones (from PDF vector layer) ──────────
  {
    id: "springfield-road-ilp",
    label: "Springfield Road – Indicative Layout Plan",
    type: "zoning",
    group: "zoning",
    zone: "all",
    enabled: false,
    opacity: 0.7,
    bounds: null,
    b64: null,
    vector: true,
    vectorUrl: "/springfield_road_ilp_wgs84.geojson",
    source: "Springfield Road Indicative Layout Plan Option B, 11 Dec 2024, urbanco.com.au",
    vectorStyleProp: "zone",
    vectorStyleMap: {
      "low-residential":         { color: "#C8BC7A", fillColor: "#EAE3B8", fillOpacity: 0.70, weight: 1 },
      "medium-residential":      { color: "#C8B840", fillColor: "#EBDE8A", fillOpacity: 0.70, weight: 1 },
      "medium-high-residential": { color: "#CC8070", fillColor: "#FFA196", fillOpacity: 0.70, weight: 1 },
      "open-space":              { color: "#00CC00", fillColor: "#00FF00", fillOpacity: 0.70, weight: 1 },
      "drainage":                { color: "#90CC60", fillColor: "#BDFF87", fillOpacity: 0.70, weight: 1 },
      "riparian":                { color: "#004000", fillColor: "#006400", fillOpacity: 0.80, weight: 1 },
      "local-centre":            { color: "#5090C0", fillColor: "#90C9F2", fillOpacity: 0.70, weight: 1 },
      "primary-school":          { color: "#CCCC00", fillColor: "#FFFF66", fillOpacity: 0.70, weight: 1 },
      "future-road":             { color: "#0050A0", fillColor: "#0071BC", fillOpacity: 0.60, weight: 1 },
      "site-boundary":           { color: "#FF0000", fillColor: "none",    fillOpacity: 0.00, weight: 2 }
    }
  },
  {
    id: "nsw-srlup",
    label: "NSW Strategic Regional Land Use Policy",
    type: "srlup",
    group: "zoning",
    zone: "all",
    enabled: false,
    opacity: 0.55,
    bounds: null,
    b64: null,
    wms: {
      url: "https://mapprod3.environment.nsw.gov.au/arcgis/rest/services/EDP/SRLUP/MapServer/export",
      layers: "show:1"
    }
  },
  {
    // Future Road Reservations — EPI Additional Layers (NSW Planning Portal)
    // Shows land reserved for future roads and arterial infrastructure under Transport & Infrastructure SEPP
    id: "nsw-future-roads",
    label: "Future Road Reservations",
    type: "future-roads",
    group: "transport",
    zone: "all",
    enabled: false,
    opacity: 0.65,
    bounds: null,
    b64: null,
    wms: {
      url: "https://mapprod.environment.nsw.gov.au/arcgis/rest/services/Planning/EPI_Additional_Layers/MapServer/export",
      layers: "show:10"
    }
  },
  {
    // Rail & Infrastructure Corridors — SEPP (Transport and Infrastructure) 2021
    // Layers 1 = Subject Land (73 features), 2 = Land Application (135 features)
    // Covers Western Sydney Freight Line, North South Rail, South West Rail Link Extension
    id: "nsw-rail-corridors",
    label: "Rail & Infrastructure Corridors (SEPP)",
    type: "rail-corridors",
    group: "transport",
    zone: "all",
    enabled: false,
    opacity: 0.65,
    bounds: null,
    b64: null,
    wms: {
      url: "https://mapprod3.environment.nsw.gov.au/arcgis/rest/services/Planning/SEPP_Transport_and_Infrastructure_2021/MapServer/export",
      layers: "show:1"
    }
  },

  // ── SEPP (Precincts—Western Parkland City) 2021 ──────────────────────────────
  {
    id: "wpc-floor-space-ratio",
    label: "Floor Space Ratio (n:1)",
    type: "wpc",
    group: "western-parkland-city",
    zone: "all", enabled: false, opacity: 0.6, bounds: null, b64: null,
    wms: { url: "https://mapprod3.environment.nsw.gov.au/arcgis/rest/services/Planning/SEPP_Precincts_Western_Parkland_City_2021/MapServer/export", layers: "show:3" }
  },
  {
    id: "wpc-land-zoning",
    label: "Land Zoning",
    type: "wpc",
    group: "western-parkland-city",
    zone: "all", enabled: false, opacity: 0.6, bounds: null, b64: null,
    wms: { url: "https://mapprod3.environment.nsw.gov.au/arcgis/rest/services/Planning/SEPP_Precincts_Western_Parkland_City_2021/MapServer/export", layers: "show:4" }
  },
  {
    id: "wpc-minimum-lot-size",
    label: "Minimum Lot Size",
    type: "wpc",
    group: "western-parkland-city",
    zone: "all", enabled: false, opacity: 0.6, bounds: null, b64: null,
    wms: { url: "https://mapprod3.environment.nsw.gov.au/arcgis/rest/services/Planning/SEPP_Precincts_Western_Parkland_City_2021/MapServer/export", layers: "show:5" }
  },
  {
    id: "wpc-height-of-building",
    label: "Height of Building",
    type: "wpc",
    group: "western-parkland-city",
    zone: "all", enabled: false, opacity: 0.6, bounds: null, b64: null,
    wms: { url: "https://mapprod3.environment.nsw.gov.au/arcgis/rest/services/Planning/SEPP_Precincts_Western_Parkland_City_2021/MapServer/export", layers: "show:6" }
  },
  {
    id: "wpc-flood",
    label: "Flood",
    type: "wpc",
    group: "western-parkland-city",
    zone: "all", enabled: false, opacity: 0.6, bounds: null, b64: null,
    wms: { url: "https://mapprod3.environment.nsw.gov.au/arcgis/rest/services/Planning/SEPP_Precincts_Western_Parkland_City_2021/MapServer/export", layers: "show:7" }
  },
  {
    id: "wpc-land-reservation-acquisition",
    label: "Land Reservation Acquisition",
    type: "wpc",
    group: "western-parkland-city",
    zone: "all", enabled: false, opacity: 0.6, bounds: null, b64: null,
    wms: { url: "https://mapprod3.environment.nsw.gov.au/arcgis/rest/services/Planning/SEPP_Precincts_Western_Parkland_City_2021/MapServer/export", layers: "show:8" }
  },
  {
    id: "wpc-additional-permitted-uses",
    label: "Additional Permitted Uses",
    type: "wpc",
    group: "western-parkland-city",
    zone: "all", enabled: false, opacity: 0.6, bounds: null, b64: null,
    wms: { url: "https://mapprod3.environment.nsw.gov.au/arcgis/rest/services/Planning/SEPP_Precincts_Western_Parkland_City_2021/MapServer/export", layers: "show:9" }
  },
  {
    id: "wpc-environmental-conservation",
    label: "Environmental Conservation Area",
    type: "wpc",
    group: "western-parkland-city",
    zone: "all", enabled: false, opacity: 0.6, bounds: null, b64: null,
    wms: { url: "https://mapprod3.environment.nsw.gov.au/arcgis/rest/services/Planning/SEPP_Precincts_Western_Parkland_City_2021/MapServer/export", layers: "show:10" }
  },
  {
    id: "wpc-native-vegetation",
    label: "Native Vegetation Protection",
    type: "wpc",
    group: "western-parkland-city",
    zone: "all", enabled: false, opacity: 0.6, bounds: null, b64: null,
    wms: { url: "https://mapprod3.environment.nsw.gov.au/arcgis/rest/services/Planning/SEPP_Precincts_Western_Parkland_City_2021/MapServer/export", layers: "show:11" }
  },
  {
    id: "wpc-dwelling-density",
    label: "Dwelling Density",
    type: "wpc",
    group: "western-parkland-city",
    zone: "all", enabled: false, opacity: 0.6, bounds: null, b64: null,
    wms: { url: "https://mapprod3.environment.nsw.gov.au/arcgis/rest/services/Planning/SEPP_Precincts_Western_Parkland_City_2021/MapServer/export", layers: "show:12" }
  },
  {
    id: "wpc-heritage",
    label: "Heritage",
    type: "wpc",
    group: "western-parkland-city",
    zone: "all", enabled: false, opacity: 0.6, bounds: null, b64: null,
    wms: { url: "https://mapprod3.environment.nsw.gov.au/arcgis/rest/services/Planning/SEPP_Precincts_Western_Parkland_City_2021/MapServer/export", layers: "show:14" }
  },
  {
    id: "wpc-riparian-lands",
    label: "Riparian Lands and Watercourses",
    type: "wpc",
    group: "western-parkland-city",
    zone: "all", enabled: false, opacity: 0.6, bounds: null, b64: null,
    wms: { url: "https://mapprod3.environment.nsw.gov.au/arcgis/rest/services/Planning/SEPP_Precincts_Western_Parkland_City_2021/MapServer/export", layers: "show:16" }
  },
  {
    id: "wpc-transport-arterial",
    label: "Transport & Arterial Road Infrastructure",
    type: "wpc",
    group: "western-parkland-city",
    zone: "all", enabled: false, opacity: 0.65, bounds: null, b64: null,
    wms: { url: "https://mapprod3.environment.nsw.gov.au/arcgis/rest/services/Planning/SEPP_Precincts_Western_Parkland_City_2021/MapServer/export", layers: "show:21" }
  },
  {
    id: "wpc-terrestrial-biodiversity",
    label: "Terrestrial Biodiversity",
    type: "wpc",
    group: "western-parkland-city",
    zone: "all", enabled: false, opacity: 0.6, bounds: null, b64: null,
    wms: { url: "https://mapprod3.environment.nsw.gov.au/arcgis/rest/services/Planning/SEPP_Precincts_Western_Parkland_City_2021/MapServer/export", layers: "show:23" }
  },
  {
    id: "wpc-airport-noise",
    label: "Airport Noise (ANEC/ANEF)",
    type: "wpc",
    group: "western-parkland-city",
    zone: "all", enabled: false, opacity: 0.6, bounds: null, b64: null,
    wms: { url: "https://mapprod3.environment.nsw.gov.au/arcgis/rest/services/Planning/SEPP_Precincts_Western_Parkland_City_2021/MapServer/export", layers: "show:26" }
  },
  {
    id: "wpc-flood-100-aep",
    label: "1 in 100 AEP Flood Extents",
    type: "wpc",
    group: "western-parkland-city",
    zone: "all", enabled: false, opacity: 0.6, bounds: null, b64: null,
    wms: { url: "https://mapprod3.environment.nsw.gov.au/arcgis/rest/services/Planning/SEPP_Precincts_Western_Parkland_City_2021/MapServer/export", layers: "show:40" }
  },

  {
    // Electricity Transmission Lines — Geoscience Australia National Electricity Infrastructure
    // Shows high-voltage transmission corridors (proxy for easements) across NSW
    id: "electricity-transmission",
    label: "Electricity Transmission Lines",
    type: "electricity",
    group: "services",
    zone: "all",
    enabled: false,
    opacity: 0.8,
    bounds: null,
    b64: null,
    wms: {
      url: "https://services.ga.gov.au/gis/rest/services/National_Electricity_Infrastructure/MapServer/export",
      layers: "show:2"
    }
  },
  {
    id: "sw-wastewater",
    label: "Wastewater — South West Sydney",
    type: "wastewater",
    group: "services",
    zone: "south-west-sydney",
    enabled: false,
    opacity: 0.7,
    bounds: { latMin: -34.0673002106552, latMax: -33.80758423780651, lonMin: 150.64488252729578, lonMax: 150.87546633811064 },
    vector: true,
    vectorFn: "addGSPLayer"
  },
  {
    id: "sw-potable",
    label: "Potable Water — South West Sydney",
    type: "potable",
    zone: "south-west-sydney",
    enabled: false,
    opacity: 0.4,
    bounds: { latMin: -34.06703146583395, latMax: -33.79801841774339, lonMin: 150.6301602408125, lonMax: 150.89931435500063 },
    b64: null
  },
  {
    id: "sw-ilp",
    label: "ILP — Leppington Stage 3&4",
    type: "ilp",
    zone: "south-west-sydney",
    enabled: false,
    opacity: 0.7,
    bounds: { latMin: -33.99934965392993, latMax: -33.94960464165743, lonMin: 150.77621588449637, lonMax: 150.81793543936465 },
    b64: null
  }
];

/**
 * ZONES
 * Each zone defines a named area and its map bounds for pan/zoom.
 * The zone id is matched against the `zone` field on listings and overlays.
 */
const ZONES = [
  {
    id: "all",
    label: "All Zones",
    bounds: null
  },
  {
    id: "south-west-sydney",
    label: "South West Sydney",
    bounds: {
      latMin: -34.0673002106552,
      latMax: -33.80758423780651,
      lonMin: 150.64488252729578,
      lonMax: 150.87546633811064
    }
  }
  // Add more zones here:
  // {
  //   id: "north-west-sydney",
  //   label: "North West Sydney",
  //   bounds: { latMin: ..., latMax: ..., lonMin: ..., lonMax: ... }
  // },
];

/**
 * Overlay type display config — label and colour for the UI type pill.
 */
const OVERLAY_TYPE_META = {
  'airport-noise':       { label: "Airport Noise",      color: "#7d6608" },
  'wpc':                 { label: "WPC 2021",           color: "#1a5276" },
  'future-roads':        { label: "Future Roads",       color: "#c0392b" },
  'transport-corridors': { label: "Transport Corridor", color: "#922b21" },
  'rail-corridors':      { label: "Rail Corridor",      color: "#6c3483" },
  electricity: { label: "Electricity",    color: "#e67e22" },
  wastewater:  { label: "Wastewater",    color: "#2980b9" },
  potable:    { label: "Potable Water", color: "#27ae60" },
  ilp:        { label: "ILP",           color: "#8e44ad" },
  srlup:      { label: "NSW Planning",  color: "#e67e22" },
  flood:       { label: "Flood Planning",   color: "#2471a3" },
  biodiversity:{ label: "Biodiversity",     color: "#1a7a3a" },
  bushfire:    { label: "Bushfire Prone",   color: "#c0392b" },
  zoning:      { label: "Land Zoning",     color: "#8B0000" },
  flood:      { label: "Flood",         color: "#1a5fa8" },
  other:      { label: "Other",         color: "#666"    }
};
