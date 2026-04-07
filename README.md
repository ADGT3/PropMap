# Sydney Property Map — V59

A browser-based interactive property map overlaying live Domain.com.au listings with planning, environmental and infrastructure data across Sydney's growth corridors. Deployed on Vercel with a Neon Postgres database for persistent pipeline storage.

---

## File Structure

```
sydney-property-map/
├── api/
│   ├── pipeline.js          — Pipeline CRUD (Neon Postgres)
│   ├── domain-search.js     — Domain API proxy (keeps key server-side)
│   ├── tiles.js             — NSW tile proxy (query params, not path segments)
│   ├── topo-style.js        — NSW topo style proxy (CORS fix)
│   └── health.js            — DB health check endpoint
├── index.html               — Page structure and UI
├── styles.css               — All styling
├── overlays-meta.js         — Overlay definitions, zone config, type metadata
├── overlays-b64-sw-wastewater.js  — SW Sydney wastewater GeoTIFF (b64)
├── overlays-b64-sw-potable.js     — SW Sydney potable water GeoTIFF (b64)
├── overlays-b64-sw-ilp.js         — Leppington ILP GeoTIFF (b64)
├── gsp-wsa-sw-wastewater.js       — WSA wastewater GeoJSON (planning stages)
├── WSA_SW_Wastewater_Precincts.geojson
├── domain-api.js            — Domain API client (live only, no mock)
├── dd-risks.js              — DD risk assessment (queries NSW layers at lat/lng)
├── map.js                   — Map logic, overlays, search, listings, Domain init
├── kanban.js                — Pipeline Kanban board with DD automation
├── package.json             — Dependencies (@neondatabase/serverless), type:module
├── vercel.json              — Vercel routing config
├── DEPLOY.md                — Deployment guide
└── README.md                — This file
```

> **Note:** `data.js` has been removed. Listings come exclusively from the live Domain API.

---

## Environment Variables (Vercel)
| Variable | Description |
|---|---|
| `DOMAIN_API_KEY` | Domain Developer API key (`key_5a7f22b3a6d2d977340624127cf55a34`) — store in Vercel only, never in code |
| `POSTGRES_URL` | Neon database connection string (auto-injected by Vercel) |

---

## Architecture Notes

### Domain API
- **Live only** — no mock mode. `DOMAIN_API_MOCK` removed.
- Proxy route: `api/domain-search.js` uses `export default` (ESM, matches `"type":"module"` in package.json)
- Search uses `geoWindow.box` from current map viewport — refreshes on pan/zoom with 5s debounce
- Capped at 100 results per search
- On 429 rate limit: shows error panel in listings pane with Retry button
- `_enrichmentCache` declared at top of `domain-api.js` — populated after each search

### Tile Proxying
- NSW tiles proxied via `api/tiles.js` using **query params** (`?z=&y=&x=`) — path segments cause Vercel 404s
- `vercel.json` has `/api/tiles/:path*` rewrite as fallback
- Topo style/sprites/glyphs proxied via `api/topo-style.js` to fix browser CORS

### DD Risk Assessment (`dd-risks.js`)
- Runs async in background when a property is added to the pipeline
- Queries NSW ArcGIS layers in parallel at the property's coordinates
- Results pre-populate the Due Diligence section in the Kanban card modal
- Never overwrites user-set values — only fills blank items
- Wastewater uses local point-in-polygon against `GSP_WSA_SW_WW` GeoJSON

| DD Item | Source |
|---|---|
| Zoning | NSW LEP EPI Primary Planning Layers |
| Flooding | NSW Flood Planning (Hazard MapServer) |
| Bushfire | Planning Portal Hazard Layer 229 |
| Vegetation | Biodiversity Values Map (LMBC) |
| Access | Future Road Reservations (EPI Additional Layers) |
| Easements | GA National Electricity Infrastructure |
| Wastewater | Local GSP GeoJSON (point-in-polygon) |

---

## Features

### Map & Navigation
- Leaflet map centred on Greater Sydney
- Basemap toggle — Map (CartoDB) / Satellite (Esri) / Topo (NSW VectorTile Hybrid via MapLibre GL)
- Address search with autocomplete (ArcGIS geocoder)
- Map click to identify property — address, LGA, Lot/DP, zoning, flood, road reservation data
- Parcel boundary drawn on selection (NSW Cadastre)
- Multi-select parcels with numbered pins

### Listings
- Live Domain API listings for the current map viewport (`geoWindow` box search)
- Refreshes on pan/zoom with 5s debounce to respect rate limits
- 100 listing cap per search
- Property thumbnail from Domain media
- Price display: numeric if available, falls back to range, shows "Price Unavailable" if none
- Domain badge (green) links directly to Domain listing page
- Filter panel: Listing Type, Property Type, Price, Land Area, Bedrooms, Bathrooms, Cars, Features, Attributes, Status, deposit/price withheld toggles
- "Exclude deposit taken" ticked by default

### Overlays
Grouped into: Zoning, Environmental, Transport, Services, Western Parkland City (SEPP 2021)

| Group | Overlays |
|---|---|
| Zoning | NSW Land Zoning (LEP), SRLUP |
| Environmental | Flood Planning, Biodiversity Values, Bushfire Prone Land |
| Transport | Future Road Reservations, Rail & Infrastructure Corridors |
| Services | Electricity Transmission, Wastewater SW, Potable Water SW |
| Western Parkland City | Floor Space Ratio, Land Zoning, Height, Flood, Heritage, Riparian, and more |

### Pipeline (Kanban)
- Six columns: Shortlisted → Under DD → Offer → Acquired / Not Suitable / Lost
- Drag and drop cards between columns
- DD risk auto-population on property add (async, from `dd-risks.js`)
- DD items: Zoning, Yield, Access, Wastewater, Water, Easements, Electricity, Flooding, Riparian, Vegetation, Contamination, Salinity, Heritage, Aboriginal, Bushfire, Odor, Commercial
- Click property address on card to fly map to that location
- Notes field per card (autosaves)
- Persistent via Neon Postgres with localStorage fallback

---

## Deployment
See `DEPLOY.md` for full setup guide.
