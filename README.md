# Sydney Property Map — V76.7

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
│   ├── properties.js        — Properties CRUD (V75) — permanent land identity; `state_prop_id` column added (V75.4c); `state` column added (V76.7)
│   ├── deals.js             — Deals CRUD (V75) — workflow-scoped Kanban cards; auto-cleans orphaned Parcels on DELETE (V75.4d.1). V75.6: accepts `board_id` filter in GET; accepts `board_id` + `column_id` in POST and PUT (auto-derives from legacy `workflow` + `stage` when absent, so older callers keep working). V76.2: `fetchAndExpand()` adds `has_due_action` boolean to each deal row via a single batched actions query
│   ├── roles.js             — Role catalogue CRUD (V75)
│   ├── contacts.js          — CRM Contacts CRUD, backed by entity_contacts (V75). Note endpoints return 410 Gone and redirect to /api/notes (V75.3)
│   ├── notes.js             — Unified polymorphic notes CRUD (V75.3) — replaces deals.data.notes[] and contact_notes table
│   ├── finance-api.js       — Financial model CRUD, keyed by deal_id going forward (V75)
│   ├── migrate-to-v75.js    — V75.0 structural migration endpoint (admin-only)
│   ├── migrate-to-v75-3.js  — V75.3 migration: notes unification + DD per-deal (admin-only)
│   ├── migrate-to-v75-4.js  — V75.4 migration: Parcels introduction + synthetic-row split (admin-only)
│   ├── parcels.js           — Parcels CRUD (V75.4); DELETE also removes child properties (V75.4d.1)
│   ├── repair-v75-4c.js     — V75.4c: re-queries NSW Spatial Portal at each child lat/lng to backfill authoritative addresses + `lot_dps` + `state_prop_id` (admin-only)
│   ├── rebuild-parcel-by-lotdp.js    — V75.4c: accepts client-pre-resolved lot data to rebuild a parcel's children cleanly (admin-only)
│   ├── create-parcel-from-lookup.js  — V75.4d: creates a Parcel + N Properties + Deal from client-pre-resolved NSW data (admin-only). V75.6: sets `board_id` + `column_id` on the new deal
│   ├── backfill-parcel-rings.js      — V75.4d.4: one-time backfill of lot polygon rings on child properties created before ring-aware lookup (admin-only)
│   ├── migrate-to-v75-6.js — V75.6 migration: creates `boards`, `board_columns`, `deal_user_order` tables; seeds 3 system boards (Acquisition / Buyer Enquiry / Agency Sales) with 6 columns each; backfills every deal's `board_id` + `column_id` from its legacy `workflow` + `stage` (admin-only)
│   ├── migrate-to-v75-7.js — V76.2 migration: adds `boards.board_type` column and creates `actions` table (admin-only)
│   ├── migrate-to-v76-7.js — V76.7 migration: adds `properties.state` column (admin-only). Idempotent. No backfill — manual cleanup via CRM Properties modal
│   ├── domain-price-estimates.js — V76.7: cache for derived price ranges from the Reveal Price bracket-probe workflow. Auto-creates `domain_price_estimates` table on first call. GET batch lookup, POST upsert, DELETE invalidation
│   ├── boards.js           — V75.6: Boards + columns CRUD. System boards (admin-only); user boards (owner-only). DELETE refuses if the board still has deals. GET returns each board with its `columns[]` nested. V76.2: accepts `board_type` on POST; guards now check actions refs alongside deals
│   ├── actions.js          — V76.2: Actions CRUD. Server-side Due promotion runs on every GET (promotes overdue todo/wip rows to status='due' in a single UPDATE). Auto-bootstraps a per-user "My Actions" board with 5 default columns on first access
│   ├── deal-order.js       — V75.6: per-user card-ordering within a board column. GET returns `{dealId → column_order}` for the current user; PUT accepts an array of `{deal_id, column_order}` rows and upserts them
│   ├── db-setup.js          — DB schema setup (legacy tables + auth columns)
│   ├── domain-search.js     — Domain API proxy (keeps key server-side)
│   ├── tiles.js             — NSW tile proxy (query params, not path segments)
│   ├── topo-style.js        — NSW topo style proxy (CORS fix)
│   └── health.js            — DB health check endpoint
├── lib/
│   ├── auth.js              — Shared JWT sign/verify, cookie helpers, session guards (V74)
│   ├── db.js                — Database URL resolver (pipeline_POSTGRES_URL prefix for Neon integration)
│   ├── parcel-format.js     — `formatParcelTitle()` — collapses street numbers into ranges for Parcel display (V75.4)
│   └── nsw-lookup.js        — Server-side NSW Spatial Portal lookup helper (used by repair endpoint and rings backfill; NOT used at create time — that's client-side) (V75.4c)
├── scripts/
│   └── hash-password.mjs    — Local utility: generates bcrypt hash for fallback env var (V74)
├── finance/
│   ├── finance-module.js    — Financial feasibility calculator, UI, DB persistence
│   └── finance-styles.css   — Finance module styles
├── index.html               — Page structure and UI (now with user menu in header)
├── styles.css               — All styling (includes user menu styles)
├── crm.js                   — CRM contact management module (now with Site Access section). V76.7: editable State dropdown in Properties modal (NSW/VIC/QLD/WA/SA/TAS/ACT/NT); `notifyPropertyChanged()` + `notifyParcelChanged()` helpers fire CustomEvents after every CRM property/parcel mutation so other modules (kanban, map) can refresh stale in-memory copies
├── crm-styles.css           — CRM-specific styles (includes Site Access styles)
├── overlays-meta.js         — Overlay definitions, zone config, type metadata
├── overlays-b64-sw-wastewater.js  — SW Sydney wastewater GeoTIFF (b64)
├── overlays-b64-sw-potable.js     — SW Sydney potable water GeoTIFF (b64)
├── overlays-b64-sw-ilp.js         — Leppington ILP GeoTIFF (b64)
├── gsp-wsa-sw-wastewater.js       — WSA wastewater GeoJSON (planning stages)
├── WSA_SW_Wastewater_Precincts.geojson
├── catherine_park_north_zoning_wgs84.geojson  — Catherine Park North proposed zoning (R2/R3/SP2, georeferenced)
├── domain-api.js            — Domain API client (live only, no mock). V76.7: captures `state` from Domain response; `revealHiddenPrices()` runs bracket-sweep probes for "Contact Agent" / "MAKE AN OFFER" listings; `hydrateDerivedPrices()` merges cached estimates into search results; `stripTrailingSuburb()` normalises `displayableAddress` to street-only; `listedSince` parameter for new-listings filter
├── dd-risks.js              — DD risk assessment (queries NSW layers at lat/lng)
├── nsw-lookup-client.js     — **Browser-side** NSW Spatial Portal helper (window.NSWLookup). Queries are done in the browser, not Vercel, because Vercel→NSW proved unreliable (timeouts on larger lots). Used at parcel create time for authoritative address + Lot/DP + propid + lot polygon rings (V75.4c/d)
├── map.js                   — Map logic, overlays, search, listings, Domain init. V76.7: reverse geocoder + autocomplete capture state; CoreLogic mapper extracts state; `addCurrentSelectionToPipeline()` resolves state from listing/click/bounding-box fallback; `stateFromLatLng()` AU state inference helper; listings panel uses `priceCellHtml()` for Reveal Price button + derived-price display; property-type badge removed from listing cards; `_lastDomainSearchOptions` stash for Reveal Price replay
├── kanban.js                — Pipeline Kanban board with DD automation and CRM. V76.2: renders both deal and action boards (dispatches on `board_type`); `renderActionsBoard()`, `openActionModal()`, `refreshDealActions()`; ⏰ Action badge on deal cards; Actions section in deal modal. V76.7: `state` field threaded through `propertyShape` (parcel + single) and `internalToPropertyPayload`; card + modal display use real state; `formatKbPrice()` recognises `derived: true` and renders `~$X – $Y (est.)`; `propertyChanged` / `parcelChanged` event listeners refresh stale pipeline cards from DB without hard refresh
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

-- V76.7: derived price-range cache for Domain "Contact Agent" listings.
-- Auto-created lazily by api/domain-price-estimates.js on first call.
domain_price_estimates (
  domain_id    TEXT PK,            -- Domain listing id
  price_from   BIGINT,             -- inferred lower bound (NULL = unbounded below)
  price_to     BIGINT,             -- inferred upper bound (NULL = unbounded above; 30M+)
  derived_at   TIMESTAMPTZ DEFAULT NOW()
)

-- V76.7: properties.state column added — see migrate-to-v76-7.js
-- ALTER TABLE properties ADD COLUMN state TEXT NOT NULL DEFAULT 'NSW';
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
- **Boards** replace hard-coded workflows (V75.6). Three seeded system boards (Acquisition / Buyer Enquiry / Agency Sales). Users can create their own personal boards; admins can create more system boards visible to all.
- **Columns** per board are user-editable — add, rename, reorder, recolour, set terminal flag, set per-column map-pin visibility.
- **Per-user card ordering**: drag a card vertically inside a column to reorder; ordering persists for that user only (user A's order doesn't affect user B's).
- Cross-column drag changes the deal's column; cards remain in their new order after reload.
- DD risk auto-population on property add (async, from `dd-risks.js`)
- DD items: Zoning, Yield, Access, Wastewater, Water, Easements, Electricity, Flooding, Riparian, Vegetation, Contamination, Salinity, Heritage, Aboriginal, Bushfire, Odor, Commercial
- Card price shows vendor terms price as fallback when listing price unavailable
- Price fields (vendor terms, offer) auto-format to whole dollars on blur/submit
- Settlement fields accept days/months/years — converted to days on save (e.g. "3 months" → "90 days")
- Deposit fields accept free text (dollars or percentage)
- Click property address on card to fly map to that location (routes through `Router.navigate('/')` so map controls re-appear)
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
- **Actions** (V76.2): tasks linked to this deal — description, assignee, effort, duration, due date, reminder. One-click edit/create; rows badge their current status (ToDo / WIP / Due / Done / Void) and flag overdue with a red left-border
- **Notes**: timestamped entries in reverse-chronological order; Ctrl/Cmd+Enter to submit; individual note deletion

### Actions (V76.2)

First-class task entity tracked through a fixed workflow (ToDo → WIP → Due → Done | Void). Each action has a description, an assignee (any CRM contact, defaulting to the current user), optional effort/duration estimates (days/months/years), due date, and reminder date. Actions can be linked to a Deal or stand alone.

- **My Actions Kanban wall**: each user gets a personal Kanban board named *My Actions* under the *My Boards* group in the Pipeline board selector. Columns (ToDo / WIP / Due / Done / Void) are user-editable like any other board — rename, recolour, reorder, add extras. Only the assignee sees the board; it's scoped to `owner_id`.
- **Drag-and-drop** between columns works the same as the Deal Kanban. Moving a card updates `column_id` and derives `status` from the column's `stage_slug`.
- **Server-side Due promotion**: on every read of `/api/actions?assignee=me`, any action with `status IN ('todo','wip')` whose `due_date ≤ today` is flipped to `status='due'` and placed in the Due column. No cron — happens lazily, so latency stays low and state converges on first access.
- **Deal-card badge**: if any action linked to a deal is currently due or overdue, the deal's Kanban card shows a red *⏰ Action* indicator. Computed server-side in `api/deals.js` via `fetchAndExpand()`, so it doesn't require an extra client roundtrip.
- **Actions section in deal modal**: every deal modal has an Actions panel listing linked actions with one-click edit and *+ Add Action* (pre-fills `deal_id`).
- **Standalone actions**: creating an action from the My Actions board directly (via *+ New Action*) creates it without a `deal_id`. The deal field in the modal is optional.
- **Author stamping**: `creator_id` is stamped server-side from the JWT session; can't be spoofed by the client. For the env-var fallback admin (no `contacts` row), `creator_id` is left NULL.

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
| V76.7 | **State field, Reveal Price, Listed Since filter, suburb-duplication fix, cross-module change broadcast.** Six related improvements bundled into one release. **(1) State as a first-class field**: new `properties.state TEXT NOT NULL DEFAULT 'NSW'` column. Domain normaliser captures `pd.state` from the API response; CoreLogic mapper extracts state from the trailing `SUBURB STATE postcode` pattern; ArcGIS reverse geocoder + autocomplete return state via `attr.Region`; `_selectedParcels` and `clickMarkerData` thread state through; `addCurrentSelectionToPipeline()` resolves with priority `listing.state → parcels[0].state → stateFromLatLng() bounding-box fallback → 'NSW'`. Display sites updated everywhere — Domain + CoreLogic listing cards, Kanban card + modal, popups, CRM Properties modal (now with editable NSW/VIC/QLD/WA/SA/TAS/ACT/NT dropdown). Backwards-compatible: existing rows default to NSW; manual cleanup via CRM modal for any wrongly-labelled interstate. **(2) Listed Since filter**: new "Last 7 / 14 / 30 days" filter on the residential search panel; passes `listedSince` ISO datetime to Domain's API; persisted in `_activeFilters` alongside other filter state. **(3) Reveal Price**: new button replaces the price text on listings where the agent has withheld the price (displayPrice = "Contact Agent" / "MAKE AN OFFER" with no `priceFrom`/`priceTo`). Click triggers a viewport-wide bracket-sweep probe — re-queries Domain at brackets `[1M, 1.5M, 2M, 3M, 4M, 5M, 7.5M, 10M, 15M, 20M, 30M]` (skipping any outside the user's active price filter) and notes which target listings drop out at each bracket. Same Domain API cost regardless of how many hidden-price listings are in view (one batch probe, all listings tested simultaneously). Early-stops when no targets remain. Results cached server-side in new `domain_price_estimates` table; auto-invalidated when Domain ever returns a real price for that listing. Derived prices render as `~$2M – $3M (est.)` everywhere (listings panel, popup, Kanban card, modal) — same style as real prices, distinguished only by the `~` prefix and `(est.)` suffix. **(4) Price normaliser tightened**: prefers numeric `priceFrom`/`priceTo` range over text `displayPrice` (so agents who put "Contact Agent" in `displayPrice` despite Domain having a real range no longer cause "Price Unavailable" UI). Regex tightened from `/\\d/` to `/\\$\\s?\\d/` so "Auction 6/12" no longer gets mistaken for a price. **(5) Suburb-duplication bug fix**: Domain's `displayableAddress` includes the suburb (e.g. "89 George Road, Leppington") whereas every other path in the app stores `address` as street-only. Concatenating `${address}, ${suburb}` produced "89 George Road, Leppington, Leppington NSW" on Domain-sourced records. New `stripTrailingSuburb()` helper in `domain-api.js` pops the trailing suburb when present, leaving suburb-only addresses untouched as a fallback. **(6) Cross-module change broadcast**: previously, editing a property in the CRM (state, address, suburb, lot/DP, Not Suitable, Domain link) didn't reflect on the corresponding Pipeline card / Deal modal until a hard refresh. Fix: new `window.CRM.notifyPropertyChanged(id)` + `notifyParcelChanged(id)` helpers fire `CustomEvent`s after every CRM mutation; `kanban.js` listens and re-runs `dbLoad()` to refresh the in-memory `pipeline` dict (cheap-filtered to only fire when the changed entity is actually referenced by a pipeline entry, avoiding needless round-trips for CRM-only properties). Other listing-card chrome trimmed: property-type badge ("House", "AcreageSemiRural") removed from both Domain and CoreLogic cards to give the price more horizontal room. **Deploy sequence**: push files → `POST /api/migrate-to-v76-7` `{confirm:true}` (idempotent; adds `properties.state` with `DEFAULT 'NSW'`) → hard reload → verify (a) State dropdown appears in CRM Properties modal, (b) interstate listings on the map show the correct state suffix, (c) editing a property in CRM updates the Pipeline card immediately, (d) Reveal Price button appears on "Contact Agent" listings and produces ranged estimates after click. The `domain_price_estimates` table is auto-created lazily on first call — no migration needed. Rollback: `ALTER TABLE properties DROP COLUMN state; DROP TABLE domain_price_estimates;` — both additive, no existing data touched. **Out-of-scope follow-ups**: multi-select pipeline-add (`_createParcelFromSelection` + `api/create-parcel-from-lookup.js`) is currently NSW-gated, so state plumbing is deferred there until the NSW-only restriction is lifted. |
| V76.2 | **Actions — assignable tasks with their own Kanban wall.** New first-class entity: tasks with description, assignee (any CRM contact, defaulting to current user), effort (days/months/years), duration (days/months/years), due date, reminder date, and a fixed workflow (ToDo → WIP → Due → Done \| Void). **Schema**: new `actions` table (id, description, assignee_id FK contacts, creator_id FK contacts nullable, deal_id FK deals nullable, effort_value/unit, duration_value/unit, due_date, reminder_date, status, board_id, column_id, column_order, timestamps); new `boards.board_type` column (`'deal'` \| `'action'`, default `'deal'`, backfilled automatically for existing boards). **New API**: `api/actions.js` (GET assignee=me \| deal_id \| id; POST creates with server-stamped creator_id; PATCH with auto-derive status from column; DELETE). Bootstraps a "My Actions" board for each user on first access — seeds the 5 default columns with matching `stage_slug`s. **Server-side Due promotion**: on every GET for an assignee, rows where `status IN ('todo','wip') AND due_date ≤ CURRENT_DATE` are flipped to `status='due'` and moved to the Due column in a single UPDATE. No cron job; state converges lazily on read. **`api/deals.js`** extended: `fetchAndExpand()` adds a `has_due_action` boolean to each deal row via a single batched query — powers the ⏰ Action badge on deal Kanban cards. **`api/boards.js`**: accepts `board_type` on POST; column-delete and board-delete guards now check both `deals` and `actions` refs (409 if either). **Frontend — `kanban.js`**: `renderBoard()` dispatches to new `renderActionsBoard()` when the active board's `board_type='action'`; full action card render with assignee/due/effort metadata, overdue styling (red left border), per-column drag-and-drop using the same insertion-index pattern as deals; new `openActionModal()` for create/edit (with Status dropdown only shown on edit), `refreshDealActions()` for in-place refresh inside open deal modals. New Actions section in the deal modal between DD and Notes. **Deploy sequence**: push files → `POST /api/migrate-to-v75-7` → hard reload → verify (a) My Actions appears in the board selector under My Boards, (b) creating an action with a past due date auto-lands in the Due column on next read, (c) deals with due actions show ⏰ on their card. Rollback: `DROP TABLE actions; ALTER TABLE boards DROP COLUMN board_type;` — all changes are additive, no existing deal data is touched. |
| V76.1 | **Promotion to production of the V75.5 + V75.6 feature stack.** Formal release tag combining: (a) the Properties CRM tab (V75.5) with its full property modal, per-modal Delete buttons, measurement-tool rework, and `_syncAfterEntityDelete` helper for map-pin refresh after CRM deletes; (b) Boards + Columns (V75.6) — Kanban workflows are now user-editable with per-user card ordering; (c) UI consistency polish (V75.6.1–V75.6.4) — Header 2 toolbar convention, stable `<select>` element across re-renders, fast-switch parallel deal fetches. **Deploy sequence for prod**: push all files → `GET /api/migrate-to-v75-6` dry-run → `POST /api/migrate-to-v75-6` execute → hard reload → verify board selector renders + system boards populated with 6 columns each + existing deals backfilled with `board_id` + `column_id`. Rollback: restore Neon DB branch snapshot (boards/board_columns/deal_user_order tables + deals.board_id/column_id columns are all additive; old `workflow`/`stage` columns kept for safety). |
| V75.6.4 | **Stable board-selector toolbar.** Fix for intermittent "pick a new board, nothing happens; pick again, it works" bug. Root cause: `_renderBoardSelectorBar()` was being called from `renderBoard()` which replaced the `<select>` element via `innerHTML = ...` mid-handler; the in-flight change event completed on a detached node. Fix: toolbar is now built once on first render; subsequent renders patch only `select.value`, `deleteBtn.disabled`, and (via a cheap diff) the `<option>` list if the boards array has actually changed. The `<select>` element persists — its change listener stays bound and board switches fire cleanly on first click. |
| V75.6.3 | **Board-switch speedup.** Switching boards was serially awaiting 3 fetches (`loadBoards` → `loadUserDealOrder` → `dbLoad`). Now: the switch handler renders the new board's empty columns instantly (so the user sees the switch immediately), then parallelises `dbLoad()` + `loadUserDealOrder()` via `Promise.all`. `loadBoards()` is skipped on switch — the boards list is already in memory from initial load and `openEditColumnsModal` already refreshes it locally after a save. Halves the wait on board switch. |
| V75.6.2 | **Board UX polish.** Six fixes: (1) dropdown auto-widths to content (`width: auto; max-width: 280px`); (2) toolbar CSS rewritten to match `.crm-tab` chrome exactly (padding, border, hover states); (3) "Delete Board" button added to the toolbar with red danger variant — disabled when the current board isn't user-deletable; server enforces permission + blocks deletion when deals exist (returns 409 with count); (4) switch-board handler now re-fetches boards so columns stay current; (5) `api/boards.js` POST no longer seeds 6 default columns — new boards start empty; (6) "+ Board" opens a proper modal with a name input and (admin only) a visual My Board / System Board radio chooser with selected-state styling — replaces the old `prompt` + `confirm` JS dialogs. |
| V75.6.1 | **Session + Header 2 fixes.** Three issues resolved: (1) "+ New Board" was failing with "Session user id missing" — root cause: `api/boards.js` + `api/deal-order.js` were reading `session.contact_id` which doesn't exist in the JWT payload. Fix: use `session.sub` (the canonical JWT subject field per `lib/auth.js`), coerced via `parseInt(session.sub, 10)` since `contacts.id` is INTEGER. Imported canonical `isAdmin` from `lib/auth.js`. (2) Board selector + action buttons were in a separate bar below the module title; moved into `.kanban-header` (Header 2) alongside the title, matching the Pipeline module to the same Header-2 convention already used by CRM and Finance. (3) Edit Columns modal's "Terminal" column renamed to "Kanban" (the underlying `is_terminal` DB field kept). |
| V75.6 | **Boards + Columns + per-user card ordering.** Replaces the hard-coded workflow/stage model with user-editable Boards. **Schema**: new `boards` table (`id, name, owner_id INTEGER, is_system BOOLEAN, sort_order`); new `board_columns` table (`id, board_id, name, stage_slug, sort_order, show_on_map, is_terminal, color`); new `deal_user_order` table (`user_id, deal_id, column_order` — per-user ordering within a column, PK composite); `deals.board_id` + `deals.column_id` columns added as FKs (old `workflow` + `stage` columns kept for safety). **Migration** (`api/migrate-to-v75-6.js`): seeds 3 system boards (`sys_acquisition`, `sys_buyer_enquiry`, `sys_agency_sales`), each with the 6 standard columns; backfills every existing deal's `board_id` + `column_id` from its legacy workflow + stage. **New API endpoints**: `api/boards.js` (full CRUD with ownership — system boards admin-only, user boards owner-only; DELETE refuses if deals exist); `api/deal-order.js` (GET/PUT per-user ordering per board). **`api/deals.js`** extended: accepts `board_id` filter in GET; accepts `board_id` + `column_id` in POST + PUT (auto-derives from `workflow` + `stage` when absent for legacy callers). **`api/create-parcel-from-lookup.js`** sets `board_id = sys_{workflow}` + `column_id = sys_{workflow}_{stage}` on the new deal. **Frontend — `kanban.js`**: dynamic `resolveCurrentStages()` pulls columns from the current board instead of a static `STAGES` constant; new board-selector bar in the Pipeline Header 2 (dropdown + "+ Board" + "Edit Columns" + "Delete Board"); new board creation modal; full Edit Columns modal with drag-to-reorder columns, rename, colour picker, show-on-map toggle, terminal toggle; intra-column card drag-reorder with insertion-index computed from cursor Y-position; per-user ordering persisted via `/api/deal-order`. **`map.js`**: `PIPELINE_PIN_STAGES` hard-coded set replaced by `_shouldRenderPipelinePin(item)` which reads the current column's `show_on_map` flag; falls back to the legacy stage-slug set for entries still in transit. **`window.getPipelineStages`** now returns `resolveCurrentStages()` instead of the static `STAGES`. Works per-user: user A's drag order on Acquisition doesn't affect user B's. **Deploy gotcha**: the frontend expects the DB migration to have run — don't deploy files without also running `POST /api/migrate-to-v75-6` on that environment. |
| V75.5.6 | **Route-through-router on module close.** Map controls (Leaflet zoom, layers, overlays) were missing after clicking a Kanban card's 📍 address link to show the property on the map. Root cause: the CSS rule `body:not([data-route="mapping"]) .leaflet-control-container { display: none }` hides all map controls whenever `body[data-route]` isn't `"mapping"`, but the card-click handler was calling `toggleKanban(false)` directly which closes the Pipeline DOM without updating `body[data-route]`. Three call sites now route through `Router.navigate('/')` instead: the card's address link, the Kanban view ✕ close button, and the CRM view ✕ close button. Each falls back to the direct toggle if the router isn't loaded. |
| V75.5.5 | **Measure area always `X m² (Y ac)`.** Dropped the size-based unit switch — measurements no longer flip to hectares / km². Thousands separator on m². Format: `5,000 m² (1.24 ac)`, `24,500 m² (6.05 ac)`, `12,350,000 m² (3,052 ac)`. |
| V75.5.4 | **Area shows acres in brackets.** `formatArea()` now always appends the acre equivalent. (Superseded by V75.5.5 which made it m²-only — no unit switching.) |
| V75.5.3 | **Measure tool fixes.** Two bugs: (1) polygon area calculation was wrong — previous shoelace implementation multiplied per-edge `mPerLng × lng` which isn't a valid planar projection (the cross-terms don't cancel). Rewrite projects all vertices into a single flat-metre plane anchored at the polygon's own centroid using `cos(centroidLat) × 111320` for `mPerLng`, then shoelace in those Cartesian coords — accurate to <0.1% for property-scale polygons at Sydney latitudes. (2) "✕ Clear Measurement" menu item was hiding as soon as the measurement finished (on double-click), even though the result stayed drawn on the map; now stays visible until `clearMeasure()` actually runs. |
| V75.5.2 | **Modal Delete buttons in headers + pipeline sync helper.** All Delete buttons across CRM Parcel / CRM Property / Kanban deal modals moved to the modal header (top-right, left of the ✕ close button) with consistent styling: outlined red (`#c0392b`) fills on hover, disabled state when deletion is invalid, simple label "Delete", simple confirm prompt "Confirm delete". New `_crm.js` helper `_syncAfterEntityDelete({parcelId? | propertyId?})` runs after server DELETE: scrubs the in-memory `pipeline` dict of entries that referenced the deleted entity, calls `cacheSave` + `renderBoard`, refreshes map pins via `window.refreshPipelinePins()`, and invalidates both CRM Parcels and Properties caches. Fixes the "star pin stays on map after CRM delete" bug — previously the pipeline dict and map pins only updated on a full page reload. Kanban modal's new Delete calls `removeFromPipeline` which already handles everything. |
| V75.5.1 | **Properties tab polish.** Search formatting fixed, parcel-child deals correctly surfaced in the Properties list (a property that's part of a parcel now shows its parent's deal), Property Modal map preview fixes (proper zoom level, lot polygon outline rendering, controls visible), race-condition fix for CRM cache invalidation when adding a property to the pipeline (was invalidating before `savePipeline` resolved, so the new entry wasn't in cache on next open). |
| V75.5 | **Properties CRM tab.** New tab in the CRM module (between Contacts and Parcels) showing every `properties` row in a searchable list. Columns: Address, Suburb, Lot/DP, Domain listing badge, Deal stage badge. Search matches Address / Suburb / Lot/DP / Domain ID / Deal stage. Clicking a row opens a **Property Modal** with the standard collapsible sections: Details (address, suburb, Lot/DP, area, `state_prop_id`, listing URL — all editable), Not Suitable (with snooze options), Deals (shows parent-parcel deal if the property is part of a parcel), Contacts (via `entity_contacts`), Notes (via `notes` table), Map Preview (CartoDB Light tiles with green polygon outline of the lot rings, zoom + fullscreen controls). Delete button disabled when the property has deals OR is part of a parcel (must delete via the parcel). |
| V75.4d.4 | **Parcel pipeline pin highlight + rings backfill.** The star pin for a parcel-deal on the map now stays as a single pin at the parcel's centroid (reverted from the interim multi-pin experiment). Clicking that pin now draws green outlines around ALL constituent child property polygons at once, using rings stored in each child's `parcels` JSONB, and zooms to fit the aggregate bounds. Missing-rings children fall back to a green centroid dot so the click still communicates extent. **`nsw-lookup-client.js`** `lookupByLatLng` now returns the Lot's polygon rings too (previously only `lookupByLotDP` did) — so parcels created via multi-select ⌘-click store polygon geometry at creation, with no later repair needed. **New admin endpoint `api/backfill-parcel-rings.js`**: re-queries NSW by `lot_dps` for all child properties missing rings and writes them into the `parcels` JSONB. GET = dry-run, POST = execute. One-time catch-up for Loftus (3) + Deepfields (2) which were created pre-V75.4d.4. **`map.js`**: new `_parcelHighlightLayer` module-scoped Leaflet layer group, cleared by `clearParcelSelection` and at the start of any single-property selection so polygons don't accumulate. `_highlightParcelChildren(parcelsArr, item)` iterates each child's rings (Leaflet expects `[lat, lng]`; source is `[lng, lat]`) and adds each as a polygon to the group. |
| V75.4d.3 | **CRM Parcels cache invalidation.** The CRM Parcels tab keeps an in-memory cache for fast search. Now invalidated automatically on: parcel create from map (cache cleared so new parcel shows on next tab open, or immediately if the tab is currently active); parcel-deal delete from Kanban (may have auto-cleaned a parcel — cache cleared to stay in sync). Exposed via `window.CRM.invalidateParcelsCache()`, called from `map.js` after `/api/create-parcel-from-lookup` and from `kanban.js` after a parcel-deal DELETE. |
| V75.4d.2 | **Kanban parcel-delete routing fix.** Bug: `removeFromPipeline` was deleting from the in-memory `pipeline[sid]` dict BEFORE calling `dbDelete(sid)`, and `dbDelete` read `pipeline[sid]._isParcel` to decide which endpoint to DELETE against — by then `pipeline[sid]` was gone so `_isParcel` was undefined (falsy), routing every delete to `/api/properties?id=<parcel-id>` which silently no-op'd. **Fix**: `removeFromPipeline` now captures `wasParcel = !!pipeline[sid]?._isParcel` before the dict delete and passes it to `dbDelete(sid, wasParcel)`. Parcel-deals now correctly hit `/api/deals?id=X` which triggers V75.4d.1's orphan-cleanup. Without this fix, parcel-deals deleted from the Kanban appeared to go but stayed in the DB with active status. |
| V75.4d.1 | **Loading state + parcel lifecycle.** The async multi-select parcel create (NSW lookups + POST + pipeline reload) could take 5-10s with no feedback, leading users to click "+ Pipeline" multiple times and create duplicate parcels. Added a lightweight in-place button state (`_setPipelineButtonState('creating', 'Lot 1 of 3…')`) that disables the popup button and updates text through phases: looking up cadastre → saving → refreshing pipeline. On success, `showKanbanToast('Parcel added to pipeline')` — elegant bottom toast matching the single-property flow. On error, button re-enables with original text. **Auto-DD for parcels** (matching `addToPipeline` behaviour for single properties): after create + pipeline reload, runs `queryDDRisks(avgLat, avgLng)` and merges results into `pipeline[newDealId].dd` (never overwriting user-set statuses), then `savePipeline` persists to `deal.data.dd`, `renderBoard` + `refreshModalDd` reflect it immediately. **Parcel lifecycle**: `api/deals.js` DELETE now detects if the deleted deal was on a Parcel and if so checks whether any OTHER deals reference that parcel — if not, the Parcel + all its child Properties are auto-deleted (response includes `parcel_deleted` and `properties_deleted` counts). `api/parcels.js` DELETE (already refused if deals exist) now also explicitly deletes child Properties before the Parcel row — the `properties.parcel_id` FK is ON DELETE SET NULL, so without this the children would be orphaned rather than removed. **Delete Parcel button** added to the Parcel Modal's Details section (right-aligned, red); disabled + tooltipped if deals exist; otherwise confirms and calls `DELETE /api/parcels?id=X`. |
| V75.4d | **Map ⌘-click integrated with client-side NSW lookup.** Multi-select parcel creation via "+ Pipeline" now creates a **real** Parcel + N Properties + Deal with authoritative NSW data from day one — no more synthetic single-row properties requiring later repair. User ⌘-clicks N blank-land points → each lat/lng is resolved via `window.NSWLookup.lookupByLatLng()` in the browser → results deduped by `lot_dps` (same-lot duplicate clicks collapse to one, with user confirm) → POSTed to new `api/create-parcel-from-lookup.js` which creates the parcel, the N children, and the deal in one transaction. Aborts with a clear alert if any pin can't be resolved to an NSW lot (no partial parcels with null data). Single-listing and single-click flows still use the legacy `addToPipeline()` path but now backfill `lot_dps` + `state_prop_id` asynchronously via a PUT to `/api/properties`. NSW-only: lat/lng outside NSW bounds (roughly -37.5→-28 lat, 140→154 lng) skip the NSW lookup entirely; SA flow unchanged via existing `api/cadastre.js`. On success the new parcel card auto-opens in Kanban via `window.openPipelineItem(newDealId)`. **`api/properties.js`** PUT handler now accepts `state_prop_id` in its COALESCE list. **`index.html`** loads `nsw-lookup-client.js` before `map.js` so `window.NSWLookup` is available. |
| V75.4c | **Authoritative NSW lookup via client-side helper.** The V75.4 migration created child properties with heuristic addresses (parsed from synthetic `parcels[].label`) and no lot_dps. V75.4c replaces this with authoritative data from the NSW Spatial Portal. **Data authority chain**: `lat/lng` → **Lot layer 8** (`lotidstring`) → **Property layer 12** (`address`, `propid`). Domain wins for listing display; NSW wins for `lot_dps` + new `state_prop_id` column. **Critical architecture decision — browser-side lookups**: initial implementation did NSW queries server-side from Vercel, but Vercel→NSW was unreliable — larger lots (e.g. 2//DP1280952) consistently timed out past 8s while the same URLs in the browser returned in ~1s. Moved all NSW queries to the browser via new **`nsw-lookup-client.js`** exposing `window.NSWLookup.lookupByLatLng(lat, lng)` and `lookupByLotDP(lotDpString)`. Server endpoints now accept pre-resolved data only. Switched base URL from `maps.six.nsw.gov.au/sixmaps` to `portal.spatial.nsw.gov.au/server/rest/services/NSW_Land_Parcel_Property_Theme_multiCRS/FeatureServer`. **Schema**: added `properties.state_prop_id TEXT` (NSW propid; TEXT for forward multi-state compatibility). **New `api/repair-v75-4c.js`**: walks every child property created by V75.4 migration with missing `lot_dps`, queries NSW at its lat/lng, writes back `address` + `suburb` + `lot_dps` + `state_prop_id`. Never overwrites user-set data. Ran successfully on preview + prod (Loftus 3/3, Deepfields 2/2 clean). **New `api/rebuild-parcel-by-lotdp.js`**: accepts `{parcel_id, properties: [{lot_dps, address, suburb, state_prop_id, lat, lng, area_sqm, rings}]}` and replaces a parcel's children entirely. Used when original click coords landed imprecisely (e.g. Northern Road had 4 children including 2 duplicate "2 Wentworth Road" from corner-lot misclicks; Al supplied the correct 3 Lot/DPs `17//DP1222679, 18//DP1222679, 2//DP1280952`, browser resolved each, POST rebuilt cleanly). Refuses if any existing child has its own Deal (would orphan it). **ALL-CAPS→Title Case splitter** `splitAddress()`: NSW returns `1178 THE NORTHERN ROAD BRINGELLY` in one field; utility finds the street-type pivot (ROAD/ST/AVE/etc.) to split into address + suburb and converts to title case. Street-type set covers RD, ST, AVE, LN, DR, PL, CT, CL, CRES, PDE, TCE, WAY, BLVD, HWY, PKWY, CCT, GR, ESP, SQ, plus TRAIL/TRACK/RIDGE/GLEN/WALK/RISE/VISTA/VIEW. **Files**: new `nsw-lookup-client.js` (root), new `lib/nsw-lookup.js` (server-side — kept for `repair-v75-4c` and ring backfill), new `api/repair-v75-4c.js`, new `api/rebuild-parcel-by-lotdp.js`, modified `api/properties.js` (state_prop_id in GET/PUT). **Deploy sequence**: files → GET `/api/repair-v75-4c` (dry-run) → POST execute → for each parcel still wrong, browser-side look up correct Lot/DPs via `window.NSWLookup` → POST `/api/rebuild-parcel-by-lotdp`. |
| V75.4a+b | **V75.4 post-migration polish.** V75.4a: initial address-repair attempt using ArcGIS World Geocoder produced wrong data (reported LGA "Camden" where the real suburb was Bringelly, wrong addresses for corner lots returning neighbouring street). Abandoned for V75.4c (authoritative NSW Spatial Portal path). V75.4b: minor CSS — collapsible section header button styling aligned with surrounding UI; fixed Save / Cancel button colours in Parcel Modal's Name edit field. |
| V75.4 | **Parcels as first-class entity.** Introduces Parcel — a container for 2+ adjacent/related Properties, used for multi-property acquisition deals. A Parcel has contacts, notes, and a single active Deal at a time; removing a Property detaches it without deleting it. **Schema**: new `parcels` table (`id, name, not_suitable_until, not_suitable_reason, created_at, updated_at`), new nullable FK `properties.parcel_id` ON DELETE SET NULL, new nullable FK `deals.parcel_id` ON DELETE CASCADE with CHECK constraint `(property_id IS NULL) <> (parcel_id IS NULL)` — every deal targets exactly one of a Property or a Parcel. `entity_contacts.entity_type` now accepts `'parcel'`. `notes.entity_type` now accepts `'parcel'`. **Migration** (`api/migrate-to-v75-4.js`): splits existing synthetic multi-parcel Property rows into a real Parcel + N Properties each. Parses `lot.label` correctly to carry street/number/suburb through to each child. Re-points matching acquisition Deals from `property_id` → `parcel_id`. Re-points `entity_contacts` and `notes` from synthetic property to new parcel. Deletes the synthetic property rows. Idempotent via `_migrations` table. **New `api/parcels.js`** endpoint with GET list/one/expanded, POST create/set_not_suitable/clear_not_suitable/add_property/remove_property, PUT rename, DELETE. **`api/deals.js`** extended: accepts `parcel_id` in queries and creates; new action `new_on_parcel`; GET responses include joined `parcel` object + `parcel_properties[]` array. **`api/contacts.js` + `api/notes.js`** enrichment queries handle deals-on-parcels. **Frontend — `lib/parcel-format.js`**: `formatParcelTitle(properties)` collapses contiguous street numbers into ranges, groups by street, handles unit numbers (`2/14`), Lot fallback, multi-street with ` & ` joiner. Unit-tested. **CRM tabs** now: Contacts · Properties · **Parcels** · Organisations. + Add button is per-tab (Contacts/Organisations show Create modal; Properties/Parcels hide the button since they're created via map ⌘-click or the pipeline flow). Parcels tab list shows Title (merged address), Property count, Active deal stage badge, Not Suitable badge. Click row opens **Parcel modal** with collapsible sections: Parcel Details (editable name; merged title display; total area; ID), Not Suitable (with 30d/90d/6m/1y/Permanent snooze), Properties-in-parcel (numbered list with Remove button per row), Deals (smart button: "Open Active Deal" or "+ New Deal (history: N closed)"), Contacts (entity_contacts with entity_type='parcel'), Notes (parcel-scoped). **Properties tab** is a V75.5 placeholder. **`window.CRM.navigateTo(subRoute, entityId)`** for router deep links to `/crm/parcels/<id>`. **Kanban**: `dealRowToInternal` handles parcel deals by aggregating `parcel_properties[]` into a pseudo-property (merged title, total area, averaged centroid, union of child lot polygons for map). `internalToDealPayload` sets `parcel_id` instead of `property_id` when `entry._isParcel`. `dbSave` skips property upsert for parcel deals. **Map pin numbering fix**: the `_selectedParcels` promotion on the first ⌘-click now correctly captures the provisional first selection even when async reverse-geocode has nulled `clickMarker` — reconstructs the pin from persisted `clickMarkerData`. **Note**: V75.4 initial release kept the synthetic-property-with-JSONB-parcels flow for new parcels from map ⌘-click; that flow was replaced with authoritative NSW lookup in V75.4d so new parcels are created as real Parcel + N Properties from day one. |
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
