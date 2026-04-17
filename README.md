# Sydney Property Map — V74

A browser-based interactive property map overlaying live Domain.com.au listings with planning, environmental and infrastructure data across Sydney's growth corridors. Deployed on Vercel with a Neon Postgres database for persistent pipeline and CRM storage.

---

## File Structure

```
sydney-property-map/
├── middleware.js            — Edge middleware: gates every request with session-cookie check (V74)
├── login.html               — Branded sign-in page (V74)
├── api/
│   ├── auth/
│   │   ├── login.js         — Verifies credentials, issues session cookie (V74)
│   │   ├── logout.js        — Clears session cookie (V74)
│   │   ├── me.js            — Returns current session user (V74, public endpoint)
│   │   ├── set-password.js  — Set/change contact password (admin or self) (V74)
│   │   └── update-access.js — Toggle can_login / is_admin / access_modules (admin only) (V74)
│   ├── pipeline.js          — Pipeline CRUD (Neon Postgres)
│   ├── contacts.js          — CRM Contacts CRUD (Neon Postgres)
│   ├── finance-api.js       — Financial model CRUD (Neon Postgres, property_financials table)
│   ├── db-setup.js          — One-time DB schema setup endpoint (now includes auth columns)
│   ├── domain-search.js     — Domain API proxy (keeps key server-side)
│   ├── tiles.js             — NSW tile proxy (query params, not path segments)
│   ├── topo-style.js        — NSW topo style proxy (CORS fix)
│   └── health.js            — DB health check endpoint
├── lib/
│   └── auth.js              — Shared JWT sign/verify, cookie helpers, session guards (V74)
├── scripts/
│   └── hash-password.mjs    — Local utility: generates bcrypt hash for fallback env var (V74)
├── finance/
│   ├── finance-module.js    — Financial feasibility calculator, UI, DB persistence
│   └── finance-styles.css   — Finance module styles
├── index.html               — Page structure and UI (now with user menu in header)
├── styles.css               — All styling (includes user menu styles)
├── crm.js                   — CRM contact management module (now with Site Access section)
├── crm-styles.css           — CRM-specific styles (includes Site Access styles)
├── overlays-meta.js         — Overlay definitions, zone config, type metadata
├── overlays-b64-sw-wastewater.js  — SW Sydney wastewater GeoTIFF (b64)
├── overlays-b64-sw-potable.js     — SW Sydney potable water GeoTIFF (b64)
├── overlays-b64-sw-ilp.js         — Leppington ILP GeoTIFF (b64)
├── gsp-wsa-sw-wastewater.js       — WSA wastewater GeoJSON (planning stages)
├── WSA_SW_Wastewater_Precincts.geojson
├── catherine_park_north_zoning_wgs84.geojson  — Catherine Park North proposed zoning (R2/R3/SP2, georeferenced)
├── domain-api.js            — Domain API client (live only, no mock)
├── dd-risks.js              — DD risk assessment (queries NSW layers at lat/lng)
├── map.js                   — Map logic, overlays, search, listings, Domain init
├── kanban.js                — Pipeline Kanban board with DD automation and CRM
├── package.json             — Dependencies (@neondatabase/serverless, jose, bcryptjs), type:module
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
| `JWT_SECRET` | Session JWT signing secret — minimum 32 random chars. Generate: `openssl rand -base64 48` |
| `ADMIN_FALLBACK_EMAIL` | Break-glass admin email (e.g. `alan.diversi@edanproperty.com.au`). Always has admin access, works even if DB is unreachable |
| `ADMIN_FALLBACK_PASSWORD_HASH` | Bcrypt hash of the fallback admin password. Generate locally with `node scripts/hash-password.mjs` |

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
-- Pipeline items
pipeline (id TEXT PK, data JSONB, updated_at TIMESTAMPTZ)

-- Organisations
organisations (
  id         SERIAL PK,
  name       TEXT NOT NULL,
  phone      TEXT DEFAULT '',
  email      TEXT DEFAULT '',
  website    TEXT DEFAULT '',
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
)

-- CRM contacts
contacts (
  id              SERIAL PK,
  first_name      TEXT NOT NULL,
  last_name       TEXT DEFAULT '',
  mobile          TEXT DEFAULT '',
  email           TEXT DEFAULT '',
  organisation_id INTEGER REFERENCES organisations(id) ON DELETE SET NULL,
  source          TEXT DEFAULT 'manual',
  domain_id       TEXT,
  created_at      TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ
)

-- Contact ↔ Pipeline junction (many-to-many)
contact_properties (
  contact_id  INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
  pipeline_id TEXT,
  role        TEXT DEFAULT 'vendor', -- 'vendor'|'purchaser'|'agent'|'buyers_agent'|'referrer'|'solicitor'
  linked_at   TIMESTAMPTZ,
  PRIMARY KEY (contact_id, pipeline_id)
)

-- Contact notes (linked to contact + optionally a pipeline property)
contact_notes (
  id          SERIAL PK,
  contact_id  INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
  pipeline_id TEXT,
  note_text   TEXT NOT NULL,
  created_at  TIMESTAMPTZ
)

-- Financial feasibility models (one per pipeline property)
property_financials (
  pipeline_id  TEXT PK,            -- matches pipeline.id
  data         JSONB NOT NULL,     -- full model: assumptions, expenses, revenue, _state (detected state code)
  updated_at   TIMESTAMPTZ
)
```

---

## Authentication (V74)

The site is staff-only. Every request (pages and API routes) runs through `middleware.js`, which verifies a signed session cookie. Anyone without a valid session is redirected to `/login.html` (for pages) or gets a 401 (for API calls). This also protects the Domain API proxy, NSW tile proxy, and all other `/api/*` endpoints from being hit anonymously.

### How it works

- **Session cookie**: `spm_session`, httpOnly, secure, SameSite=Lax, 30-day expiry. Contains a JWT signed with `JWT_SECRET` (HS256 via `jose`). Payload: `sub`, `email`, `name`, `isAdmin`, `modules`, `src`.
- **Login priority**: the login endpoint first checks the `contacts` table (`can_login = true`, password matches). If no match, it falls back to the env-var superuser (`ADMIN_FALLBACK_EMAIL` + `ADMIN_FALLBACK_PASSWORD_HASH`). The fallback always has admin access and works even if Neon is unreachable.
- **Admins** can enable/disable login for any contact, toggle admin rights, and reset passwords via the Site Access section of the contact detail drawer in the CRM.
- **Non-admins** can only change their own password (via the same UI on their own record, which requires their current password).
- **Password hashing**: `bcryptjs`, 10 rounds. Happens in Node serverless functions (`api/auth/login.js`, `api/auth/set-password.js`) — never in the Edge middleware.

### Contact table auth columns

Run `POST /api/db-setup` once after deploying V74 to apply these. All statements are `IF NOT EXISTS` and safe to re-run.

```sql
ALTER TABLE contacts ADD COLUMN can_login      BOOLEAN     NOT NULL DEFAULT false;
ALTER TABLE contacts ADD COLUMN is_admin       BOOLEAN     NOT NULL DEFAULT false;
ALTER TABLE contacts ADD COLUMN password_hash  TEXT;
ALTER TABLE contacts ADD COLUMN last_login_at  TIMESTAMPTZ;
ALTER TABLE contacts ADD COLUMN access_modules TEXT[]      NOT NULL DEFAULT ARRAY['*'];
CREATE INDEX contacts_email_lower_idx ON contacts (LOWER(email));
```

### First-time setup (do this before V74 goes live)

**1. Install the new dependencies locally** (first time only, for the hash script):
```bash
npm install
```

**2. Generate a JWT signing secret**:
```bash
openssl rand -base64 48
```
Copy the output. In Vercel → Settings → Environment Variables, add:
- `JWT_SECRET` = (the output, for Production + Preview)

> If you ever rotate `JWT_SECRET`, all existing sessions are invalidated and everyone must log in again.

**3. Generate the fallback admin password hash**:
```bash
node scripts/hash-password.mjs
```
Type a strong password (min 8 chars). It will print a bcrypt hash. In Vercel → Settings → Environment Variables, add:
- `ADMIN_FALLBACK_EMAIL` = `alan.diversi@edanproperty.com.au`
- `ADMIN_FALLBACK_PASSWORD_HASH` = (the hash output)

**4. Deploy V74** (redeploy after adding the env vars so they take effect).

**5. Run the DB migration**:
```
POST https://<your-prod-url>/api/db-setup
```
This adds the auth columns. You'll need to be logged in to call it — which is the chicken-and-egg: use the fallback admin login from step 3.

**6. Log in as the fallback admin** at `/login.html` using `ADMIN_FALLBACK_EMAIL` + the password you chose in step 3.

**7. Create your own contact row and grant yourself admin** (so you're not relying on the fallback day-to-day):
- Open the CRM → find or create the contact for `alan.diversi@edanproperty.com.au`
- Open the contact detail drawer → scroll to **Site Access**
- Click **Set password** → enter a password → Save
- Tick **Can log in** and **Administrator**
- Log out and log back in — you'll now be signed in via the DB path (seen as `src: 'db'` in `/api/auth/me`), with the env-var fallback reserved as break-glass.

### Day-to-day admin tasks

**Grant a new staff member login access:**
1. CRM → open (or create) their contact record
2. Site Access → **Set password** → type an initial password → Save (share it with them via Signal, in person, or similar out-of-band channel)
3. Tick **Can log in** ✓
4. Tick **Administrator** if they should be an admin
5. Tell them to log in and change their password immediately via their own CRM record

**Revoke access:**
- CRM → contact → Site Access → untick **Can log in**. Their current session remains valid until its 30-day expiry, but no new logins. To force-expire, rotate `JWT_SECRET` (kicks everyone out).

**Reset someone's forgotten password:**
- CRM → contact → Site Access → **Reset password** → type new password → Save → share with them.

**Safeguard**: The update-access endpoint refuses to leave the system with zero DB-admins (where `is_admin = true AND can_login = true`). The env-var fallback is always still available, but this prevents accidentally orphaning the admin set through the UI.

### If you lock yourself out

As long as the env-var fallback is configured, you can always log in as `ADMIN_FALLBACK_EMAIL` + fallback password. To rotate the fallback password:
1. Locally: `node scripts/hash-password.mjs` → copy hash
2. Vercel → Settings → Environment Variables → update `ADMIN_FALLBACK_PASSWORD_HASH` → Save
3. Trigger a redeploy (env var changes don't take effect until the next deploy)

If both the fallback env vars and your DB admin credentials are lost, connect directly to Neon and either update `password_hash` for an existing admin row, or insert a new admin contact — then log in.

### Portability notes

This system is mostly portable — if you migrate off Vercel, only `middleware.js` is Vercel-specific. Everything else (lib/auth.js, the `/api/auth/*` endpoints, login.html, the CRM Site Access UI, the DB columns) works on any Node host.

On a platform without edge middleware (Bluehost, Railway, Render, VPS, etc.):
1. Delete `middleware.js`.
2. At the top of every `/api/*.js` handler that should be protected, add:
   ```js
   import { requireSession } from '../lib/auth.js';
   // inside handler, before the real logic:
   const session = await requireSession(req, res);
   if (!session) return;
   ```
3. For static HTML pages (`index.html`), either wrap them behind a thin Node/Express server that checks the cookie before serving, or accept that the HTML/JS is reachable and rely on API-level auth to protect data (the frontend will just show a broken page that immediately redirects to `/login.html` when its XHRs return 401, which `index.html` already does via the `/api/auth/me` bootstrap).

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
6. If no address match, `_pendingAddressMatch` set — cadastre Lot/DP match attempted when cadastre returns

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
- **Organisations** table — contacts belong to an org; org typeahead with inline create
- Many-to-many relationship with pipeline items via `contact_properties` junction table
- Contact roles (per-property): **Vendor**, **Purchaser**, **Agent**, **Buyer's Agent**, **Referrer**, **Solicitor**
- **Duplicate detection** — as you type name/email/mobile, existing contacts are surfaced with click-to-link
- **Contact notes** (`contact_notes` table) — notes linked to a contact and optionally a pipeline property
- Pipeline notes can tag a contact — note stored on the pipeline item AND mirrored to `contact_notes` for future CRM contact view
- `window.CRM.renderContactsSection(pipelineId, agentData)` — renders collapsible Contacts section in kanban modal
- Domain agent (from `p._agent`) shown as first read-only row with 💾 one-tap save to contacts DB
- `api/contacts.js` endpoints: GET (list/search/by-pipeline/org-search/notes/duplicate-check), POST (create/link/unlink/add-note/create-org), PUT (update), DELETE (contact or note)

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
| Zoning | NSW Land Zoning (LEP), SRLUP, Catherine Park North Proposed Zoning |
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
- **Header**: Price → address → Lot/DP (async backfill via NSW Cadastre if missing) → Domain link
- **Contacts section** (collapsible, first in body):
  - Domain listing agent shown as first read-only row (name, agency, phone/email as tappable links)
  - 💾 button saves Domain agent to CRM contacts DB with one tap
  - Additional contacts (referrers, buyer's agents) linked from CRM with role badges
  - Add form with existing-contact search or create-new flow
- **Vendor Terms**: price, settlement, deposit structure
- **Terms Offered**: offer price, settlement, deposit — logged as history
- **Due Diligence**: per-item risk level and notes
- **Notes**: timestamped entries in reverse-chronological order; Ctrl/Cmd+Enter to submit; individual note deletion

### Finance Module (`finance/finance.js`)

A dedicated financial feasibility calculator, isolated in its own `finance/` folder with no cross-dependencies on map or kanban code. Accessed via the **📊 Finance** nav tab or the **📊 Finance** button on any kanban card modal.

**Phase 1 — Feasibility (current, v66.2):**

_Calculation engine matches `Feasibility_-82WPRL-v3.xlsx`:_
- **Loan model**: interest-only by default; principal paid = (Rent − Interest) × `% profit used for debt reduction`. When 0% this is pure interest-only; when positive, profit above interest reduces principal each year
- **Settlement lag**: configurable years (0..n) where rent and interest are both zero — property not yet settled; lag rows shown greyed/italic
- **Cost of Funds**: upfront cash requirement compounded at cost of capital each year; NPV = Asset Value − Cost of Funds (not a DCF NPV)
- **Cashflow** = Net Rent − Interest − Principal Paid; **ROE** = Cashflow ÷ Total Cash Required (Total)
- **Dual cash totals**: Upfront (deposit + purchase costs) and Total (Upfront − cashflows before hold duration pre-revaluation)
- **Inputs (grey cells)**: acquisition price, LVR, deposit %, sales commission %, interest rate, rental growth, capital growth, cost of capital, term of ownership, settlement lag, project duration, hold duration pre-revaluation, % profit to debt reduction; weekly rent (× 52), council quarterly (× 4), maintenance monthly (× 12), management fee %, sinking fund % — formula-driven inputs matching spreadsheet pattern
- **Calculated fields**: gross rent, council annual, maintenance annual, management fee $, sinking fund $, stamp duty — shown in italic, not editable
- **Comparable Value panel** (collapsible, collapsed by default): Method 1 Gross Area, Method 2 30% GRV, Method 3 Development TDC/lot, Method 5 Derived from Yield — all inputs editable inline; mean shown as badge in header
- **Multi-state stamp duty**: state auto-detected from property address; formulas for NSW, VIC, QLD, SA, ACT sourced from official .gov.au pages; detected state shown in field hint
- **Finance header**: phase chevron nav (Financial Feasibility › Acquisition → Delivery); Mean Comparable Value shown live in header, updates as inputs change
- **Kanban integration**: Finance button sits below Terms Offered in kanban modal; passes most recent submitted offer price (falls back to vendor terms price, then listing price); existing model variables fully preserved on re-open — only acquisition price updates if offer has changed
- **Save Model** persists to Postgres (`property_financials` table) keyed by pipeline ID; reloads on next visit

**Phase 2 — Full Viability (planned):** Development scenarios, sensitivity analysis, IRR/NPV reporting, PDF export.

### Agent / Contact Data Flow
- When a Domain listing is matched to a pipeline property, `_agent` (name, agency, phone, email) and `_listingUrl` are stored on `pipeline[id].property` and persisted to Neon
- `resolveFromDomain()` runs async on modal open — tries address match against current listings, falls back to `runDomainSearchAt` if needed
- `backfillAgentFromCache()` runs after every Domain viewport search — backfills agent data on all pipeline items that currently lack it
- Lot/DP backfilled async from NSW Cadastre on property add if not already captured

---

## Deployment
See `DEPLOY.md` for full setup guide.

---

## GeoJSON Overlays — Georeferencing Notes

### Catherine Park North Proposed Zoning (`catherine_park_north_zoning_wgs84.geojson`)

Source: **Figure 40** of the *Catherine Park North Draft Planning Proposal, September 2025* (urbanco.com.au, Catherine Field Precinct, South West Growth Area).

**How it was produced:**
1. Figure 40 extracted as a 1471×1471px raster image from the PDF.
2. Colour segmentation (HSV masking in OpenCV) isolated R2 (light pink), R3 (darker red), SP2 (yellow).
3. Contours extracted and simplified using Shapely, normalised to pixel-space coordinates.
4. Affine transform fitted using 3 confirmed road intersection GCPs.

**GCPs (confirmed from Google Maps):**

| # | Feature | Pixel (x,y) | WGS84 |
|---|---------|-------------|-------|
| 1 | Catherine Park Drive / Springfield Road (top corner) | (565, 220) | -34.00092, 150.76190 |
| 2 | Springfield Road / Camden Valley Way (SE corner) | (1096, 1201) | -34.00974, 150.77015 |
| 3 | SW corner on Camden Valley Way | (823, 1201) | -34.01309, 150.76645 |

**Zone legend:**

| Code | Name | Fill | `fill-opacity` |
|------|------|------|----------------|
| R2 | Low Density Residential | `#ff9999` | 0.50 |
| R3 | Medium Density Residential | `#cc3333` | 0.60 |
| SP2 | Infrastructure – Classified Road (Catherine Park Drive) | `#ffcc00` | 0.70 |

**Output:** 7 features (2× R2, 4× R3, 1× SP2). Final bounding box: lat −34.013 to −34.001, lon 150.759 to 150.770. Centre: −34.007, 150.764 (Catherine Field, Camden LGA). Confirmed correct against satellite basemap.

**Affine transform coefficients** (px_x, px_y in 1471×1471 image, origin top-left):
```
lon = 150.75400628 + 0.0000135531 × px_x + 0.0000010737 × px_y
lat = −34.00441390 + 0.0000122711 × px_x − 0.0000156330 × px_y
```

Corrective affine applied post-hoc from 4 confirmed GCP pairs (Web Mercator coords, max residual 11m):
```
cor_lon = −5.22125477 + 1.03752258 × cur_lon + 0.01293760 × cur_lat
cor_lat =  3.86074737 − 0.00992951 × cur_lon + 1.06930344 × cur_lat
```

**Final output:** 7 features, bbox lat −34.013 to −34.001, lon 150.759 to 150.770, centre −34.007, 150.764.

---

## Version History

| Version | Notes |
|---|---|
| V74 | **Authentication & site access.** Entire site gated behind a session cookie via `middleware.js` (Vercel Routing Middleware, Edge runtime) — protects both pages and API routes, so Domain API proxy, tile proxy, and all other endpoints are no longer publicly hit-able. New branded `/login.html`. JWT (HS256 via `jose`) stored in httpOnly Secure SameSite=Lax cookie, 30-day expiry. **Contacts table extended**: `can_login`, `is_admin`, `password_hash` (bcryptjs, 10 rounds), `last_login_at`, `access_modules TEXT[]` (default `['*']` = full site access; per-module wiring scaffolded for future Map/CRM/Finance split). **Login priority**: DB first, then env-var fallback superuser (`ADMIN_FALLBACK_EMAIL`, `ADMIN_FALLBACK_PASSWORD_HASH`) that always has admin and works even if Neon is unreachable. **New endpoints** (`api/auth/*`): `login`, `logout`, `me`, `set-password` (admin or self; self requires current password), `update-access` (admin-only, with last-admin safeguard — cannot orphan DB admin set through UI). **CRM Site Access section** added to contact detail drawer: Can log in / Administrator / Full site access checkboxes, Last login display, Set/Reset/Change password form. Admin-gated; non-admins only see self-service password change on their own record. **Header user menu** in `index.html` — avatar with initials, dropdown showing full name/email/role and Sign out action; bootstraps from `/api/auth/me` on page load. **New files**: `middleware.js`, `login.html`, `lib/auth.js`, `api/auth/{login,logout,me,set-password,update-access}.js`, `scripts/hash-password.mjs`. **New env vars** (required before V74 goes live): `JWT_SECRET`, `ADMIN_FALLBACK_EMAIL`, `ADMIN_FALLBACK_PASSWORD_HASH`. **New deps**: `jose`, `bcryptjs`. `api/db-setup.js` extended with ALTER statements for all auth columns (safe to re-run). Framework-agnostic middleware uses plain Web Request/Response (not `next/server`) so no Next.js dependency. Portability: only `middleware.js` is Vercel-specific; if migrating, delete it and call `requireSession()` at the top of each API route — `lib/auth.js` already exposes this. See **Authentication** section for full setup, day-to-day admin tasks, and lockout recovery. |
| V73 | Leppington and South Creek ILPs added. |
| V68 | **map.js improvements.** Viewport and filter persistence: map center/zoom saved to `localStorage` on every pan/zoom and restored on page load (deferred to `window.load` to avoid Leaflet container sizing race); active filters saved to `localStorage` on Apply and Clear, restored on load including chip/select/checkbox UI state and filter badge count. Measure tool fixed: removed broken secondary picker popup that was appending to a hidden parent; Distance and Area now injected directly as items in the Tools dropdown menu; Clear Measurement item shown only when a measurement is active. Selecting a Domain API listing marker no longer recentres the map (popup `autoPan` disabled; `setView` suppressed on marker click, preserved on sidebar card click). **Data + overlays:** `catherine_park_north_zoning_wgs84.geojson` added — Catherine Park North proposed zoning (R2/R3/SP2) georeferenced from Figure 40 of the Draft Planning Proposal (Sep 2025) using 3 confirmed road intersection GCPs. Added to Zoning overlay group. `map.js` `buildLeafletLayer` extended with `vectorUrl` branch for fetch-based GeoJSON overlays. |
| V67 | **Finance module — Phase 2 (Data Integrity, Calculations & UX).** **File renames**: `finance/finance.js` → `finance/finance-module.js`, `api/finance.js` → `api/finance-api.js` (delete old files on deploy). **Data integrity**: all pipeline monetary values stored as plain numbers. Submit offer handler force-blurs all inputs before reading so unblurred tranches are captured. `deleteOffer` uses `String()` coercion for ID comparison. **Kanban modal**: "Terms Offered" and "Model in Financial Feasibility" merged into single **Submitted Offers & Financial Feasibility** section. Each offer row shows full details (price, settlement, deposit tranches) plus 📊 Model and ✕ delete buttons. **+ Add Offer** button in section header opens inline popup form immediately below heading. Vendor terms row shown with same detail, no delete. **Nav buttons**: Pipeline and Finance converted to `toggle-btn` with `.dot` indicator matching Listings. Dot goes accent-coloured when active. Finance button opens/closes finance view. Pipeline button opens pipeline board. **Finance → Pipeline link**: navigates back to pipeline modal without triggering kanban close. **Finance table**: Funds to Complete section with ▶/▼ toggle and **Include in cashflow** checkbox (default on). Each cost placed in correct year: deposits at cumulative days from contract ÷ 365, purchase costs at offer settlement year. `_settlementYr` computed once in `runModel` from actual offer settlement days and reused by KPI tiles, table rows, and cashflow adjustment — all consistent. **KPI strip**: 9 tiles, CSS grid, 75% of original size. Tiles: Acquisition Price · Comparable Value · Total Loan · Cash Required (Upfront) · Cash Required (Settlement) · Cash Required (Total) · Net Income (Yr 1) · Asset Value (Exit) · NPV at Exit. Cashflow (Yr 1) tile removed. **Cash Required definitions**: Upfront = all FTC items except Commission and Equity Contribution; Settlement = Commission + Equity Contribution; Total = Upfront + Settlement = Total Purchase Costs. **Total Purchase Costs** = all Funds to Complete items across all years (deposits + stamp + valuation + solicitor + inspections + commission + equity). **Stamp duty**: auto-calculated only on new model creation — never overwritten on existing models, preserving manual changes. Editing acquisition price no longer recalculates stamp duty. **Sidebar sections**: all start collapsed. Purchase Costs moved into Outgoings section as first subsection. Deposits shown as first items under Purchase Costs. Revenue section: Rent (accepts /w /m /y) + Other. All running cost fields annual (accept /w /m /y): Council, Water, Cleaning, Insurance, Land Tax, Management Fee, Common Power, Fire Services, Maintenance, Sinking Fund, Other. Separate Council (quarterly) and Maintenance (monthly) inputs removed — stored as annual. **Settlement lag** auto-set from offer settlement days on open (rent starts at correct year). **ROE** = Cashflow ÷ Total Cash Required. |
| V66.2 | **Finance module enhancements.** Calculation engine rewritten to match `Feasibility_-82WPRL-v3.xlsx`: interest-only loan driven by `% profit used for debt reduction` (principal paid = (Rent − Interest) × debt reduction %; 0% = pure interest-only), settlement lag (pre-settlement years show zero rent/interest), Cost of Funds row (upfront cash × cost of capital per year), NPV = Asset Value − Cost of Funds (per-year, not DCF). Dual cash totals: Upfront (deposit + purchase costs) and Total (upfront − pre-reval cashflows). Inputs correctly split into grey (editable) vs calculated display fields — weekly rent × 52, council quarterly × 4, maintenance monthly × 12, management fee % × gross rent, sinking fund % × acquisition price. Five comparable value methods (Gross Area, 30% GRV, Development TDC, Method 5 Yield-derived). **Multi-state stamp duty**: state auto-detected from property address; separate formula for NSW, VIC, QLD, SA, ACT — each sourced from official .gov.au pages (Revenue NSW contracts guide, SRO Vic fixtures page, QRO rates page, RevenueSA, ACT Revenue Office non-commercial table). NSW rates updated to 1 July 2025 CPI-adjusted thresholds. **Kanban modal**: Finance button moved from header to below Terms Offered section, restyled as full-width accent action link; passes most recent offer price (or vendor terms price) to finance module. **Price carry-forward**: new models seeded from offer price; existing models preserve all assumptions — only acquisitionPrice updates if offer differs. **Finance header**: phase chevron nav (Financial Feasibility › Acquisition → Delivery placeholder); Mean Comparable Value shown live in header. **Comparable section**: collapsed by default, mean value shown as badge in section header. |
| V66 | **Finance module** (Phase 1 — Feasibility, initial). New `finance/` folder with `finance.js` and `finance-styles.css`. New `api/finance.js` (Postgres CRUD, `property_financials` table). Nav updated: **Pipeline \| CRM \| Finance \| ⚙ Tools ▾**. |
| V65 | Extended contact schema (baseline for v66). |
| V62 | CRM module (contacts DB, collapsible modal section, Domain agent save). Timestamped notes with reverse-chronological history. Lot/DP async backfill. Agent/listingUrl stored on pipeline items. Address-string listing match (normalised, 3-pass). `runDomainSearchAt` for immediate post-search address lookup. Domain search debounce 5s→1.5s. `_suppressNextDomainSearch` flag. Listing panel highlight after address search. `api/contacts.js`, `api/db-setup.js`, `crm.js`, `crm-styles.css` added. |
| V60 | Domain API live (no mock). Viewport geoWindow search, 1.5s debounce, 100 cap. `dd-risks.js` for DD automation. Topo = NSW VectorTile Hybrid via MapLibre GL. Tiles proxied via `api/tiles.js` query params. |
