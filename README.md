# Sydney Property Map — V56

A browser-based interactive property map overlaying live Domain.com.au listings with planning, environmental and infrastructure data across Sydney's growth corridors. Deployed on Vercel with a Neon Postgres database for persistent pipeline storage.

---

## V56 Baseline — What's New
- **Live Domain API** — listings fetched from Domain Developer API (`POST /v1/listings/residential/_search`)
- **Viewport-based search** — Domain search uses the current map bounds as a `geoWindow` bounding box, refreshing on pan/zoom (600ms debounce)
- **Selection-aware search** — if a parcel is selected, search centres on that property; falls back to map viewport
- **100 listing cap** — max 100 results per search to avoid overloading
- **Server-side proxy** — `api/domain-search.js` keeps API key out of the browser (`DOMAIN_API_KEY` env var)
- **Correct field mapping** — normaliser uses actual Domain API field names (`propertyDetails.latitude`, `displayableAddress`, `summaryDescription`, `priceFrom/priceTo`, `listingSlug`)
- **Enrichment cache** — `_enrichmentCache` populated after each search for synchronous badge/link lookups in map.js

---

## File Structure

```
sydney-property-map/
├── api/
│   ├── pipeline.js                  — Pipeline CRUD (Neon Postgres)
│   ├── domain-search.js             — Domain API proxy (keeps key server-side)
│   ├── tiles.js                     — NSW tile proxy
│   └── topo-style.js                — NSW topo style proxy
├── index.html                       — Page structure and UI
├── styles.css                       — All styling
├── overlays-meta.js                 — Overlay and zone definitions
├── overlays-b64-sw-wastewater.js    — SW Sydney wastewater GeoTIFF (b64)
├── overlays-b64-sw-potable.js       — SW Sydney potable water GeoTIFF (b64)
├── overlays-b64-sw-ilp.js           — Leppington ILP GeoTIFF (b64)
├── gsp-wsa-sw-wastewater.js         — WSA wastewater vector data
├── WSA_SW_Wastewater_Precincts.geojson
├── data.js                          — Static fallback listings (49 properties)
├── domain-api.js                    — Domain API client (live + mock modes)
├── map.js                           — Map logic, overlays, search, listings
├── kanban.js                        — Pipeline Kanban board
├── package.json                     — Dependencies (@neondatabase/serverless)
├── vercel.json                      — Vercel routing config
├── DEPLOY.md                        — Deployment guide
└── README.md                        — This file
```

---

## Environment Variables (Vercel)
| Variable | Description |
|---|---|
| `DOMAIN_API_KEY` | Domain Developer API key |
| `POSTGRES_URL` | Neon database connection string (auto-injected) |

---

## Features

### Map & Navigation
- Leaflet map centred on Greater Sydney
- Basemap toggle — Map / Satellite / Topo (NSW 1:25k–1:100k)
- Address search with autocomplete (ArcGIS geocoder)
- Map click to identify property — address, LGA, Lot/DP, zoning, flood data
- Parcel boundary drawn on selection

### Listings
- Live Domain API listings for the current map viewport
- Refreshes on pan/zoom with 600ms debounce
- Falls back to static `data.js` if API unavailable
- Filter by type: All / House / Apartment / Land
- Add to pipeline from listing card

### Overlays
Grouped into: Zoning, Environmental, Transport, Services, Western Parkland City (SEPP 2021)

| Group | Overlays |
|---|---|
| Zoning | NSW Land Zoning (LEP), SRLUP |
| Environmental | Flood Planning, Biodiversity Values, Bushfire Prone Land |
| Transport | Future Road Reservations, Rail & Infrastructure Corridors |
| Services | Electricity Transmission, Wastewater SW, Potable Water SW |
| Western Parkland City | Floor Space Ratio, Land Zoning, Height, Flood, Heritage, and more |

### Pipeline (Kanban)
- Six columns: Shortlisted → Under DD → Offer → Acquired / Not Suitable / Lost
- Drag and drop cards between columns
- Notes field per card (autosaves)
- Persistent via Neon Postgres with localStorage fallback

---

## Deployment
See `DEPLOY.md` for full setup guide.
