# Sydney Property Map — V63

A browser-based interactive property map overlaying live Domain.com.au listings with planning, environmental and infrastructure data across Sydney's growth corridors. Deployed on Vercel with a Neon Postgres database for persistent pipeline and CRM storage.

---

## File Structure

```
sydney-property-map/
├── api/
│   ├── pipeline.js          — Pipeline CRUD (Neon Postgres)
│   ├── contacts.js          — CRM Contacts CRUD (Neon Postgres)
│   ├── db-setup.js          — One-time DB schema setup endpoint
│   ├── domain-search.js     — Domain API proxy (keeps key server-side)
│   ├── tiles.js             — NSW tile proxy (query params, not path segments)
│   ├── topo-style.js        — NSW topo style proxy (CORS fix)
│   └── cadastre.js          — National parcel boundary proxy (state-aware)
│   └── health.js            — DB health check endpoint
├── index.html               — Page structure and UI
├── styles.css               — All styling (includes timestamped notes styles)
├── crm.js                   — CRM contact management module
├── crm-styles.css           — CRM-specific styles
├── overlays-meta.js         — Overlay definitions, zone config, type metadata
├── overlays-b64-sw-wastewater.js  — SW Sydney wastewater GeoTIFF (b64)
├── overlays-b64-sw-potable.js     — SW Sydney potable water GeoTIFF (b64)
├── overlays-b64-sw-ilp.js         — Leppington ILP GeoTIFF (b64)
├── gsp-wsa-sw-wastewater.js       — WSA wastewater GeoJSON (planning stages)
├── WSA_SW_Wastewater_Precincts.geojson
├── domain-api.js            — Domain API client (live only, no mock)
├── dd-risks.js              — DD risk assessment (queries NSW layers at lat/lng)
├── map.js                   — Map logic, overlays, search, listings, Domain init
├── kanban.js                — Pipeline Kanban board with DD automation and CRM
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
| `DOMAIN_API_KEY` | Domain Developer API key — store in Vercel only, never in code |
| `POSTGRES_URL` | Neon database connection string (auto-injected by Vercel) |

---

## Database Setup

### 1. Create a Neon database

1. Go to [neon.tech](https://neon.tech) and sign in (free tier is sufficient)
2. Click **New Project** → give it a name (e.g. `sydney-property-map`) → **Create Project**
3. On the project dashboard, copy the **Connection string** — it looks like:
   ```
   postgresql://user:password@ep-xxx.ap-southeast-1.aws.neon.tech/neondb?sslmode=require
   ```

### 2. Connect Neon to Vercel

**Option A — Vercel Neon Integration (recommended):**
1. In your Vercel project → **Settings** → **Integrations** → search **Neon** → **Add Integration**
2. Authorise and select your Neon project
3. Vercel automatically injects `POSTGRES_URL` (and several aliases) into your environment variables

**Option B — Manual:**
1. In Vercel → **Settings** → **Environment Variables**
2. Add `POSTGRES_URL` = your Neon connection string (all environments)
3. Redeploy for the variable to take effect

### 3. Create tables

Run once after deployment. Open browser console on the deployed site and run:

```javascript
fetch('/api/db-setup', { method: 'POST' })
  .then(r => r.json())
  .then(console.log)
```

Expected response — all `ok: true`:
```json
{
  "allOk": true,
  "results": [
    { "ok": true, "stmt": "CREATE TABLE pipeline" },
    { "ok": true, "stmt": "CREATE TABLE contacts" },
    { "ok": true, "stmt": "CREATE TABLE contact_properties" },
    { "ok": true, "stmt": "CREATE INDEX contacts_name_idx" },
    { "ok": true, "stmt": "Create INDEX contacts_email_idx" },
    { "ok": true, "stmt": "CREATE INDEX contacts_company_idx" },
    { "ok": true, "stmt": "CREATE INDEX contact_properties_pipeline_idx" }
  ]
}
```

Safe to re-run — all statements use `IF NOT EXISTS`.

### 4. Verify setup

Check tables exist and Neon connection is healthy:

```javascript
// Check all three tables are present
fetch('/api/db-setup')
  .then(r => r.json())
  .then(d => {
    console.log('pipeline:           ', d.pipeline_ready           ? '✓' : '✗');
    console.log('contacts:           ', d.contacts_ready           ? '✓' : '✗');
    console.log('contact_properties: ', d.contact_properties_ready ? '✓' : '✗');
  });
```

```javascript
// Check DB health endpoint
fetch('/api/health')
  .then(r => r.json())
  .then(console.log);
```

```javascript
// Verify pipeline API is reading/writing (returns {} if empty)
fetch('/api/pipeline')
  .then(r => r.json())
  .then(d => console.log('Pipeline items:', Object.keys(d).length));
```

```javascript
// Verify contacts API is live (returns [] if empty)
fetch('/api/contacts')
  .then(r => r.json())
  .then(d => console.log('Contacts:', d.length));
```

All four should respond without errors. If any return a 500, check `POSTGRES_URL` is set correctly in Vercel environment variables and redeploy.

### Schema

```sql
-- Pipeline items (existing)
pipeline (id TEXT PK, data JSONB, updated_at TIMESTAMPTZ)

-- CRM contacts
contacts (
  id         SERIAL PK,
  first_name TEXT NOT NULL,
  last_name  TEXT DEFAULT '',
  mobile     TEXT DEFAULT '',
  email      TEXT DEFAULT '',
  company    TEXT DEFAULT '',
  source     TEXT DEFAULT 'manual',   -- 'manual' | 'domain_agent' | 'referrer'
  domain_id  TEXT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
)

-- Contact ↔ Pipeline junction (many-to-many)
contact_properties (
  contact_id  INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
  pipeline_id TEXT,
  role        TEXT DEFAULT 'referrer', -- 'listing_agent' | 'referrer' | 'buyer_agent'
  linked_at   TIMESTAMPTZ,
  PRIMARY KEY (contact_id, pipeline_id)
)
```

---

## Architecture Notes

### Domain API
- **Live only** — no mock mode
- Proxy route: `api/domain-search.js` uses `export default` (ESM, matches `"type":"module"` in package.json)
- Search uses `geoWindow.box` from current map viewport — refreshes on pan/zoom with 1.5s debounce
- Capped at 100 results per search
- On 429 rate limit: shows error panel in listings pane with Retry button
- `_enrichmentCache` and `_addressCache` (keyed by normalised address) populated after each search
- `DomainAPI.getEnrichedByAddress(address)` — address-based cache lookup exposed for CRM backfill

### Listing ↔ Pipeline Linkage
- `map.js` exposes `window.matchListingByAddress`, `window.runDomainSearchAt`, `window.getListings`, `window.fetchLotDP` for use by `kanban.js` and `crm.js`
- **Address-string matching** (`matchListingByAddress`) normalises street type abbreviations (Rd→Road, St→Street, etc.) and matches in three passes: street + suburb → street only → Lot/DP
- **`runDomainSearchAt(lat, lng, address, suburb)`** — fires an immediate (no debounce) Domain search centred on a point, waits for results, then matches by address string. Used by address search and pipeline card modal
- **`_suppressNextDomainSearch`** flag prevents duplicate Domain searches triggered by programmatic map moves (selectListing, flyTo)
- Viewport Domain search debounce reduced from 5s → 1.5s

### Address Search → Listing Panel Flow
1. User selects address from geocoder autocomplete
2. Map flies to location (moveend Domain search suppressed)
3. `runDomainSearchAt` fires immediately, waits for Domain results
4. `matchListingByAddress` finds matching listing by address string
5. Listing highlighted/scrolled-to in panel; if not in current results, pinned as search card at top
6. If no address match, `_pendingAddressMatch` set — cadastre Lot/DP match attempted when cadastre returns (state-aware via `api/cadastre.js`)


### Cadastre — Parcel Boundary (`api/cadastre.js`)
- Server-side proxy routes parcel boundary queries to the correct state cadastre service based on lat/lng
- `map.js` calls `/api/cadastre?state=NSW&lat=...&lng=...` — no direct browser requests to state ArcGIS servers (CORS)
- Address search and map clicks both use this proxy for boundary drawing and Lot/DP lookup

| State | Boundary | Lot ID | Source |
|---|---|---|---|
| NSW | ✓ | ✓ | maps.six.nsw.gov.au — NSW Cadastre MapServer |
| QLD | ✓ | ✓ | spatial-gis.information.qld.gov.au — DCDB, updated nightly |
| VIC | ✓ | ✓ | services-ap1.arcgis.com — Vicmap Parcel FeatureServer |
| WA | ✓ | ✗ | services.slip.wa.gov.au — geometry only (lot ID requires Landgate subscription) |
| ACT | pending | pending | data.actmapi.act.gov.au — endpoint under investigation |
| SA | ✗ | ✗ | Paywalled — Land Services SA charges min. $250 for cadastre access |
| TAS | ✗ | ✗ | Pending — no verified public endpoint yet |
| NT | ✗ | ✗ | Pending — no verified public endpoint yet |

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

### CRM (`crm.js` + `api/contacts.js`)
- Contacts stored as first-class DB entities in the `contacts` table
- Many-to-many relationship with pipeline items via `contact_properties` junction table
- Three contact roles: **Listing Agent**, **Referrer**, **Buyer's Agent**
- `window.CRM.renderContactsSection(pipelineId, agentData)` — renders collapsible Contacts section in kanban modal
- Domain agent (from `p._agent`) shown as first read-only row with 💾 one-tap save to contacts DB
- Existing contacts searchable by name, company, email — link to property with role selector
- `api/contacts.js` endpoints: GET (list/search/by-pipeline), POST (create/link/unlink), PUT (update), DELETE (cascades junction rows)

---

## Features

### Map & Navigation
- Leaflet map centred on Greater Sydney
- Basemap toggle — Map (CartoDB) / Satellite (Esri) / Topo (NSW VectorTile Hybrid via MapLibre GL)
- Address search with autocomplete (ArcGIS geocoder)
- Map click to identify property — address, LGA, Lot/DP, zoning, flood, road reservation data
- Parcel boundary drawn on selection (state-aware — see Cadastre Coverage below)
- Multi-select parcels with numbered pins

### Listings
- Live Domain API listings for the current map viewport (`geoWindow` box search)
- Refreshes on pan/zoom with 1.5s debounce
- 100 listing cap per search
- Property thumbnail from Domain media
- Price display: numeric if available, falls back to range, then vendor terms price, then "Price Unavailable"
- Domain badge (green) links directly to Domain listing page
- Address search result highlighted in listings panel; pinned at top if not in current viewport results
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
- Card price shows vendor terms price as fallback when listing price unavailable
- Price fields (vendor terms, offer) auto-format to whole dollars on blur/submit
- Settlement fields accept days/months/years — converted to days on save (e.g. "3 months" → "90 days")
- Deposit fields accept free text (dollars or percentage)
- Click property address on card to fly map to that location
- Persistent via Neon Postgres with localStorage fallback

### Pipeline Card Modal
- **Header**: Price → address → Lot/DP (async backfill via state cadastre if missing) → Domain link
- **Contacts section** (collapsible, first in body):
  - Domain listing agent shown as first read-only row (name, agency, phone/email as tappable links)
  - 💾 button saves Domain agent to CRM contacts DB with one tap
  - Additional contacts (referrers, buyer's agents) linked from CRM with role badges
  - Add form with existing-contact search or create-new flow
- **Vendor Terms**: price, settlement, deposit structure
- **Terms Offered**: offer price, settlement, deposit — logged as history
- **Due Diligence**: per-item risk level and notes
- **Notes**: timestamped entries in reverse-chronological order; Ctrl/Cmd+Enter to submit; individual note deletion

### Agent / Contact Data Flow
- When a Domain listing is matched to a pipeline property, `_agent` (name, agency, phone, email) and `_listingUrl` are stored on `pipeline[id].property` and persisted to Neon
- `resolveFromDomain()` runs async on modal open — tries address match against current listings, falls back to `runDomainSearchAt` if needed
- `backfillAgentFromCache()` runs after every Domain viewport search — backfills agent data on all pipeline items that currently lack it
- Lot/DP backfilled async from state cadastre on property add if not already captured

---

## Deployment
See `DEPLOY.md` for full setup guide.

---

## Version History

| Version | Notes |
|---|---|
| V63 | State-aware parcel boundary proxy (`api/cadastre.js`). NSW, QLD, VIC, WA boundaries working interstate. Address search works nationally. |
| V62 | CRM module (contacts DB, collapsible modal section, Domain agent save). Timestamped notes with reverse-chronological history. Lot/DP async backfill. Agent/listingUrl stored on pipeline items. Address-string listing match (normalised, 3-pass). `runDomainSearchAt` for immediate post-search address lookup. Domain search debounce 5s→1.5s. `_suppressNextDomainSearch` flag. Listing panel highlight after address search. `api/contacts.js`, `api/db-setup.js`, `crm.js`, `crm-styles.css` added. |
| V60 | Domain API live (no mock). Viewport geoWindow search, 1.5s debounce, 100 cap. `dd-risks.js` for DD automation. Topo = NSW VectorTile Hybrid via MapLibre GL. Tiles proxied via `api/tiles.js` query params. |
