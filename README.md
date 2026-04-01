# Sydney Property Map

A browser-based interactive property map overlaying property listings with Sydney Water planning maps, NSW Indicative Layout Plans (ILPs), and live NSW Government planning layers across Sydney's growth corridors.

---

## File Structure

```
sydney-property-map/
├── index.html      — Page structure and UI layout
├── styles.css      — All visual styling
├── overlays.js     — Map overlay images and zone definitions
├── data.js         — Property listings data
├── map.js          — Map logic, interactivity, and upload manager
└── README.md       — This file
```

---

## Features

### Map & Navigation
- **Interactive Leaflet map** centred on Greater Sydney
- **Basemap toggle** — switch between CartoDB Light (street map) and Esri World Imagery (satellite) using the Map / Satellite pill in the bottom-left corner
- **Address search** — type any NSW address or suburb in the header search bar; autocomplete suggestions appear as you type using the ArcGIS geocoder. Supports full street addresses including house numbers (e.g. `109 Deepfields Road Camden`). Select a result to drop a pin and fly to the location
- **Click to select property** — click anywhere on the map to drop a green pin and load property information for that location. A parcel boundary outline is drawn on the map

### Property Information Popup
Clicking the map or selecting an address search result shows a popup containing:
- **Street address** — reverse geocoded from the clicked point
- **LGA** — Local Government Area
- **Lot/DP** — cadastral lot and deposited plan number, fetched from NSW Spatial Services
- **Land Zoning** — zone code (e.g. R2, RU1, B4), land use class, and the LEP name — shown when the Land Zoning overlay is enabled
- **NSW Planning Zone** — SRLUP growth area details — shown when the SRLUP overlay is enabled

### Overlays Panel
Click **🗺 Overlays** in the header to open the overlays panel. Each overlay has:
- A checkbox to show/hide it
- An opacity slider
- A type pill (colour-coded by overlay type)

**Hide all / Show all** — toggle all overlays off or on in one click using the button in the panel header.

Available overlay types:

| Type | Colour | Description |
|---|---|---|
| `wastewater` | Blue | Sydney Water wastewater/sewerage planning maps (GeoTIFF upload) |
| `potable` | Green | Sydney Water potable (drinking) water planning maps (GeoTIFF upload) |
| `ilp` | Purple | NSW Indicative Layout Plans (GeoTIFF upload) |
| `srlup` | Orange | NSW Strategic Regional Land Use Policy — live from NSW Environment |
| `zoning` | Dark red | NSW Land Zoning (LEP) — live from NSW Planning Portal |
| `other` | Grey | Any other overlay type |

Live ArcGIS overlays (SRLUP and Land Zoning) refresh automatically whenever the map is panned or zoomed, using a double-buffer image swap to avoid flickering.

### Listings Sidebar
- Shows all property listings visible in the current map view
- Filter by property type: All / House / Apartment / Land
- Click a listing card or map marker to select it and fly to the location
- Listing count updates dynamically as you pan and zoom

### Upload Manager
Click **⬆ Upload Map** in the header to add your own GeoTIFF overlay maps:
1. Enter a label, select the overlay type, and enter the zone id
2. Select a **GeoTIFF file** (`.tif` / `.tiff`) — bounds are extracted automatically
3. Click **Add to map (this session)** to preview immediately
4. Click **Download updated overlays.js** to embed the image permanently — replace your existing file with the downloaded one

> **GeoTIFF requirement:** The file must use **WGS84 (EPSG:4326)** coordinates. Re-export from QGIS in WGS84 if your file uses MGA2020 / GDA94 / UTM.

---

## File Descriptions

### `index.html`
The main HTML file. Defines the page structure including the header controls (address search, zone selector, overlays panel, listings toggle, upload manager), the Leaflet map container, and the listings sidebar with legend.

**When to edit:** Adding new UI elements to the header or sidebar, or changing the overall page layout.

---

### `styles.css`
All CSS for the application — layout, header, sidebar, listing cards, overlay panel, upload manager form, address search, basemap toggle, and Leaflet popup overrides. Uses CSS custom properties (variables) defined in `:root` for colours.

**When to edit:** Any visual or layout changes — colours, spacing, typography, panel sizing, etc.

---

### `overlays.js`
**The main file you will edit most often.** Contains two key data structures:

**`OVERLAYS` array** — each entry defines one map overlay. Fields:

| Field | Description |
|---|---|
| `id` | Unique identifier string (e.g. `"sw-wastewater"`) |
| `label` | Display name shown in the Overlays panel |
| `type` | One of: `"wastewater"`, `"potable"`, `"ilp"`, `"srlup"`, `"zoning"`, `"other"` |
| `zone` | Must match a zone `id` in the `ZONES` array below |
| `enabled` | `true` = visible by default, `false` = hidden by default |
| `opacity` | Default opacity between `0` (invisible) and `1` (fully opaque) |
| `bounds` | Geographic bounds `{ latMin, latMax, lonMin, lonMax }` — for GeoTIFF overlays. Set to `null` for live WMS overlays. |
| `b64` | Base64-encoded PNG — for GeoTIFF overlays. Set to `null` for live WMS overlays. |
| `wms` | `{ url, layers }` — for live ArcGIS overlays. Omit for GeoTIFF overlays. |

**`ZONES` array** — each entry defines a named geographic zone:

| Field | Description |
|---|---|
| `id` | Unique identifier string (e.g. `"south-west-sydney"`) |
| `label` | Display name in the zone dropdown |
| `bounds` | Map bounds the view pans/zooms to when this zone is selected. Set to `null` for "All Zones". |

**`OVERLAY_TYPE_META`** — display colour for each overlay type pill in the UI.

**When to edit:** Adding new zones, changing which overlays are on by default, or adding new live ArcGIS layers.

---

### `data.js`
Contains the `listings` array with all property data, and the `waterLabels` lookup object.

Each listing has these fields:

| Field | Description |
|---|---|
| `id` | Unique number |
| `address` | Street address |
| `suburb` | Suburb name |
| `price` | Display price string |
| `type` | One of: `"house"`, `"apartment"`, `"land"` |
| `beds` / `baths` / `cars` | Counts (set to `0` for land) |
| `lat` / `lng` | Map coordinates |
| `waterStatus` | One of: `"serviced"`, `"planned"`, `"unserviced"`, `"outside"` |
| `zone` | Must match a zone `id` in `overlays.js` — controls which zone filter shows this listing |

**When to edit:** Adding, removing, or updating property listings.

---

### `map.js`
The application logic layer. Handles:

- **Leaflet map initialisation** — tile layers, zoom, starting position, basemap toggle
- **Address search** — ArcGIS geocoder with autocomplete, debounced suggestions, keyboard navigation, and pin drop
- **Property selection** — map click handler that reverse geocodes the point, fetches Lot/DP from NSW Spatial Services cadastre, queries Land Zoning from NSW Planning Portal, and draws the parcel boundary polygon
- **GeoTIFF parsing** — reads uploaded `.tif` files, extracts geographic bounds, rasterises to PNG for Leaflet display
- **Live ArcGIS overlays** — double-buffered `ImageOverlay` that refreshes on map move/zoom with a 150ms debounce; uses Web Mercator projection for pixel-perfect alignment
- **Overlay panel UI** — show/hide/opacity controls, hide-all/show-all toggle, overlay badge count
- **Zone selector** — populates dropdown from `ZONES`, filters listings, pans map to zone bounds
- **Listings rendering** — sidebar cards and map markers, zone + type filtering, selected marker highlight
- **Upload Manager** — GeoTIFF upload, bounds extraction, live preview, and `overlays.js` download

**When to edit:** Changes to map behaviour, filtering logic, marker appearance, or upload/download workflow.

---

## How To: Add a New GeoTIFF Overlay

### Option A — Upload via browser (recommended)
1. Click **⬆ Upload Map** in the header
2. Enter a label, select the overlay type, and enter the zone id
3. Select your **GeoTIFF file** — bounds are extracted automatically
4. Click **Add to map (this session)** to preview
5. Click **Download updated overlays.js** — replace your existing file to make it permanent

### Option B — Edit overlays.js directly
1. Open `overlays.js`
2. Copy an existing GeoTIFF entry in the `OVERLAYS` array
3. Set a unique `id`, `label`, `type`, `zone`, and `opacity`
4. Fill in `bounds`: `{ latMin, latMax, lonMin, lonMax }`
5. Paste a base64-encoded PNG string into `b64`
6. Save and reload

---

## How To: Add a New Live ArcGIS Overlay

1. Open `overlays.js`
2. Add a new entry to the `OVERLAYS` array with a `wms` field:

```javascript
{
  id:      "my-layer",
  label:   "My Layer Label",
  type:    "other",
  zone:    "all",
  enabled: false,
  opacity: 0.5,
  bounds:  null,
  b64:     null,
  wms: {
    url:    "https://example.arcgis.com/arcgis/rest/services/MyService/MapServer/export",
    layers: "show:0"
  }
}
```

3. Save and reload — the layer will appear in the Overlays panel and refresh automatically on map move/zoom

---

## How To: Add a New Zone

1. Open `overlays.js`
2. Add a new entry to the `ZONES` array with a unique `id`, a display `label`, and the geographic `bounds`
3. Add overlay entries for that zone using the same zone `id`
4. In `data.js`, add listings with the matching `zone` field value
5. Save both files and reload

---

## Live Data Sources

| Layer | Source | Endpoint |
|---|---|---|
| NSW SRLUP | NSW Dept of Environment | `mapprod3.environment.nsw.gov.au/…/EDP/SRLUP/MapServer` |
| NSW Land Zoning (LEP) | NSW Planning Portal | `mapprod3.environment.nsw.gov.au/…/Planning/EPI_Primary_Planning_Layers/MapServer` |
| Address geocoding | ArcGIS World Geocoder | `geocode.arcgis.com/…/GeocodeServer` |
| Reverse geocoding | ArcGIS World Geocoder | `geocode.arcgis.com/…/GeocodeServer/reverseGeocode` |
| Lot/DP cadastre | NSW Spatial Services (SIX Maps) | `maps.six.nsw.gov.au/…/sixmaps/Cadastre/MapServer` |
| Parcel geometry | NSW Spatial Services (SIX Maps) | `maps.six.nsw.gov.au/…/sixmaps/Cadastre/MapServer/0/query` |
| Satellite imagery | Esri World Imagery | `server.arcgisonline.com/…/World_Imagery/MapServer` |

All live data sources are publicly accessible with no API key required.

---

## Current Zones

| Zone ID | Label | Status |
|---|---|---|
| `all` | All Zones | Always available — shows all listings |
| `south-west-sydney` | South West Sydney | Active — awaiting GeoTIFF uploads |

---

## Dependencies

All loaded via CDN — no build step or package manager required.

| Library | Version | Purpose |
|---|---|---|
| [Leaflet](https://leafletjs.com/) | 1.9.4 | Interactive map |
| [geotiff.js](https://geotiffjs.github.io/) | 2.1.3 | GeoTIFF parsing and bounds extraction |
| [CartoDB Light](https://carto.com/basemaps/) | — | Street map base tiles |
| [Esri World Imagery](https://www.arcgis.com/) | — | Satellite base tiles |
| [DM Sans + DM Serif Display](https://fonts.google.com/) | — | Typography |

---

## Potential Next Steps

- **Height of Buildings / Floor Space Ratio overlays** — available on the same NSW Planning Portal MapServer (`EPI_Primary_Planning_Layers`, layers 4 and 5)
- **Heritage overlay** — also on the same MapServer (layer 3)
- **Export property details** — save popup information to PDF or clipboard
- **Live listing data** — connect `data.js` to a Google Sheet or headless CMS instead of hardcoded entries
- **Valuer General land values** — available via NSW spatial data APIs
