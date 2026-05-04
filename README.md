# Sydney Property Map — V77.0

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
│   ├── usage/                                                                   ← NEW V76.11
│   │   ├── active.js        — Toggle is_active on a subscription. Domain: any signed-in user (Listings button uses this); TessaDEM: admin only (V76.11)
│   │   └── config.js        — Fast read of subscription config (sub_type, sub_amount, effective_start_date, is_active). Used by the dashboard for instant first paint while /api/usage loads stats in parallel (V76.11)
│   ├── usage.js             — API call usage tracking + subscription mgmt. Two backing tables: `api_subscriptions` (per-API config) and `api_usage_log` (per-call log). GET returns full stats incl. period_calls + balance_remaining; PUT updates sub fields (admin); POST logs internally. Exports `logApiCall()` and `checkApiAllowed()` for proxy short-circuiting. Auto-seeds Domain (monthly, 10000, 2026-04-27) and TessaDEM (total, 12000, 2026-05-03) on first call (V76.11)
│   ├── elevation-tile.js    — Server-side TessaDEM tile renderer. Two modes: `mode=probe` returns viewport min/max as JSON; tile mode returns a 256×256 PNG with a 19-band blue→cyan→green→yellow→orange→red→white ramp scaled to supplied min/max. Per-tile GeoTIFF fetch via TessaDEM area-mode (64×64 grid). 12-month CDN cache. Calls `checkApiAllowed('tessadem')` first — short-circuits with 503 (inactive) or 402 (quota exhausted). Logs every call to api_usage_log via `logApiCall()` (V76.10/11)
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
│   ├── backfill-parcel-rings.js      — V75.4d.4: one-time backfill of lot polygon rings on child properties (admin-only)
│   ├── migrate-to-v75-6.js  — V75.6 migration (admin-only)
│   ├── migrate-to-v75-7.js  — V76.2 migration: actions table + boards.board_type column (admin-only)
│   ├── migrate-to-v76-7.js  — V76.7 migration: properties.state column (admin-only)
│   ├── domain-price-estimates.js — V76.7: cache for derived price ranges from the Reveal Price bracket-probe workflow
│   ├── boards.js            — V75.6: Boards + columns CRUD. V76.2: accepts `board_type` on POST; guards check actions refs alongside deals
│   ├── actions.js           — V76.2: Actions CRUD with server-side Due promotion + bootstrap of "My Actions" board
│   ├── deal-order.js        — V75.6: per-user card-ordering within a board column
│   ├── db-setup.js          — DB schema setup (legacy tables + auth columns)
│   ├── domain-search.js     — Domain API proxy (keeps key server-side). V76.11: short-circuits with `checkApiAllowed('domain')` — returns 503 (inactive) or 402 (quota_exhausted) before calling Domain. Logs every call (success or failure) to api_usage_log via `logApiCall()`
│   ├── tiles.js             — NSW tile proxy (query params, not path segments)
│   ├── topo-style.js        — NSW topo style proxy (CORS fix)
│   └── health.js            — DB health check endpoint
├── lib/
│   ├── auth.js              — Shared JWT sign/verify, cookie helpers, session guards (V74)
│   ├── db.js                — Database URL resolver
│   ├── parcel-format.js     — `formatParcelTitle()` — collapses street numbers into ranges for Parcel display (V75.4)
│   └── nsw-lookup.js        — Server-side NSW Spatial Portal lookup helper (V75.4c)
├── scripts/
│   └── hash-password.mjs    — Local utility: generates bcrypt hash for fallback env var (V74)
├── finance/
│   ├── finance-module.js    — Financial feasibility calculator, UI, DB persistence
│   └── finance-styles.css   — Finance module styles
├── index.html               — Page structure and UI. V76.11: System Settings now houses the API Dashboard with two cards (TessaDEM, Domain) showing subscription type/amount/effective-start, balance remaining, period calls, last call, and an active toggle. Edit Subscription modal for admin updates of type/amount/effective-start. Two-phase dashboard load (`/api/usage/config` first for instant paint, `/api/usage` after for stats). Quota-exhausted banner ("Elevation quota exhausted — Settings" link for admin, "please contact administrator" for non-admin). `window._apiState` cache + `window.syncApiDependentUi()` keep listings button colour and elevation overlay row state in sync with API state across the page lifetime
├── styles.css               — All styling. V76.11: API Dashboard cards, active toggle (green track when on, grey when off), edit-subscription modal, listings-button api-inactive grey state, elevation overlay row "(API off)" indicator
├── crm.js                   — CRM contact management module
├── crm-styles.css           — CRM-specific styles
├── overlays-meta.js         — Overlay definitions, zone config, type metadata. V76.11: adds `tessadem-elevation` overlay (URL `/api/elevation-tile?z={z}&x={x}&y={y}`); `OVERLAY_TYPE_META` adds `'elevation'` (label "Topographic")
├── overlays-b64-sw-wastewater.js  — SW Sydney wastewater GeoTIFF (b64)
├── overlays-b64-sw-potable.js     — SW Sydney potable water GeoTIFF (b64)
├── overlays-b64-sw-ilp.js         — Leppington ILP GeoTIFF (b64)
├── gsp-wsa-sw-wastewater.js       — WSA wastewater GeoJSON (planning stages)
├── WSA_SW_Wastewater_Precincts.geojson
├── catherine_park_north_zoning_wgs84.geojson
├── domain-api.js            — Domain API client (V76.7 enhancements)
├── dd-risks.js              — DD risk assessment (queries NSW layers at lat/lng)
├── nsw-lookup-client.js     — Browser-side NSW Spatial Portal helper (V75.4c/d)
├── map.js                   — Map logic, overlays, search, listings, Domain init. V76.11: `tessadem-elevation` layer is viewport-adaptive — overrides `getTileUrl` to inject current viewport min/max from local state, debounced 400ms `moveend` probe via `mode=probe` JSON endpoint, transparent placeholder until first probe completes, `tileerror` 402 detection auto-disables layer client-side and triggers quota banner. Listings button click also POSTs to `/api/usage/active` to flip Domain `is_active` (any signed-in user); reads back the updated state and triggers `syncApiDependentUi()`
├── kanban.js                — Pipeline Kanban board (V76.7 enhancements)
├── package.json             — Dependencies. V76.11: adds `geotiff` (server-side GeoTIFF decode for elevation tiles) and `sharp` (server-side PNG render)
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
| `TESSADEM_API_KEY` | TessaDEM Elevation API key — used by `api/elevation-tile.js` for the Elevation Gradient overlay (V76.11) |
| `POSTGRES_URL` | Neon database connection string (auto-injected by Vercel) |
| `JWT_SECRET` | Session JWT signing secret — minimum 32 random chars. Generate: `openssl rand -base64 48` |
| `ADMIN_FALLBACK_EMAIL` | Break-glass admin email (e.g. `alan.diversi@edanproperty.com.au`). Always has admin access, works even if DB is unreachable |
| `ADMIN_FALLBACK_PASSWORD_HASH` | Bcrypt hash of the fallback admin password. Generate locally with `node scripts/hash-password.mjs` |

---

## Version History

| Version | Notes |
|---|---|
| V77.0 | **Bug fix — Kanban deal-delete is now deal-only.** Fixed a long-standing bug where deleting a deal card on a property that had multiple deals would wipe the property record and cascade-delete every other deal on it (because the client routed property-deal deletes to `DELETE /api/properties` and `deals.property_id` has `ON DELETE CASCADE`). New behaviour: `DELETE /api/deals?id=X` removes only the deal row plus its deal-scoped data — `property_financials` (by `deal_id`), `entity_contacts` where `entity_type='deal'`, `notes` where `entity_type='deal'`, `actions` where `deal_id=<id>`, and `deal_user_order` (cascades via FK). Properties, parcels, child properties, and any property-scoped contacts/notes are explicitly NOT touched. Property/parcel deletion remains a CRM-only operation (the CRM already client-side-disables the delete button when deals reference the entity, so the existing safe workflow is preserved). Confirm modal wording updated: "Are you sure you want to delete this card? The property record and any associated contacts, notes or other property-level data will not be affected." Address still shown as the modal subject. **Behaviour change to flag**: the V75.4d auto-orphan-cleanup of parcels (server would auto-delete a parcel + child properties when the last deal on it was removed) is GONE. A parcel that ends up with zero deals now stays — it's cleaned up from the CRM where contact/note implications are visible. **Files touched**: `api/deals.js` (DELETE handler rewritten — deal-only with explicit cascade list, fail-soft on missing tables), `kanban.js` (`dbDelete` simplified to always route to `/api/deals`, `removeFromPipeline` no longer captures `_isParcel`/propertyId for routing, `openDeleteCardConfirm` reworded). **No DB schema change. No migration. Backward-compatible.** Older clients calling `DELETE /api/deals?id=X` get the safer new behaviour transparently. Response shape adds `financials_deleted`, `contact_links_deleted`, `notes_deleted`, `actions_deleted` counters; preserves `property_deleted`/`parcel_deleted`/`properties_deleted` keys (always false/0 in V77) for any consumers reading them. **Deploy sequence**: push files → Vercel auto-deploys. **Verify**: (a) on a property with two deals (e.g. Shortlisted + Acquired), deleting one card only removes that card, the property and the other card stay; (b) deleting a parcel-deal removes only the deal, not the parcel or child properties; (c) the deal modal's Delete button shows the new wording. **Rollback**: revert the two files. |
| V76.11 | **API Dashboard, subscription model, elevation gradient overlay.** Three connected feature areas bundled as one release. **(1) TessaDEM Elevation Gradient overlay** — new "Elevation Gradient" overlay in the Environmental group (id `tessadem-elevation`). Server-side `api/elevation-tile.js` fetches GeoTIFFs from TessaDEM (area mode, 64×64 grid per tile), decodes with `geotiff`, renders coloured PNG with `sharp`. 19 discrete colour bands: blue → cyan → green → yellow → orange → red → white. Range scales to current viewport min/max via a separate `mode=probe` endpoint that returns `{min, max}` JSON for the viewport bbox. Client-side: `map.js` overrides `getTileUrl` to inject current min/max from local state into each tile URL; debounced 400ms `moveend` triggers a fresh probe; tiles return a transparent placeholder until first probe completes (no error spam during initial load); aborts in-flight probes when a new viewport supersedes them. CDN-cached for 12 months on success — Sydney basin browsing builds up a useful tile cache after first visit. **(2) Subscription + usage tracking model**. New `api_subscriptions` table (one row per API: `api_name PK, sub_type 'monthly'|'total', sub_amount INT, effective_start_date DATE, is_active BOOL, updated_at, updated_by`). Auto-seeded on first call: Domain (monthly, 10000, 2026-04-27, active), TessaDEM (total, 12000, 2026-05-03, active). New `api_usage_log` table (one row per upstream call: api_name, called_at, status_code, balance_remaining, metadata JSONB). New endpoints: `GET /api/usage/config` (fast — single SELECT, no period math), `GET /api/usage` (full stats incl. period_calls + balance_remaining via period math), `PUT /api/usage` (admin updates sub_type/sub_amount/effective_start), `POST /api/usage/active` (Domain: any signed-in user, TessaDEM: admin only), internal `POST /api/usage` (call log, used by proxies). Period math: monthly subs roll on the same day-of-month as effective_start_date (e.g. 27 Apr → 27 May → 27 Jun). Total subs run from effective_start_date to forever. **`checkApiAllowed()`** helper exported from `api/usage.js`: looked up by `api/elevation-tile.js` and `api/domain-search.js` before every upstream call — returns 503 if `is_active=false`, 402 if `balance_remaining ≤ 0`, never letting the proxy hit the upstream when blocked. **(3) System Settings → API Dashboard** (admin-only menu item already existed as empty scaffold from V75.2). Two cards (TessaDEM, Domain) each showing: green/grey active toggle in the header, sub-type, sub-amount, effective_start_date, balance_remaining, period_calls (with period label e.g. "(27 Apr → 27 May)" for monthly), last_call_at, edit-subscription button, and (TessaDEM only) "Top up at TessaDEM" external link. **Two-phase dashboard load**: opens with `/api/usage/config` for instant paint of toggle + sub fields, then fills balance/period/last-call fields when the slower `/api/usage` returns — first-paint perceived latency dropped from ~1s to ~150ms. Edit modal lets admin change type, amount, and effective start date in one go (top-up flow). **Listings button cross-link**: clicking the existing Listings button in the listings sidebar header now also POSTs to `/api/usage/active` to toggle Domain `is_active` — green dot when active, grey when inactive. Any signed-in user can use this (deliberate exception to admin-only rule on the dashboard toggle). **Elevation overlay greying**: when TessaDEM `is_active=false`, the Elevation Gradient overlay row in the Overlays panel greys out, the checkbox disables, and "(API off)" appears next to the label. **Quota-exhausted banner**: when `api/elevation-tile` returns 402, the elevation layer auto-disables client-side and a top-of-map banner appears. For admins: "Elevation quota exhausted — Settings" with Settings as a clickable link to the dashboard. For non-admins: "Elevation quota exhausted — please contact administrator" (no link). **Architecture detail — Vercel filesystem routing**: `/api/usage/active` and `/api/usage/config` had to be split into `api/usage/active.js` and `api/usage/config.js` because Vercel's serverless routing maps URL paths to files; a path-detecting `if (url.includes('/active'))` branch in a single `api/usage.js` returns 404 because the file doesn't exist at that path. **New deps**: `geotiff` (^2.1.3), `sharp` (^0.33.5). **New env var**: `TESSADEM_API_KEY`. **No DB migration needed** — both new tables (`api_subscriptions`, `api_usage_log`) are auto-created on first endpoint call (idempotent CREATE TABLE IF NOT EXISTS). Default subscription rows seeded by `INSERT … ON CONFLICT DO NOTHING`. **Deploy sequence**: push files → set `TESSADEM_API_KEY` in Vercel → redeploy (so the new deps are installed) → verify (a) Elevation Gradient toggleable in Overlays panel and renders a banded coloured ramp, (b) Settings → API Dashboard shows both cards with subscription details, (c) editing a subscription persists across reload, (d) flipping Domain off via dashboard greys the Listings button and clicking the Listings button flips it back on, (e) flipping TessaDEM off greys the elevation overlay row. Rollback: `DROP TABLE api_usage_log; DROP TABLE api_subscriptions;` — both additive, no other tables touched. The two new overlay/proxy files (`api/elevation-tile.js`, `api/usage*.js`) and the dashboard chrome can be removed without affecting any V76.7 or earlier behaviour. |
| V76.7 | **State field, Reveal Price, Listed Since filter, suburb-duplication fix, cross-module change broadcast.** *(see prior notes — unchanged)* |
| V76.2 | **Actions — assignable tasks with their own Kanban wall.** *(see prior notes — unchanged)* |
| V76.1 | **Promotion to production of the V75.5 + V75.6 feature stack.** *(see prior notes — unchanged)* |
| V75.6.x and earlier | *(See prior README revisions for V75.x and V74.x history.)* |

