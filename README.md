# Sydney Property Map

A browser-based interactive property map overlaying listings with planning, environmental and infrastructure data across Sydney's growth corridors. Deployed on Vercel with a Neon Postgres database for persistent pipeline storage.

**Current baseline: v52**

---

## Local Development

No build step required. Open `index.html` directly in a browser — all map, overlay, search and Domain mock functionality works locally. The only feature requiring a server is pipeline persistence (Neon Postgres), which falls back to localStorage automatically when offline.

If you hit CORS issues in Chrome loading from `file://`, run a local server instead:
```bash
npx serve .
# or
python3 -m http.server 8080
```

---

## File Structure

```
sydney-property-map/
├── api/
│   ├── pipeline.js               — Vercel serverless API: pipeline CRUD (Neon Postgres)
│   └── health.js                 — Vercel serverless API: DB connection health check
├── images/
│   ├── favicon.ico               — Multi-size ICO favicon (16×16 – 256×256)
│   ├── favicon-16x16.png         — Browser tab favicon
│   ├── favicon-32x32.png         — Browser tab favicon (retina)
│   ├── favicon-180x180.png       — Apple Touch Icon (iOS home screen)
│   ├── favicon-192x192.png       — Android / PWA icon
│   └── favicon-512x512.png       — PWA splash icon
├── index.html                    — Page structure and UI layout
├── styles.css                    — All visual styling
├── overlays-meta.js              — Overlay definitions and zone configurations (no image data)
├── overlays-b64-sw-wastewater.js — Wastewater overlay image data
├── overlays-b64-sw-potable.js    — Potable water overlay image data
├── overlays-b64-sw-ilp.js        — ILP overlay image data
├── data.js                       — Property listings data (49 listings, South West Sydney)
├── domain-api.js                 — Mock Domain API (swap to live when API key arrives)
├── map.js                        — Map logic, overlays, search, parcel boundary, listings
├── kanban.js                     — Pipeline Kanban board with DB persistence
├── split-overlays.js             — Node script to split overlays.js into meta + b64 files
├── package.json                  — Node dependencies (@neondatabase/serverless)
├── vercel.json                   — Vercel deployment configuration
├── DEPLOY.md                     — Vercel + Neon setup guide
└── README.md                     — This file
```

### Overlay File Structure

Overlay data is split into separate files to keep individual files small enough to work with:

- **`overlays-meta.js`** — all overlay definitions with `b64: null`. This is the file to share or edit when adding/changing overlays.
- **`overlays-b64-{id}.js`** — one file per image overlay, containing only the base64 image data for that overlay. These files are never edited directly.

`map.js` merges them at runtime:
```javascript
OVERLAYS.forEach(o => { if (window.OVERLAY_B64?.[o.id]) o.b64 = window.OVERLAY_B64[o.id]; });
```

To split a new or updated `overlays.js` into the separate files, run:
```bash
node split-overlays.js
```

---

## Features

### Map & Navigation
- **Interactive Leaflet map** centred on Greater Sydney
- **Basemap toggle** — Map (CartoDB Light) / Satellite (Esri) / Topo (NSW Spatial Services 1:25k–1:100k)
- **Address search** — ArcGIS geocoder with autocomplete, supports full street addresses. Flies to location, drops a pin, draws parcel boundary
- **Map click** — Click anywhere to identify a property: shows address, LGA, Lot/DP, lot size, zoning, and active overlay data. Draws parcel boundary polygon
- **Parcel boundary** — Green outline drawn on map whenever a property is selected, fetched from NSW Cadastre

### Unified Property Selection
All three selection paths — clicking a map marker, clicking a listing card, or selecting an address search result — route through a single unified handler that:
- Places a pin and opens a consistent popup
- Draws the parcel boundary
- Highlights the matching listing card in the sidebar (if applicable)
- Fetches Lot/DP, lot size, and zoning in parallel

### Property Information Popup
- **Price** — shown when a known listing is selected
- **Address** — from listing data or reverse geocoded
- **LGA** — Local Government Area
- **Lot/DP** — fetched from NSW Spatial Services cadastre (e.g. Lot 10 DP739366)
- **Lot Size** — calculated from parcel boundary rings in m²
- **Zoning** — zone code (e.g. RU1, R2) always shown, regardless of whether the zoning overlay is enabled
- **Overlay detail** — full LEP zoning, SRLUP, flood planning, and future road reservation data when relevant overlays are active
- **Domain link** — direct link to listing when available

### Overlays Panel
Click **🗺 Overlays** in the header. Overlays are grouped into five categories:

#### Zoning
| Overlay | Source |
|---|---|
| NSW Land Zoning (LEP) | NSW Planning Portal — EPI Primary Planning Layers |
| NSW Strategic Regional Land Use Policy | NSW Environment — SRLUP MapServer |
| ILP (Indicative Layout Plans) | GeoTIFF upload (`overlays-b64-sw-ilp.js`) |

#### Services
| Overlay | Source |
|---|---|
| Electricity Transmission Lines | Geoscience Australia — National Electricity Infrastructure MapServer |
| Wastewater — South West Sydney | GeoTIFF upload (`overlays-b64-sw-wastewater.js`) |
| Potable Water — South West Sydney | GeoTIFF upload (`overlays-b64-sw-potable.js`) |

#### Environmental
| Overlay | Source |
|---|---|
| NSW Flood Planning (EPI) | NSW Planning Portal — Hazard MapServer |
| Biodiversity Values Map | NSW LMBC — BiodiversityValues MapServer (tiled) |
| Bushfire Prone Land | NSW Planning Portal — Planning_Portal_Hazard MapServer |
| Airport Noise Contours (ANEC/ANEF) | SEPP (Western Sydney Aerotropolis) 2020 — layer 12 |

#### Transport
| Overlay | Source |
|---|---|
| Future Road Reservations | NSW Planning Portal — EPI Additional Layers MapServer — layer 10 |
| Rail & Infrastructure Corridors (SEPP) | SEPP (Transport and Infrastructure) 2021 — layers 1,2 |

#### SEPP — Western Parkland City 2021
All layers from `SEPP_Precincts_Western_Parkland_City_2021` MapServer on mapprod3. Only renders within the Aerotropolis precinct boundary. Most layers require zoom 12+.

| Overlay | Layer ID | Min Zoom |
|---|---|---|
| Floor Space Ratio (n:1) | 3 | 12+ |
| Land Zoning | 4 | 12+ |
| Minimum Lot Size | 5 | 12+ |
| Height of Building | 6 | 12+ |
| Flood | 7 | 12+ |
| Land Reservation Acquisition | 8 | 12+ |
| Additional Permitted Uses | 9 | 12+ |
| Environmental Conservation Area | 10 | 12+ |
| Native Vegetation Protection | 11 | 12+ |
| Dwelling Density | 12 | 12+ |
| Heritage | 14 | 12+ |
| Riparian Lands and Watercourses | 16 | 12+ |
| Transport & Arterial Road Infrastructure | 21 | 11+ |
| Terrestrial Biodiversity | 23 | 12+ |
| Airport Noise (ANEC/ANEF) | 26 | 10+ |
| 1 in 100 AEP Flood Extents | 40 | 11+ |

Each overlay has a checkbox, opacity slider, and **Hide all / Show all** toggle. Live ArcGIS overlays refresh automatically on map pan/zoom.

### Listings Sidebar
- Shows all property listings visible in the current map view
- Filter by type: All / House / Apartment / Land
- Each card shows price, address, suburb, property type, agent name and agency (from Domain API)
- Click a card to select it — flies to location, draws parcel boundary, opens popup
- Selected listing card is highlighted and pinned to top when selected via search or map click
- **Listings toggle** — turning listings off clears the sidebar panel and disables background re-rendering on map move, improving performance when overlays are the focus

### Measurement Tool
Click **📐 Measure** in the header to open the mode picker:

- **Measure Distance** — click points on the map to draw a line; live running distance shown in tooltip; double-click to finish and display total
- **Measure Area** — click points to draw a polygon; double-click to close and display total area with individual segment lengths labelled on each side
- While measuring, property selection and popups are disabled to avoid interference
- Distances displayed in m or km; areas in m², ha, or km²
- Result stays on the map after finishing — click **📐 Measure** → **Clear** to remove

### Legend
- Collapsible — click the **Legend** header bar to hide/show
- State saved to localStorage across page refreshes
- Covers: Sydney Water Planning, NSW Strategic Land Use, Flood Planning, Biodiversity & Bushfire, NSW Land Zoning

### Domain API
- Currently running in **mock mode** — enriches all listings with deterministic mock data: agency, agent name/avatar, days on market, photos, description
- Switching to live API: set `DOMAIN_API_MOCK = false` and add your key in `domain-api.js`
- When live, map marker placement should be updated to use `dl.geoLocation.latitude/longitude` instead of `data.js` coordinates (with fallback)

### Address Search
- ArcGIS World Geocoder with autocomplete
- Supports full street addresses including house numbers
- On selection: flies to location, places pin, draws parcel boundary, fetches Lot/DP and zoning
- If search result matches a known listing, the listing card is shown in the sidebar in Domain format
- Clear button removes pin, parcel boundary, and sidebar card

### Upload Manager
Click **⬆ Upload Map** to add custom GeoTIFF overlays:
1. Enter label, type, and zone id
2. Select a WGS84 GeoTIFF — bounds extracted automatically
3. **Add to map** for live preview, or **Download overlay files** to save permanently

Downloading produces two files:
- `overlays-meta.js` — updated overlay definitions
- `overlays-b64-{id}.js` — image data for the new overlay

Add the new b64 file to `index.html`:
```html
<script src="overlays-b64-{id}.js"></script>
```

---

## Property Pipeline (Kanban)

Click **⬢ Pipeline** in the header to open the full-screen pipeline board.

### Stages
Shortlisted → Under DD → Offer → Acquired | Not Suitable | Lost

### Board Cards (Summary View)
Each card shows price, address, stage selector, and indicator pills:
- **Terms** — vendor terms have been recorded
- **N Offers** — number of offers submitted
- **DD N/17** — due diligence progress
- **Note** — card has a note

### Card Detail Modal
Click a card to open the full detail modal:

**Vendor Terms**
- Price, Settlement, Deposit Structure (multiple tranches)

**Terms Offered**
- Price, Settlement, Deposit Structure
- **+ Submit Offer** records offer with timestamp
- Full offer history shown newest-first with delete option

**Due Diligence**
17 risk items each with Low / Possible / High dropdown and note:
Zoning, Yield, Access, Sewer, Water, Easements, Electricity, Flooding, Riparian, Vegetation, Contamination, Salinity, Heritage, Aboriginal, Bushfire, Odor, Commercial

**Notes** — freetext, autosaves as you type

### Pipeline Actions
- Drag and drop cards between columns
- Stage dropdown on each card
- **📍 Address link** — populates search, closes pipeline, runs geocode
- **✕ Remove** — removes from pipeline

### Data Persistence
Pipeline data saved to **Neon Postgres** via Vercel serverless API:
- Loads from DB on startup; falls back to localStorage if offline
- Every change saves to DB immediately
- Data survives code deployments

---

## Switching to Live Domain API

When your Domain API key arrives:

1. In `domain-api.js`:
```javascript
const DOMAIN_API_MOCK = false;
const DOMAIN_API_KEY  = 'your-key-here';
```

2. In `map.js`, update marker placement in `makeListingCard` and `renderListings` to use Domain coordinates:
```javascript
const lat = dl ? dl.geoLocation.latitude  : l.lat;
const lng = dl ? dl.geoLocation.longitude : l.lng;
```

---

## Deployment (Vercel + Neon)

See DEPLOY.md for full setup. Summary:

1. Push repo to GitHub
2. Import to Vercel → connect GitHub repo
3. Vercel dashboard → **Storage** → create **Postgres (Neon)** database
4. Connect to project — DATABASE_URL injected automatically
5. Push to deploy
6. Visit /api/health to verify DB connection

---

## Live Data Sources

| Layer | Endpoint |
|---|---|
| NSW Land Zoning (LEP) | mapprod3.environment.nsw.gov.au/…/EPI_Primary_Planning_Layers/MapServer |
| NSW SRLUP | mapprod3.environment.nsw.gov.au/…/EDP/SRLUP/MapServer |
| NSW Flood Planning | mapprod3.environment.nsw.gov.au/…/Planning/Hazard/MapServer |
| Bushfire Prone Land | mapprod3.environment.nsw.gov.au/…/ePlanning/Planning_Portal_Hazard/MapServer |
| Biodiversity Values | www.lmbc.nsw.gov.au/arcgis/rest/services/BV/BiodiversityValues/MapServer |
| Electricity Transmission | services.ga.gov.au/…/National_Electricity_Infrastructure/MapServer |
| Future Road Reservations | mapprod.environment.nsw.gov.au/…/Planning/EPI_Additional_Layers/MapServer |
| Rail Corridors | mapprod3.environment.nsw.gov.au/…/Planning/SEPP_Transport_and_Infrastructure_2021/MapServer |
| Airport Noise | mapprod3.environment.nsw.gov.au/…/Planning/SEPP_Western_Sydney_Aerotropolis_2020/MapServer |
| SEPP Western Parkland City | mapprod3.environment.nsw.gov.au/…/Planning/SEPP_Precincts_Western_Parkland_City_2021/MapServer |
| Address geocoding | geocode.arcgis.com/…/GeocodeServer |
| Lot/DP + parcel boundary | maps.six.nsw.gov.au/…/public/NSW_Cadastre/MapServer/9 |
| Satellite imagery | server.arcgisonline.com/…/World_Imagery/MapServer |
| NSW Topo Map | maps.six.nsw.gov.au/…/public/NSW_Topo_Map/MapServer/tile/{z}/{y}/{x} |

---

## Dependencies

| Library | Version | Purpose |
|---|---|---|
| Leaflet | 1.9.4 | Interactive map |
| @neondatabase/serverless | ^0.10.4 | Neon Postgres client |
| CartoDB Light | — | Street map tiles |
| Esri World Imagery | — | Satellite tiles |
| NSW Topo Map | — | Topographic tiles |
| DM Sans + DM Serif Display | — | Typography |
