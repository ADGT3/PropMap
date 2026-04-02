# Sydney Property Map

A browser-based interactive property map overlaying listings with planning, environmental and infrastructure data across Sydney's growth corridors. Deployed on Vercel with a Neon Postgres database for persistent pipeline storage.

---

## File Structure

```
sydney-property-map/
├── api/
│   ├── pipeline.js     — Vercel serverless API: pipeline CRUD (Neon Postgres)
│   └── health.js       — Vercel serverless API: DB connection health check
├── index.html          — Page structure and UI layout
├── styles.css          — All visual styling
├── overlays.js         — Map overlay definitions and zone configurations
├── data.js             — Property listings data (49 listings, South West Sydney)
├── domain-api.js       — Mock Domain API (swap to live when API key arrives)
├── map.js              — Map logic, overlays, search, parcel boundary, listings
├── kanban.js           — Pipeline Kanban board with DB persistence
├── package.json        — Node dependencies (@neondatabase/serverless)
├── vercel.json         — Vercel deployment configuration
├── DEPLOY.md           — Vercel + Neon setup guide
└── README.md           — This file
```

---

## Features

### Map & Navigation
- **Interactive Leaflet map** centred on Greater Sydney
- **Basemap toggle** — Map (CartoDB Light) / Satellite (Esri) / Topo (NSW Spatial Services 1:25k–1:100k)
- **Address search** — ArcGIS geocoder with autocomplete, supports full street addresses. Drops a pin, flies to location, draws parcel boundary
- **Map click** — Click anywhere to identify a property: shows address, LGA, Lot/DP, and active overlay data (zoning, SRLUP, flood). Draws parcel boundary polygon
- **Parcel boundary** — Green outline drawn on map when a listing card or address search result is selected, fetched from NSW Cadastre

### Property Information Popup
- Street address (reverse geocoded)
- LGA — Local Government Area
- Lot/DP — fetched from NSW Spatial Services cadastre
- Land Zoning — zone code, land use class, LEP name (when overlay active)
- NSW Planning Zone — SRLUP growth area details (when overlay active)
- Flood Planning — classification and EPI name (when overlay active)

### Overlays Panel
Click **🗺 Overlays** in the header. Overlays are grouped into three categories:

#### Zoning
| Overlay | Source |
|---|---|
| NSW Land Zoning (LEP) | NSW Planning Portal — EPI Primary Planning Layers |
| NSW Strategic Regional Land Use Policy | NSW Environment — SRLUP MapServer |
| ILP (Indicative Layout Plans) | GeoTIFF upload |

#### Services
| Overlay | Source |
|---|---|
| Wastewater — South West Sydney | GeoTIFF upload |
| Potable Water | GeoTIFF upload |

#### Environmental
| Overlay | Source |
|---|---|
| NSW Flood Planning (EPI) | NSW Planning Portal — Hazard MapServer |
| Biodiversity Values Map | NSW LMBC — BiodiversityValues MapServer (tiled) |
| Bushfire Prone Land | NSW Planning Portal — Planning_Portal_Hazard MapServer |

Each overlay has a checkbox, opacity slider, and **Hide all / Show all** toggle. Live ArcGIS overlays refresh automatically on map pan/zoom.

### Legend
- Collapsible — click the **Legend** header bar to hide/show
- State saved to localStorage across page refreshes
- Covers: Sydney Water Planning, NSW Strategic Land Use, Flood Planning, Biodiversity & Bushfire, NSW Land Zoning

### Listings Sidebar
- Shows all property listings visible in the current map view
- Filter by type: All / House / Apartment / Land
- Each card shows price, address, suburb, property type, and agent info (mock Domain data)
- **⊕ button** on each card to add to the pipeline
- Click a card to select it, fly to location, and draw parcel boundary
- **Search result card** persists at top of sidebar when address search is used

### Domain API (Mock)
- Enriches all listings with realistic mock data: agency, agent name/avatar, days on market, photos, description
- Deterministic — same listing always gets same mock data
- Switch to live: set DOMAIN_API_MOCK = false and add your key in domain-api.js

### Address Search
- ArcGIS World Geocoder with autocomplete
- Supports full street addresses including house numbers
- Search result shown in sidebar with Lot/DP, LGA, and links to Domain/REA/Pricefinder
- **+ Add to Pipeline** button on search result card
- Clear button removes pin, parcel boundary, and sidebar card

### Upload Manager
Click **⬆ Upload Map** to add custom GeoTIFF overlays:
1. Enter label, type, and zone id
2. Select a WGS84 GeoTIFF — bounds extracted automatically
3. **Add to map** for live preview, or **Download updated overlays.js** to save permanently

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
