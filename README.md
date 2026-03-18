# Sydney Property Map

A browser-based interactive property map overlaying Domain listings with Sydney Water planning maps and NSW Indicative Layout Plans (ILPs) across Sydney's growth corridors.

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

## File Descriptions

### `index.html`
The main HTML file that ties everything together. Defines the page structure including the header controls (zone selector, overlays panel, listings toggle, and upload manager), the Leaflet map container, and the listings sidebar. Loads scripts in the correct order: Leaflet → geotiff.js → overlays.js → data.js → map.js.

**When to edit:** Adding new UI elements to the header or sidebar, or changing the overall page layout.

---

### `styles.css`
All CSS for the application — layout, header, sidebar, listing cards, overlay panel, upload manager form, and Leaflet popup overrides. Uses CSS custom properties (variables) defined in `:root` for colours, making it easy to retheme the app by changing values in one place.

**When to edit:** Any visual or layout changes — colours, spacing, typography, panel sizing, etc.

---

### `overlays.js`
**The main file you will edit most often.** Contains two key data structures:

**`OVERLAYS` array** — each entry defines one map overlay. Fields:

| Field | Description |
|---|---|
| `id` | Unique identifier string (e.g. `"sw-wastewater"`) |
| `label` | Display name shown in the Overlays panel |
| `type` | One of: `"wastewater"`, `"potable"`, `"ilp"`, `"other"` |
| `zone` | Must match a zone `id` in the `ZONES` array below |
| `enabled` | `true` = visible by default, `false` = hidden by default |
| `opacity` | Default opacity between `0` (invisible) and `1` (fully opaque) |
| `bounds` | Geographic bounds `{ latMin, latMax, lonMin, lonMax }` — extracted automatically from GeoTIFF on upload. Set to `null` until populated. |
| `b64` | Base64-encoded PNG — generated automatically from GeoTIFF on upload. Set to `null` until populated. |

**`ZONES` array** — each entry defines a named geographic zone:

| Field | Description |
|---|---|
| `id` | Unique identifier string (e.g. `"south-west-sydney"`) |
| `label` | Display name in the zone dropdown |
| `bounds` | Map bounds the view pans/zooms to when this zone is selected. Set to `null` for "All Zones". |

**`OVERLAY_TYPE_META`** — display colour for each overlay type pill in the UI.

**When to edit:** Adding new zones, changing which overlays are on by default, or pasting in manually prepared base64 data.

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

**When to edit:** Adding, removing, or updating property listings. When adding listings for a new zone, set `zone` to match the zone `id` in `overlays.js`.

---

### `map.js`
The application logic layer. Handles:

- **Leaflet map initialisation** — tile layer, zoom, starting position
- **GeoTIFF parsing** — reads uploaded `.tif` files using geotiff.js, extracts geographic bounds automatically from the file's embedded metadata, and rasterises the image to PNG for display in Leaflet
- **Overlay rendering** — reads the `OVERLAYS` array, creates Leaflet image overlay layers, manages show/hide/opacity per overlay
- **Zone selector** — populates the dropdown from `ZONES`, filters listings, and pans the map to the selected zone's bounds
- **Listings rendering** — builds sidebar cards and map markers, applying zone + property type filters
- **Panel UI** — opens/closes the Overlays panel and Upload Manager panel
- **Upload Manager** — reads a GeoTIFF, extracts bounds + converts to PNG automatically, and either adds it to the map live (current session) or downloads an updated `overlays.js` for permanent use
- **Overlay management** — allows removing overlays from the current session via the Upload Manager panel

**When to edit:** Changes to map behaviour, filtering logic, marker appearance, or upload/download workflow. Rarely needed for day-to-day content updates.

---

## How To: Add a New Overlay Map

### Option A — Upload a GeoTIFF via the browser (recommended)
1. Click **⬆ Upload Map** in the header
2. Enter a label, select the overlay type, and enter the zone id
3. Select your **GeoTIFF file** (`.tif` / `.tiff`) — bounds are extracted automatically from the file's georeferencing metadata and shown as a preview
4. Click **Add to map (this session)** to see it immediately
5. Click **Download updated overlays.js** to get a new `overlays.js` with the image embedded — replace your existing file with this one to make it permanent

> **GeoTIFF requirement:** The file must use **WGS84 (EPSG:4326)** geographic coordinates. If your file uses a projected CRS (e.g. MGA2020 / GDA94 / UTM), re-export it in WGS84 first using QGIS or similar before uploading.

### Option B — Edit overlays.js directly
1. Open `overlays.js`
2. Copy an existing entry in the `OVERLAYS` array
3. Set a unique `id`, `label`, `type`, `zone`, and `opacity`
4. Fill in `bounds` manually: `{ latMin, latMax, lonMin, lonMax }`
5. Paste a base64-encoded PNG string into `b64`
6. Save and reload

---

## How To: Add a New Zone

1. Open `overlays.js`
2. Add a new entry to the `ZONES` array with a unique `id`, a display `label`, and the geographic `bounds`
3. Add any overlay entries for that zone to the `OVERLAYS` array using the same zone `id`
4. In `data.js`, add listings with the matching `zone` field value
5. Save both files and reload

---

## Overlay Types

| Type | Colour | Description |
|---|---|---|
| `wastewater` | Blue | Sydney Water wastewater/sewerage planning maps |
| `potable` | Green | Sydney Water potable (drinking) water planning maps |
| `ilp` | Purple | NSW Indicative Layout Plans |
| `other` | Grey | Any other overlay type |

---

## Current Zones

| Zone ID | Label | Status |
|---|---|---|
| `all` | All Zones | Always available — shows all listings |
| `south-west-sydney` | South West Sydney | Active — awaiting GeoTIFF uploads |

More zones will be added in future versions.

---

## Dependencies

All loaded via CDN — no build step or package manager required.

| Library | Version | Purpose |
|---|---|---|
| [Leaflet](https://leafletjs.com/) | 1.9.4 | Interactive map |
| [geotiff.js](https://geotiffjs.github.io/) | 2.1.3 | GeoTIFF parsing and bounds extraction |
| [CartoDB Light](https://carto.com/basemaps/) | — | Base map tiles |
| [DM Sans + DM Serif Display](https://fonts.google.com/) | — | Typography |
