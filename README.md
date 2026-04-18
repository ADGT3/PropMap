# Sydney Property Map — V75.3

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
│   ├── properties.js        — Properties CRUD (V75) — permanent land identity
│   ├── deals.js             — Deals CRUD (V75) — workflow-scoped Kanban cards
│   ├── roles.js             — Role catalogue CRUD (V75)
│   ├── contacts.js          — CRM Contacts CRUD, backed by entity_contacts (V75). Note endpoints return 410 Gone and redirect to /api/notes (V75.3)
│   ├── notes.js             — Unified polymorphic notes CRUD (V75.3) — replaces deals.data.notes[] and contact_notes table
│   ├── finance-api.js       — Financial model CRUD, keyed by deal_id going forward (V75)
│   ├── migrate-to-v75.js    — V75.0 structural migration endpoint (admin-only)
│   ├── migrate-to-v75-3.js  — V75.3 migration: notes unification + DD per-deal (admin-only)
│   ├── db-setup.js          — DB schema setup (legacy tables + auth columns)
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
- Tick **PropMap Access** and **Administrator**
- Log out and log back in — you'll now be signed in via the DB path (seen as `src: 'db'` in `/api/auth/me`), with the env-var fallback reserved as break-glass.

### Day-to-day admin tasks

**Grant a new staff member login access:**
1. CRM → open (or create) their contact record
2. Site Access → **Set password** → type an initial password → Save (share it with them via Signal, in person, or similar out-of-band channel)
3. Tick **PropMap Access** ✓
4. Tick **Administrator** if they should be an admin
5. Tell them to log in and change their password immediately via their own CRM record

**Revoke access:**
- CRM → contact → Site Access → untick **PropMap Access**. Their current session remains valid until its 30-day expiry, but no new logins. To force-expire, rotate `JWT_SECRET` (kicks everyone out).

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
| V75.3 | **Notes unification + DD per-deal.** Two independent data-model changes bundled into one migration. **(A) Notes unification**: replaces the two parallel note stores (JSONB array inside `deals.data.notes` and the `contact_notes` table) with a single polymorphic `notes` table. Schema: `id, entity_type, entity_id, tagged_contact_id, note_text, author_id, author_name, created_at`. Each note has three identities — where it lives (entity_type/entity_id), who it's about (optional tagged_contact_id), who wrote it (author_id with relation primary, author_name as text fallback for the env-var fallback admin and migrated-from-history rows). Server-side author stamping: the frontend sends no author field; `/api/notes` POST reads the session cookie and stamps `author_id`+`author_name` from it. View rules — the Kanban card for deal X shows only notes written on deal X; the property page for prop Y shows only notes written on prop Y; the contact drawer for contact N shows notes where `entity_type='contact' AND entity_id=N` OR `tagged_contact_id=N`, with a source badge showing each note's origin ("Deal — 35 Smith St", "Property — 12 Oak Ave", "Contact"). When adding a note on a deal or property the writer picks a contact to tag from the full contacts list; that tag is what causes the note to surface in the contact's aggregated drawer view. **(B) DD per-deal**: DD risk assessment data moves from `properties.dd` (property-level) to `deals.data.dd` (per-deal) so each new deal on the same property gets fresh assessment rather than inheriting a prior assessment. Existing DD data is propagated 1:1 to every active deal on its property at migration time. **New files**: `api/notes.js` (full CRUD with source-label enrichment for contact drawer feed), `api/migrate-to-v75-3.js` (dry-run via GET, execute via POST, idempotent via `_migrations` table). **Modified**: `api/contacts.js` (all note routes return 410 Gone pointing to `/api/notes`), `api/properties.js` (`dd` column dropped from SELECT/INSERT/UPDATE), `kanban.js` (`fetchNotesForDeal`/`addNote`/`deleteNote` async backed by `/api/notes` with in-memory cache per deal id; `internalToPropertyPayload` no longer sends `dd`; `internalToDealPayload` writes `data.dd`; note count on card indicator reads from cache), `crm.js` (contact drawer and legacy agent-side panel now fetch from `/api/notes?by_contact=X`, show source badge + author, add-note form attaches to the contact), `crm-styles.css` (new `.crm-note-source` pill style). **Deploy sequence**: deploy all files to preview → GET `/api/migrate-to-v75-3` to dry-run (returns counts) → POST to execute → verify notes + DD work → promote to prod → POST on prod. Rollback = restore Neon DB branch snapshot taken pre-migration. |
| V75.2 | **UI architecture refactor.** Pure refactor — no new features, no schema changes. Header restructured into three regions: logo, module nav (Mapping / Pipeline / CRM / Finance / Tools), and right-anchored search box + user menu. Mapping is now a first-class top-level module; Search, Overlays and Listings are no longer top-header buttons. Overlays moved into the Leaflet basemap row at bottom-left alongside Map / Satellite / Topography. Listings show/hide toggle moved into the listings sidebar header. New secondary bar below the main header shows the active module's title; hidden when Mapping is active. CRM promoted from 960px right-side drawer to full-viewport module — matches Kanban/Finance treatment since all four data-centric modules now replace the map entirely when active. New `router.js` owns navigation state: parses URL paths (e.g. `/pipeline`, `/crm/contacts/123`, `/settings`), calls existing `toggleKanban`/`toggleCRM`/`toggleFinance` functions (no logic duplication), handles browser back/forward via `popstate`, updates `document.title` per route, and sets `body[data-route]` for CSS targeting. System Settings added as empty scaffold — accessible from user menu (admin-only), reached by clicking ⚙ System Settings above Sign out. Settings view is the first of what will become several system-level configuration surfaces; Role Management lands there in V75.5. Legacy button IDs (`kanbanToggleBtn`, `crmNavBtn`, `financeNavBtn`, `listingsToggle`, `overlayPanelBtn`, `overlayBadge`) kept as hidden DOM stubs so existing JS module code still finds its event targets — the router drives navigation by invoking the same underlying toggle functions those stubs' click listeners used to fire. `Router.navigate(path)` is the public API for programmatic nav. Deep link scaffolding for `/pipeline/deal/:id` works via existing `openCardModal`; CRM deep links (`/crm/contacts/:id`) require `window.CRM.navigateTo` which lands in V75.4 alongside the Properties tab. Kanban / CRM / Finance close buttons (✕) now route back to Mapping rather than directly flipping `.visible`. No DB migration, no backend changes — pure frontend architectural work. New files: `router.js`. Modified: `index.html`, `map.js`, `styles.css`, `crm-styles.css`. Untouched: `kanban.js`, `crm.js`, `finance-module.js`, all `api/*`. |
| V75.1 | **Mark Not Suitable + snooze.** New listing-filter feature: any listing or property can be marked Not Suitable with a snooze period of 30 days / 90 days / 6 months / 1 year / Permanent. Filtered listings and their pins are hidden from the map by default. **Storage**: marking creates a `properties` row (no deal attached) with `not_suitable_until` set; the row persists in DB so flags are shared across users/devices. Marking an already-pipelined property updates the existing row without touching the deal. **UI surfaces**: (1) inline "Not Suitable ▾" dropdown on each listing card → reveals 5 snooze options → one click to apply; (2) same control in map pin popups (works for Domain pins, bare clicks, and parcel selections); (3) "Show Not Suitable / snoozed" checkbox in the filter panel exposes hidden listings (with reinstate button on each card). **Pipeline pins**: starred pipeline pins for not-suitable properties are also hidden by default; honours the same toggle. **Active deals carry on** when their property is flagged not-suitable (per design — listings filter concern only). New JS surface area in `map.js`: `loadNotSuitable()`, `markNotSuitable(listing, optionIndex)`, `clearNotSuitable(listing)`, `isNotSuitable(...)`, `SNOOZE_OPTIONS`, lookup maps `_notSuitable.byListingId` and `_notSuitable.byLatLng`. CSS additions in `styles.css` for `.listing-ns-*` and `.listing-not-suitable-banner`. New filter checkbox `#filterShowSnoozed` in `index.html`. No DB migration — `properties.not_suitable_until` column already exists from V75.0a. |
| V75.0c | **Environment isolation fix.** V75 backend endpoints (and the auth + db-setup endpoints) were reading only `process.env.POSTGRES_URL`, which on this project is a manually-set "All Environments" variable that overrides Neon's per-deployment branch injection — meaning preview deploys were hitting prod data despite Neon's branch-per-preview integration working correctly. Fixed via new shared helper `lib/db.js` exporting `getDatabaseUrl()`. Lookup order now checks `pipeline_POSTGRES_URL` and `pipeline_DATABASE_URL` first (these are managed per-deployment by the Neon Vercel integration), then `PIPELINE_*` variants, then falls back to `POSTGRES_URL` / `DATABASE_URL`. Updated files: `lib/db.js` (new), `api/migrate-to-v75.js`, `api/properties.js`, `api/deals.js`, `api/roles.js`, `api/contacts.js`, `api/finance-api.js`, `api/db-setup.js`, `api/auth/login.js`, `api/auth/set-password.js`, `api/auth/update-access.js`. After deploying, delete the manual `POSTGRES_URL` variable from Vercel (Settings → Environment Variables → the one without the green "N" badge). Neon integration variables stay as-is. |
| V75.0b | **Frontend cutover — pipeline shim removed.** `kanban.js` now talks directly to `/api/deals` and `/api/properties` (save fans out to both: property upsert first for FK, then deal upsert). Internal `pipeline` dict shape preserved so `crm.js`, `map.js`, finance module, and DD code work unchanged. New helpers `dealRowToInternal`, `internalToPropertyPayload`, `internalToDealPayload` translate at the API boundary. Notes endpoint now called with `entity_type=deal&entity_id=X` instead of legacy `pipeline_id=X`. **`api/pipeline.js` deleted.** `crm.js` continues to use legacy `pipeline_id` params which V75 `/api/contacts` accepts transparently (maps to `entity_type='deal'`) — left unchanged to minimise blast radius; will be modernised naturally when V75.2 (property page) introduces property-level UI. Map.js untouched — `window.getPipelineData()` still returns the same shape. |
| V75.0a | **Structural rebuild — backend only (stage 1, part A).** First half of the V75 structural separation of property identity from deal lifecycle. **New schema**: `properties` (permanent land identity incl. `not_suitable_until` / reason), `deals` (workflow-scoped Kanban cards with `workflow`/`stage`/`status`), `roles` (manageable role catalogue with per-role `scopes` and `default_scope`), `entity_contacts` (polymorphic contact→entity link table replacing `contact_properties`). **New API endpoints**: `/api/properties`, `/api/deals`, `/api/roles`. **Rewritten**: `/api/contacts` (now backed by `entity_contacts`; translates legacy `pipeline_id` params to `entity_type='deal'` lookups so V74 frontend keeps working); `/api/finance-api` (keyed by `deal_id`, accepts legacy `pipeline_id` as alias); `/api/pipeline` (now a compatibility shim that reads/writes `deals`+`properties` and reassembles the old pipeline shape for the frontend). **Migration endpoint**: `POST /api/migrate-to-v75` — admin-only, idempotent via `_migrations` tracking table. Migrates existing `pipeline` rows into `properties`+`deals` (same id preserved), splits `contact_properties` into `entity_contacts` by role scope, alters `contact_notes` and `property_financials` to add `entity_type`/`deal_id` columns, then **drops** `pipeline` and `contact_properties` tables. **No frontend changes** — user-visible UI is unchanged because all V74 frontend endpoints keep working through the shim. **V75.0b** (next deploy) will update the frontend to call `/api/deals` and `/api/properties` directly and remove the `/api/pipeline.js` shim. Rollback: take a Neon DB branch snapshot before running migration on prod; restore from snapshot if anything goes wrong. |
| V74.8 | **"Open in Pipeline" from map popup.** When a starred pipeline pin is clicked (or any click location that matches an existing pipeline item), the popup's `+ Pipeline` button is replaced with a gold **★ Open in Pipeline** button that calls `window.openPipelineItem(id)` — closes CRM if open, opens the Kanban, auto-opens the property's modal. Matching logic (priority order): (1) listing ID exact match, (2) Lot/DP overlap between current click and pipeline entry's stored `_lotDPs`, (3) lat/lng proximity within ~25m of any parcel on the pipeline entry. Closes the workflow loop — previously the only way from a starred pin was to scroll Kanban for the card. No data changes, pure UI. |
| V74.7 | **Add-to-Pipeline moved to map popup.** The sticky "multi-select-bar" at the bottom of the listings/sidebar pane is removed. A `+ Pipeline` button is now the last element of every map-click popup (listing pins, bare map clicks, multi-parcel selections). The button reads live map selection state at click time (via new helper `addCurrentSelectionToPipeline` on `window`), so it keeps working across popup re-renders (DD load, Lot/DP resolve, overlay changes). Listing pins still carry full listing details (price, type, beds/baths/cars) into the pipeline entry; bare clicks and multi-parcel selections use `'Unknown'` price and `'land'` type as before. The `+` button on each listing card in the listings panel is unchanged (still present, useful for bulk-adding without clicking each pin). `renderMultiSelectBar()` is retained as a no-op cleanup stub to keep legacy call sites working. Orphan `.multi-select-bar`, `.msb-*` rules removed from `styles.css`. |
| V74.6 | **Contact Source — editable with curated list.** Source is now editable in both contact edit forms (pipeline-side `showForm` and CRM-side `renderContactDrawer`). Dropdown values: Our Website · Realestate.com.au · Domain.com.au · Instagram · Facebook · Letter Drop · Door Knocking · Walk-In · Signboard · Cold-Calling · Open House · Referral · Other. Selecting **Other** reveals a free-text input for custom sources; existing contacts with legacy values outside the list open with Other pre-selected and their current value pre-filled. **New Add Contact** forms start blank (placeholder "Select source…") to force a conscious choice. **Domain agent "💾 Save to CRM"** now sets source to `'Domain.com.au'` instead of legacy `'domain_agent'`. **Migration** (run via `POST /api/db-setup` after deploy — safe to re-run): `'domain'` and `'domain_agent'` → `'Domain.com.au'`; all other legacy values (including `'manual'`) → `'Other'`. Helpers `resolveSource`, `renderSourceField`, `readSourceField`, `wireSourceField` added to `crm.js` for reuse between both forms. |
| V74.5 | **CRM Organisation detail view.** Clicking an organisation name in the CRM Organisations tab now opens a detail drawer showing name, phone, email, website plus the full contacts list, matching the pattern of the contact detail drawer. **Read mode by default** with an ✎ Edit button aligned right of the section heading; edit mode exposes all four fields (name, phone, email, website) with Save/Cancel. Clicking ✎ from the table row opens straight in edit mode. Organisation contact rows show name + mobile/email meta; clicking the name opens the full contact detail drawer (same as from the contacts list). Phone/email/website render as clickable `tel:` / `mailto:` / external links in view mode. **Backend**: `PUT /api/contacts` with `org_id` now updates `phone`, `email`, `website` alongside `name` (was previously name-only). `create_org` action already supported all fields — no change there. No DB migration. |
| V74.4 | **CRM JSONB path fix.** `api/contacts.js` was reading `data->>'address'` and `data->>'suburb'` from the `pipeline` table, but kanban stores those fields nested under `property` (full shape is `{ stage, note, addedAt, property: { address, suburb, lat, lng, ... }, terms, offers, dd }`). Result: Linked Properties in the CRM contact drawer showed the pipeline ID in place of the address (e.g. `property-1775203487841` repeated), and the pipeline-selector dropdown when linking a property was blank. Fixed all five occurrences to use `data->'property'->>'address'` and `data->'property'->>'suburb'`: `contact_properties` query, `pipeline_list` query, `notes` query's `property_address` alias. No DB change needed — data was always correct, query was wrong. |
| V74.3 | **CRM UI refinements.** (1) **Pipeline modal contacts row**: role moved from standalone badge/dropdown to plain-text badge inline in the meta line between organisation and mobile (`Acme Pty · Vendor · 0400 · email`). No inline dropdown — role changes via the Edit form now. (2) **Edit Contact form (pipeline side)**: Role dropdown restored next to Organisation, labelled "Role (this property)". Saving an edit now persists role to `contact_properties` for the current `pipelineId` via a link-upsert alongside the identity PUT. This is the explicit place to change a contact's role on a given property. (3) **CRM contact detail → Linked Properties**: row layout changed from `[address · role ▾ · ✕]` to `[address · pipeline-id-pill · role ▾ · ✕]`. The pipeline ID pill is a clickable link — clicking opens that pipeline item (closes CRM view, opens Kanban, auto-opens the card modal). (4) **Site Access section heading**: "Set password" / "Reset password" / "Change my password" button moved from below the checkboxes to the right side of the section heading, matching the "+ Link Property" pattern used elsewhere. (5) **Kanban exposes `window.openPipelineItem(id)`** for cross-module navigation. Also fixed/kept: contact identity edits via CRM-side drawer `renderContactDrawer` still omit the role field (role is inherently per-property, not a contact attribute, so global contact edit doesn't offer it). |
| V74.2 | **CRM role model fixes.** Role is per-property-per-contact (lives on `contact_properties`, not on `contacts`) — same person can be Vendor on one deal and Purchaser on another. UI previously had role dropdowns on contact edit forms that were silently discarded on save. **Fixes**: (1) `api/contacts.js` — `contact_properties` query used wrong column (`cp.created_at` → `cp.linked_at`); this was throwing 500 and the frontend was silently catching it, so contact drawers showed no linked properties even when the count badge said 2+. (2) Removed Role dropdown from pipeline-side contact Add/Edit form (`showForm`); organisation now full-width. (3) Removed Role dropdown from CRM-side drawer form (`renderContactDrawer`) — was dead UI, save handler never read it. (4) Replaced static role badge in pipeline contacts list with **inline role dropdown** that saves to `contact_properties` on change, per-property. (5) Removed Role column from CRM contact list table (header + cells + colspan 7→6). (6) When linking an existing contact, default role = their most recent role on any property (via new `GET /api/contacts?last_role=1&contact_id=X` endpoint), falling back to `'vendor'`. New contacts still default to `'vendor'`. Net effect: role is now exclusively set via the inline dropdown next to each contact in a property's contacts list. |
| V74.1 | **Site Access UI simplification.** Merged "Can log in" and "Full site access" into a single **PropMap Access** checkbox in the CRM contact detail drawer — ticking it sets `can_login = true` and `access_modules = ['propmap']` in one API call; unticking revokes both (password is preserved). Admin checkbox unchanged. Rationale: the two checkboxes were functionally redundant while only one module exists. When CRM and Finance later become independently-gated modules, each gets its own access checkbox; "can log in" becomes implicit in having any module access. Login endpoint and DB schema unchanged — still checks `can_login`. Fallback env-var superuser continues to receive `['*']` wildcard for full access. |
| V74 | **Authentication & site access.** Entire site gated behind a session cookie via `middleware.js` (Vercel Routing Middleware, Edge runtime) — protects both pages and API routes, so Domain API proxy, tile proxy, and all other endpoints are no longer publicly hit-able. New branded `/login.html`. JWT (HS256 via `jose`) stored in httpOnly Secure SameSite=Lax cookie, 30-day expiry. **Contacts table extended**: `can_login`, `is_admin`, `password_hash` (bcryptjs, 10 rounds), `last_login_at`, `access_modules TEXT[]` (default `['*']` = full site access; per-module wiring scaffolded for future Map/CRM/Finance split). **Login priority**: DB first, then env-var fallback superuser (`ADMIN_FALLBACK_EMAIL`, `ADMIN_FALLBACK_PASSWORD_HASH`) that always has admin and works even if Neon is unreachable. **New endpoints** (`api/auth/*`): `login`, `logout`, `me`, `set-password` (admin or self; self requires current password), `update-access` (admin-only, with last-admin safeguard — cannot orphan DB admin set through UI). **CRM Site Access section** added to contact detail drawer: Can log in / Administrator / Full site access checkboxes, Last login display, Set/Reset/Change password form. Admin-gated; non-admins only see self-service password change on their own record. **Header user menu** in `index.html` — avatar with initials, dropdown showing full name/email/role and Sign out action; bootstraps from `/api/auth/me` on page load. **New files**: `middleware.js`, `login.html`, `lib/auth.js`, `api/auth/{login,logout,me,set-password,update-access}.js`, `scripts/hash-password.mjs`. **New env vars** (required before V74 goes live): `JWT_SECRET`, `ADMIN_FALLBACK_EMAIL`, `ADMIN_FALLBACK_PASSWORD_HASH`. **New deps**: `jose`, `bcryptjs`. `api/db-setup.js` extended with ALTER statements for all auth columns (safe to re-run). Framework-agnostic middleware uses plain Web Request/Response (not `next/server`) so no Next.js dependency. Portability: only `middleware.js` is Vercel-specific; if migrating, delete it and call `requireSession()` at the top of each API route — `lib/auth.js` already exposes this. See **Authentication** section for full setup, day-to-day admin tasks, and lockout recovery. |
| V73 | Leppington and South Creek ILPs added. |
| V68 | **map.js improvements.** Viewport and filter persistence: map center/zoom saved to `localStorage` on every pan/zoom and restored on page load (deferred to `window.load` to avoid Leaflet container sizing race); active filters saved to `localStorage` on Apply and Clear, restored on load including chip/select/checkbox UI state and filter badge count. Measure tool fixed: removed broken secondary picker popup that was appending to a hidden parent; Distance and Area now injected directly as items in the Tools dropdown menu; Clear Measurement item shown only when a measurement is active. Selecting a Domain API listing marker no longer recentres the map (popup `autoPan` disabled; `setView` suppressed on marker click, preserved on sidebar card click). **Data + overlays:** `catherine_park_north_zoning_wgs84.geojson` added — Catherine Park North proposed zoning (R2/R3/SP2) georeferenced from Figure 40 of the Draft Planning Proposal (Sep 2025) using 3 confirmed road intersection GCPs. Added to Zoning overlay group. `map.js` `buildLeafletLayer` extended with `vectorUrl` branch for fetch-based GeoJSON overlays. |
| V67 | **Finance module — Phase 2 (Data Integrity, Calculations & UX).** **File renames**: `finance/finance.js` → `finance/finance-module.js`, `api/finance.js` → `api/finance-api.js` (delete old files on deploy). **Data integrity**: all pipeline monetary values stored as plain numbers. Submit offer handler force-blurs all inputs before reading so unblurred tranches are captured. `deleteOffer` uses `String()` coercion for ID comparison. **Kanban modal**: "Terms Offered" and "Model in Financial Feasibility" merged into single **Submitted Offers & Financial Feasibility** section. Each offer row shows full details (price, settlement, deposit tranches) plus 📊 Model and ✕ delete buttons. **+ Add Offer** button in section header opens inline popup form immediately below heading. Vendor terms row shown with same detail, no delete. **Nav buttons**: Pipeline and Finance converted to `toggle-btn` with `.dot` indicator matching Listings. Dot goes accent-coloured when active. Finance button opens/closes finance view. Pipeline button opens pipeline board. **Finance → Pipeline link**: navigates back to pipeline modal without triggering kanban close. **Finance table**: Funds to Complete section with ▶/▼ toggle and **Include in cashflow** checkbox (default on). Each cost placed in correct year: deposits at cumulative days from contract ÷ 365, purchase costs at offer settlement year. `_settlementYr` computed once in `runModel` from actual offer settlement days and reused by KPI tiles, table rows, and cashflow adjustment — all consistent. **KPI strip**: 9 tiles, CSS grid, 75% of original size. Tiles: Acquisition Price · Comparable Value · Total Loan · Cash Required (Upfront) · Cash Required (Settlement) · Cash Required (Total) · Net Income (Yr 1) · Asset Value (Exit) · NPV at Exit. Cashflow (Yr 1) tile removed. **Cash Required definitions**: Upfront = all FTC items except Commission and Equity Contribution; Settlement = Commission + Equity Contribution; Total = Upfront + Settlement = Total Purchase Costs. **Total Purchase Costs** = all Funds to Complete items across all years (deposits + stamp + valuation + solicitor + inspections + commission + equity). **Stamp duty**: auto-calculated only on new model creation — never overwritten on existing models, preserving manual changes. Editing acquisition price no longer recalculates stamp duty. **Sidebar sections**: all start collapsed. Purchase Costs moved into Outgoings section as first subsection. Deposits shown as first items under Purchase Costs. Revenue section: Rent (accepts /w /m /y) + Other. All running cost fields annual (accept /w /m /y): Council, Water, Cleaning, Insurance, Land Tax, Management Fee, Common Power, Fire Services, Maintenance, Sinking Fund, Other. Separate Council (quarterly) and Maintenance (monthly) inputs removed — stored as annual. **Settlement lag** auto-set from offer settlement days on open (rent starts at correct year). **ROE** = Cashflow ÷ Total Cash Required. |
| V66.2 | **Finance module enhancements.** Calculation engine rewritten to match `Feasibility_-82WPRL-v3.xlsx`: interest-only loan driven by `% profit used for debt reduction` (principal paid = (Rent − Interest) × debt reduction %; 0% = pure interest-only), settlement lag (pre-settlement years show zero rent/interest), Cost of Funds row (upfront cash × cost of capital per year), NPV = Asset Value − Cost of Funds (per-year, not DCF). Dual cash totals: Upfront (deposit + purchase costs) and Total (upfront − pre-reval cashflows). Inputs correctly split into grey (editable) vs calculated display fields — weekly rent × 52, council quarterly × 4, maintenance monthly × 12, management fee % × gross rent, sinking fund % × acquisition price. Five comparable value methods (Gross Area, 30% GRV, Development TDC, Method 5 Yield-derived). **Multi-state stamp duty**: state auto-detected from property address; separate formula for NSW, VIC, QLD, SA, ACT — each sourced from official .gov.au pages (Revenue NSW contracts guide, SRO Vic fixtures page, QRO rates page, RevenueSA, ACT Revenue Office non-commercial table). NSW rates updated to 1 July 2025 CPI-adjusted thresholds. **Kanban modal**: Finance button moved from header to below Terms Offered section, restyled as full-width accent action link; passes most recent offer price (or vendor terms price) to finance module. **Price carry-forward**: new models seeded from offer price; existing models preserve all assumptions — only acquisitionPrice updates if offer differs. **Finance header**: phase chevron nav (Financial Feasibility › Acquisition → Delivery placeholder); Mean Comparable Value shown live in header. **Comparable section**: collapsed by default, mean value shown as badge in section header. |
| V66 | **Finance module** (Phase 1 — Feasibility, initial). New `finance/` folder with `finance.js` and `finance-styles.css`. New `api/finance.js` (Postgres CRUD, `property_financials` table). Nav updated: **Pipeline \| CRM \| Finance \| ⚙ Tools ▾**. |
| V65 | Extended contact schema (baseline for v66). |
| V62 | CRM module (contacts DB, collapsible modal section, Domain agent save). Timestamped notes with reverse-chronological history. Lot/DP async backfill. Agent/listingUrl stored on pipeline items. Address-string listing match (normalised, 3-pass). `runDomainSearchAt` for immediate post-search address lookup. Domain search debounce 5s→1.5s. `_suppressNextDomainSearch` flag. Listing panel highlight after address search. `api/contacts.js`, `api/db-setup.js`, `crm.js`, `crm-styles.css` added. |
| V60 | Domain API live (no mock). Viewport geoWindow search, 1.5s debounce, 100 cap. `dd-risks.js` for DD automation. Topo = NSW VectorTile Hybrid via MapLibre GL. Tiles proxied via `api/tiles.js` query params. |
