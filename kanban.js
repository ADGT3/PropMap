/**
 * kanban.js
 * Property pipeline Kanban board for the Sydney Property Map.
 *
 * Stages: Shortlisted → Under DD → Offer → Acquired | Not Suitable | Lost
 * State persists to localStorage under the key 'propertyPipeline'.
 *
 * A property can be added to the board from:
 *   - The listings sidebar (via the ⊕ button on each card)
 *   - The map popup (via "Add to pipeline" button)
 *
 * Properties on the board can be:
 *   - Dragged between columns
 *   - Given a note (editable inline)
 *   - Removed from the board
 */

// ─── Stage / Board state (V75.6) ──────────────────────────────────────────────
//
// V75.6 introduces Boards (replaces the hard-coded workflow concept). STAGES
// below is the system-acquisition fallback — real stages come from the
// currently-selected board's columns[]. See resolveCurrentStages().

// Fallback stage set — matches system Acquisition board's columns
const STAGES = [
  { id: 'shortlisted',   label: 'Shortlisted',   color: '#f39c12', show_on_map: true,  is_terminal: false },
  { id: 'under-dd',      label: 'Under DD',      color: '#8e44ad', show_on_map: true,  is_terminal: false },
  { id: 'offer',         label: 'Offer',         color: '#2980b9', show_on_map: true,  is_terminal: false },
  { id: 'acquired',      label: 'Acquired',      color: '#27ae60', show_on_map: true,  is_terminal: false },
  { id: 'not-suitable',  label: 'Not Suitable',  color: '#95a5a6', show_on_map: false, is_terminal: true  },
  { id: 'lost',          label: 'Lost',          color: '#c0392b', show_on_map: false, is_terminal: true  },
];

// Boards loaded from /api/boards. Populated on init (async). If the
// API is unreachable or returns empty, Kanban falls back to STAGES.
let boards         = [];           // [{ id, name, is_system, columns: [...] }]
let currentBoardId = 'sys_acquisition'; // default to system Acquisition
let userDealOrder  = {};           // { dealId: column_order } per-user, per current board
// V78g — Per-board default score (interest_level) used when a new card is
// added via addToPipeline. Loaded from system_settings (category=boards)
// during init. Falls back to 40 if a board has no row (matches the seed).
let boardDefaultScores = {};       // { board_id: number 0-100 }
const BOARD_DEFAULT_SCORE_FALLBACK = 40;

// Returns the STAGES-like array for the current board. Falls back to the
// static STAGES constant if no boards are loaded yet. Each returned entry
// has { id: column.id, label, color, show_on_map, is_terminal, stage_slug }
// where `stage_slug` is used for backward-compat with legacy pipeline[]
// entries that still have `.stage` set to a string like 'shortlisted'.
function resolveCurrentStages() {
  const b = boards.find(x => x.id === currentBoardId);
  if (!b || !Array.isArray(b.columns) || !b.columns.length) return STAGES;
  return b.columns.map(c => ({
    id:           c.id,                 // column id (e.g. "sys_acquisition_shortlisted")
    stage_slug:   c.stage_slug || c.id, // slug for legacy matching
    label:        c.name,
    color:        c.color || '#95a5a6',
    show_on_map:  !!c.show_on_map,
    is_terminal:  !!c.is_terminal,
  }));
}

// Map a legacy pipeline entry's .stage slug to the current board's column id.
// Needed because in-memory pipeline entries still carry the historical
// `stage` string (e.g. 'shortlisted') while the board drives column ids.
function stageToColumnId(stageSlug, boardId) {
  const b = boards.find(x => x.id === (boardId || currentBoardId));
  if (!b) return stageSlug;
  const col = b.columns?.find(c => c.stage_slug === stageSlug || c.id === stageSlug);
  return col ? col.id : stageSlug;
}
function columnIdToStage(columnId, boardId) {
  const b = boards.find(x => x.id === (boardId || currentBoardId));
  if (!b) return columnId;
  const col = b.columns?.find(c => c.id === columnId);
  return col ? (col.stage_slug || col.id) : columnId;
}

// ─── Pipeline Search (V76.7+) ────────────────────────────────────────────────
//
// Boolean expression search for the active pipeline board. Supports:
//   - Field=value pairs:   contact = anthony     suburb = "rossmore"
//   - Comparison operators: price > 1000000      beds >= 4
//   - Boolean composition:  AND OR NOT and parentheses
//   - Free-text fallback:   anthony  → matches across address/suburb/state/
//                                       contacts/agent/agency/headline/notes
//
// Field name → JSON path on the in-memory deal entry. Lowercase keys.
// Values are compared case-insensitively (substring for strings, equality
// for numbers). Quoted values support whitespace.
const SEARCH_FIELD_MAP = {
  // Address / location
  address:   { path: 'property.address',     type: 'string' },
  suburb:    { path: 'property.suburb',      type: 'string' },
  state:     { path: 'property.state',       type: 'string' },
  postcode:  { path: 'property.postcode',    type: 'string' },
  lotdp:     { path: 'property.lot_dps',     type: 'string' },
  // Stage / status
  stage:     { path: 'stage',                type: 'string' },
  status:    { path: 'status',               type: 'string' },
  // Property attrs
  beds:      { path: 'property.beds',        type: 'number' },
  baths:     { path: 'property.baths',       type: 'number' },
  cars:      { path: 'property.cars',        type: 'number' },
  land:      { path: 'property.landAreaSqm', type: 'number' },
  type:      { path: 'property.type',        type: 'string' },
  // Listing fields
  headline:  { path: 'property.headline',    type: 'string' },
  agent:     { path: 'property.agent.name',  type: 'string' },
  agency:    { path: 'property.agent.agency',type: 'string' },
  // Price (numeric: search on .from for >, <; substring on .display for =)
  price:     { path: '__price',              type: 'price'  },
  // Contacts (lazy-loaded — see _searchContactsCache)
  contact:   { path: '__contacts',           type: 'contact' },
};

// Free-text fallback searches across these string fields:
const SEARCH_FREETEXT_FIELDS = ['address', 'suburb', 'state', 'agent', 'agency', 'headline', 'lotdp'];

// In-memory cache: dealId → array of contact name strings (lazy-fetched on first
// search; invalidated when the pipeline refreshes from DB).
let _searchContactsCache = null;

// Currently-applied search query (UI keeps it in sync via input event).
let _searchQuery = '';

// V80.4 — Per-user kanban sort preference. localStorage-backed.
// Values: 'interest' (default) | 'created' | 'actions_due' | 'dd_risk'.
const KANBAN_SORT_KEY = 'propmap.kanban.sortMode';
const VALID_KANBAN_SORT_MODES = ['interest', 'created', 'actions_due', 'dd_risk'];
function getKanbanSortMode() {
  try {
    const v = localStorage.getItem(KANBAN_SORT_KEY);
    if (v && VALID_KANBAN_SORT_MODES.includes(v)) return v;
  } catch (_) {}
  return 'interest';
}
function setKanbanSortMode(mode) {
  if (!VALID_KANBAN_SORT_MODES.includes(mode)) return;
  try { localStorage.setItem(KANBAN_SORT_KEY, mode); } catch (_) {}
}
// Comparator factory — returns (entryA, entryB) → number.
// `entry` shape from the stage loop: [dealId, pipelineItem]. Each item has:
//   item.data.interest_level (0-100 or null)
//   item.addedAt              (ms epoch — used as creation time + tiebreaker)
//   item._earliestActionDue   (ISO date string for soonest due_date among
//                              the deal's overdue/due-today actions, or null)
//   item.dd                   ({ <ddItem>: { status: 'high'|'possible'|'low' } })
function buildKanbanComparator(mode, ddItems) {
  switch (mode) {
    case 'created':
      // Most recent first
      return (a, b) => (b[1].addedAt || 0) - (a[1].addedAt || 0);
    case 'actions_due':
      // Most-overdue first; null (no due action) last.
      return (a, b) => {
        const da = a[1]._earliestActionDue;
        const db = b[1]._earliestActionDue;
        if (!da && !db) return (b[1].addedAt || 0) - (a[1].addedAt || 0);
        if (!da) return 1;
        if (!db) return -1;
        return da < db ? -1 : da > db ? 1 : 0;
      };
    case 'dd_risk': {
      // Per Q4 — low risk first (and unset/empty are also "low"), high last.
      // Score: high=3, possible=2, low=1, none=0.
      const score = (item) => {
        const dd = item.dd || {};
        let max = 0;
        for (const k of ddItems) {
          const s = dd[k.toLowerCase()]?.status;
          if (s === 'high')     max = Math.max(max, 3);
          else if (s === 'possible') max = Math.max(max, 2);
          else if (s === 'low')      max = Math.max(max, 1);
        }
        return max;
      };
      return (a, b) => {
        const sa = score(a[1]);
        const sb = score(b[1]);
        if (sa !== sb) return sa - sb;
        return (b[1].addedAt || 0) - (a[1].addedAt || 0);
      };
    }
    case 'interest':
    default:
      // High first; UNSET sorts to the TOP (per Q5=b — demand attention)
      return (a, b) => {
        const ia = a[1].data?.interest_level;
        const ib = b[1].data?.interest_level;
        const aSet = (ia != null);
        const bSet = (ib != null);
        if (!aSet && !bSet) return (b[1].addedAt || 0) - (a[1].addedAt || 0);
        if (!aSet) return -1; // a is unset → a goes top
        if (!bSet) return  1;
        return ib - ia; // higher first
      };
  }
}

async function _ensureContactsCache() {
  if (_searchContactsCache) return _searchContactsCache;
  _searchContactsCache = {};
  const dealIds = Object.keys(pipeline);
  // Fetch contacts for every deal in parallel — N round-trips concurrent
  await Promise.all(dealIds.map(async id => {
    try {
      const res = await fetch(`/api/contacts?pipeline_id=${encodeURIComponent(id)}`);
      if (res.ok) {
        const list = await res.json();
        _searchContactsCache[id] = (Array.isArray(list) ? list : [])
          .map(c => `${c.first_name || ''} ${c.last_name || ''}`.trim().toLowerCase())
          .filter(Boolean);
      } else {
        _searchContactsCache[id] = [];
      }
    } catch (_) {
      _searchContactsCache[id] = [];
    }
  }));
  return _searchContactsCache;
}

// Tokenise the search input. Tokens: WORD, QUOTED, OP (= != > < >= <=),
// LPAREN, RPAREN, AND, OR, NOT.
function _tokenise(input) {
  const tokens = [];
  const s = input.trim();
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '(') { tokens.push({ type: 'LPAREN' }); i++; continue; }
    if (c === ')') { tokens.push({ type: 'RPAREN' }); i++; continue; }
    if (c === '"' || c === "'") {
      // Quoted string
      const quote = c;
      let j = i + 1;
      while (j < s.length && s[j] !== quote) j++;
      tokens.push({ type: 'QUOTED', value: s.slice(i + 1, j) });
      i = j + 1;
      continue;
    }
    // Multi-char operators first
    if (s.slice(i, i + 2) === '!=' || s.slice(i, i + 2) === '>=' || s.slice(i, i + 2) === '<=') {
      tokens.push({ type: 'OP', value: s.slice(i, i + 2) });
      i += 2;
      continue;
    }
    if (c === '=' || c === '>' || c === '<') {
      tokens.push({ type: 'OP', value: c });
      i++;
      continue;
    }
    // Word — runs until whitespace, paren, operator
    let j = i;
    while (j < s.length && !/[\s()=><!"']/.test(s[j])) j++;
    const word = s.slice(i, j);
    const upper = word.toUpperCase();
    if (upper === 'AND' || upper === 'OR' || upper === 'NOT') {
      tokens.push({ type: upper });
    } else {
      tokens.push({ type: 'WORD', value: word });
    }
    i = j;
  }
  return tokens;
}

// Parser: recursive descent.
//   expr   := term (OR term)*
//   term   := factor (AND? factor)*    -- implicit AND: "a b" == "a AND b"
//   factor := NOT factor | LPAREN expr RPAREN | atom
//   atom   := WORD OP value  |  WORD  |  QUOTED  -- bare word is free-text
function _parse(tokens) {
  let pos = 0;
  const peek = () => tokens[pos];
  const eat  = (type) => { const t = tokens[pos]; if (t && t.type === type) { pos++; return t; } return null; };

  function parseExpr() {
    let left = parseTerm();
    while (peek()?.type === 'OR') { pos++; const right = parseTerm(); left = { type: 'or', children: [left, right] }; }
    return left;
  }
  function parseTerm() {
    let left = parseFactor();
    while (peek() && peek().type !== 'OR' && peek().type !== 'RPAREN') {
      // Skip explicit AND if present
      if (peek().type === 'AND') pos++;
      const right = parseFactor();
      if (!right) break;
      left = { type: 'and', children: [left, right] };
    }
    return left;
  }
  function parseFactor() {
    if (peek()?.type === 'NOT') { pos++; return { type: 'not', child: parseFactor() }; }
    if (peek()?.type === 'LPAREN') {
      pos++;
      const e = parseExpr();
      eat('RPAREN');
      return e;
    }
    return parseAtom();
  }
  function parseAtom() {
    const t = peek();
    if (!t) return null;
    if (t.type === 'QUOTED') { pos++; return { type: 'free', text: t.value.toLowerCase() }; }
    if (t.type !== 'WORD') return null;
    const word = t.value;
    pos++;
    // Field=value form?
    const fieldKey = word.toLowerCase();
    if (peek()?.type === 'OP' && SEARCH_FIELD_MAP[fieldKey]) {
      const op = peek().value; pos++;
      const valTok = peek();
      let value = '';
      if (valTok?.type === 'QUOTED') { value = valTok.value; pos++; }
      else if (valTok?.type === 'WORD') { value = valTok.value; pos++; }
      return { type: 'term', field: fieldKey, op, value };
    }
    // Bare word → free-text search
    return { type: 'free', text: word.toLowerCase() };
  }

  return parseExpr();
}

// Read a value at a JSON path from a deal entry. Handles the synthetic
// fields __price (price.from) and __contacts (lookup in cache).
function _readField(entry, path, dealId) {
  if (path === '__price') {
    const p = entry?.property?.price;
    if (!p) return null;
    if (typeof p === 'object') return p.from || p.to || null;
    return null;
  }
  if (path === '__contacts') {
    return (_searchContactsCache && _searchContactsCache[dealId]) || [];
  }
  return path.split('.').reduce((o, k) => (o == null ? o : o[k]), entry);
}

function _matchTerm(entry, dealId, term) {
  const fieldDef = SEARCH_FIELD_MAP[term.field];
  if (!fieldDef) return false;
  const raw = _readField(entry, fieldDef.path, dealId);
  const op = term.op;
  const val = String(term.value).toLowerCase();

  if (fieldDef.type === 'contact') {
    // term.value is a name fragment; cache holds lowercase full names
    if (!Array.isArray(raw)) return false;
    const match = raw.some(n => n.includes(val));
    return op === '!=' ? !match : match;
  }

  if (fieldDef.type === 'price') {
    const num = Number(raw);
    const tnum = Number(term.value);
    if (op === '=' || op === '!=') {
      // Substring match against display text if present, else numeric equality
      const display = entry?.property?.price?.display || '';
      const numEq = !isNaN(num) && !isNaN(tnum) && num === tnum;
      const strMatch = display.toLowerCase().includes(val);
      const match = numEq || strMatch;
      return op === '!=' ? !match : match;
    }
    if (isNaN(num) || isNaN(tnum)) return false;
    if (op === '>')  return num >  tnum;
    if (op === '<')  return num <  tnum;
    if (op === '>=') return num >= tnum;
    if (op === '<=') return num <= tnum;
    return false;
  }

  if (fieldDef.type === 'number') {
    const num = Number(raw);
    const tnum = Number(term.value);
    if (isNaN(num) || isNaN(tnum)) return false;
    if (op === '=')  return num === tnum;
    if (op === '!=') return num !== tnum;
    if (op === '>')  return num >  tnum;
    if (op === '<')  return num <  tnum;
    if (op === '>=') return num >= tnum;
    if (op === '<=') return num <= tnum;
    return false;
  }

  // string
  const str = String(raw ?? '').toLowerCase();
  if (op === '=')  return str.includes(val);
  if (op === '!=') return !str.includes(val);
  if (op === '>' || op === '<' || op === '>=' || op === '<=') {
    return op === '>'  ? str >  val
         : op === '<'  ? str <  val
         : op === '>=' ? str >= val
         :                str <= val;
  }
  return false;
}

function _matchFree(entry, dealId, text) {
  // Search across all freetext fields plus contacts cache
  for (const fk of SEARCH_FREETEXT_FIELDS) {
    const fdef = SEARCH_FIELD_MAP[fk];
    if (!fdef) continue;
    const v = _readField(entry, fdef.path, dealId);
    if (typeof v === 'string' && v.toLowerCase().includes(text)) return true;
  }
  const contacts = (_searchContactsCache && _searchContactsCache[dealId]) || [];
  if (contacts.some(n => n.includes(text))) return true;
  return false;
}

function _evalAst(ast, entry, dealId) {
  if (!ast) return true;
  if (ast.type === 'and')  return ast.children.every(c => _evalAst(c, entry, dealId));
  if (ast.type === 'or')   return ast.children.some (c => _evalAst(c, entry, dealId));
  if (ast.type === 'not')  return !_evalAst(ast.child, entry, dealId);
  if (ast.type === 'term') return _matchTerm(entry, dealId, ast);
  if (ast.type === 'free') return _matchFree(entry, dealId, ast.text);
  return true;
}

// Public — check whether a given deal entry matches the current search query.
// Empty query matches everything. Parse failures degrade to free-text on the
// raw input so users get something useful even when their syntax is off.
function _searchMatches(dealId, entry) {
  const q = (_searchQuery || '').trim();
  if (!q) return true;
  let ast;
  try { ast = _parse(_tokenise(q)); }
  catch (_) { return _matchFree(entry, dealId, q.toLowerCase()); }
  return _evalAst(ast, entry, dealId);
}

// ─── State ────────────────────────────────────────────────────────────────────

// V76.5: cache key bumped to invalidate localStorage on first load post-migration.
// Old cached entries are keyed by listing.id (which used to also be the deal id);
// after migration, deal ids are `deal_*` and the old cached keys would never
// resolve. Forcing a fresh load avoids that mismatch. The old key
// 'propertyPipeline' is left orphaned in localStorage — harmless, ~few KB.
const STORAGE_KEY = 'propertyPipeline_v76_5';

// V75.0b — frontend talks to /api/deals and /api/properties directly.
// No /api/pipeline shim used.
const DEALS_API      = '/api/deals';
const PROPERTIES_API = '/api/properties';

// In-memory pipeline dict — keyed by deal.id; shape matches what kanban.js
// has always used so the rest of the file keeps working with minimal edits:
//   { [id]: { stage, note, addedAt, property, terms, offers, notes, dd } }
let pipeline = {};
let dbAvailable = false;

// V76.5: lookup helper — returns the [dealId, entry] tuple for the pipeline
// entry whose property has the given domain_listing_id, or null if none.
// This is the canonical "is this Domain listing already in the pipeline?"
// check, replacing the old `pipeline[listing.id]` lookup that relied on
// deal.id == listing.id collision.
function findPipelineByDomainId(domainId) {
  if (domainId == null) return null;
  const needle = String(domainId);
  const entries = Object.entries(pipeline);
  for (const [dealId, entry] of entries) {
    if (entry?.property?.domain_id != null && String(entry.property.domain_id) === needle) {
      return [dealId, entry];
    }
  }
  return null;
}
window.findPipelineByDomainId = findPipelineByDomainId;

// V78 — expose at module load so mobile-shell can open a deal modal from the
// Upcoming Inspections panel even before the kanban view has been rendered.
// All three are function declarations, so hoisted and safe to reference here.
window.openCardModal              = openCardModal;
window.reloadPipelineEntryFromDb  = reloadPipelineEntryFromDb;

// ── localStorage helpers (cache / offline fallback) ──────────────────────────
function cacheLoad() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch (_) { return {}; }
}
function cacheSave(p) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(p)); } catch (_) {}
}

// ── Shape translation helpers ──────────────────────────────────────────────
// New backend: deal row has { id, property_id, stage, status, data } joined
// with a property object that has { address, suburb, lat, lng, lot_dps,
// area_sqm, parcels, property_count, dd, domain_listing_id, listing_url,
// agent, not_suitable_until, not_suitable_reason }.
//
// Internal kanban shape: { stage, note, notes, addedAt, terms, offers, dd,
// property: { address, suburb, lat, lng, _parcels, _lotDPs, _areaSqm,
// _propertyCount, _agent, _listingUrl, domain_id, price, type, beds, baths,
// cars, waterStatus, zone } }

function dealRowToInternal(row) {
  const dealData = row.data || {};
  const isParcel = !!row.parcel_id;

  // Build the "property" shape that the rest of Kanban expects. For parcel
  // deals we aggregate across all constituent properties; for property deals
  // we use the single joined property directly.
  let propertyShape;
  if (isParcel) {
    const pa     = row.parcel || {};
    const kids   = Array.isArray(row.parcel_properties) ? row.parcel_properties : [];
    // Merged title — V78h.7: always compute from kids when we have them and
    // the formatter is available. The stale pa.name snapshot was the source
    // of "Catherine Field, Catherine Field" duplication and never reflected
    // updates to the lot-contiguity rules.
    const title = (kids.length && typeof window !== 'undefined' && window.formatParcelTitle)
      ? window.formatParcelTitle(kids.map(k => ({ address: k.address, suburb: k.suburb, lot_dps: k.lot_dps })))
      : (pa.name || kids.map(k => k.address).join(' & '));
    // Aggregate area + centroid
    const totalArea = kids.reduce((s, k) => s + (k.area_sqm || 0), 0);
    const avgLat = kids.length ? kids.reduce((s, k) => s + (k.lat ?? 0), 0) / kids.length : null;
    const avgLng = kids.length ? kids.reduce((s, k) => s + (k.lng ?? 0), 0) / kids.length : null;
    // Concat all lot_dps for display
    const allLotDPs = kids.map(k => k.lot_dps).filter(Boolean).join(', ');
    // Aggregate parcels JSONB from each kid for the map polygon renderer
    const allPolygons = kids.flatMap(k => Array.isArray(k.parcels) ? k.parcels : []);
    propertyShape = {
      id:             row.parcel_id,   // use parcel id in the .id slot for compatibility
      address:        title,
      suburb:         (kids[0] && kids[0].suburb) || '',
      state:          (kids[0] && kids[0].state) || 'NSW',
      lat:            avgLat,
      lng:            avgLng,
      _lotDPs:        allLotDPs,
      _areaSqm:       totalArea || null,
      _parcels:       allPolygons,
      _propertyCount: kids.length,
      _agent:         null,
      _listingUrl:    null,
      domain_id:      null,
      not_suitable_until:  pa.not_suitable_until  || null,
      not_suitable_reason: pa.not_suitable_reason || null,
      price:          dealData.price       || 'Unknown',
      type:           dealData.type        || 'land',
      beds:           dealData.beds        || 0,
      baths:          dealData.baths       || 0,
      cars:           dealData.cars        || 0,
      waterStatus:    dealData.waterStatus || 'outside',
      zone:           dealData.zone        || 'all',
      _isParcel:      true,
      _parcelId:      row.parcel_id,
      _parcelName:    pa.name || '',
      _parcelProperties: kids,
    };
  } else {
    const p = row.property || {};
    propertyShape = {
      id:             row.property_id,
      address:        p.address || '',
      suburb:         p.suburb  || '',
      state:          p.state   || 'NSW',
      lat:            p.lat     ?? null,
      lng:            p.lng     ?? null,
      _lotDPs:        p.lot_dps || '',
      _areaSqm:       p.area_sqm ?? null,
      _parcels:       Array.isArray(p.parcels) ? p.parcels : [],
      _propertyCount: p.property_count ?? 1,
      _agent:         p.agent ?? null,
      _listingUrl:    p.listing_url ?? null,
      domain_id:      p.domain_listing_id ?? null,
      not_suitable_until:  p.not_suitable_until  || null,
      not_suitable_reason: p.not_suitable_reason || null,
      price:          dealData.price       || 'Unknown',
      type:           dealData.type        || 'land',
      beds:           dealData.beds        || 0,
      baths:          dealData.baths       || 0,
      cars:           dealData.cars        || 0,
      waterStatus:    dealData.waterStatus || 'outside',
      zone:           dealData.zone        || 'all',
      _isParcel:      false,
    };
  }

  return {
    stage:   row.stage || 'shortlisted',
    note:    dealData.note    || '',
    // V75.3: notes live in `notes` table, fetched lazily by fetchNotesForDeal
    notes:   [],
    addedAt: dealData.addedAt || (row.opened_at ? Date.parse(row.opened_at) : Date.now()),
    terms:   dealData.terms   || null,
    offers:  dealData.offers  || [],
    // V75.3: DD per-deal
    dd:      (typeof dealData.dd === 'object' && dealData.dd !== null) ? dealData.dd : {},
    // V77.1: full data blob exposed so card renderers can read fields like
    // data.interest_level (Enquiry boards) and data.validation (Lease Enquiry).
    data:    dealData,
    property: propertyShape,
    // V75.4: expose the parcel id/name at the top level for kanban-side code
    _isParcel:     isParcel,
    _parcelId:     row.parcel_id   || null,
    _dealId:       row.id,
    // V75.6: Board + column identity — new source of truth. Legacy `.stage`
    // preserved above for backward compat during the transition.
    _boardId:      row.board_id    || null,
    _columnId:     row.column_id   || null,
    // V77.1b: parent_deal_id (Enquiry → Listing relationship)
    parent_deal_id: row.parent_deal_id || null,
    // V75.7: due-action flag, set server-side in api/deals.js fetchAndExpand
    // V76.4.2: due_action_count is the actual number; _hasDueAction kept for compat.
    // V76.4.3: _hasOverdueAction drives the red left-border attention bar
    // (narrower rule: due_date today-or-earlier, status not done/void).
    _hasDueAction:      !!row.has_due_action,
    _dueActionCount:    Number(row.due_action_count || 0),
    _hasOverdueAction:  !!row.has_overdue_action,
    // V80.4: earliest open action's due_date (ISO string), or null.
    // Powers the "Actions due" kanban sort mode.
    _earliestActionDue: row.earliest_action_due_date || null,
  };
}

function internalToPropertyPayload(id, entry) {
  const p = entry.property || {};
  const firstParcel = Array.isArray(p._parcels) && p._parcels[0] ? p._parcels[0] : null;
  // V76.5: property's own id, sourced from entry.property.id (the actual
  // `properties.id` column value). The legacy `id` parameter is the deal id
  // — a leftover from the V75 era when deal.id == property.id. We keep the
  // parameter for call-site compatibility but don't use it for the payload id.
  return {
    id:                p.id || id,
    address:           p.address || '',
    suburb:            p.suburb  || '',
    state:             p.state   || 'NSW',
    lat:               p.lat     ?? firstParcel?.lat ?? null,
    lng:               p.lng     ?? firstParcel?.lng ?? null,
    lot_dps:           (p._lotDPs || '').toString().toUpperCase(),
    area_sqm:          p._areaSqm ?? null,
    parcels:           Array.isArray(p._parcels) ? p._parcels : [],
    property_count:    p._propertyCount ?? 1,
    // V75.3: dd removed — DD now lives per-deal in deals.data.dd
    domain_listing_id: p.domain_id || null,
    listing_url:       p._listingUrl || null,
    agent:             p._agent || null,
  };
}

function internalToDealPayload(id, entry) {
  const p = entry.property || {};
  const stage  = entry.stage || 'shortlisted';
  const status = (stage === 'lost') ? 'lost' : (stage === 'acquired' ? 'won' : 'active');
  // V75.6: also persist board_id / column_id so moves across boards/columns stick.
  // Entry.columnId is authoritative going forward; fall back to derivation for legacy
  // in-memory entries still keyed only by .stage.
  const boardId  = entry._boardId  || currentBoardId;
  const columnId = entry._columnId || stageToColumnId(stage, boardId);
  // V77.1: spread entry.data first so unknown/new fields (validation,
  // interest_level, etc.) survive a save round-trip; explicit fields override.
  const payload = {
    id,
    workflow:    'acquisition',
    stage,
    status,
    board_id:    boardId,
    column_id:   columnId,
    data: {
      ...(entry.data || {}),
      note:    entry.note    || '',
      addedAt: entry.addedAt || Date.now(),
      terms:   entry.terms   || null,
      offers:  entry.offers  || [],
      dd:      entry.dd      || {},
      price:       p.price,
      type:        p.type,
      beds:        p.beds,
      baths:       p.baths,
      cars:        p.cars,
      waterStatus: p.waterStatus,
      zone:        p.zone,
    },
  };
  // V75.4: parcel deals vs property deals — exactly one of these must be set.
  // V76.5: property_id sourced from entry.property.id (no longer assumed to
  // equal the deal id). Falls back to the deal id only for legacy in-memory
  // entries that haven't been hydrated from a server fetch yet.
  if (entry._isParcel && entry._parcelId) {
    payload.parcel_id = entry._parcelId;
  } else {
    payload.property_id = entry.property?.id || id;
  }
  return payload;
}

// ── DB helpers ────────────────────────────────────────────────────────────────
// V75.6: load the list of boards visible to this user. Call once during
// bootstrap (before dbLoad) so resolveCurrentStages has data to work with.
async function loadBoards() {
  try {
    const res = await fetch('/api/boards');
    if (!res.ok) throw new Error(res.status);
    boards = await res.json();
    // If the current selection isn't valid (e.g. first load), pick the first
    // system board (Acquisition by convention, sort_order 0).
    if (!boards.find(b => b.id === currentBoardId)) {
      const firstSys = boards.find(b => b.is_system) || boards[0];
      if (firstSys) currentBoardId = firstSys.id;
    }
  } catch (err) {
    console.warn('[boards] load failed, using fallback STAGES:', err.message);
    boards = [];
  }
}

// V78g — Load per-board default scores from system_settings (category=boards).
// Keys are 'board_default_score_<board_id>'; values parsed as int 0-100.
// Called during init alongside loadBoards(). Failure is non-fatal — falls
// back to BOARD_DEFAULT_SCORE_FALLBACK per board.
async function loadBoardDefaultScores() {
  try {
    const res = await fetch('/api/system-settings?category=boards');
    if (!res.ok) throw new Error(res.status);
    const rows = await res.json();
    const map = {};
    for (const row of rows) {
      const m = String(row.key || '').match(/^board_default_score_(.+)$/);
      if (!m) continue;
      const n = parseInt(row.value, 10);
      if (Number.isFinite(n)) map[m[1]] = n;
    }
    boardDefaultScores = map;
  } catch (err) {
    console.warn('[kanban] loadBoardDefaultScores failed, falling back to 40:', err.message);
    boardDefaultScores = {};
  }
}

// V75.6: load per-user card order for the current board
async function loadUserDealOrder() {
  try {
    const res = await fetch(`/api/deal-order?board_id=${encodeURIComponent(currentBoardId)}`);
    if (!res.ok) { userDealOrder = {}; return; }
    userDealOrder = await res.json();
  } catch (_) {
    userDealOrder = {};
  }
}

async function dbLoad() {
  try {
    // V75.6: filter by currently-selected board_id so each board shows only its own deals
    const res = await fetch(`${DEALS_API}?board_id=${encodeURIComponent(currentBoardId)}`);
    if (!res.ok) throw new Error(res.status);
    const rows = await res.json();
    dbAvailable = true;
    const dict = {};
    for (const row of rows) dict[row.id] = dealRowToInternal(row);
    return dict;
  } catch (_) {
    dbAvailable = false;
    return null;
  }
}

// V77.2g — Refetch a single deal from the server and overwrite the in-memory
// pipeline entry + localStorage cache. Used to roll back optimistic updates
// when the DB save was rejected (so the cache doesn't stay ahead of reality).
// Also fires a repaint event so any open modal/board re-renders against the
// truthful state.
async function reloadPipelineEntryFromDb(id) {
  try {
    const r = await fetch(`/api/deals?id=${encodeURIComponent(id)}`);
    if (!r.ok) {
      if (r.status === 404) {
        // Deal was deleted server-side — drop locally too
        delete pipeline[id];
        cacheSave(pipeline);
        if (kanbanVisible) renderBoard();
        return;
      }
      throw new Error(r.status);
    }
    const row = await r.json();
    pipeline[id] = dealRowToInternal(row);
    cacheSave(pipeline);
    // Repaint: the open modal (if any) will close+reopen via re-render below
    // for now we just repaint the board. A more polished fix would re-render
    // the modal in place if it's the same deal id.
    if (kanbanVisible) renderBoard();
    // If the modal for this deal is open, re-render its body so the agent
    // sees the rolled-back state.
    const openModal = document.querySelector(`.kb-modal-overlay[data-property-id="${id}"]`);
    if (openModal) {
      openModal.remove();
      // Reopen with fresh data — minor UX blip but keeps the user honest
      try {
        if (typeof window.openPipelineItem === 'function') window.openPipelineItem(id);
      } catch (_) {}
    }
  } catch (err) {
    console.warn('[kanban] reloadPipelineEntryFromDb failed for', id, err);
  }
}

// Save an entry — writes property first (needed as FK target for the deal), then deal.
// V75.4: parcel deals skip the property upsert (their properties are separate
// records with their own parcel_id FK, managed via the Parcel modal).
async function dbSave(id, entry) {
  if (!dbAvailable) return;
  try {
    const dealPayload = internalToDealPayload(id, entry);

    if (!entry._isParcel) {
      const propPayload = internalToPropertyPayload(id, entry);
      // PUT property first (will 404 if it doesn't exist yet → fall through to create)
      let propRes = await fetch(PROPERTIES_API, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(propPayload),
      });
      if (propRes.status === 404) {
        propRes = await fetch(PROPERTIES_API, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify(propPayload),
        });
      }
    }

    // Then deal — same pattern
    let dealRes = await fetch(DEALS_API, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(dealPayload),
    });
    if (dealRes.status === 404) {
      dealRes = await fetch(DEALS_API, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(dealPayload),
      });
    }
    // V77.2g — surface any non-2xx response (e.g. 409 from the Default Board
    // Role invariant). Silently swallowing it means the modal closes as if it
    // saved while the change never hit the DB — which is exactly the bug the
    // invariant was meant to prevent.
    if (!dealRes.ok) {
      let errorMsg = `Save failed (${dealRes.status})`;
      try {
        const errBody = await dealRes.json();
        if (errBody?.error) errorMsg = errBody.error;
      } catch (_) {}
      showKanbanToast(errorMsg);
      throw new Error(errorMsg);
    }
  } catch (err) {
    console.warn('[kanban] dbSave failed:', err);
    throw err;
  }
}

async function dbDelete(id) {
  // V76.12b: Deal-delete is deal-only. Both property-deals and parcel-deals
  // route to /api/deals — server cascades to deal-scoped associations
  // (financials, deal contact links, deal notes, actions) but never
  // touches properties, parcels, or property-scoped data. Property/
  // parcel deletion is a CRM-only operation.
  if (!dbAvailable) return;
  try {
    await fetch(`${DEALS_API}?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
  } catch (_) {}
}

// ── savePipeline — write to both cache and DB ─────────────────────────────────
// Called after every mutation. id = the specific entry that changed (or null = full sync).
// Returns a Promise that resolves once the DB write has completed. Callers
// that don't care can ignore the returned value — sync behaviour is
// preserved. Callers that need to know the write has committed (e.g. the
// CRM cache invalidation after addToPipeline) can await it.
function savePipeline(changedId) {
  cacheSave(pipeline);
  let writePromise = Promise.resolve();
  if (changedId && pipeline[changedId]) {
    writePromise = dbSave(changedId, pipeline[changedId]).catch(err => {
      // V77.2g — DB rejected the save. Refetch the entry to overwrite our
      // optimistic cache so what the user sees matches the truth. The toast
      // already explained the rejection (showKanbanToast inside dbSave). We
      // swallow the error here so existing fire-and-forget callers don't
      // produce unhandled rejections; the toast + reload IS the user feedback.
      console.warn('[savePipeline] DB rejected save for id', changedId, '— rolling back local cache');
      return reloadPipelineEntryFromDb(changedId);
    });
  }
  if (typeof window.refreshPipelinePins === 'function') window.refreshPipelinePins();
  return writePromise;
}

// ── Init — load from DB, fall back to localStorage ───────────────────────────
async function initPipeline() {
  // Load from localStorage immediately so board is usable at once
  pipeline = cacheLoad();
  updateAddButtons();

  // V76.9: Parallelise init API calls. Previously these ran sequentially
  // (auth/me → loadBoards → actions-bootstrap → loadUserDealOrder → dbLoad),
  // which on a typical connection was ~600-1500ms of blocking before the
  // first render of fresh data. Most of these calls are independent.
  //
  // Phase 1 (parallel):  auth/me, loadBoards
  // Phase 2 (parallel):  actions-bootstrap (needs session), userDealOrder
  //                       and dbLoad (both need currentBoardId from boards)
  //
  // V75.6: load boards + per-user ordering first, then the deal list.
  // Also prime the admin flag cache so the toolbar's Delete Board button
  // renders correctly on first paint (system boards only deletable by admin).
  // V75.7: also prime the session-user id so the actions module can default
  // assignee to the current user.

  const phase1Promises = [];

  if (window._pipelineIsAdmin === undefined || window._sessionUserId === undefined) {
    phase1Promises.push(
      fetch('/api/auth/me').then(r => r.ok ? r.json() : null).then(me => {
        const user = me?.user || me || {};
        window._pipelineIsAdmin = !!(user.isAdmin || user.is_admin);
        const uid = user.id;
        if (typeof uid === 'number') window._sessionUserId = uid;
        else if (typeof uid === 'string' && /^\d+$/.test(uid)) window._sessionUserId = parseInt(uid, 10);
        else window._sessionUserId = null;
        window._sessionUserName = user.name || user.email || null;
      }).catch(() => {
        window._pipelineIsAdmin = false;
        window._sessionUserId = null;
        window._sessionUserName = null;
      })
    );
  }

  phase1Promises.push(loadBoards());
  // V78g — Per-board default scores. Used by addToPipeline to stamp
  // interest_level on new cards. Independent of boards loading, so parallel.
  phase1Promises.push(loadBoardDefaultScores());

  await Promise.all(phase1Promises);

  // Phase 2 — these all depend on phase 1 results (session id, currentBoardId).
  // V75.7: ensure My Actions board exists for this user. Hits /api/actions
  // with assignee=me which auto-creates the board + 5 default columns on
  // first call. Then reload boards so the selector includes it.
  const actionsBootstrapPromise = window._sessionUserId
    ? fetch('/api/actions?assignee=me')
        .then(r => r.ok ? r.json() : null)
        .then(payload => {
          if (payload?.board && !boards.find(b => b.id === payload.board.id)) {
            boards.push(payload.board);
          }
          // Cache the actions data too so first Pipeline open can paint from cache
          if (payload?.actions) {
            _actionsCache = payload.actions;
            _actionsBoardCache = { activeBoard: payload.board, actions: payload.actions };
            markActionsFresh();
          }
        })
        .catch(err => console.warn('[actions] bootstrap failed:', err.message))
    : Promise.resolve();

  const dealOrderPromise = loadUserDealOrder();
  const remotePromise    = dbLoad();

  const [, , remote] = await Promise.all([
    actionsBootstrapPromise,
    dealOrderPromise,
    remotePromise,
  ]);

  if (remote !== null) {
    pipeline = remote;
    cacheSave(pipeline);
    if (typeof window.refreshPipelinePins === 'function') window.refreshPipelinePins();
    updateAddButtons();
    if (kanbanVisible) renderBoard();
    // V76.9: we just loaded fresh deal data — mark BoardSync so the next
    // openPipeline doesn't redundantly hit dbLoad() again within the debounce window.
    markPipelineFresh();
  }
}

// pipeline: { [propertyId]: { stage, note, addedAt, property, terms, offers, dd } }

// ─── View toggle ──────────────────────────────────────────────────────────────

let kanbanVisible = false;

function toggleKanban(show) {
  kanbanVisible = show !== undefined ? show : !kanbanVisible;
  window.kanbanVisible = kanbanVisible;  // expose for finance module
  document.getElementById('kanbanView').classList.toggle('visible', kanbanVisible);
  const btn = document.getElementById('kanbanToggleBtn');
  btn.classList.toggle('active', kanbanVisible);
  if (kanbanVisible) {
    renderBoard();
    // V76.4: refresh the due-actions bell badge whenever Pipeline is opened.
    // No polling — the count refreshes only on view open (and after action
    // mutations, which is what the user asked for).
    refreshDueBadge();
    // V76.9: opportunistic multi-user sync on view open. Picks up background
    // changes from this user (other tabs) or other users. Debounced via the
    // BoardSync framework so rapid open/close doesn't hammer the API. The
    // appropriate adapter runs based on which board is currently active.
    refreshPipelineIfStale();
    refreshActionsIfStale();
  }
}

// ─── V76.4: Due-actions bell badge ───────────────────────────────────────────
// Hits the lightweight count endpoint and toggles the badge in Header 2.
// Visible on all Pipeline boards (not just My Actions). Click jumps to the
// user's My Actions board.

async function refreshDueBadge() {
  const badge = document.getElementById('kanbanDueBadge');
  const countEl = document.getElementById('kanbanDueBadgeCount');
  if (!badge || !countEl) return;
  try {
    const r = await fetch('/api/actions?count=due');
    if (!r.ok) { badge.hidden = true; return; }
    const { count } = await r.json();
    if (!count || count <= 0) {
      badge.hidden = true;
    } else {
      countEl.textContent = String(count);
      badge.hidden = false;
    }
  } catch (_) {
    badge.hidden = true;
  }
}
window.refreshDueBadge = refreshDueBadge;

// Bind click once on first script load — switches the active board to the
// user's My Actions board (without filter), reusing the board-select flow.
(function bindDueBadgeClick() {
  document.addEventListener('DOMContentLoaded', () => {
    const badge = document.getElementById('kanbanDueBadge');
    if (!badge) return;
    badge.addEventListener('click', () => {
      const myActions = (boards || []).find(b => b.board_type === 'action');
      if (!myActions) return;
      if (currentBoardId === myActions.id) return; // already there
      currentBoardId = myActions.id;
      // Sync the visible board selector so it reflects the switch
      const sel = document.getElementById('kanbanBoardSelect');
      if (sel) sel.value = currentBoardId;
      pipeline = {};
      renderBoard();
    });
  });
})();

// ─── Add property to pipeline ────────────────────────────────────────────────

// V76.5 — id generation. Properties and deals each get their own keyspace,
// distinct from each other and from Domain listing ids. Reflects the new
// architectural rule: deal id, property id, and listing id are all unique
// and must never overlap. Migration to-v76-5 renumbers legacy data that
// violated this; addToPipeline below never creates a violation in new data.
function newPropertyId() {
  return 'prop_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}
function newDealId() {
  return 'deal_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

// V78g — Board picker shown before adding a property to the pipeline. The
// agent chooses which board the new deal lands on, regardless of which board
// they're currently viewing. Returns a Promise resolving to the chosen
// board id, or null if cancelled.
//
// Eligible boards are deal-type boards visible to the user — system boards
// (Acquisition, Sales Listings, Lease Listings) plus any custom owned boards.
// Enquiry boards (sys_sales_enquiry, sys_lease_enquiry) are excluded — those
// represent inbound buyer/tenant enquiries on existing listings, not somewhere
// a fresh map-discovered property should land. Action boards are excluded too.
function pickBoardForNewDeal(listingAddress) {
  return new Promise(resolve => {
    const eligible = boards.filter(b => {
      if (b.board_type === 'action') return false;
      // Exclude Enquiry boards (per above).
      if (b.id === 'sys_sales_enquiry' || b.id === 'sys_lease_enquiry') return false;
      return true;
    });

    // If nothing's eligible (shouldn't happen in practice — Acquisition is
    // always seeded as a system board), fall back to Acquisition silently.
    if (!eligible.length) {
      resolve('sys_acquisition');
      return;
    }

    // System boards first (sort_order ascending), then user boards.
    eligible.sort((a, b) => {
      if (a.is_system !== b.is_system) return a.is_system ? -1 : 1;
      return (a.sort_order || 0) - (b.sort_order || 0);
    });

    const wrap = document.createElement('div');
    wrap.className = 'kb-modal-overlay kb-board-picker-overlay';
    wrap.innerHTML = `
      <div class="kb-modal" role="dialog" aria-modal="true" style="max-width:520px">
        <div class="kb-modal-header">
          <h2>Add to which board?</h2>
          <button class="kb-modal-close" title="Close" type="button">✕</button>
        </div>
        <div class="kb-modal-body">
          <div class="kb-board-picker-help">${listingAddress ? escapeHtml(listingAddress) + ' &middot; ' : ''}Choose the board this property should be added to.</div>
          <div class="kb-board-picker-list">
            ${eligible.map((b, i) => `
              <label class="kb-board-picker-row">
                <input type="radio" name="kb-board-pick" value="${escapeHtml(b.id)}" ${i === 0 ? 'checked' : ''}>
                <span class="kb-board-picker-name">${escapeHtml(b.name)}</span>
                ${b.is_system ? '<span class="kb-board-picker-tag">system</span>' : ''}
              </label>
            `).join('')}
          </div>
        </div>
        <div class="kb-modal-footer">
          <button type="button" class="kb-board-picker-cancel-btn">Cancel</button>
          <button type="button" class="kb-board-picker-confirm-btn">Add</button>
        </div>
      </div>
    `;
    document.body.appendChild(wrap);

    function close(result) {
      if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
      resolve(result);
    }
    wrap.querySelector('.kb-modal-close').addEventListener('click', () => close(null));
    wrap.querySelector('.kb-board-picker-cancel-btn').addEventListener('click', () => close(null));
    wrap.querySelector('.kb-board-picker-confirm-btn').addEventListener('click', () => {
      const checked = wrap.querySelector('input[name="kb-board-pick"]:checked');
      close(checked ? checked.value : null);
    });
  });
}

// V76.5 — addToPipeline rewritten:
//   - If the listing's domain id is already linked to an existing property
//     (because the user manually linked them via the CRM Property modal),
//     reuse that property and just create a new deal pointing at it.
//   - Otherwise generate a fresh `prop_*` id for the property and a fresh
//     `deal_*` id for the deal. Property gets `domain_listing_id = listing.id`
//     so future "in pipeline?" lookups via domain id resolve correctly.
//   - For non-Domain inputs (map clicks without a listing), the caller passes
//     a synthetic listing without a Domain id; we skip the domain lookup and
//     skip stamping domain_id on the new property.
async function addToPipeline(listing) {
  // Distinguish a real Domain listing from a synthetic map-click record.
  // Real Domain listing ids are purely numeric strings; synthetic ids generated
  // elsewhere look like "property-1234567890" or other non-numeric formats.
  const rawId = listing?.id != null ? String(listing.id) : '';
  const isDomainId = /^\d{6,}$/.test(rawId);
  const domainId = isDomainId ? rawId : null;

  // Already in pipeline? Highlight the existing card. Look up via domain_id
  // (the new canonical relationship) rather than trusting that the listing's
  // id is also a deal id, which it is no longer.
  if (domainId) {
    const existing = findPipelineByDomainId(domainId);
    if (existing) {
      highlightCard(existing[0]);
      return;
    }
  }

  // V78g — Agent picks which board this lands on. Don't default to
  // currentBoardId — that produced the bug where adding from the map while
  // viewing Lease Listings landed the property on the Lease board.
  const targetBoardId = await pickBoardForNewDeal(listing?.address);
  if (!targetBoardId) return; // user cancelled

  // V78g — Resolve the first column of the target board. New cards always
  // land in the leftmost column (sort_order 0) of whatever board the agent
  // picked. Without this, internalToDealPayload's fallback stageToColumnId
  // would try to resolve 'shortlisted' against the chosen board, which only
  // exists on Acquisition — every other board would return the literal string
  // 'shortlisted' and trigger an FK violation on deals_column_id_fkey.
  const targetBoard = boards.find(x => x.id === targetBoardId);
  const firstCol = (targetBoard?.columns || []).slice().sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0))[0];
  if (!firstCol) {
    alert('Cannot add to this board — it has no columns. Edit the board to add a column first.');
    return;
  }
  const targetColumnId = firstCol.id;
  const targetStageSlug = firstCol.stage_slug || firstCol.id;

  // Server-side check: maybe a property already exists with this Domain
  // listing id (e.g. user linked it before adding to pipeline). If so, reuse
  // it; if not, we'll create a new property below.
  // V76.7+ — also check by lot/DP, so a property created earlier via "+ Property"
  // (or a previous deal that's since been deleted) is reused rather than
  // duplicated when the user clicks "+ Pipeline" on the same parcel.
  const existingProperty = await findExistingProperty(listing);

  const propertyId = existingProperty?.id || newPropertyId();
  const dealId     = newDealId();

  // Build _parcels array — multi-parcel entries already have it, single entries get one from lat/lng
  const parcels = listing._parcels && listing._parcels.length > 0
    ? listing._parcels
    : [{ lat: listing.lat, lng: listing.lng, label: `${listing.address}, ${listing.suburb}` }];

  // V78g — Resolve default score for the chosen board. Falls back to 40 if
  // the board has no setting row (shouldn't happen post-migration but stays
  // defensive — same value as the v78g seed).
  const defaultScore = (boardDefaultScores[targetBoardId] != null)
    ? boardDefaultScores[targetBoardId]
    : BOARD_DEFAULT_SCORE_FALLBACK;

  pipeline[dealId] = {
    stage:   targetStageSlug,
    note:    '',
    addedAt: Date.now(),
    // V78g — Stamp the chosen board + first column so internalToDealPayload
    // doesn't fall back to currentBoardId or to a column-id that doesn't
    // exist for this board.
    _boardId:  targetBoardId,
    _columnId: targetColumnId,
    property: {
      id:          propertyId,
      address:     existingProperty?.address || listing.address,
      suburb:      existingProperty?.suburb  || listing.suburb,
      state:       existingProperty?.state   || listing.state || 'NSW',
      price:       listing.price,
      type:        listing.type,
      beds:        listing.beds,
      baths:       listing.baths,
      cars:        listing.cars,
      _parcels:    parcels,
      _lotDPs:        existingProperty?.lot_dps     || listing._lotDPs        || null,
      _areaSqm:       existingProperty?.area_sqm    || listing._areaSqm       || null,
      _propertyCount: listing._propertyCount  || 1,
      _agent:         listing.agent           || null,
      _listingUrl:    listing.listingUrl       || null,
      // domain_id is the link to Domain. Only set it for real Domain listings;
      // synthetic ids (e.g. "property-1234567890" from map clicks) leave it null.
      domain_id:      domainId,
    },
    // V78g — Apply per-board default score so the new card ranks correctly
    // when sorted by interest_level (the default kanban sort mode).
    data: { interest_level: defaultScore },
    dd: {}
  };
  const savedPromise = savePipeline(dealId);
  updateAddButtons();
  if (kanbanVisible) renderBoard();
  showKanbanToast(`${listing.address} added to pipeline`);

  // V75.5: new property was created (or upserted) — refresh CRM Properties
  // cache AFTER the DB write has committed. Without the await, the re-fetch
  // from /api/properties would race the save and miss the new row.
  savedPromise.then(() => {
    if (window.CRM?.invalidatePropertiesCache) {
      window.CRM.invalidatePropertiesCache();
    }
  }).catch(() => {});

  // Async — fetch Lot/DP from cadastre if not already present
  const lat = listing.lat ?? parcels[0]?.lat ?? null;
  const lng = listing.lng ?? parcels[0]?.lng ?? null;
  if (!pipeline[dealId].property._lotDPs && window.fetchLotDP) {
    if (lat && lng) {
      fetchLotDP(lat, lng).then(cadastre => {
        if (!pipeline[dealId] || !cadastre?.lotid) return;
        pipeline[dealId].property._lotDPs = cadastre.lotid;
        if (!pipeline[dealId].property._areaSqm && cadastre.areaSqm) pipeline[dealId].property._areaSqm = cadastre.areaSqm;
        savePipeline(dealId);
        const modal = document.getElementById('kb-modal');
        if (modal?.dataset?.propertyId === String(dealId)) {
          const lotEl = modal.querySelector('.kb-modal-lotdp');
          if (lotEl) lotEl.textContent = cadastre.lotid;
        }
        if (kanbanVisible) renderBoard();
      }).catch(() => {});
    }
  }

  // Async — query overlay layers and pre-populate DD risks
  if (lat && lng && window.queryDDRisks) {
    console.log('[DD] Querying risks for', listing.address, lat, lng);
    queryDDRisks(lat, lng).then(dd => {
      console.log('[DD] Results:', dd);
      if (!pipeline[dealId]) return;
      Object.entries(dd).forEach(([key, val]) => {
        if (!pipeline[dealId].dd[key]?.status) pipeline[dealId].dd[key] = val;
      });
      savePipeline(dealId);
      if (kanbanVisible) renderBoard();
      // If this card's modal is open, refresh its DD section
      refreshModalDd(dealId);
    }).catch(err => console.warn('[DD] Risk query failed:', err));
  } else {
    console.warn('[DD] Skipping risk query — lat:', lat, 'lng:', lng, 'queryDDRisks:', !!window.queryDDRisks);
  }
}

// V76.7+ — Create a property record WITHOUT a deal.
//
// Same population logic as addToPipeline() but skips deal creation entirely.
// Used by the map popup's "+ Property" button to support workflows where the
// property exists in the CRM but isn't (yet) in any pipeline — e.g. tracking
// not-suitable properties, agency listings before a deal is opened, or
// linking a Domain listing to a known address without committing to acquisition.
//
// Returns { propertyId, isNew, existing } — isNew is false if a property with
// this Domain listing id already existed and was reused.
// V76.7+ — Look up an existing property record in the database that matches
// the given listing/click context. Tries Domain id first (fast, indexed),
// then each lot/DP element (also indexed via UPPER substring on properties).
//
// Returns the matching property row, or null.
//
// Used by BOTH addPropertyOnly (for "+ Property" duplicate-detection) and
// addToPipeline (so "+ Pipeline" reuses an existing property when the user
// clicks a parcel that was previously added via "+ Property" or another deal).
// V76.7+ — Open a property record in the CRM Properties modal. Used when
// the map's "+ Property" button is clicked but the property already exists.
// Closes the kanban (if visible), shows the CRM, navigates to the Properties
// tab, and opens the modal for that property. If the CRM is currently hidden,
// toggleCRM(true) lazily renders it first (one-time cost on first open).
function _openPropertyInCrm(propertyId) {
  if (!propertyId) return;
  // Prefer router-level navigation so /crm/properties/:id is the URL state
  if (window.Router?.navigate) {
    window.Router.navigate('/crm/properties/' + encodeURIComponent(propertyId));
    return;
  }
  // Fallback: direct toggle + navigateTo
  if (typeof toggleCRM === 'function') toggleCRM(true);
  // navigateTo runs after the CRM has rendered — small timeout matches router behaviour
  setTimeout(() => {
    if (window.CRM?.navigateTo) window.CRM.navigateTo('properties', propertyId);
  }, 100);
}

async function findExistingProperty(listing) {
  // Domain id — most precise, single fetch
  const rawId = listing?.id != null ? String(listing.id) : '';
  const isDomainId = /^\d{6,}$/.test(rawId);
  if (isDomainId) {
    try {
      const r = await fetch(`/api/properties?by_domain_listing=${encodeURIComponent(rawId)}`);
      if (r.ok) {
        const row = await r.json();
        if (row?.id) return row;
      }
    } catch (_) { /* fall through */ }
  }

  // Lot/DP + address — V77.2: a single lot/DP can host multiple addresses
  // (strata units, duplexes, granny flats, dual-occupancy). Dedup uses the
  // pair (lot_dp, address) so 45 Earl St and 45a Earl St on the same lot/DP
  // are correctly treated as separate properties. If `address` is empty we
  // fall back to lot/DP-only match (legacy behaviour) to avoid creating
  // duplicates from incomplete listing data.
  const lotDpsStr = (listing._lotDPs || '').toString();
  const lotElements = lotDpsStr.split(',').map(s => s.trim()).filter(Boolean);
  const addr = (listing.address || '').trim();
  for (const lot of lotElements) {
    const url = addr
      ? `/api/properties?by_lot_dp=${encodeURIComponent(lot)}&by_lot_dp_address=${encodeURIComponent(addr)}`
      : `/api/properties?by_lot_dp=${encodeURIComponent(lot)}`;
    try {
      const r = await fetch(url);
      if (r.ok) {
        const row = await r.json();
        if (row?.id) return row;
      }
    } catch (_) { /* try next lot */ }
  }

  return null;
}

async function addPropertyOnly(listing) {
  // V76.7+ — Look up by Domain id OR lot/DP. If a match exists, route the
  // user to it instead of creating a duplicate.
  // V77.2 — Lot/DP can host multiple addresses (strata units, duplexes,
  // granny flats). When the existing record's address doesn't match, ask
  // the user whether this is the same property (open existing) or a new one
  // sharing the lot/DP (e.g. 45 vs 45a Earl St).
  const existingProperty = await findExistingProperty(listing);

  if (existingProperty?.id) {
    // V77.2 — when an existing property is found, prompt the agent so they
    // can confirm: same property → open existing, OR different property
    // sharing the lot/DP (e.g. 45 vs 45a Earl St) → create new with edited
    // address. Skipped only for Domain-driven flows where the listing's
    // Domain ID precisely identifies the property.
    const isDomainDriven = !!(listing?.id && /^\d{6,}$/.test(String(listing.id)));

    if (isDomainDriven) {
      if (window.CRM?.invalidatePropertiesCache) window.CRM.invalidatePropertiesCache();
      _openPropertyInCrm(existingProperty.id);
      showKanbanToast(`${existingProperty.address || 'Property'} already in CRM — opened`);
      return { propertyId: existingProperty.id, isNew: false, existing: existingProperty };
    }

    const choice = await promptSharedLotDpChoice(existingProperty, listing);
    if (choice === 'open') {
      if (window.CRM?.invalidatePropertiesCache) window.CRM.invalidatePropertiesCache();
      _openPropertyInCrm(existingProperty.id);
      showKanbanToast(`${existingProperty.address || 'Property'} already in CRM — opened`);
      return { propertyId: existingProperty.id, isNew: false, existing: existingProperty };
    }
    if (choice === 'cancel') {
      return { propertyId: null, isNew: false, cancelled: true };
    }
    // choice === { create_with_address: 'X' } — fall through with overridden address
    if (typeof choice === 'object' && choice.create_with_address) {
      listing = { ...listing, address: choice.create_with_address };
    }
  }

  // No existing match (or user chose to create a new one) — create the property.
  const propertyId = newPropertyId();
  const rawId = listing?.id != null ? String(listing.id) : '';
  const isDomainId = /^\d{6,}$/.test(rawId);
  const domainId = isDomainId ? rawId : null;

  // Build _parcels array — multi-parcel entries already have it; single
  // entries get one synthesised from lat/lng.
  const parcels = listing._parcels && listing._parcels.length > 0
    ? listing._parcels
    : [{ lat: listing.lat, lng: listing.lng, label: `${listing.address}, ${listing.suburb}` }];
  const firstParcel = parcels[0];

  const payload = {
    id:                propertyId,
    address:           listing.address || '',
    suburb:            listing.suburb  || '',
    state:             listing.state   || 'NSW',
    lat:               listing.lat ?? firstParcel?.lat ?? null,
    lng:               listing.lng ?? firstParcel?.lng ?? null,
    lot_dps:           (listing._lotDPs || '').toString().toUpperCase(),
    area_sqm:          listing._areaSqm ?? null,
    parcels,
    property_count:    listing._propertyCount ?? 1,
    domain_listing_id: domainId,
    listing_url:       listing.listingUrl || null,
    agent:             listing.agent || null,
  };

  try {
    const res = await fetch(PROPERTIES_API, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.warn('[addPropertyOnly] API error:', err);
      showKanbanToast(`Failed to create property: ${err.error || res.statusText}`);
      return { propertyId: null, isNew: false };
    }
  } catch (err) {
    console.warn('[addPropertyOnly] fetch failed:', err);
    showKanbanToast(`Failed to create property: ${err.message}`);
    return { propertyId: null, isNew: false };
  }

  // Refresh CRM Properties cache so the new row is visible immediately
  if (window.CRM?.invalidatePropertiesCache) {
    window.CRM.invalidatePropertiesCache();
  }
  // Broadcast for any other module that might be listening (kanban refresh
  // is a no-op since this property has no deal yet, but the event is harmless).
  window.dispatchEvent(new CustomEvent('propertyChanged', {
    detail: { propertyId: String(propertyId) },
  }));

  showKanbanToast(`${listing.address || 'Property'} added to CRM`);
  return { propertyId, isNew: true };
}

// V77.2 — When the user is creating a property at a lot/DP that already has
// a property with a different address, prompt to clarify whether this is the
// same property (open existing) or a new one sharing the lot/DP (a strata unit,
// granny flat etc.). Returns 'open' | 'cancel' | { create_with_address: 'X' }.
function promptSharedLotDpChoice(existing, incoming) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'kb-modal-overlay';
    overlay.style.zIndex = '20000';
    const lotDp = (existing.lot_dps || '').split(',')[0]?.trim() || '—';
    const sameAddr = (existing.address || '').trim().toLowerCase() === (incoming.address || '').trim().toLowerCase();
    const headlineText = sameAddr
      ? 'A property already exists here'
      : 'Property already exists at this Lot/DP';
    const bodyText = sameAddr
      ? `<p>An existing property is already recorded at this location:</p>
         <p style="background:var(--surface2);padding:8px 10px;border-radius:4px;font-weight:600">${escapeHtml(existing.address || '—')}${existing.suburb ? ', ' + escapeHtml(existing.suburb) : ''}</p>
         <p style="margin-top:14px;color:var(--muted);font-size:12px">If you intended a different address (e.g. a strata unit, granny flat or letter suffix like 45a), edit the address below and click <strong>Add as new property</strong>. Otherwise click <strong>Open existing</strong>.</p>`
      : `<p>An existing property at <strong>${escapeHtml(lotDp)}</strong> has the address:</p>
         <p style="background:var(--surface2);padding:8px 10px;border-radius:4px;font-weight:600">${escapeHtml(existing.address || '—')}${existing.suburb ? ', ' + escapeHtml(existing.suburb) : ''}</p>
         <p style="margin-top:14px">You're trying to add a property here with the address:</p>
         <p style="background:var(--surface2);padding:8px 10px;border-radius:4px;font-weight:600">${escapeHtml(incoming.address || '—')}${incoming.suburb ? ', ' + escapeHtml(incoming.suburb) : ''}</p>
         <p style="margin-top:14px;color:var(--muted);font-size:12px">A single Lot/DP can have multiple addresses (strata units, duplexes, granny flats). Choose what to do:</p>`;
    overlay.innerHTML = `
      <div class="kb-modal" style="max-width:520px;background:var(--surface);border-radius:6px">
        <div class="kb-modal-header" style="padding:14px 18px;border-bottom:1px solid var(--border)">
          <div class="kb-modal-title" style="font-size:14px;font-weight:600">${escapeHtml(headlineText)}</div>
        </div>
        <div class="kb-modal-body" style="padding:18px;font-size:13px;line-height:1.5">
          ${bodyText}
          <div class="kb-field-wrap" style="margin-top:14px">
            <label class="kb-field-label" style="font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:var(--muted)">Address for the new property</label>
            <input class="kb-input" data-role="new-address" type="text" value="${escapeHtml(incoming.address || '')}" placeholder="e.g. 45a Earl St">
            <div style="font-size:11px;color:var(--muted);margin-top:4px">Edit if needed (e.g. add unit number).</div>
          </div>
        </div>
        <div class="kb-modal-footer" style="padding:12px 18px;border-top:1px solid var(--border);display:flex;gap:8px;justify-content:flex-end">
          <button data-role="cancel" class="params-cancel-btn">Cancel</button>
          <button data-role="open" class="params-cancel-btn">Open existing instead</button>
          <button data-role="create" class="params-save-btn">Add as new property</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const close = (val) => { overlay.remove(); resolve(val); };

    overlay.querySelector('[data-role="cancel"]').addEventListener('click', () => close('cancel'));
    overlay.querySelector('[data-role="open"]').addEventListener('click', () => close('open'));
    overlay.querySelector('[data-role="create"]').addEventListener('click', () => {
      const v = overlay.querySelector('[data-role="new-address"]').value.trim();
      if (!v) {
        alert('Please enter an address for the new property.');
        return;
      }
      // V77.2 — guard against the agent clicking "Add as new property" without
      // actually changing the address. That would create an exact duplicate.
      if (v.trim().toLowerCase() === (existing.address || '').trim().toLowerCase()) {
        alert('Please edit the address (e.g. add a unit number) to differentiate from the existing property — or click "Open existing" instead.');
        return;
      }
      close({ create_with_address: v });
    });
    overlay.addEventListener('click', e => { if (e.target === overlay) close('cancel'); });
    setTimeout(() => overlay.querySelector('[data-role="new-address"]')?.focus(), 50);
  });
}

async function removeFromPipeline(id) {
  // V76.12b: deal-only delete. The server no longer touches properties or
  // parcels, so we don't need to capture _isParcel / propertyId for routing.
  const sid = String(id);
  delete pipeline[sid];
  cacheSave(pipeline);
  await dbDelete(sid);
  updateAddButtons();
  renderBoard();
  if (typeof window.refreshPipelinePins === 'function') window.refreshPipelinePins();
  // V76.12b: deal-delete no longer touches property/parcel rows, but the CRM
  // views display deal counts and active-deal status on properties and
  // parcels — invalidate so they re-fetch.
  if (window.CRM?.invalidatePropertiesCache) window.CRM.invalidatePropertiesCache();
  if (window.CRM?.invalidateParcelsCache)    window.CRM.invalidateParcelsCache();
}

function moveToStage(id, stageId) {
  // V75.6: legacy wrapper. `stageId` is a stage slug (e.g. 'under-dd') or
  // a column id — we route through moveToColumn which handles both.
  moveToColumn(id, stageId);
}

// V75.6: move a deal to a target column. `target` may be a column id
// (preferred — "sys_acquisition_under-dd") or a legacy stage slug
// ("under-dd"). Either way we update entry.stage + entry._columnId and
// persist via savePipeline.
function moveToColumn(id, target) {
  const entry = pipeline[id];
  if (!entry) return;
  const board = boards.find(b => b.id === (entry._boardId || currentBoardId));
  const col = board?.columns?.find(c => c.id === target || c.stage_slug === target);
  if (col) {
    entry._columnId = col.id;
    entry.stage     = col.stage_slug || col.id;
    entry._boardId  = board.id;
  } else {
    // Fallback: no board loaded, just set the slug
    entry.stage = target;
    entry._columnId = null;
  }
  savePipeline(id);
}

// V75.6.4: render the board selector bar once, then only update the select's
// selected value and the Delete button's disabled state on subsequent calls.
// Replacing innerHTML on every renderBoard() caused a race where the user's
// change event fired on a detached <select> (kanban visible but board didn't
// switch until the second click).
function _renderBoardSelectorBar() {
  const bar = document.getElementById('kanbanBoardToolbar');
  if (!bar) return;
  if (!boards.length) {
    bar.innerHTML = '';
    return;
  }

  const sysBoards  = boards.filter(b =>  b.is_system);
  const userBoards = boards.filter(b => !b.is_system);
  const active     = boards.find(b => b.id === currentBoardId);
  const adminProbe = !!window._pipelineIsAdmin;

  // Whether Delete Board is enabled for the current selection
  let canDeleteCurrent = false;
  if (active) {
    if (active.is_system) canDeleteCurrent = adminProbe;
    else                   canDeleteCurrent = true;
  }

  // V76.2: strip the "+ New Action" button when the current board isn't an
  // action board. renderActionsBoard() re-adds it when it runs.
  const isActionBoard = active?.board_type === 'action';
  if (!isActionBoard) {
    const existingNewAction = bar.querySelector('#kbNewActionBtn');
    if (existingNewAction) existingNewAction.remove();
  }

  // FAST-PATH: toolbar already built — patch state instead of rebuilding DOM
  const existing = bar.querySelector('#kanbanBoardSelect');
  if (existing) {
    // Sync selected board
    if (existing.value !== currentBoardId) existing.value = currentBoardId;
    // Sync Delete button
    const delBtn = bar.querySelector('#kanbanDeleteBoardBtn');
    if (delBtn) {
      delBtn.disabled = !canDeleteCurrent;
      delBtn.title    = canDeleteCurrent ? 'Delete this board' : 'You cannot delete this board';
    }
    // Boards list might have new entries (e.g. just created one).
    // Regenerate only the <option>s — not the <select> element itself,
    // so the change-listener stays bound.
    const expectedOpts = [];
    if (sysBoards.length) {
      expectedOpts.push('<optgroup label="System Boards">');
      for (const b of sysBoards) expectedOpts.push(`<option value="${b.id}">${b.name}</option>`);
      expectedOpts.push('</optgroup>');
    }
    if (userBoards.length) {
      expectedOpts.push('<optgroup label="My Boards">');
      for (const b of userBoards) expectedOpts.push(`<option value="${b.id}">${b.name}</option>`);
      expectedOpts.push('</optgroup>');
    }
    const expectedHtml = expectedOpts.join('');
    // Cheap diff: set innerHTML on <select> body only if content differs.
    // This preserves the <select> node so its bound listener isn't detached.
    if (existing.innerHTML.replace(/\s+/g, '') !== expectedHtml.replace(/\s+/g, '')) {
      existing.innerHTML = expectedHtml;
      existing.value = currentBoardId;
    }
    // V77.1: re-evaluate the "+ New Card" button visibility for this board
    if (window.KanbanNewCard) {
      KanbanNewCard.attachToToolbar(bar, currentBoardId, (newDealId) => {
        pipeline = {};
        renderBoard();
        setTimeout(() => {
          if (typeof openPipelineItem === 'function') openPipelineItem(newDealId);
        }, 300);
      });
    }
    // V80.4 — keep the sort select's DD-risk option visibility in sync as
    // boards change. Other state (selected mode) is already correct in
    // localStorage; just toggle the option visibility.
    const sortSelFast = bar.querySelector('#kanbanSortSelect');
    if (sortSelFast) {
      const ddOptFast = sortSelFast.querySelector('option[value="dd_risk"]');
      if (ddOptFast) {
        const isAcquisition = currentBoardId === 'sys_acquisition';
        ddOptFast.hidden = !isAcquisition;
        if (!isAcquisition && sortSelFast.value === 'dd_risk') {
          sortSelFast.value = 'interest';
          setKanbanSortMode('interest');
        }
      }
    }
    return;
  }

  // FIRST BUILD: construct the toolbar and wire handlers once
  const options = [];
  if (sysBoards.length) {
    options.push('<optgroup label="System Boards">');
    for (const b of sysBoards) options.push(`<option value="${b.id}">${b.name}</option>`);
    options.push('</optgroup>');
  }
  if (userBoards.length) {
    options.push('<optgroup label="My Boards">');
    for (const b of userBoards) options.push(`<option value="${b.id}">${b.name}</option>`);
    options.push('</optgroup>');
  }

  bar.innerHTML = `
    <select class="kb-board-select" id="kanbanBoardSelect" title="Switch board">${options.join('')}</select>
    <button class="kb-toolbar-btn" id="kanbanNewBoardBtn" title="Create a new board">+ Board</button>
    <button class="kb-toolbar-btn" id="kanbanEditColumnsBtn" title="Edit this board's columns">Edit Columns</button>
    <button class="kb-toolbar-btn kb-toolbar-btn-danger" id="kanbanDeleteBoardBtn" ${canDeleteCurrent ? '' : 'disabled'} title="${canDeleteCurrent ? 'Delete this board' : 'You cannot delete this board'}">Delete Board</button>
    <input type="search" class="kb-search-input" id="kanbanSearchInput" placeholder="Search… (e.g. contact=anthony AND suburb=rossmore)" title="Boolean search: AND, OR, NOT, parens. Fields: address, suburb, state, stage, contact, agent, beds, baths, price… or just type a word for free-text search."
           value="${(_searchQuery || '').replace(/"/g,'&quot;')}">
    <span class="kb-sort-label">Sort By</span>
    <select class="kb-sort-select" id="kanbanSortSelect" title="Sort cards within each column">
      <option value="interest">Interest level</option>
      <option value="created">Date created</option>
      <option value="actions_due">Actions due</option>
      <option value="dd_risk">DD risk (low first)</option>
    </select>
  `;

  // Set selected AFTER options are in the DOM
  const sel = bar.querySelector('#kanbanBoardSelect');
  sel.value = currentBoardId;

  sel.addEventListener('change', async (e) => {
    currentBoardId = e.target.value;
    const target = boards.find(b => b.id === currentBoardId);

    // V75.7: action boards load from /api/actions, not /api/deals. renderBoard()
    // itself dispatches to renderActionsBoard, which calls the actions endpoint.
    if (target?.board_type === 'action') {
      pipeline = {};
      renderBoard();
      return;
    }

    // V75.6.3: fast-switch — don't refetch /api/boards. Parallelise deal fetches.
    // Render immediately so the user sees the switch; fill in cards on arrival.
    pipeline = {};
    renderBoard();

    const [dict, _order] = await Promise.all([
      dbLoad(),
      loadUserDealOrder(),
    ]);
    if (dict) {
      Object.keys(pipeline).forEach(k => delete pipeline[k]);
      Object.assign(pipeline, dict);
    }
    cacheSave(pipeline);
    renderBoard();
    // V76.9: just freshly loaded — debounce subsequent stale-checks
    markPipelineFresh();
    if (typeof window.refreshPipelinePins === 'function') window.refreshPipelinePins();
  });

  bar.querySelector('#kanbanNewBoardBtn').addEventListener('click', () => openNewBoardModal());
  bar.querySelector('#kanbanEditColumnsBtn').addEventListener('click', () => openEditColumnsModal());
  bar.querySelector('#kanbanDeleteBoardBtn').addEventListener('click', () => openDeleteBoardConfirm());

  // V76.7+ — search input. Debounce so we don't re-render on every keystroke.
  // First non-empty query triggers contacts cache fetch (lazy).
  const searchInput = bar.querySelector('#kanbanSearchInput');
  let _searchDebounceTimer = null;
  searchInput.addEventListener('input', (e) => {
    clearTimeout(_searchDebounceTimer);
    const val = e.target.value;
    _searchDebounceTimer = setTimeout(async () => {
      _searchQuery = val;
      // If the query references contacts (or is non-empty free-text), populate
      // the contacts cache before re-rendering. Otherwise the search would miss
      // contact matches on the first render.
      if (val.trim()) await _ensureContactsCache();
      renderBoard();
    }, 250);
  });

  // V80.4 — Wire the sort-order select. Persists the chosen mode in
  // localStorage; same key is used across all deal boards (per Q2=a).
  const sortSel = bar.querySelector('#kanbanSortSelect');
  if (sortSel) {
    sortSel.value = getKanbanSortMode();
    sortSel.addEventListener('change', (e) => {
      setKanbanSortMode(e.target.value);
      renderBoard();
    });
    // DD risk option only makes sense on Acquisition (other boards don't
    // populate dd state). Hide it elsewhere.
    const ddOption = sortSel.querySelector('option[value="dd_risk"]');
    if (ddOption) {
      const isAcquisition = currentBoardId === 'sys_acquisition';
      ddOption.hidden = !isAcquisition;
      // If user previously had dd_risk selected and switches to a non-Acq
      // board, fall back to the default (interest) so they don't see a
      // hidden value selected.
      if (!isAcquisition && sortSel.value === 'dd_risk') {
        sortSel.value = 'interest';
        setKanbanSortMode('interest');
      }
    }
  }

  // V77.1: attach the "+ New Card" button (only visible on V77.1 system boards).
  if (window.KanbanNewCard) {
    KanbanNewCard.attachToToolbar(bar, currentBoardId, (newDealId) => {
      // After a deal is created, refresh the board view so the new card shows
      pipeline = {};
      renderBoard();
      // Open the new deal modal for immediate edit
      setTimeout(() => {
        if (typeof openPipelineItem === 'function') openPipelineItem(newDealId);
      }, 300);
    });
  }
}

// V76.7+ — Shared confirmation modal for deleting a deal card.
// Used by BOTH the kanban card's X button AND the modal's Delete button so
// the same destructive action shows the same warning, with consistent site
// styling (CSS variables, kb-editcols-overlay pattern, no native confirm()).
//
// V76.7+ — Generic site-styled confirmation modal.
//
// Used wherever the app does a destructive action and wants the same
// consistent overlay UX. Replaces ad-hoc native confirm() dialogs which
// inherit OS chrome (wrong fonts, wrong colours, no design tokens).
//
// opts:
//   title         (string)  — modal title (e.g. "Delete this property?")
//   subject       (string)  — primary identifying text shown bold (e.g. an address)
//   bodyHtml      (string)  — HTML for the explanation paragraph (already escaped)
//   confirmLabel  (string)  — Confirm button text (default "Delete")
//   cancelLabel   (string)  — Cancel button text (default "Cancel")
//   danger        (bool)    — if true, confirm button uses #c0392b red (default true)
//   onConfirm     (fn)      — called when user clicks confirm
//
// Returns a `close()` function the caller can use to dismiss programmatically.
function openConfirmModal(opts = {}) {
  const {
    title         = 'Confirm',
    subject       = '',
    bodyHtml      = '',
    confirmLabel  = 'Delete',
    cancelLabel   = 'Cancel',
    danger        = true,
    onConfirm     = () => {},
  } = opts;

  const overlay = document.createElement('div');
  overlay.className = 'kb-editcols-overlay';
  const subjectBlock = subject
    ? `<div style="font-size:13px;font-weight:600">${escapeHtml(subject)}</div>`
    : '';
  const bodyBlock = bodyHtml
    ? `<div style="font-size:12px;color:var(--text-secondary);line-height:1.5">${bodyHtml}</div>`
    : '';
  const confirmBg = danger ? '#c0392b' : 'var(--accent, #1a6b3a)';

  overlay.innerHTML = `
    <div class="kb-editcols-modal" style="width:440px">
      <div class="kb-editcols-header">
        <div class="kb-editcols-title">${escapeHtml(title)}</div>
        <button class="kb-editcols-close" type="button">✕</button>
      </div>
      <div class="kb-editcols-body">
        <div style="display:flex;flex-direction:column;gap:12px">
          ${subjectBlock}
          ${bodyBlock}
        </div>
      </div>
      <div class="kb-editcols-footer">
        <button class="kb-editcols-cancel" type="button">${escapeHtml(cancelLabel)}</button>
        <button class="kb-confirm-modal-confirm" type="button"
          style="background:${confirmBg};color:#fff;border:1px solid ${confirmBg};padding:7px 14px;border-radius:6px;
                 font-size:13px;font-weight:600;cursor:pointer;font-family:'DM Sans',sans-serif">
          ${escapeHtml(confirmLabel)}
        </button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.querySelector('.kb-editcols-close').addEventListener('click', close);
  overlay.querySelector('.kb-editcols-cancel').addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  overlay.querySelector('.kb-confirm-modal-confirm').addEventListener('click', () => {
    close();
    try { onConfirm(); } catch (err) { console.error('[openConfirmModal] onConfirm threw', err); }
  });

  return close;
}

// V76.7+ — Shared confirmation modal for deleting a deal card.
// Used by BOTH the kanban card's X button AND the modal's Delete button so
// the same destructive action shows the same warning, with consistent site
// styling (CSS variables, kb-editcols-overlay pattern, no native confirm()).
//
// V76.12b: deal-delete is deal-only. Property/parcel records and any
// property-scoped contacts, notes, or other associations are untouched.
// Wording reflects this so users who experienced the V76 bug aren't left
// guessing what gets removed.
//
// Calls removeFromPipeline(id) on confirm — which deletes the deal row plus
// its deal-scoped data (financials, deal contact links, deal notes, actions).
//
// Optional `closeOnConfirm` callback runs before deletion (used by the modal
// to dismiss itself before the card disappears mid-render).
function openDeleteCardConfirm(id, closeOnConfirm) {
  const entry = pipeline[id];
  const labelText = entry?.property?.address
    ? `${entry.property.address}${entry.property.suburb ? ', ' + entry.property.suburb : ''}`
    : `deal ${id}`;

  openConfirmModal({
    title:        'Delete this card?',
    subject:      labelText,
    bodyHtml:     'Are you sure you want to delete this card?<br><br>' +
                  'The property record and any associated contacts, notes ' +
                  'or other property-level data will not be affected.',
    confirmLabel: 'Delete',
    onConfirm: async () => {
      if (typeof closeOnConfirm === 'function') closeOnConfirm();
      await removeFromPipeline(id);
    },
  });
}

// Tiny HTML-escape used by the confirm modal — avoids dependency on the
// existing _escapeHtmlSafe (which lives in map.js, not always loaded first).
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// V75.6.2: confirm deletion of the current board. Server will reject if
// the board still has deals or the user lacks permission.
async function openDeleteBoardConfirm() {
  const b = boards.find(x => x.id === currentBoardId);
  if (!b) return;
  if (!confirm(`Delete board "${b.name}"?\n\nThis cannot be undone. The board will be removed along with its columns. Deals must be moved elsewhere first.`)) return;

  try {
    const r = await fetch(`/api/boards?id=${encodeURIComponent(b.id)}`, { method: 'DELETE' });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      if (r.status === 409 && err.deal_count) {
        alert(`Cannot delete "${b.name}" — it still has ${err.deal_count} deal${err.deal_count === 1 ? '' : 's'}. Move them to another board first.`);
      } else {
        alert(`Failed: ${err.error || r.status}`);
      }
      return;
    }
    // Switch to Acquisition (or first available)
    await loadBoards();
    const firstSys = boards.find(x => x.is_system) || boards[0];
    currentBoardId = firstSys ? firstSys.id : null;
    await loadUserDealOrder();
    const dict = await dbLoad();
    if (dict) {
      Object.keys(pipeline).forEach(k => delete pipeline[k]);
      Object.assign(pipeline, dict);
    }
    renderBoard();
    if (typeof window.refreshPipelinePins === 'function') window.refreshPipelinePins();
  } catch (err) {
    alert(`Network error: ${err.message}`);
  }
}

// V75.6.2: create new board modal — proper modal with name input and
// (for admins) a scope chooser (My Board vs System Board). New boards
// start with NO columns; user adds columns via "Edit Columns".
async function openNewBoardModal() {
  // Probe for admin status. Cached on `window` after first call.
  let adminProbe = window._pipelineIsAdmin;
  if (adminProbe === undefined) {
    try {
      const me = await fetch('/api/auth/me').then(r => r.ok ? r.json() : null);
      adminProbe = !!(me?.is_admin || me?.isAdmin);
    } catch (_) { adminProbe = false; }
    window._pipelineIsAdmin = adminProbe;
  }

  // Build modal
  const overlay = document.createElement('div');
  overlay.className = 'kb-editcols-overlay';
  overlay.innerHTML = `
    <div class="kb-editcols-modal" style="width:420px">
      <div class="kb-editcols-header">
        <div class="kb-editcols-title">New Board</div>
        <button class="kb-editcols-close" type="button">✕</button>
      </div>
      <div class="kb-editcols-body">
        <div style="display:flex;flex-direction:column;gap:14px">
          <div>
            <label style="display:block;font-size:12px;color:var(--text-secondary);margin-bottom:6px">Board Name</label>
            <input class="kb-input kb-new-board-name" type="text" placeholder="e.g. Off-market Leads" autofocus
              style="width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px;font-family:'DM Sans',sans-serif">
          </div>
          ${adminProbe ? `
            <div>
              <label style="display:block;font-size:12px;color:var(--text-secondary);margin-bottom:6px">Board Scope</label>
              <div style="display:flex;gap:8px">
                <label class="kb-scope-opt" style="flex:1;padding:10px 12px;border:2px solid var(--accent);border-radius:6px;cursor:pointer;background:rgba(30,167,101,0.06)">
                  <input type="radio" name="newBoardScope" value="user" checked style="margin-right:8px">
                  <span style="font-size:13px;font-weight:600">My Board</span>
                  <div style="font-size:11px;color:var(--text-secondary);margin-top:2px">Visible only to you</div>
                </label>
                <label class="kb-scope-opt" style="flex:1;padding:10px 12px;border:1px solid var(--border);border-radius:6px;cursor:pointer">
                  <input type="radio" name="newBoardScope" value="system" style="margin-right:8px">
                  <span style="font-size:13px;font-weight:600">System Board</span>
                  <div style="font-size:11px;color:var(--text-secondary);margin-top:2px">Visible to all users</div>
                </label>
              </div>
            </div>
          ` : ''}
          <div style="font-size:11px;color:var(--text-secondary);line-height:1.4">
            New boards start empty. Use <strong>⚙ Edit Columns</strong> after creation to add columns.
          </div>
        </div>
      </div>
      <div class="kb-editcols-footer">
        <button class="kb-editcols-cancel" type="button">Cancel</button>
        <button class="kb-editcols-save kb-new-board-submit" type="button">Create Board</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  // Hook up radio visual styling
  if (adminProbe) {
    overlay.querySelectorAll('input[name="newBoardScope"]').forEach(radio => {
      radio.addEventListener('change', () => {
        overlay.querySelectorAll('.kb-scope-opt').forEach(opt => {
          const isChecked = opt.querySelector('input').checked;
          opt.style.border  = isChecked ? '2px solid var(--accent)' : '1px solid var(--border)';
          opt.style.background = isChecked ? 'rgba(30,167,101,0.06)' : '';
        });
      });
    });
  }

  const nameInput = overlay.querySelector('.kb-new-board-name');
  setTimeout(() => nameInput.focus(), 50);

  const close = () => overlay.remove();
  overlay.querySelector('.kb-editcols-close').addEventListener('click', close);
  overlay.querySelector('.kb-editcols-cancel').addEventListener('click', close);

  const submit = async () => {
    const name = nameInput.value.trim();
    if (!name) { nameInput.focus(); return; }
    const scopeRadio = overlay.querySelector('input[name="newBoardScope"]:checked');
    const is_system  = adminProbe && scopeRadio && scopeRadio.value === 'system';
    try {
      const r = await fetch('/api/boards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, is_system }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        alert(`Failed: ${err.error || r.status}`);
        return;
      }
      const newBoard = await r.json();
      close();
      await loadBoards();
      currentBoardId = newBoard.id;
      await loadUserDealOrder();
      const dict = await dbLoad();
      if (dict) {
        Object.keys(pipeline).forEach(k => delete pipeline[k]);
        Object.assign(pipeline, dict);
      }
      renderBoard();
      if (typeof window.refreshPipelinePins === 'function') window.refreshPipelinePins();
    } catch (err) {
      alert(`Network error: ${err.message}`);
    }
  };

  overlay.querySelector('.kb-new-board-submit').addEventListener('click', submit);
  nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
}

// V75.6: edit-columns modal for the current board. Lets user add/remove
// columns and toggle show_on_map per column. On save, does a PUT to
// /api/boards which replaces the column set.
async function openEditColumnsModal() {
  const b = boards.find(x => x.id === currentBoardId);
  if (!b) return;

  // Read-only preview: fresh columns snapshot (mutable during the session)
  const cols = b.columns.map(c => ({
    id:           c.id,
    name:         c.name,
    stage_slug:   c.stage_slug,
    show_on_map:  c.show_on_map,
    is_terminal:  c.is_terminal,
    color:        c.color || '#95a5a6',
  }));

  // Build simple overlay HTML
  const overlay = document.createElement('div');
  overlay.className = 'kb-editcols-overlay';
  overlay.innerHTML = `
    <div class="kb-editcols-modal">
      <div class="kb-editcols-header">
        <div class="kb-editcols-title">Edit Columns — ${b.name}</div>
        <button class="kb-editcols-close">✕</button>
      </div>
      <div class="kb-editcols-body">
        <table class="kb-editcols-table">
          <thead>
            <tr>
              <th></th>
              <th>Name</th>
              <th title="Color dot">Color</th>
              <th title="Show on map">Map</th>
              <th title="Kanban terminal column (closes deal)">Kanban</th>
              <th></th>
            </tr>
          </thead>
          <tbody class="kb-editcols-rows"></tbody>
        </table>
        <button class="kb-toolbar-btn kb-editcols-add">+ Add Column</button>
      </div>
      <div class="kb-editcols-footer">
        <button class="kb-editcols-cancel">Cancel</button>
        <button class="kb-editcols-save kb-add-offer-btn">Save Changes</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const rowsEl = overlay.querySelector('.kb-editcols-rows');
  const renderRows = () => {
    rowsEl.innerHTML = '';
    cols.forEach((c, i) => {
      const tr = document.createElement('tr');
      tr.draggable = true;
      tr.dataset.idx = i;
      tr.innerHTML = `
        <td><span class="kb-editcols-drag" title="Drag to reorder">≡</span></td>
        <td><input class="kb-input kb-col-name" value="${(c.name || '').replace(/"/g,'&quot;')}" style="width:140px"></td>
        <td><input class="kb-col-color" type="color" value="${c.color}"></td>
        <td><input class="kb-col-showmap" type="checkbox" ${c.show_on_map ? 'checked' : ''}></td>
        <td><input class="kb-col-terminal" type="checkbox" ${c.is_terminal ? 'checked' : ''}></td>
        <td><button class="kb-col-del" title="Remove column">✕</button></td>`;
      tr.querySelector('.kb-col-name').addEventListener('input',  e => { cols[i].name = e.target.value; });
      tr.querySelector('.kb-col-color').addEventListener('input', e => { cols[i].color = e.target.value; });
      tr.querySelector('.kb-col-showmap').addEventListener('change', e => { cols[i].show_on_map = e.target.checked; });
      tr.querySelector('.kb-col-terminal').addEventListener('change', e => { cols[i].is_terminal = e.target.checked; });
      tr.querySelector('.kb-col-del').addEventListener('click', () => {
        cols.splice(i, 1);
        renderRows();
      });
      // Simple drag-reorder
      tr.addEventListener('dragstart', e => {
        e.dataTransfer.setData('text/plain', String(i));
      });
      tr.addEventListener('dragover', e => e.preventDefault());
      tr.addEventListener('drop', e => {
        e.preventDefault();
        const fromIdx = parseInt(e.dataTransfer.getData('text/plain'), 10);
        const toIdx   = parseInt(tr.dataset.idx, 10);
        if (isNaN(fromIdx) || isNaN(toIdx) || fromIdx === toIdx) return;
        const [moved] = cols.splice(fromIdx, 1);
        cols.splice(toIdx, 0, moved);
        renderRows();
      });
      rowsEl.appendChild(tr);
    });
  };
  renderRows();

  overlay.querySelector('.kb-editcols-add').addEventListener('click', () => {
    cols.push({
      id:          null,
      name:        'New Column',
      stage_slug:  null,
      show_on_map: true,
      is_terminal: false,
      color:       '#95a5a6',
    });
    renderRows();
  });
  overlay.querySelector('.kb-editcols-close').addEventListener('click',  () => overlay.remove());
  overlay.querySelector('.kb-editcols-cancel').addEventListener('click', () => overlay.remove());
  overlay.querySelector('.kb-editcols-save').addEventListener('click', async () => {
    // Assign sort_order from current order
    const payload = cols.map((c, idx) => ({
      ...c,
      sort_order: idx,
    }));
    try {
      const r = await fetch('/api/boards', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: b.id, columns: payload }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        alert(`Failed: ${err.error || r.status}${err.deals_in_removed_columns ? ` (${err.deals_in_removed_columns} deal(s) blocking)` : ''}`);
        return;
      }
      overlay.remove();
      await loadBoards();
      const dict = await dbLoad();
      if (dict) {
        Object.keys(pipeline).forEach(k => delete pipeline[k]);
        Object.assign(pipeline, dict);
      }
      renderBoard();
      if (typeof window.refreshPipelinePins === 'function') window.refreshPipelinePins();
    } catch (err) {
      alert(`Network error: ${err.message}`);
    }
  });
}

// ─── Notes (V75.3 — unified /api/notes backend) ──────────────────────────────
// Notes are no longer stored on the pipeline object; they live in the `notes`
// table accessed via /api/notes. Kept a tiny in-memory cache per deal id so
// repeated modal opens don't re-fetch. The cache is invalidated after any
// write.

const NOTES_API = '/api/notes';
const _notesCache = new Map();   // dealId → array of note rows (newest first)

async function fetchNotesForDeal(id) {
  if (_notesCache.has(id)) return _notesCache.get(id);
  try {
    const r = await fetch(`${NOTES_API}?entity_type=deal&entity_id=${encodeURIComponent(id)}`);
    if (!r.ok) throw new Error(r.status);
    const rows = await r.json();
    _notesCache.set(id, rows);
    return rows;
  } catch (err) {
    console.warn('[notes] fetchNotesForDeal failed:', err);
    return [];
  }
}

async function addNote(id, text, taggedContactId = null, interactionType = null, source = null) {
  if (!text.trim()) return null;
  try {
    const body = {
      entity_type:       'deal',
      entity_id:         String(id),
      note_text:         text.trim(),
      tagged_contact_id: taggedContactId || null,
    };
    if (interactionType) body.interaction_type = interactionType;
    if (source)          body.source           = source;
    const r = await fetch(NOTES_API, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
    if (!r.ok) throw new Error(r.status);
    _notesCache.delete(id);
    return await r.json();
  } catch (err) {
    console.error('[notes] addNote failed:', err);
    return null;
  }
}

async function deleteNote(id, noteId) {
  try {
    const r = await fetch(`${NOTES_API}?id=${encodeURIComponent(noteId)}`, { method: 'DELETE' });
    if (!r.ok) throw new Error(r.status);
    _notesCache.delete(id);
    return true;
  } catch (err) {
    console.error('[notes] deleteNote failed:', err);
    return false;
  }
}

// ─── Vendor Terms ────────────────────────────────────────────────────────────

function saveTerms(id, terms) {
  if (pipeline[id]) {
    pipeline[id].terms = terms;
    savePipeline(id);
  }
}

// ─── Price formatting ─────────────────────────────────────────────────────────
// Formats a price value for display on kanban cards/modals.
// Handles Domain API price objects, plain strings, and numbers.
// Falls back to termsPrice if listing price is unavailable.

function formatKbPrice(price, termsPrice) {
  // Format a single numeric value as whole dollars with $ + thousands separators.
  const fmtOne = (numStr) => {
    const num = parseFloat(numStr);
    return isNaN(num) ? null : '$' + Math.round(num).toLocaleString();
  };

  // Detect a price-range string like "$629,950 - $649,950" or "629950-649950"
  // or with en-dash/em-dash. Splits on the first dash that sits between digits,
  // not on minus signs in front of a single number. Returns [lo, hi] strings
  // of digits-and-decimal-only, or null if it's not a range.
  const splitRange = (s) => {
    const cleaned = String(s).replace(/[$,\s]/g, ''); // keep digits, dot, dashes
    const m = cleaned.match(/^(\d+(?:\.\d+)?)[-\u2013\u2014](\d+(?:\.\d+)?)$/);
    return m ? [m[1], m[2]] : null;
  };

  const fmt = v => {
    if (!v && v !== 0) return null;
    // Already a formatted string with $ — return as-is if it has digits
    if (typeof v === 'string' && /\d/.test(v)) {
      // V78h — Range detection. If the string is a two-number range
      // (e.g. "$629,950-649,950"), format each side and join with en-dash.
      // Otherwise strip non-numeric and reformat as a single value.
      const range = splitRange(v);
      if (range) {
        const lo = fmtOne(range[0]);
        const hi = fmtOne(range[1]);
        if (lo && hi) return lo + ' – ' + hi;
      }
      const num = parseFloat(v.replace(/[^0-9.]/g, ''));
      return isNaN(num) ? v : '$' + Math.round(num).toLocaleString();
    }
    if (typeof v === 'number') return '$' + Math.round(v).toLocaleString();
    if (typeof v === 'object') {
      // Domain API price object { display, from, to }
      const { display, from, to } = v;
      const hasNum = display && /\d/.test(display);
      if (hasNum) {
        const range = splitRange(display);
        if (range) {
          const lo = fmtOne(range[0]);
          const hi = fmtOne(range[1]);
          if (lo && hi) return lo + ' – ' + hi;
        }
        const num = parseFloat(display.replace(/[^0-9.]/g, ''));
        return isNaN(num) ? display : '$' + Math.round(num).toLocaleString();
      }
      if (from && to) return '$' + Math.round(from).toLocaleString() + ' – $' + Math.round(to).toLocaleString();
      if (from) return '$' + Math.round(from).toLocaleString();
      if (to)   return '$' + Math.round(to).toLocaleString();
    }
    return null;
  };

  // Helper: does a value contain a real (non-zero) price?
  const hasRealPrice = v => {
    if (v === null || v === undefined || v === '') return false;
    if (typeof v === 'number') return v > 0;
    if (typeof v === 'string') {
      const num = parseFloat(v.replace(/[^0-9.]/g, ''));
      return !isNaN(num) && num > 0;
    }
    if (typeof v === 'object') {
      const { display, from, to } = v;
      if (display && /\d/.test(display)) return true;
      if ((from && from > 0) || (to && to > 0)) return true;
    }
    return false;
  };

  // Vendor terms price wins when it's been recorded — it's the agreed deal price.
  // Fall back to listing price otherwise.
  if (hasRealPrice(termsPrice)) {
    const terms = fmt(termsPrice);
    if (terms) return terms + ' <span style="font-size:10px;opacity:0.7">(vendor terms)</span>';
  }

  const listed = fmt(price);
  if (listed && listed !== 'Price Unavailable') return listed;

  return 'Price Unavailable';
}

// V77.1 — Lease-aware rent formatter for Lease Listing cards/modals.
// Reads from data.terms.rent_amount + terms.rent_period (set in Lease Terms section).
// Returns "$650/wk" or "$2,800/month" or 'Rent not set' as the fallback.
function formatKbRent(terms) {
  const t = terms || {};
  const amt = t.rent_amount;
  if (amt == null || amt === '') return 'Rent not set';
  const num = typeof amt === 'number' ? amt : parseFloat(String(amt).replace(/[^0-9.]/g, ''));
  if (isNaN(num) || num <= 0) return 'Rent not set';
  const period = t.rent_period === 'monthly' ? '/month' : '/wk';
  return '$' + Math.round(num).toLocaleString('en-AU') + period;
}

// Formats a raw input price (from terms/offer fields) as whole dollars
function formatInputPrice(val) {
  if (val === null || val === undefined || val === '') return '';
  const num = parseFloat(String(val).replace(/[^0-9.]/g, ''));
  return isNaN(num) || num === 0 ? '' : '$' + Math.round(num).toLocaleString();
}

// Converts settlement entry (days, months or years) to days
// e.g. "3 months" → "90 days", "2 years" → "730 days", "42" → "42 days", "42 days" → "42 days"
function formatSettlement(val) {
  if (!val) return '';
  const s = val.trim().toLowerCase();
  const match = s.match(/^(\d+(?:\.\d+)?)\s*(d|day|days|m|mo|month|months|y|yr|year|years)?$/);
  if (!match) return val; // unrecognised — leave as-is
  const num  = parseFloat(match[1]);
  const unit = match[2] || 'd';
  let days;
  if (/^y/.test(unit))      days = Math.round(num * 365);
  else if (/^m/.test(unit)) days = Math.round(num * 30);
  else                       days = Math.round(num);
  return days + ' days';
}

// Format a deposit amount — accepts "$50,000", "50000", or "5%"
// Stores and displays as "$50,000 (5%)" when price is known
// Price is read from pipeline terms.price or property price for % calculation
// Parse any deposit input (string or number) to a plain number
function parseDepositAmountKanban(val, price) {
  if (val === null || val === undefined || val === '') return 0;
  if (typeof val === 'number') return Math.round(val);
  const s = String(val).trim();
  // Already formatted "$50,000 (5%)" — extract dollar amount before the parenthesis
  if (s.includes('$')) {
    const dollarPart = s.split('(')[0]; // take only "$50,000 " before "(5%)"
    const n = parseFloat(dollarPart.replace(/[^0-9.]/g, ''));
    return isNaN(n) ? 0 : Math.round(n);
  }
  // Pure percentage e.g. "5%"
  if (s.includes('%')) {
    const pct = parseFloat(s) / 100;
    return isNaN(pct) ? 0 : Math.round((price || 0) * pct);
  }
  // Plain number
  const n = parseFloat(s.replace(/[^0-9.]/g, ''));
  return isNaN(n) ? 0 : Math.round(n);
}

// Format a stored numeric deposit amount for display
function formatDepositAmount(numOrStr, price) {
  const num = parseDepositAmountKanban(numOrStr, price);
  if (!num) return '';
  const dollars = '$' + num.toLocaleString();
  if (price && price > 0) {
    const pct = ((num / price) * 100).toFixed(2).replace(/\.?0+$/, '');
    return dollars + ' (' + pct + '%)';
  }
  return dollars;
}



// Parse a settlement string to a plain integer number of days for storage.
// e.g. "90 days" -> 90, "3 months" -> 90, "1 year" -> 365, "90" -> 90
function parseSettlementDays(val) {
  if (!val && val !== 0) return 0;
  if (typeof val === 'number') return Math.round(val);
  const s = String(val).trim().toLowerCase();
  const match = s.match(/^(\d+(?:\.\d+)?)\s*(d|day|days|m|mo|month|months|y|yr|year|years)?/);
  if (!match) return 0;
  const num  = parseFloat(match[1]);
  const unit = match[2] || 'd';
  if (/^y/.test(unit)) return Math.round(num * 365);
  if (/^m/.test(unit)) return Math.round(num * 30);
  return Math.round(num);
}

// Format due — same logic as settlement, converts to days
// Due = days since previous deposit (or since contract for first tranche)
function formatDepositDue(val) {
  return formatSettlement(val); // reuse same logic — normalises to "X days"
}

// V77.1: Lease term parser — accepts "12 months", "1 year", "6m", "2y" etc.
// Returns integer number of months, or null if unparseable / empty.
function parseLeaseTermMonths(val) {
  if (val == null || val === '') return null;
  if (typeof val === 'number') return Math.round(val);
  const s = String(val).trim().toLowerCase();
  if (!s) return null;
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(m|mo|month|months|y|yr|year|years)?/);
  if (!m) return null;
  const num  = parseFloat(m[1]);
  const unit = m[2] || 'months';
  if (/^y/.test(unit)) return Math.round(num * 12);
  return Math.round(num);
}

function getTerms(id) {
  const t = pipeline[id]?.terms || {};
  if (!Array.isArray(t.deposits) || t.deposits.length === 0) {
    t.deposits = [{ amount: '', due: '', note: '' }];
  }
  return { price: '', settlement: '', ...t };
}

function addDeposit(id) {
  const terms = getTerms(id);
  terms.deposits.push({ amount: '', due: '', note: '' });
  saveTerms(id, terms);
}

function removeDeposit(id, idx) {
  const terms = getTerms(id);
  terms.deposits.splice(idx, 1);
  if (terms.deposits.length === 0) terms.deposits.push({ amount: '', due: '', note: '' });
  saveTerms(id, terms);
}

// ─── Offers ───────────────────────────────────────────────────────────────────

function getOffers(id) {
  return pipeline[id]?.offers || [];
}

function addOffer(id, offer) {
  if (!pipeline[id]) return;
  if (!pipeline[id].offers) pipeline[id].offers = [];
  pipeline[id].offers.unshift({ // newest first
    ...offer,
    date: new Date().toISOString(),
    id:   Date.now(),
  });
  savePipeline(id);
}

function deleteOffer(propertyId, offerId) {
  if (!pipeline[propertyId]) return;
  pipeline[propertyId].offers = (pipeline[propertyId].offers || []).filter(o => String(o.id) !== String(offerId));
  savePipeline(propertyId);
}

function formatOfferDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// ─── Due Diligence ────────────────────────────────────────────────────────────

const DD_ITEMS = [
  'Zoning','Yield','Access','Wastewater','Water','Easements','Electricity',
  'Flooding','Riparian','Vegetation','Contamination','Salinity',
  'Heritage','Aboriginal','Bushfire','Odor','Commercial'
];

const DD_RISK_OPTIONS = [
  { value: '',         label: '— Risk' },
  { value: 'low',      label: 'Low' },
  { value: 'possible', label: 'Possible' },
  { value: 'high',     label: 'High' },
];

function getDd(id) {
  return pipeline[id]?.dd || {};
}

// Refresh the DD rows in an open modal after async risk results arrive
function refreshModalDd(id) {
  const modal = document.getElementById('kb-modal');
  console.log('[DD] refreshModalDd — modal:', !!modal, 'modal id:', modal?.dataset?.propertyId, 'target id:', String(id));
  if (!modal || modal.dataset.propertyId !== String(id)) return;
  const dd = getDd(id);
  console.log('[DD] refreshModalDd — dd object:', dd);
  modal.querySelectorAll('.kb-dd-row').forEach(row => {
    const key    = row.dataset.key;
    const status = dd[key]?.status || '';
    const note   = dd[key]?.note   || '';
    const sel    = row.querySelector('.kb-dd-select');
    const inp    = row.querySelector('.kb-dd-note');
    if (sel && !sel.value) {
      sel.value     = status;
      sel.className = `kb-dd-select dd-risk-${status || 'none'}`;
    }
    if (inp && !inp.value) inp.value = note;
  });
}

function saveDd(id, dd) {
  if (pipeline[id]) {
    pipeline[id].dd = dd;
    savePipeline(id);
  }
}

// ─── Listing sidebar — add buttons ───────────────────────────────────────────
// Called by map.js after renderListings() to inject ⊕ buttons

function updateAddButtons() {
  document.querySelectorAll('.listing-card').forEach(card => {
    const id = String(card.dataset.id);
    let btn = card.querySelector('.pipeline-add-btn');

    if (!btn) {
      btn = document.createElement('button');
      btn.className = 'pipeline-add-btn';
      btn.title = 'Add to pipeline';
      card.appendChild(btn);
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const listing = listings.find(l => String(l.id) === id);
        if (listing) addToPipeline(listing);
      });
    }

    // V76.5: card.dataset.id is the listing's Domain id. Look up by domain_id
    // instead of pipeline[id], because deal ids no longer match listing ids.
    const inPipeline = !!findPipelineByDomainId(id);
    btn.textContent = inPipeline ? '✓' : '+';
    btn.classList.toggle('in-pipeline', inPipeline);
    btn.title = inPipeline ? 'In pipeline' : 'Add to pipeline';
  });
}

// ─── Board render ─────────────────────────────────────────────────────────────

// V77.1 — Card renderers split by board type (renderBoard delegates).

function renderStandardCard(card, id, item, p, stages, boardId) {
  // Compact summary indicators
  const terms    = getTerms(id);
  const offers   = getOffers(id);
  const dd       = getDd(id);
  const ddCount  = DD_ITEMS.filter(i => dd[i.toLowerCase()]?.status).length;
  const ddHigh   = DD_ITEMS.some(i => dd[i.toLowerCase()]?.status === 'high');
  const ddPoss   = DD_ITEMS.some(i => dd[i.toLowerCase()]?.status === 'possible');
  const ddClass  = ddCount === 0 ? '' : ddHigh ? 'dd-high' : ddPoss ? 'dd-possible' : 'dd-low';
  // V80.3 — Terms badge removed (no longer surfaced on cards).

  const stageOptions = stages.map(s =>
    `<option value="${s.id}" ${s.id === (item._columnId || stageToColumnId(item.stage)) ? 'selected' : ''}>${s.label}</option>`
  ).join('');

  // V77.1: Lease Listings show rent (per-week / per-month) in the headline,
  // not "Price Unavailable" from the sales price field. Other boards keep
  // the standard formatKbPrice behaviour.
  const isLeaseListing = (boardId || item._boardId || currentBoardId) === 'sys_lease_listings';
  const headline = isLeaseListing ? formatKbRent(terms) : formatKbPrice(p.price, terms.price);

  // V80.2 — Interest level badge: shown on every card type now (was Enquiry-only).
  // Format: "{MoSCoW} {score}" — e.g. "Wont 5", "Could 35", "Should 60", "Must 90".
  const interestLevel = (item.data?.interest_level != null)
    ? Math.max(0, Math.min(100, parseInt(item.data.interest_level, 10) || 0))
    : null;
  const interestBadgeHtml = (interestLevel != null)
    ? `<span class="kb-ind kb-ind-interest kb-ind-interest-${moscowBand(interestLevel)}" title="Interest level (0–100)">${moscowLabel(interestLevel)} ${interestLevel}</span>`
    : '';

  card.innerHTML = `
    <div class="kb-card-top">
      <span class="kb-card-type">${p.type || ''}</span>
      <button class="kb-remove" title="Remove from pipeline">✕</button>
    </div>
    <div class="kb-card-price">${headline}</div>
    <div class="kb-card-address kb-card-address-link" title="Show on map">📍 ${p.address || ''}</div>
    <div class="kb-card-suburb">${p.suburb || ''}${p.state ? ' ' + p.state : ''}</div>
    <select class="kb-stage-select">${stageOptions}</select>
    <div class="kb-card-indicators">
      ${interestBadgeHtml}
      ${offers.length ? `<span class="kb-ind kb-ind-offers" title="${offers.length} offer(s)">${offers.length} Offer${offers.length > 1 ? 's' : ''}</span>` : ''}
      ${ddCount    ? `<span class="kb-ind kb-ind-dd ${ddClass}" title="${ddCount} DD items assessed">DD ${ddCount}/${DD_ITEMS.length}</span>` : ''}
      ${(Array.isArray(item.note) ? item.note.length : item.note) ? `<span class="kb-ind kb-ind-note" title="Has notes">Note</span>` : ''}
      ${item._dueActionCount > 0 ? `<span class="kb-ind kb-ind-action-due" title="${item._dueActionCount} action${item._dueActionCount === 1 ? '' : 's'} due or reminder due">🔔 ${item._dueActionCount}</span>` : ''}
    </div>
  `;
}

// V80.2 — MoSCoW band helpers. Thresholds match the slider's label positions
// in the deal modal (labels at 0%, 25%, 50%, 75% of the track):
//   0-24   → Won't  (low/no priority)
//   25-49  → Could  (nice to have)
//   50-74  → Should (important)
//   75-100 → Must   (critical — and the 75-100 range gives a Must spectrum)
// Used by both renderEnquiryCard and the non-Enquiry card render above.
function moscowLabel(n) {
  if (n >= 75) return 'Must';
  if (n >= 50) return 'Should';
  if (n >= 25) return 'Could';
  return 'Wont';
}
function moscowBand(n) {
  if (n >= 75) return 'must';
  if (n >= 50) return 'should';
  if (n >= 25) return 'could';
  return 'wont';
}


function renderEnquiryCard(card, id, item, p, stages, boardId) {
  // V77.1 — Enquiry card layout. No "type/price headline" gold writing — we
  // show contact name instead. No Land/beds/baths badges. Interest level is
  // shown as a small numeric badge (the slider lives in the deal modal,
  // above Status). Other badges (Offer, Evidenced, Latest Offer Price for
  // Lease; Inspected, Contract Requested, Latest Offer Price for Sales) come
  // from item._enquiryMeta (filled async — see enrichEnquiryCardsAsync()).
  const interestLevel = (item.data?.interest_level != null)
    ? Math.max(0, Math.min(100, parseInt(item.data.interest_level, 10) || 0))
    : null;

  const meta = item._enquiryMeta || {};
  const isLease = boardId === 'sys_lease_enquiry';
  const contactName = meta.contact_name || '<span style="color:var(--muted);font-style:italic">Loading…</span>';

  const stageOptions = stages.map(s =>
    `<option value="${s.id}" ${s.id === (item._columnId || stageToColumnId(item.stage)) ? 'selected' : ''}>${s.label}</option>`
  ).join('');

  // Build the per-board badge set
  const badges = [];
  if (isLease) {
    if (meta.has_submitted_offer) badges.push(`<span class="kb-ind kb-ind-enq kb-ind-offer-submitted" title="Lease offer submitted">Offer</span>`);
    if (meta.has_evidence)        badges.push(`<span class="kb-ind kb-ind-enq kb-ind-evidence" title="Evidence submitted">Evidenced</span>`);
    if (meta.latest_rent != null) badges.push(`<span class="kb-ind kb-ind-enq kb-ind-rent" title="Latest offer price">$${Math.round(meta.latest_rent).toLocaleString('en-AU')}/wk</span>`);
  } else {
    // Sales Enquiry
    if (meta.has_inspection_attended) badges.push(`<span class="kb-ind kb-ind-enq kb-ind-inspected" title="Inspection attended">Inspected</span>`);
    if (meta.has_contract_requested)  badges.push(`<span class="kb-ind kb-ind-enq kb-ind-contract"  title="Contract requested">Contract</span>`);
    if (meta.latest_rent != null)     badges.push(`<span class="kb-ind kb-ind-enq kb-ind-rent" title="Latest offer price">$${Math.round(meta.latest_rent).toLocaleString('en-AU')}</span>`);
  }
  // V80.2 — Interest level badge — only when set. Format: "{MoSCoW} {score}".
  if (interestLevel != null) {
    badges.push(`<span class="kb-ind kb-ind-enq kb-ind-interest kb-ind-interest-${moscowBand(interestLevel)}" title="Interest level (0–100)">${moscowLabel(interestLevel)} ${interestLevel}</span>`);
  }
  // Common across both Enquiry types
  if (item._dueActionCount > 0) {
    badges.push(`<span class="kb-ind kb-ind-action-due" title="${item._dueActionCount} action${item._dueActionCount === 1 ? '' : 's'} due">🔔 ${item._dueActionCount}</span>`);
  }

  card.innerHTML = `
    <div class="kb-card-top">
      <span class="kb-card-type">${isLease ? 'Lease Enquiry' : 'Sales Enquiry'}</span>
      <button class="kb-remove" title="Remove from pipeline">✕</button>
    </div>
    <div class="kb-card-price">${contactName}</div>
    <div class="kb-card-address kb-card-address-link" title="Show on map">📍 ${p.address || ''}</div>
    <div class="kb-card-suburb">${p.suburb || ''}${p.state ? ' ' + p.state : ''}</div>
    <select class="kb-stage-select">${stageOptions}</select>
    <div class="kb-card-indicators">${badges.join('')}</div>
  `;
}

// Persist interest_level for an Enquiry deal — sets data.interest_level via the
// standard pipeline save. Called from the deal-modal slider.
async function saveInterestLevel(dealId, level) {
  if (!pipeline[dealId]) return;
  if (!pipeline[dealId].data) pipeline[dealId].data = {};
  pipeline[dealId].data.interest_level = level;
  savePipeline(dealId);
  // Refresh the kanban card badge in place if board is visible
  refreshCardLive(dealId);
}

// V77.1 — Enrich Enquiry cards with metadata fetched from server.
// Called after renderBoard() completes for Sales/Lease Enquiry boards.
async function enrichEnquiryCardsAsync() {
  const boardForCheck = currentBoardId;
  if (boardForCheck !== 'sys_sales_enquiry' && boardForCheck !== 'sys_lease_enquiry') return;
  const dealIds = Object.keys(pipeline).filter(id => {
    const item = pipeline[id];
    return (item._boardId || currentBoardId) === boardForCheck;
  });
  if (!dealIds.length) return;

  try {
    const r = await fetch(`/api/enquiry-card-meta?deal_ids=${encodeURIComponent(dealIds.join(','))}`);
    if (!r.ok) return;
    const metaMap = await r.json();
    Object.entries(metaMap).forEach(([dealId, meta]) => {
      if (pipeline[dealId]) pipeline[dealId]._enquiryMeta = meta;
    });
    // Re-render only the cards that got enriched
    Object.keys(metaMap).forEach(dealId => {
      const cardEl = document.querySelector(`.kb-card[data-id="${CSS.escape(dealId)}"]`);
      if (!cardEl) return;
      const item = pipeline[dealId];
      const p = item?.property;
      if (!p) return;
      const stages = resolveCurrentStages();
      // Re-render in place, then re-attach handlers (they were attached after innerHTML last render)
      renderEnquiryCard(cardEl, dealId, item, p, stages, item._boardId || currentBoardId);
      // Re-attach handlers for the re-rendered card body. Drag handlers were attached on
      // the card root (still valid). The buttons / dropdowns inside were replaced — re-wire.
      _wireCardInnerHandlers(cardEl, dealId);
    });
  } catch (err) {
    console.warn('[kanban] enrichEnquiryCardsAsync failed:', err);
  }
}

// Helper to re-wire kb-card inner handlers after a rebuild of innerHTML.
// Mirrors the wiring done in the main entries.forEach loop in renderBoard.
function _wireCardInnerHandlers(card, id) {
  const stageSel = card.querySelector('.kb-stage-select');
  if (stageSel) {
    stageSel.addEventListener('change', function (e) {
      e.stopPropagation();
      moveToColumn(id, this.value);
      renderBoard();
    });
  }
  const removeBtn = card.querySelector('.kb-remove');
  if (removeBtn) {
    removeBtn.addEventListener('click', e => {
      e.stopPropagation();
      openDeleteCardConfirm(id);
    });
  }
  const addrLink = card.querySelector('.kb-card-address-link');
  if (addrLink) {
    addrLink.addEventListener('click', e => {
      e.stopPropagation();
      // Just open the deal modal for this card — clicking address on Enquiry
      // doesn't navigate to map, since Enquiry's address is the listing's address.
      // Use the standard deal-open path.
      if (typeof window.openPipelineItem === 'function') window.openPipelineItem(id);
    });
  }
}

function renderBoard() {
  const board = document.getElementById('kanbanBoard');
  board.innerHTML = '';

  // V75.6: render the board-selector UI bar above the columns
  _renderBoardSelectorBar();

  // V75.7: if the active board is an action board, delegate to the actions
  // renderer. Keeps the deal-board render path below untouched.
  const activeBoard = boards.find(b => b.id === currentBoardId);
  if (activeBoard?.board_type === 'action') {
    return renderActionsBoard(activeBoard);
  }

  // V75.6: dynamic stages from currently-selected board
  const stages = resolveCurrentStages();

  stages.forEach(stage => {
    // Match pipeline entries to this column. Primary match: entry._columnId === stage.id.
    // Secondary (legacy/fallback): entry.stage === stage.stage_slug (for entries
    // that don't yet have _columnId populated).
    // V76.7+ — also filter by active search query.
    const entries = Object.entries(pipeline).filter(([id, v]) => {
      const inColumn = v._columnId ? v._columnId === stage.id : v.stage === stage.stage_slug;
      if (!inColumn) return false;
      return _searchMatches(id, v);
    });

    // V80.4 — Sort by user-selected mode (default: interest level high→low).
    // Replaces the legacy "manual drag-to-reorder" model: drag now only
    // moves cards between columns, not within. This keeps card order
    // deterministic and consistent across viewers.
    const sortMode = getKanbanSortMode();
    entries.sort(buildKanbanComparator(sortMode, DD_ITEMS));

    const col = document.createElement('div');
    col.className = 'kb-col';
    col.dataset.stage = stage.id;
    col.dataset.columnId = stage.id;

    col.innerHTML = `
      <div class="kb-col-header">
        <span class="kb-stage-dot" style="background:${stage.color}"></span>
        <span class="kb-stage-label">${stage.label}</span>
        <span class="kb-count">${entries.length}</span>
      </div>
      <div class="kb-cards" data-stage="${stage.id}" data-column-id="${stage.id}"></div>
    `;

    const cardsEl = col.querySelector('.kb-cards');

    entries.forEach(([id, item]) => {
      const p = item.property;
      if (!p) return; // skip malformed entries
      const card = document.createElement('div');
      card.className = 'kb-card';
      // V76.4.3: red attention bar when the deal has at least one OVERDUE
      // action — same rule as the action card's _isOverdue (status active,
      // due_date today-or-earlier). Reminder-due alone doesn't trigger
      // the bar; it only contributes to the bell count.
      if (item._hasOverdueAction) card.classList.add('kb-card-attention');
      card.draggable = true;
      card.dataset.id = id;

      // V77.1 — branch by board type:
      //   - Enquiry boards (sys_sales_enquiry, sys_lease_enquiry): contact-name
      //     headline, no Land/beds/baths badges, Enquiry-specific badges + Interest
      //     Level. Meta enriched async via /api/enquiry-card-meta.
      //   - All other boards: legacy card layout.
      const boardForCard = item._boardId || currentBoardId;
      const isEnquiryBoard = boardForCard === 'sys_sales_enquiry' || boardForCard === 'sys_lease_enquiry';

      if (isEnquiryBoard) {
        renderEnquiryCard(card, id, item, p, stages, boardForCard);
      } else {
        renderStandardCard(card, id, item, p, stages, boardForCard);
      }

      // Drag
      card.addEventListener('dragstart', e => {
        e.dataTransfer.setData('text/plain', id);
        e.dataTransfer.effectAllowed = 'move';
        card.classList.add('dragging');
      });
      card.addEventListener('dragend', () => card.classList.remove('dragging'));

      // Stage select change — argument is the TARGET column id in the current board
      card.querySelector('.kb-stage-select').addEventListener('change', function (e) {
        e.stopPropagation();
        moveToColumn(id, this.value);
        renderBoard();
      });

      // Remove card
      card.querySelector('.kb-remove').addEventListener('click', e => {
        e.stopPropagation();
        // V76.7+ — uses the shared openDeleteCardConfirm modal so the X button
        // and the modal's Delete button show the same consistent warning.
        openDeleteCardConfirm(id);
      });

      // Address — show on map
      card.querySelector('.kb-card-address-link').addEventListener('click', e => {
        e.stopPropagation();
        // V75.5.6: route through Router so body[data-route] updates to 'mapping'
        // and the Leaflet controls reappear (they're hidden by CSS when on any
        // non-mapping route). Fallback to direct toggle if router unavailable.
        if (window.Router?.navigate) {
          window.Router.navigate('/');
        } else {
          toggleKanban(false);
        }
        const parcels = (p._parcels && p._parcels.length > 0 && p._parcels[0].lat)
          ? p._parcels
          : (p.lat && p.lng ? [{ lat: p.lat, lng: p.lng, label: `${p.address}, ${p.suburb}` }] : null);
        if (parcels && typeof window.reSelectParcels === 'function') {
          setTimeout(() => window.reSelectParcels(parcels), 150);
        }
      });

      // Click card body → open detail modal
      card.addEventListener('click', e => {
        if (e.target.closest('.kb-remove, .kb-stage-select, .kb-card-address-link')) return;
        openCardModal(id);
      });

      cardsEl.appendChild(card);
    });

    // Drop zone — V75.6: also supports intra-column reordering
    // V76.9: visible insertion-line indicator + optimistic UI. The indicator
    // (`.kb-drop-indicator`) is a thin accent-coloured line that moves with
    // the cursor to show exactly where the card will land. The drop itself
    // updates in-memory state and DOM immediately, then persists in the
    // background — no waiting for the network round-trip before the card
    // settles into place.
    let _dropIndicator = null;
    function ensureDropIndicator() {
      if (_dropIndicator && _dropIndicator.parentNode === cardsEl) return _dropIndicator;
      _dropIndicator = document.createElement('div');
      _dropIndicator.className = 'kb-drop-indicator';
      return _dropIndicator;
    }
    // computeInsertIndex also returns the reference card so we can splice the
    // indicator into the DOM at the right location without recomputing.
    function computeInsertSpec(e) {
      const cards = [...cardsEl.querySelectorAll('.kb-card:not(.dragging)')];
      for (let i = 0; i < cards.length; i++) {
        const rect = cards[i].getBoundingClientRect();
        if (e.clientY < rect.top + rect.height / 2) return { idx: i, before: cards[i] };
      }
      return { idx: cards.length, before: null };
    }
    cardsEl.addEventListener('dragover', e => {
      e.preventDefault();
      cardsEl.classList.add('drag-over');
      const { idx, before } = computeInsertSpec(e);
      cardsEl.dataset.dropIdx = String(idx);
      const indicator = ensureDropIndicator();
      // Position indicator at the right insertion point
      if (before) cardsEl.insertBefore(indicator, before);
      else        cardsEl.appendChild(indicator);
    });
    cardsEl.addEventListener('dragleave', e => {
      // Only clear if we're really leaving the column, not just hovering over
      // a child element. relatedTarget is the element being entered.
      if (e.relatedTarget && cardsEl.contains(e.relatedTarget)) return;
      cardsEl.classList.remove('drag-over');
      if (_dropIndicator?.parentNode) _dropIndicator.remove();
    });
    cardsEl.addEventListener('drop', e => {
      e.preventDefault();
      cardsEl.classList.remove('drag-over');
      if (_dropIndicator?.parentNode) _dropIndicator.remove();

      const id = e.dataTransfer.getData('text/plain');
      if (!id || !pipeline[id]) return;

      const targetColumnId = stage.id;
      const sameColumn = (pipeline[id]._columnId || stageToColumnId(pipeline[id].stage)) === targetColumnId;

      // V80.4 — Drop is now COLUMN-ONLY: drag-to-reorder within the same
      // column has been removed (per Q6=b). The auto-sort (interest/created/
      // actions_due/dd_risk) decides ordering within columns. A drop on the
      // same column is silently ignored.
      if (sameColumn) return;

      // Cross-column: change the deal's column. moveToColumn handles
      // pipeline mutation + background persistence. The next renderBoard
      // (driven by the optimistic DOM update below) will place the card in
      // the right spot under the active sort mode.
      moveToColumn(id, targetColumnId);

      // Optimistic DOM update — append the dragged card to the new column.
      // Its precise position will be corrected on next renderBoard.
      const draggedCard = document.querySelector(`.kb-card[data-id="${id}"]`);
      if (draggedCard) {
        cardsEl.appendChild(draggedCard);
        refreshCardLive(id);
      }
      _updateColumnCounts();
    });

    board.appendChild(col);
  });

  // V77.1 — async enrichment for Enquiry boards (contact name + offer/inspection meta)
  if (currentBoardId === 'sys_sales_enquiry' || currentBoardId === 'sys_lease_enquiry') {
    enrichEnquiryCardsAsync();
  }

  // V78 — Mobile shell: switch to single-column picker on narrow viewports.
  // The mobile-shell module re-applies the active-column class + injects the
  // picker dropdown. No-op on desktop / tablet.
  // Sync the small set of state mobile-shell needs onto window so it can read
  // them without depending on module-internal scope.
  window.currentBoardId = currentBoardId;
  window.pipeline       = pipeline;
  window.openCardModal  = openCardModal;
  window.renderBoard    = renderBoard;
  if (window.MobileShell) {
    if (typeof window.MobileShell.applyKanbanMobileLayout === 'function') {
      window.MobileShell.applyKanbanMobileLayout();
    }
  }
}

// ─── V75.7: Actions module ────────────────────────────────────────────────────
//
// Actions are tasks assigned to Contacts, optionally linked to a Deal.
// They live on their own kanban wall ("My Actions") with fixed default
// columns (ToDo / WIP / Due / Done / Void). The server auto-promotes
// todo/wip rows whose due_date is today-or-past to 'due' on every GET.
//
// The render path here mirrors renderBoard() but operates on the `actions`
// array fetched from /api/actions?assignee=me, not the `pipeline` dict.

const ACTIONS_API = '/api/actions';
let _actionsCache = [];           // Most-recent action rows (for current user)
let _actionsContactCache = null;  // [{id, name, email}] — lazy-loaded for picker
// V76.9: cache the most recent (board, actions) pair so renderActionsBoard
// can paint from cache before the fresh fetch returns (stale-while-revalidate).
let _actionsBoardCache = null;

async function fetchMyActions() {
  try {
    const res = await fetch(`${ACTIONS_API}?assignee=me`);
    if (!res.ok) return { board: null, actions: [] };
    return await res.json();
  } catch (err) {
    console.warn('[actions] fetch failed:', err.message);
    return { board: null, actions: [] };
  }
}

async function fetchActionsForDeal(dealId) {
  try {
    const res = await fetch(`${ACTIONS_API}?deal_id=${encodeURIComponent(dealId)}`);
    if (!res.ok) return [];
    return await res.json();
  } catch (_) { return []; }
}

async function fetchContactsForAssignee() {
  if (_actionsContactCache) return _actionsContactCache;
  try {
    const res = await fetch('/api/contacts');
    if (!res.ok) return [];
    const rows = await res.json();
    _actionsContactCache = rows.map(c => ({
      id:    c.id,
      name:  `${c.first_name || ''} ${c.last_name || ''}`.trim(),
      email: c.email || '',
    }));
    return _actionsContactCache;
  } catch (_) { return []; }
}

// V76.2.1: effort/duration are stored as integer days. Format like
// `formatSettlement()` does for settlement ("90 days"). Accepts the stored
// integer directly.
function _formatDaysShort(days) {
  if (days == null || days === '') return '—';
  const n = Number(days);
  if (Number.isNaN(n) || n <= 0) return '—';
  return `${n} day${n === 1 ? '' : 's'}`;
}

function _formatDateShort(iso) {
  if (!iso) return '';
  // iso can be 'YYYY-MM-DD' or full ISO timestamp — slice first 10 chars
  const s = String(iso).slice(0, 10);
  const [y, m, d] = s.split('-');
  if (!y || !m || !d) return s;
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${parseInt(d, 10)} ${months[parseInt(m, 10) - 1]} ${y}`;
}

function _isOverdue(action) {
  if (!action.due_date) return false;
  if (!['todo','wip','due'].includes(action.status)) return false;
  const today = new Date(); today.setHours(0,0,0,0);
  const due = new Date(action.due_date);
  return due.getTime() <= today.getTime();
}

/**
 * Render the Actions kanban — called by renderBoard() when the active
 * board is an action board. Fetches data async; renders skeleton first,
 * then replaces with real cards.
 */
// V76.9: Build a single action card DOM element. Extracted from
// renderActionsBoard so that single-card refreshes (`refreshActionCardLive`)
// can rebuild one card without touching the rest of the board.
function _buildActionCard(a) {
  const card = document.createElement('div');
  card.className = 'kb-card kb-action-card';
  if (_isOverdue(a)) card.classList.add('kb-card-attention');
  card.draggable = true;
  card.dataset.id = a.id;

  // V80 — show ALL assignees, not just the first. Multiple agents may be
  // assigned to the same Action; everyone sees the same row, drag-by-anyone
  // changes the shared status, individual reorders within column are private.
  const assignees = Array.isArray(a.assignees) && a.assignees.length
    ? a.assignees.map(x => x.name).filter(Boolean)
    : [a.assignee?.name].filter(Boolean);
  const assigneeText = assignees.length ? assignees.join(', ') : 'Unassigned';
  const dealLabel = a.deal?.label ? `🔗 ${a.deal.label}` : '';
  const dueLabel  = a.due_date ? `📅 ${_formatDateShort(a.due_date)}` : '';
  const remLabel  = a.reminder_date ? `⏰ ${_formatDateShort(a.reminder_date)}` : '';

  card.innerHTML = `
    <div class="kb-action-desc">${_escapeHtml(a.description)}</div>
    <div class="kb-action-meta">
      <span class="kb-action-assignee" title="${_escapeHtml(assigneeText)}">👤 ${_escapeHtml(assigneeText)}</span>
      ${dueLabel ? `<span class="kb-action-due ${_isOverdue(a) ? 'overdue' : ''}">${dueLabel}</span>` : ''}
    </div>
    ${(remLabel || dealLabel) ? `
      <div class="kb-action-meta-sub">
        ${remLabel ? `<span>${remLabel}</span>` : ''}
        ${dealLabel ? `<span title="${_escapeHtml(a.deal?.label || '')}">${_escapeHtml(dealLabel)}</span>` : ''}
      </div>
    ` : ''}
    ${(a.effort_days || a.duration_days) ? `
      <div class="kb-action-effort">
        ${a.effort_days ? `Effort: ${_formatDaysShort(a.effort_days)}` : ''}
        ${a.effort_days && a.duration_days ? ' · ' : ''}
        ${a.duration_days ? `Duration: ${_formatDaysShort(a.duration_days)}` : ''}
      </div>
    ` : ''}
  `;

  card.addEventListener('dragstart', e => {
    e.dataTransfer.setData('text/plain', String(a.id));
    e.dataTransfer.effectAllowed = 'move';
    card.classList.add('dragging');
  });
  card.addEventListener('dragend', () => card.classList.remove('dragging'));
  card.addEventListener('click', e => {
    if (e.target.closest('button')) return;
    openActionModal(a.id, null);
  });

  return card;
}

async function renderActionsBoard(board) {
  const boardEl = document.getElementById('kanbanBoard');

  // V76.9: Stale-while-revalidate. If we have cached actions from a previous
  // open, paint them immediately so the user sees content (not a spinner)
  // while the fresh fetch runs in the background. On first load (cache empty)
  // we still show the loading placeholder.
  const haveCache = _actionsCache && _actionsCache.length > 0;
  if (haveCache && _actionsBoardCache?.activeBoard) {
    _paintActionsBoard(boardEl, _actionsBoardCache.activeBoard, _actionsCache);
  } else {
    boardEl.innerHTML = '<div class="kb-actions-loading">Loading actions…</div>';
  }

  const { board: srvBoard, actions } = await fetchMyActions();
  // Prefer server's authoritative board (includes any column renames) over
  // the stale one in our local `boards[]` cache.
  const activeBoard = srvBoard || board;
  if (!activeBoard) {
    boardEl.innerHTML = `
      <div class="kb-actions-empty">
        <p>My Actions board is unavailable.</p>
        <p class="kb-actions-empty-sub">Ensure your user account is linked to a contact record.</p>
      </div>`;
    return;
  }

  _actionsCache = actions;
  _actionsBoardCache = { activeBoard, actions };
  _paintActionsBoard(boardEl, activeBoard, actions);
}

// Pure paint function — given a board + actions list, build the DOM. No fetch.
function _paintActionsBoard(boardEl, activeBoard, actions) {
  boardEl.innerHTML = '';

  // V76.2: "+ New Action" lives in Header 2 (`.kanban-header-controls`)
  // alongside the board selector, per the Header-2 toolbar convention.
  // Inject it into the existing toolbar if not already present.
  const headerToolbar = document.getElementById('kanbanBoardToolbar');
  if (headerToolbar && !headerToolbar.querySelector('#kbNewActionBtn')) {
    const btn = document.createElement('button');
    btn.id = 'kbNewActionBtn';
    btn.className = 'kb-toolbar-btn kb-toolbar-btn-primary';
    btn.textContent = '+ New Action';
    btn.title = 'Create a new action';
    btn.addEventListener('click', () => {
      openActionModal(null, { assignee_id: window._sessionUserId || null });
    });
    headerToolbar.appendChild(btn);
  }

  const cols = (activeBoard.columns || []).slice().sort((a, b) => a.sort_order - b.sort_order);

  const colsWrap = document.createElement('div');
  colsWrap.className = 'kb-actions-cols';
  boardEl.appendChild(colsWrap);

  cols.forEach(col => {
    const colActions = actions
      .filter(a => a.column_id === col.id || (a.column_id == null && a.status === col.stage_slug))
      .sort((a, b) => (a.column_order ?? 0) - (b.column_order ?? 0));

    const colEl = document.createElement('div');
    colEl.className = 'kb-col kb-col-action';
    colEl.dataset.columnId = col.id;
    colEl.dataset.stageSlug = col.stage_slug || '';
    colEl.innerHTML = `
      <div class="kb-col-header">
        <span class="kb-stage-dot" style="background:${col.color || '#94a3b8'}"></span>
        <span class="kb-stage-label">${col.name}</span>
        <span class="kb-count">${colActions.length}</span>
      </div>
      <div class="kb-cards" data-column-id="${col.id}"></div>
    `;

    const cardsEl = colEl.querySelector('.kb-cards');
    colActions.forEach(a => cardsEl.appendChild(_buildActionCard(a)));

    // DnD drop handler — V76.9: visible insertion-line + optimistic UI.
    // Same pattern as the deal board.
    let _actionDropIndicator = null;
    function ensureActionDropIndicator() {
      if (_actionDropIndicator && _actionDropIndicator.parentNode === cardsEl) return _actionDropIndicator;
      _actionDropIndicator = document.createElement('div');
      _actionDropIndicator.className = 'kb-drop-indicator';
      return _actionDropIndicator;
    }
    function computeInsertSpec(e) {
      const cards = [...cardsEl.querySelectorAll('.kb-card:not(.dragging)')];
      for (let i = 0; i < cards.length; i++) {
        const rect = cards[i].getBoundingClientRect();
        if (e.clientY < rect.top + rect.height / 2) return { idx: i, before: cards[i] };
      }
      return { idx: cards.length, before: null };
    }
    cardsEl.addEventListener('dragover', e => {
      e.preventDefault();
      cardsEl.classList.add('drag-over');
      const { before } = computeInsertSpec(e);
      const indicator = ensureActionDropIndicator();
      if (before) cardsEl.insertBefore(indicator, before);
      else        cardsEl.appendChild(indicator);
    });
    cardsEl.addEventListener('dragleave', e => {
      if (e.relatedTarget && cardsEl.contains(e.relatedTarget)) return;
      cardsEl.classList.remove('drag-over');
      if (_actionDropIndicator?.parentNode) _actionDropIndicator.remove();
    });
    cardsEl.addEventListener('drop', e => {
      e.preventDefault();
      cardsEl.classList.remove('drag-over');
      if (_actionDropIndicator?.parentNode) _actionDropIndicator.remove();

      const actionId = e.dataTransfer.getData('text/plain');
      if (!actionId) return;
      const actionIdNum = parseInt(actionId, 10);
      if (Number.isNaN(actionIdNum)) return;

      const { idx: insertIdx } = computeInsertSpec(e);
      const targetColId = col.id;

      // ── Optimistic UI: move the card immediately ──────────────────────
      const draggedCard = document.querySelector(`.kb-action-card[data-id="${actionIdNum}"]`);
      if (draggedCard) {
        const siblings = [...cardsEl.querySelectorAll('.kb-card:not(.dragging)')]
          .filter(c => c !== draggedCard);
        const refCard = siblings[insertIdx] || null;
        if (refCard) cardsEl.insertBefore(draggedCard, refCard);
        else         cardsEl.appendChild(draggedCard);
      }

      // Update local cache so future renders are consistent
      const cached = (_actionsCache || []).find(a => a.id === actionIdNum);
      if (cached) {
        cached.column_id = targetColId;
        cached.column_order = insertIdx;
        // Update status if column is mapped to a stage_slug (server will confirm)
        if (col.stage_slug) cached.status = col.stage_slug;
      }
      _updateColumnCounts();

      // ── Persist in background ─────────────────────────────────────────
      fetch(`${ACTIONS_API}?id=${actionIdNum}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          column_id:    targetColId,
          column_order: insertIdx,
        }),
      }).then(res => {
        if (!res.ok) {
          console.warn('[actions] move failed:', res.status);
          // Roll back by re-rendering from server truth
          renderBoard();
          return;
        }
        return res.json().catch(() => null);
      }).then(updated => {
        // V76.9: server may have reclassified the action via auto due-promotion.
        // Update cache + refresh just this card if it differs from optimistic state.
        if (updated && updated.id) {
          const idx = _actionsCache.findIndex(a => a.id === updated.id);
          if (idx >= 0) _actionsCache[idx] = updated;
          if (_actionsBoardCache) _actionsBoardCache.actions = _actionsCache;
          // If server moved it to a different column than where we dropped it
          // (e.g. due-promotion), do a full render. Otherwise patch in place.
          if (updated.column_id !== targetColId) renderBoard();
        }
        // V76.4: drag may move an action into/out of Due (or change a date-driven
        // status), so refresh the badge.
        refreshDueBadge();
      }).catch(err => {
        console.warn('[actions] move failed:', err.message);
        renderBoard();
      });
    });

    colsWrap.appendChild(colEl);
  });
}

function _escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Open the action modal.
 *   openActionModal(null, { assignee_id, deal_id, ... })  → create new
 *   openActionModal(id, null)                              → edit existing
 */
async function openActionModal(id, defaults) {
  // V76.9: Opportunistic multi-user sync. If editing, exclude the current
  // action from the diff so the user isn't disrupted mid-edit. Fire-and-forget.
  if (id != null) refreshActionsIfStale({ editingId: id });
  else            refreshActionsIfStale();

  // Fetch existing action if editing
  let action = null;
  if (id) {
    try {
      const res = await fetch(`${ACTIONS_API}?id=${id}`);
      if (res.ok) action = await res.json();
    } catch (_) {}
    if (!action) {
      showKanbanToast('Action not found');
      return;
    }
  }

  const isEdit = !!action;
  const contacts = await fetchContactsForAssignee();
  // V80 — actions can have multiple assignees. Edit dropdown only shows ONE
  // assignee for now (the first); changing it via Edit replaces the full
  // assignees set with just that single contact. To preserve multi-assignee
  // wiring on edit (e.g. Listing Agent + Listing Admin both stay), avoid
  // editing the assignee field — use the dropdown only when you want to
  // narrow to one. Future enhancement: multi-pick UI here.
  const firstAssignee = isEdit
    ? (action.assignees?.[0]?.id || action.assignee?.id || null)
    : null;
  const defaultAssignee = isEdit ? firstAssignee : (defaults?.assignee_id || window._sessionUserId || null);

  // Build modal
  const wrap = document.createElement('div');
  wrap.className = 'kb-modal-overlay kb-action-modal-overlay';
  wrap.innerHTML = `
    <div class="kb-modal kb-action-modal" role="dialog" aria-modal="true">
      <div class="kb-modal-header">
        <h2>${isEdit ? 'Edit Action' : 'New Action'}</h2>
        <button class="kb-modal-close" title="Close">✕</button>
      </div>
      <div class="kb-modal-body">
        ${isEdit ? (() => {
          // V76.4: Status as the first field in the body, consistent with the
          // deal modal. Columns sourced from the user's My Actions board so
          // any renames are reflected. Server still derives status from the
          // column's stage_slug on save.
          const actBoard = (boards || []).find(b => b.board_type === 'action');
          const cols = (actBoard?.columns || []).slice().sort((a,b) => a.sort_order - b.sort_order);
          if (!cols.length) {
            // Fallback: hardcoded slugs if board/columns aren't loaded yet
            return `
              <div class="kb-action-field">
                <label>Status</label>
                <select id="kbActionStatus">
                  <option value="todo" ${action.status === 'todo' ? 'selected' : ''}>ToDo</option>
                  <option value="wip"  ${action.status === 'wip'  ? 'selected' : ''}>WIP</option>
                  <option value="due"  ${action.status === 'due'  ? 'selected' : ''}>Due</option>
                  <option value="done" ${action.status === 'done' ? 'selected' : ''}>Done</option>
                  <option value="void" ${action.status === 'void' ? 'selected' : ''}>Void</option>
                </select>
              </div>
            `;
          }
          // Pick the column whose stage_slug matches the action's status (or
          // fall back to current column_id if set on the action).
          const currentColId = action.column_id ||
            cols.find(c => c.stage_slug === action.status)?.id ||
            cols[0]?.id;
          return `
            <div class="kb-action-field">
              <label>Status</label>
              <select id="kbActionStatus">
                ${cols.map(c => `<option value="${c.stage_slug}" data-col-id="${c.id}" ${c.id === currentColId ? 'selected' : ''}>${_escapeHtml(c.name)}</option>`).join('')}
              </select>
            </div>
          `;
        })() : ''}
        <div class="kb-action-field">
          <label>Description</label>
          <textarea id="kbActionDesc" rows="3" placeholder="What needs to be done?">${_escapeHtml(action?.description || '')}</textarea>
        </div>
        <div class="kb-action-field">
          <label>Assignee</label>
          <select id="kbActionAssignee">
            <option value="">— Select —</option>
            ${contacts.map(c => `
              <option value="${c.id}" ${c.id === defaultAssignee ? 'selected' : ''}>
                ${_escapeHtml(c.name)}${c.email ? ` (${_escapeHtml(c.email)})` : ''}
              </option>
            `).join('')}
          </select>
        </div>
        <div class="kb-action-row">
          <div class="kb-action-field">
            <label>Effort</label>
            <input type="text" id="kbActionEffort" placeholder="e.g. 2d, 3m, 1y" value="${action?.effort_days ? formatSettlement(String(action.effort_days)) : ''}">
          </div>
          <div class="kb-action-field">
            <label>Duration</label>
            <input type="text" id="kbActionDuration" placeholder="e.g. 5d, 2m, 1y" value="${action?.duration_days ? formatSettlement(String(action.duration_days)) : ''}">
          </div>
        </div>
        <div class="kb-action-row">
          <div class="kb-action-field">
            <label>Due date</label>
            <input type="date" id="kbActionDue" value="${action?.due_date ? String(action.due_date).slice(0,10) : ''}">
          </div>
          <div class="kb-action-field">
            <label>Reminder date</label>
            <input type="date" id="kbActionReminder" value="${action?.reminder_date ? String(action.reminder_date).slice(0,10) : ''}">
          </div>
        </div>
        ${(isEdit && action.deal) ? `
          <div class="kb-action-field">
            <label>Linked deal</label>
            <div class="kb-action-deal-tag" id="kbActionDealTag">
              <a class="kb-action-deal-label kb-action-deal-link" href="#" id="kbActionDealOpen" title="Open deal">${_escapeHtml(action.deal.label || action.deal_id)}</a>
              <button class="kb-action-deal-clear" title="Unlink">✕</button>
            </div>
            <input class="kb-input kb-action-deal-search" type="text" id="kbActionDealSearch" placeholder="Search deal by address or id…" style="display:none">
            <div class="kb-action-deal-results" id="kbActionDealResults"></div>
          </div>
        ` : (defaults?.deal_id ? `
          <div class="kb-action-field">
            <label>Linked deal</label>
            <div class="kb-action-deal-tag" id="kbActionDealTag">
              <span class="kb-action-deal-label">(This deal)</span>
              <button class="kb-action-deal-clear" title="Unlink">✕</button>
            </div>
            <input class="kb-input kb-action-deal-search" type="text" id="kbActionDealSearch" placeholder="Search deal by address or id…" style="display:none">
            <div class="kb-action-deal-results" id="kbActionDealResults"></div>
          </div>
        ` : `
          <div class="kb-action-field">
            <label>Linked deal (optional)</label>
            <div class="kb-action-deal-tag" id="kbActionDealTag" style="display:none"></div>
            <input class="kb-input kb-action-deal-search" type="text" id="kbActionDealSearch" placeholder="Search deal by address or id…">
            <div class="kb-action-deal-results" id="kbActionDealResults"></div>
          </div>
        `)}
      </div>
      <div class="kb-modal-footer">
        ${isEdit ? `<button class="kb-modal-btn kb-modal-btn-danger" id="kbActionDelete">Delete</button>` : ''}
        <div style="flex:1"></div>
        <button class="kb-modal-btn" id="kbActionCancel">Cancel</button>
        <button class="kb-modal-btn kb-modal-btn-primary" id="kbActionSave">${isEdit ? 'Save' : 'Create'}</button>
      </div>
    </div>
  `;
  document.body.appendChild(wrap);

  const close = () => wrap.remove();
  wrap.querySelector('.kb-modal-close').addEventListener('click', close);
  wrap.querySelector('#kbActionCancel').addEventListener('click', close);
  wrap.addEventListener('click', e => { if (e.target === wrap) close(); });

  // V76.4: clicking the linked-deal label opens that deal's modal.
  // Closes the action modal first so the user isn't left with both stacked.
  // Only present in edit mode when action.deal resolved server-side.
  const dealOpenLink = wrap.querySelector('#kbActionDealOpen');
  if (dealOpenLink) {
    dealOpenLink.addEventListener('click', (e) => {
      e.preventDefault();
      const dealId = action?.deal_id;
      if (!dealId) return;
      close();
      if (typeof window.openPipelineItem === 'function') {
        window.openPipelineItem(dealId);
      }
    });
  }

  // V76.2.1: deal picker — search + tag + clear. Tracks the selected deal
  // in this closure; initial value comes from the action being edited,
  // or from defaults.deal_id when creating from within a deal modal.
  let _selectedDealId    = isEdit ? (action?.deal_id || null) : (defaults?.deal_id || null);
  let _selectedDealLabel = isEdit ? (action?.deal?.label || action?.deal_id || null)
                                  : (defaults?.deal_id ? '(This deal)' : null);

  const dealTag     = wrap.querySelector('#kbActionDealTag');
  const dealSearch  = wrap.querySelector('#kbActionDealSearch');
  const dealResults = wrap.querySelector('#kbActionDealResults');

  function showDealTag(id, label) {
    _selectedDealId    = id;
    _selectedDealLabel = label;
    dealTag.innerHTML = `
      <span class="kb-action-deal-label">${_escapeHtml(label)}</span>
      <button class="kb-action-deal-clear" title="Unlink">✕</button>
    `;
    dealTag.style.display = 'flex';
    dealSearch.style.display = 'none';
    dealSearch.value = '';
    dealResults.innerHTML = '';
    dealTag.querySelector('.kb-action-deal-clear').addEventListener('click', clearDealTag);
  }

  function clearDealTag() {
    _selectedDealId    = null;
    _selectedDealLabel = null;
    dealTag.innerHTML = '';
    dealTag.style.display = 'none';
    dealSearch.style.display = '';
    dealSearch.value = '';
    dealResults.innerHTML = '';
  }

  // Wire the initial clear-button if a deal is pre-filled
  const initialClear = dealTag.querySelector('.kb-action-deal-clear');
  if (initialClear) initialClear.addEventListener('click', clearDealTag);

  let _dealSearchTimer;
  if (dealSearch) {
    dealSearch.addEventListener('input', () => {
      clearTimeout(_dealSearchTimer);
      const q = dealSearch.value.trim();
      if (q.length < 2) { dealResults.innerHTML = ''; return; }
      _dealSearchTimer = setTimeout(async () => {
        try {
          const res = await fetch(`/api/deals?search=${encodeURIComponent(q)}`);
          if (!res.ok) { dealResults.innerHTML = ''; return; }
          const rows = await res.json();
          dealResults.innerHTML = '';
          rows.slice(0, 8).forEach(d => {
            const addr  = d.property?.address || d.parcel?.name || '';
            const sub   = d.property?.suburb || '';
            const label = addr ? `${addr}${sub ? ', ' + sub : ''}` : d.id;
            const item = document.createElement('div');
            item.className = 'kb-action-deal-result';
            item.innerHTML = `<strong>${_escapeHtml(label)}</strong><span class="kb-action-deal-result-id">${_escapeHtml(d.id)}</span>`;
            item.addEventListener('click', () => showDealTag(d.id, label));
            dealResults.appendChild(item);
          });
          if (!rows.length) {
            dealResults.innerHTML = '<div class="kb-action-deal-result kb-action-deal-none">No matches</div>';
          }
        } catch (err) {
          console.warn('[actions] deal search failed:', err.message);
        }
      }, 300);
    });
  }

  wrap.querySelector('#kbActionSave').addEventListener('click', async () => {
    const desc = wrap.querySelector('#kbActionDesc').value.trim();
    const assigneeSel = wrap.querySelector('#kbActionAssignee').value;
    if (!desc) { alert('Description is required.'); return; }
    if (!assigneeSel) { alert('Please select an assignee.'); return; }

    const payload = {
      description:    desc,
      // V80 — server accepts assignee_ids array (multi-assignee model). For
      // edit, sending a single-element array tells the server to replace any
      // existing multi-assignee setup with just this one. POST also accepts
      // the array. The legacy assignee_id is also still read by the server.
      assignee_ids:   [parseInt(assigneeSel, 10)],
      effort_days:    parseSettlementDays(wrap.querySelector('#kbActionEffort').value) || null,
      duration_days:  parseSettlementDays(wrap.querySelector('#kbActionDuration').value) || null,
      due_date:       wrap.querySelector('#kbActionDue').value || null,
      reminder_date:  wrap.querySelector('#kbActionReminder').value || null,
      deal_id:        _selectedDealId || null,
    };
    if (isEdit) {
      payload.status = wrap.querySelector('#kbActionStatus').value;
    }

    try {
      const url = isEdit ? `${ACTIONS_API}?id=${action.id}` : ACTIONS_API;
      const method = isEdit ? 'PATCH' : 'POST';
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(err.error || `Save failed (${res.status})`);
        return;
      }
      // V76.9: API returns the updated/created enriched row. Use it to patch
      // the in-memory cache + refresh just the affected card, instead of
      // refetching everything and rebuilding the whole board.
      const saved = await res.json().catch(() => null);
      close();

      const activeBoard = boards.find(b => b.id === currentBoardId);
      if (activeBoard?.board_type === 'action') {
        if (saved && saved.id) {
          // Update cache
          const idx = _actionsCache.findIndex(a => String(a.id) === String(saved.id));
          if (idx >= 0) _actionsCache[idx] = saved;
          else _actionsCache.push(saved);
          if (_actionsBoardCache) _actionsBoardCache.actions = _actionsCache;

          // If the column changed (status promotion server-side, or column_id
          // change), the card needs to move — full render. Otherwise patch.
          const movedColumn = isEdit && action && (
            action.column_id   !== saved.column_id ||
            action.status      !== saved.status
          );
          if (!isEdit || movedColumn) {
            renderBoard();
          } else {
            refreshActionCardLive(saved.id);
          }
        } else {
          renderBoard();
        }
      } else if (defaults?.deal_id || action?.deal_id) {
        // Deal modal is open — refresh its actions section
        const dealId = defaults?.deal_id || action?.deal_id;
        if (typeof refreshDealActions === 'function') refreshDealActions(dealId);
      }
      showKanbanToast(isEdit ? 'Action updated' : 'Action created');
      // V76.4: action create/update may change the due-count
      refreshDueBadge();
    } catch (err) {
      alert('Network error: ' + err.message);
    }
  });

  if (isEdit) {
    wrap.querySelector('#kbActionDelete').addEventListener('click', async () => {
      if (!confirm('Delete this action?')) return;
      try {
        const res = await fetch(`${ACTIONS_API}?id=${action.id}`, { method: 'DELETE' });
        if (!res.ok) { alert('Delete failed'); return; }
        close();
        const activeBoard = boards.find(b => b.id === currentBoardId);
        if (activeBoard?.board_type === 'action') {
          // V76.9: drop from cache, then remove the single card from DOM —
          // no full board rebuild needed.
          const idx = _actionsCache.findIndex(a => String(a.id) === String(action.id));
          if (idx >= 0) _actionsCache.splice(idx, 1);
          if (_actionsBoardCache) _actionsBoardCache.actions = _actionsCache;
          refreshActionCardLive(action.id);
        } else if (action.deal_id && typeof refreshDealActions === 'function') {
          refreshDealActions(action.deal_id);
        }
        showKanbanToast('Action deleted');
        // V76.4: action delete may decrease the due-count
        refreshDueBadge();
      } catch (err) {
        alert('Network error: ' + err.message);
      }
    });
  }

  // Focus the description on open
  setTimeout(() => wrap.querySelector('#kbActionDesc')?.focus(), 50);

  // V76.2.1: normalise effort/duration on blur — "2m" → "60 days", "1y" → "365 days"
  // Matches the behaviour of the Settlement input on the deal modal.
  ['#kbActionEffort', '#kbActionDuration'].forEach(sel => {
    const el = wrap.querySelector(sel);
    if (!el) return;
    el.addEventListener('blur', () => {
      const v = el.value.trim();
      if (!v) return;
      el.value = formatSettlement(v);
    });
  });
}

/**
 * Refresh the Actions section inside an open deal modal. Called after
 * create/update/delete of an action linked to that deal.
 */
async function refreshDealActions(dealId) {
  const section = document.querySelector(`.kb-modal [data-deal-actions="${dealId}"]`);
  if (!section) return; // modal not open for this deal
  const actions = await fetchActionsForDeal(dealId);
  _renderDealActionsSection(section, dealId, actions);
}

function _renderDealActionsSection(container, dealId, actions) {
  const list = actions.length
    ? actions.map(a => `
        <div class="kb-deal-action-row ${_isOverdue(a) ? 'overdue' : ''}" data-action-id="${a.id}">
          <div class="kb-deal-action-main">
            <div class="kb-deal-action-desc">${_escapeHtml(a.description)}</div>
            <div class="kb-deal-action-meta">
              <span class="kb-deal-action-status kb-deal-action-status-${a.status}">${a.status.toUpperCase()}</span>
              <span>👤 ${_escapeHtml(a.assignee?.name || 'Unassigned')}</span>
              ${a.due_date ? `<span class="kb-deal-action-due ${_isOverdue(a) ? 'overdue' : ''}">📅 ${_formatDateShort(a.due_date)}</span>` : ''}
            </div>
          </div>
          <button class="kb-deal-action-edit" title="Edit action">✎</button>
        </div>
      `).join('')
    : '<div class="kb-deal-action-empty">No actions yet.</div>';

  container.innerHTML = `
    <div class="kb-deal-actions-list">${list}</div>
    <button class="kb-modal-btn kb-deal-action-add" id="kbDealAddActionBtn_${dealId}">+ Add Action</button>
  `;

  // Wire handlers
  container.querySelectorAll('.kb-deal-action-row').forEach(row => {
    const aid = parseInt(row.dataset.actionId, 10);
    row.querySelector('.kb-deal-action-edit').addEventListener('click', e => {
      e.stopPropagation();
      openActionModal(aid, null);
    });
    row.addEventListener('click', () => openActionModal(aid, null));
  });
  container.querySelector(`#kbDealAddActionBtn_${dealId}`).addEventListener('click', () => {
    openActionModal(null, { deal_id: dealId, assignee_id: window._sessionUserId || null });
  });
}

// Expose for router + finance module integration
window.openActionModal   = openActionModal;
window.refreshDealActions = refreshDealActions;

// ─── Card detail modal ────────────────────────────────────────────────────────

function buildDepositsHtml(deps, termsPrice) {
  termsPrice = termsPrice || 0;
  if (!Array.isArray(deps) || !deps.length) deps = [{ amount: '', due: '', note: '' }];
  return deps.map((d, i) => `
    <div class="kb-deposit-row" data-idx="${i}">
      <div class="kb-deposit-fields">
        <input class="kb-input kb-dep-amount" type="text" placeholder="$ or % e.g. 5% or $50,000" value="${d.amount ? formatDepositAmount(d.amount, termsPrice) : ''}" data-idx="${i}">
        <input class="kb-input kb-dep-due" type="text" placeholder="${i === 0 ? 'Days from contract e.g. 0' : 'Days since prev deposit e.g. 30'}" value="${d.due != null && d.due !== '' ? formatSettlement(String(d.due)) : ''}" data-idx="${i}">
        <input class="kb-input kb-dep-note kb-dep-note-inline" type="text" placeholder="Note" value="${d.note || ''}" data-idx="${i}">
        ${deps.length > 1 ? `<button class="kb-dep-remove" data-idx="${i}" title="Remove tranche">✕</button>` : ''}
      </div>
    </div>`).join('');
}

function buildOfferDepositsHtml(deps, offerPrice) {
  offerPrice = offerPrice || 0;
  if (!Array.isArray(deps) || !deps.length) deps = [{ amount: '', due: '', note: '' }];
  return deps.map((d, i) => `
    <div class="kb-deposit-row kb-offer-dep-row" data-idx="${i}">
      <div class="kb-deposit-fields">
        <input class="kb-input kb-odep-amount" type="text" placeholder="$ or % e.g. 5% or $50,000" value="${d.amount ? formatDepositAmount(d.amount, offerPrice) : ''}" data-idx="${i}">
        <input class="kb-input kb-odep-due" type="text" placeholder="${i === 0 ? 'Days from contract e.g. 0' : 'Days since prev deposit e.g. 30'}" value="${d.due != null && d.due !== '' ? formatSettlement(String(d.due)) : ''}" data-idx="${i}">
        <input class="kb-input kb-odep-note kb-dep-note-inline" type="text" placeholder="Note" value="${d.note || ''}" data-idx="${i}">
        ${deps.length > 1 ? `<button class="kb-odep-remove" data-idx="${i}" title="Remove tranche">✕</button>` : ''}
      </div>
    </div>`).join('');
}

function openCardModal(id) {
  const item = pipeline[id];
  if (!item) return;
  const p = item.property;

  // V76.9: Opportunistic multi-user sync — pull any background changes from
  // other users (or other tabs) so the modal shows current state. The deal
  // we're about to open is excluded from the diff so it can't be clobbered
  // mid-edit. Fires fire-and-forget; modal opens immediately on cached data.
  refreshPipelineIfStale({ editingId: id });

  // Remove any existing modal
  const existing = document.getElementById('kb-modal');
  if (existing) existing.remove();

  const terms = getTerms(id);
  const offers = getOffers(id);

  async function resolveFromDomain() {
    if (!window.matchListingByAddress || !window.getListings) return;
    let hit = matchListingByAddress(window.getListings(), p.address, p.suburb, p._lotDPs);
    if (!hit && window.runDomainSearchAt) {
      const parcel = p._parcels?.[0];
      if (parcel?.lat && parcel?.lng) hit = await runDomainSearchAt(parcel.lat, parcel.lng, p.address, p.suburb);
    }
    if (!hit) return;
    let changed = false;
    if (hit.agent && !(p._agent?.name || p._agent?.email || p._agent?.phone)) {
      p._agent = hit.agent; changed = true;
    }
    if (hit.listingUrl && !p._listingUrl) { p._listingUrl = hit.listingUrl; changed = true; }
    if (changed) savePipeline(id);
    const modal = document.getElementById('kb-modal');
    if (!modal || modal.dataset.propertyId !== String(id)) return;
    if (p._listingUrl && !modal.querySelector('.kb-domain-link')) {
      const lotEl = modal.querySelector('.kb-modal-lotdp');
      if (lotEl) {
        const link = document.createElement('a');
        link.href = p._listingUrl; link.target = '_blank'; link.rel = 'noopener';
        link.className = 'kb-domain-link';
        link.style.cssText = 'display:inline-block;margin-top:4px;font-size:11px;color:#1ea765;font-weight:600;text-decoration:none';
        link.textContent = '↗ View on Domain';
        lotEl.insertAdjacentElement('afterend', link);
      }
    }
    if (window.CRM) {
      const crmEl = modal.querySelector('.crm-section');
      if (crmEl) {
        const newCrm = await CRM.renderContactsSection(id, p._agent);
        crmEl.replaceWith(newCrm);
      }
    }
  }
  resolveFromDomain();



  function buildFinancePickerHtml(offers, terms, prop) {
    const rows = [];

    // One row per submitted offer (newest first) — full details + delete + model
    offers.forEach((o, i) => {
      if (!o.price) return;
      const depSummary = (o.deposits || [])
        .filter(d => d.amount)
        .map((d, di) => {
          const price = parseDepositAmountKanban(o.price, null) || 0;
          return formatDepositAmount(d.amount, price) + (d.due ? ' · ' + formatSettlement(String(d.due)) : '') + (d.note ? ' · ' + d.note : '');
        }).join('<br>');
      rows.push(`
        <div class="kb-fin-pick-row" data-price="${o.price}" data-offer-id="${o.id}">
          <div class="kb-fin-pick-main">
            <div class="kb-fin-pick-top">
              <span class="kb-fin-pick-label">Offer ${offers.length - i}${i === 0 ? ' <span class="kb-fin-pick-latest">latest</span>' : ''}</span>
              <span class="kb-fin-pick-date">${formatOfferDate(o.date)}</span>
            </div>
            <div class="kb-fin-pick-detail">
              <span class="kb-fin-pick-price">${formatInputPrice(String(o.price))}</span>
              ${o.settlement ? `<span class="kb-fin-pick-meta">${formatSettlement(String(o.settlement))} settlement</span>` : ''}
            </div>
            ${depSummary ? `<div class="kb-fin-pick-deps">${depSummary}</div>` : ''}
          </div>
          <div class="kb-fin-pick-actions">
            <button class="kb-fin-pick-btn">📊 Model</button>
            <button class="kb-fin-pick-delete" data-offer-id="${o.id}" title="Delete offer">✕</button>
          </div>
        </div>`);
    });

    // Vendor terms row if price set
    if (terms.price) {
      const termsDepSummary = (terms.deposits || [])
        .filter(d => d.amount)
        .map(d => {
          const price = parseDepositAmountKanban(terms.price, null) || 0;
          return formatDepositAmount(d.amount, price) + (d.due ? ' · ' + formatSettlement(String(d.due)) : '') + (d.note ? ' · ' + d.note : '');
        }).join('<br>');
      rows.push(`
        <div class="kb-fin-pick-row" data-price="${terms.price}" data-offer-id="vendor-terms">
          <div class="kb-fin-pick-main">
            <div class="kb-fin-pick-top">
              <span class="kb-fin-pick-label">Vendor terms</span>
            </div>
            <div class="kb-fin-pick-detail">
              <span class="kb-fin-pick-price">${formatInputPrice(String(terms.price))}</span>
              ${terms.settlement ? `<span class="kb-fin-pick-meta">${formatSettlement(String(terms.settlement))} settlement</span>` : ''}
            </div>
            ${termsDepSummary ? `<div class="kb-fin-pick-deps">${termsDepSummary}</div>` : ''}
          </div>
          <div class="kb-fin-pick-actions">
            <button class="kb-fin-pick-btn">📊 Model</button>
          </div>
        </div>`);
    }

    // Listing price fallback
    if (!rows.length) {
      rows.push(`
        <div class="kb-fin-pick-row" data-price="" data-offer-id="listing">
          <div class="kb-fin-pick-main">
            <span class="kb-fin-pick-label">Listing price</span>
            <span class="kb-fin-pick-price">${formatKbPrice(prop.price, null)}</span>
            <span class="kb-fin-pick-meta">No offers submitted yet</span>
          </div>
          <div class="kb-fin-pick-actions">
            <button class="kb-fin-pick-btn">📊 Model</button>
          </div>
        </div>`);
    }

    return `<div class="kb-fin-pick-header"><span>Submitted Offers &amp; Financial Feasibility</span><button class="kb-add-offer-btn" id="kb-add-offer-btn-${id}">+ Add Offer</button></div>
<div class="kb-offer-popup" id="kb-offer-popup-${id}" style="display:none">
  <div class="kb-offer-popup-inner">
    <div class="kb-terms-row">
      <div class="kb-field-wrap"><label class="kb-field-label">Price</label><input class="kb-input kb-offer-price" type="text" placeholder="e.g. $1,200,000"></div>
      <div class="kb-field-wrap"><label class="kb-field-label">Settlement</label><input class="kb-input kb-offer-settlement" type="text" placeholder="e.g. 90, 3 months, 1 year"></div>
    </div>
    <label class="kb-field-label" style="margin-top:8px;display:block">Deposit Structure</label>
    <div class="kb-offer-deposits">${buildOfferDepositsHtml([{ amount: '', due: '', note: '' }])}</div>
    <button class="kb-offer-add-deposit">+ Add tranche</button>
    <div class="kb-offer-actions">
      <button class="kb-submit-offer">+ Submit Offer</button>
      <button class="kb-offer-popup-cancel">Cancel</button>
    </div>
  </div>
</div>
${rows.join('')}`;
  }

  function buildOffersHtml(offers) {
    if (!offers || offers.length === 0) return '<div class="kb-offers-empty">No offers submitted yet</div>';
    return offers.map(o => `
      <div class="kb-offer-item" data-offer-id="${o.id}">
        <div class="kb-offer-header">
          <span class="kb-offer-date">${formatOfferDate(o.date)}</span>
          <button class="kb-offer-delete" data-offer-id="${o.id}" title="Delete offer">✕</button>
        </div>
        <div class="kb-offer-fields">
          <span class="kb-offer-field"><span class="kb-offer-lbl">Price</span> ${o.price || '—'}</span>
          <span class="kb-offer-field"><span class="kb-offer-lbl">Settlement</span> ${o.settlement ? formatSettlement(String(o.settlement)) : '—'}</span>
        </div>
        ${o.deposits && o.deposits.length ? `
          <div class="kb-offer-deps-label">Deposit structure</div>
          <div class="kb-offer-deposits-list">${o.deposits.map(d => {
            const price = parseDepositAmountKanban(o.price, null) || 0;
            const amtDisplay = d.amount ? formatDepositAmount(d.amount, price) : '';
            return `<span class="kb-offer-dep">${[amtDisplay, d.due, d.note].filter(Boolean).join(' · ')}</span>`;
          }).join('')}</div>` : ''}
      </div>`).join('');
  }

  const dd = getDd(id);

  const overlay = document.createElement('div');
  overlay.id = 'kb-modal';
  overlay.className = 'kb-modal-overlay';
  overlay.dataset.propertyId = String(id);
  try { overlay.innerHTML = `
    <div class="kb-modal">
      <div class="kb-modal-header">
        <div style="flex:1;min-width:0">
          ${(() => {
            const dealBoardForHeader = item._boardId || currentBoardId;
            const isEnquiryBoard = dealBoardForHeader === 'sys_sales_enquiry' || dealBoardForHeader === 'sys_lease_enquiry';
            if (isEnquiryBoard) {
              // V77.1: Enquiry modal headline = enquirer contact name. Falls back
              // to "Loading…" until populated by fetchEnquirerNameForModal() below.
              const cached = item._enquiryMeta?.contact_name || '';
              return `<div class="kb-modal-price kb-modal-enquirer" data-deal-id="${id}">${cached || 'Loading…'}</div>`;
            }
            // V77.1: Lease Listings show rent (per-week / per-month) — sales price field
            // doesn't apply.
            if (dealBoardForHeader === 'sys_lease_listings') {
              return `<div class="kb-modal-price">${formatKbRent(terms)}</div>`;
            }
            return `<div class="kb-modal-price">${formatKbPrice(p.price, terms.price)}</div>`;
          })()}
          <div class="kb-modal-address">📍 ${p.address}, ${p.suburb}${p.state ? ' ' + p.state : ''}</div>
          ${p._lotDPs
            ? `<div class="kb-modal-lotdp" style="font-size:11px;color:#888;margin-top:3px;letter-spacing:0.02em">${p._lotDPs}</div>`
            : `<div class="kb-modal-lotdp" style="font-size:11px;color:#bbb;margin-top:3px">Lot/DP loading…</div>`}
          ${p._listingUrl ? `<a href="${p._listingUrl}" target="_blank" rel="noopener" class="kb-domain-link" style="display:inline-block;margin-top:4px;font-size:11px;color:#1ea765;font-weight:600;text-decoration:none">↗ View on Domain</a>` : ''}
        </div>
        <div style="display:flex;align-items:center;gap:8px;flex-shrink:0" class="crm-modal-header-actions">
          <button class="kb-modal-delete crm-modal-delete" title="Delete">Delete</button>
          <button class="kb-modal-close" title="Close">✕</button>
        </div>
      </div>
      <div class="kb-modal-body">

        <!-- V77.1 — Status select (Enquiry boards only — first section, above Contacts).
             Non-Enquiry boards keep Status in the legacy IIFE just below. -->
        <div class="v77-status-mount" data-deal-id="${id}"></div>

        <!-- V77.1 — Interest level slider (Enquiry boards only — second section, above Contacts). -->
        <div class="v77-interest-mount" data-deal-id="${id}"></div>

        ${(() => {
          // V76.4 / V77.1: Status select position depends on board type.
          //   - Enquiry boards (Sales/Lease): Status renders FIRST (above Contacts),
          //     via the v77-status-mount above. Suppressed here.
          //   - All other boards: Status stays at top of modal (legacy V76.4 layout).
          const dealBoardId = item._boardId || currentBoardId;
          if (dealBoardId === 'sys_sales_enquiry' || dealBoardId === 'sys_lease_enquiry') return '';
          const dealBoard   = boards.find(b => b.id === dealBoardId);
          const cols        = (dealBoard?.columns || []).slice().sort((a,b) => a.sort_order - b.sort_order);
          if (!cols.length) return '';
          const currentColId = item._columnId || stageToColumnId(item.stage);
          return `
            <div class="kb-field-wrap" style="margin-bottom:12px">
              <label class="kb-field-label">Status</label>
              <select class="kb-input kb-modal-status-select" id="kbModalStatus-${id}">
                ${cols.map(c => `<option value="${c.id}" ${c.id === currentColId ? 'selected' : ''}>${_escapeHtml(c.name)}</option>`).join('')}
              </select>
            </div>
          `;
        })()}

        <div class="crm-section-placeholder"></div>

        ${(() => {
          // V77.1: Vendor Terms — Sales Listings + Acquisition (price/settlement/deposits)
          const dealBoardForTerms = item._boardId || currentBoardId;
          const showVendorTerms = dealBoardForTerms === 'sys_acquisition'
                              || dealBoardForTerms === 'sys_sales_listings';
          if (!showVendorTerms) return '';
          return `
        <div class="kb-section-label" style="margin-top:12px">Vendor Terms</div>
        <div class="kb-terms">
          <div class="kb-terms-row">
            <div class="kb-field-wrap">
              <label class="kb-field-label">Price</label>
              <input class="kb-input kb-terms-price" type="text" placeholder="e.g. $1,250,000" value="${terms.price ? formatInputPrice(String(terms.price)) : ''}">
            </div>
            <div class="kb-field-wrap">
              <label class="kb-field-label">Settlement</label>
              <input class="kb-input kb-terms-settlement" type="text" placeholder="e.g. 90, 3 months, 1 year" value="${terms.settlement ? formatSettlement(String(terms.settlement)) : ''}">
            </div>
          </div>
          <label class="kb-field-label" style="margin-top:8px;display:block">Deposit Structure</label>
          <div class="kb-deposits">${buildDepositsHtml(terms.deposits, parseDepositAmountKanban(terms.price, null) || 0)}</div>
          <button class="kb-add-deposit">+ Add tranche</button>
        </div>
          `;
        })()}

        ${(() => {
          // V77.1: Finance Picker (purchase offers) — Acquisition only.
          const dealBoardForFinance = item._boardId || currentBoardId;
          if (dealBoardForFinance !== 'sys_acquisition') return '';
          return `
        <div class="kb-finance-picker" id="kb-finance-picker-${id}">${buildFinancePickerHtml(offers, terms, p)}</div>
          `;
        })()}

        ${(() => {
          // V77.1: Lease Terms — Lease Listings only
          // Different shape from Sales: rent_amount, rent_period, bond, term_months, available_from, special_terms
          const dealBoardForLease = item._boardId || currentBoardId;
          if (dealBoardForLease !== 'sys_lease_listings') return '';
          const lt = terms || {};
          const rentAmt    = lt.rent_amount != null ? formatInputPrice(String(lt.rent_amount)) : '';
          const rentPeriod = lt.rent_period || 'weekly';
          const bond       = lt.bond != null ? formatInputPrice(String(lt.bond)) : '';
          const termText   = lt.term_months != null ? `${lt.term_months} months` : '';
          const availFrom  = lt.available_from || '';
          const special    = lt.special_terms || '';
          return `
        <div class="kb-section-label" style="margin-top:12px">Lease Terms</div>
        <div class="kb-lease-terms">
          <div class="kb-lease-rent-row">
            <div class="kb-field-wrap" style="flex:1">
              <label class="kb-field-label">Rent</label>
              <input class="kb-input kb-lease-rent-amount" type="text" placeholder="e.g. $650" value="${rentAmt}">
            </div>
            <div class="kb-lease-period-toggle" data-role="period-toggle">
              <button class="kb-lease-period-btn ${rentPeriod === 'weekly' ? 'active' : ''}" data-period="weekly" type="button">Weekly</button>
              <button class="kb-lease-period-btn ${rentPeriod === 'monthly' ? 'active' : ''}" data-period="monthly" type="button">Monthly</button>
            </div>
            <input type="hidden" class="kb-lease-rent-period" value="${rentPeriod}">
          </div>
          <div class="kb-terms-row">
            <div class="kb-field-wrap">
              <label class="kb-field-label">Bond</label>
              <input class="kb-input kb-lease-bond" type="text" placeholder="e.g. $2,600" value="${bond}">
            </div>
            <div class="kb-field-wrap">
              <label class="kb-field-label">Term</label>
              <input class="kb-input kb-lease-term" type="text" placeholder="e.g. 12 months, 1 year, 6m" value="${termText}">
            </div>
            <div class="kb-field-wrap">
              <label class="kb-field-label">Available from</label>
              <input class="kb-input kb-lease-available" type="date" value="${availFrom}">
            </div>
          </div>
          <div class="kb-field-wrap" style="margin-top:8px">
            <label class="kb-field-label">Special Terms</label>
            <textarea class="kb-input kb-lease-special" rows="2" placeholder="e.g. Garden maintenance included, Water included">${special}</textarea>
          </div>
        </div>
          `;
        })()}

        <!-- V77.1 — Listings sections (Inspection Schedule + Agency Agreements).
             Renderers no-op for non-Listings boards. -->
        <div class="v77-inspections-mount" data-deal-id="${id}"></div>
        <div class="v77-agreements-mount" data-deal-id="${id}"></div>

        <!-- V77.1b — Listing Summary section (Enquiry boards only). -->
        <div class="v77-listing-summary-mount" data-deal-id="${id}"></div>

        <!-- V77.2d — Lease Offer section (Lease Enquiry only). -->
        <!-- Validation checklist is now inside each offer's review block, no separate section. -->
        <div class="v77-lease-offer-mount" data-deal-id="${id}"></div>

        <!-- V77.1 — Lease Offers Received cross-reference (Lease Listings only). -->
        <div class="v77-lease-offers-received-mount" data-deal-id="${id}"></div>

        ${(() => {
          // V77.1: Due Diligence section is Acquisition-workflow only.
          // Listings (Sales/Lease) and Enquiry (Sales/Lease) boards don't have DD.
          const dealBoardForDD = item._boardId || currentBoardId;
          if (dealBoardForDD !== 'sys_acquisition') return '';
          return `
        <div class="kb-section-label" style="margin-top:16px">Due Diligence</div>
        <div style="display:flex;justify-content:flex-end;margin-bottom:4px">
          <button class="kb-rerun-dd-btn kb-add-offer-btn" data-id="${id}" title="Re-run Auto DD">↻ Auto DD</button>
        </div>
        <div class="kb-dd">
          ${DD_ITEMS.map(ddItem => {
            const key    = ddItem.toLowerCase();
            const status = dd[key]?.status || '';
            const note   = dd[key]?.note   || '';
            return `
              <div class="kb-dd-row" data-key="${key}">
                <span class="kb-dd-label">${ddItem}</span>
                <select class="kb-dd-select dd-risk-${status || 'none'}" data-key="${key}">
                  ${DD_RISK_OPTIONS.map(o => `<option value="${o.value}" ${o.value === status ? 'selected' : ''}>${o.label}</option>`).join('')}
                </select>
                <input class="kb-input kb-dd-note" type="text" placeholder="Note…" value="${note}" data-key="${key}">
                <button type="button" class="kb-dd-attach-btn" data-key="${key}" data-deal-id="${id}" title="Attach files to this risk">
                  📎<span class="kb-dd-attach-count" data-key="${key}"></span>
                </button>
              </div>`;
          }).join('')}
        </div>
          `;
        })()}

        <div class="kb-section-label" style="margin-top:16px">Actions</div>
        <div class="kb-deal-actions-section" data-deal-actions="${id}">
          <div class="kb-deal-actions-loading">Loading…</div>
        </div>

        <div class="kb-section-label" style="margin-top:16px">Notes</div>
        <div class="kb-notes-section">
          <!-- V77.1: Extended note form (type + source + contact tagger + textarea) -->
          <div class="v77-note-form-mount" data-deal-id="${id}"></div>
          <div class="kb-notes-list"></div>
        </div>

      </div>
    </div>
  `;

  } catch(e) { console.error('[Kanban] Modal build error:', e); return; }
  document.body.appendChild(overlay);
  const modal = overlay.querySelector('.kb-modal');

  // Mount CRM contacts section
  if (window.CRM) {
    CRM.renderContactsSection(id, p._agent).then(crmEl => {
      const placeholder = modal.querySelector('.crm-section-placeholder');
      if (placeholder) placeholder.replaceWith(crmEl);
    });
  }

  // V77.1: Async-populate the Enquiry headline (contact name in modal header).
  // The kanban-card enrichment (enrichEnquiryCardsAsync) might not have run yet
  // when modal opens via openPipelineItem from outside the board, so we hit the
  // batch endpoint with this single deal id.
  const _hdrBoard = item._boardId || currentBoardId;
  if (_hdrBoard === 'sys_sales_enquiry' || _hdrBoard === 'sys_lease_enquiry') {
    const headlineEl = modal.querySelector('.kb-modal-enquirer');
    if (headlineEl) {
      const cached = item._enquiryMeta?.contact_name;
      if (!cached) {
        fetch(`/api/enquiry-card-meta?deal_ids=${encodeURIComponent(id)}`)
          .then(r => r.ok ? r.json() : null)
          .then(metaMap => {
            const meta = metaMap?.[id];
            if (!meta) return;
            if (pipeline[id]) pipeline[id]._enquiryMeta = meta;
            const name = meta.contact_name || '(no contact linked)';
            // Re-resolve the headline element in case the modal HTML was rebuilt
            const stillThere = document.querySelector(`.kb-modal-enquirer[data-deal-id="${CSS.escape(String(id))}"]`);
            if (stillThere) stillThere.textContent = name;
          })
          .catch(() => { /* leave Loading… visible */ });
      }
    }
  }

  // V77.1: Mount Listings sections (Inspection Schedule + Agency Agreements).
  // These are only populated for sys_sales_listings / sys_lease_listings deals;
  // the renderer functions are no-ops for other boards.
  const dealBoardForSections = item._boardId || currentBoardId;
  if (window.InspectionsSection) {
    const mount = modal.querySelector('.v77-inspections-mount');
    if (mount) InspectionsSection.render(mount, id, dealBoardForSections);
  }
  if (window.AgencyAgreementsSection) {
    const mount = modal.querySelector('.v77-agreements-mount');
    if (mount) AgencyAgreementsSection.render(mount, id, dealBoardForSections);
  }
  // V77.1b: Listing Summary section (Enquiry boards only — read-only display
  // of parent Listing's terms). Replaces editable Vendor Terms on Enquiry deals.
  if (window.ListingSummarySection) {
    const mount = modal.querySelector('.v77-listing-summary-mount');
    if (mount) {
      const parentDealId = item.parent_deal_id || item._parentDealId || null;
      ListingSummarySection.render(mount, id, dealBoardForSections, parentDealId);
    }
  }

  // V80.2 — Interest level slider — now ALL deal modals (was Enquiry-only).
  // Field is data.interest_level (0-100, step 5). MoSCoW band labels
  // (Won't / Could / Should / Must) sit under the track at 0/33/66/100% so
  // the agent sees both the precise number AND the qualitative position.
  {
    const interestMount = modal.querySelector('.v77-interest-mount');
    if (interestMount) {
      const initialLevel = (item.data?.interest_level != null)
        ? Math.max(0, Math.min(100, parseInt(item.data.interest_level, 10) || 0))
        : 0;
      interestMount.innerHTML = `
        <div class="kb-section-label" style="margin-top:12px">Interest Level</div>
        <div class="kb-modal-interest">
          <div class="kb-interest-row">
            <input type="range" class="kb-modal-interest-slider" min="0" max="100" step="1" value="${initialLevel}">
            <span class="kb-modal-interest-value">${initialLevel}</span>
          </div>
          <div class="kb-interest-moscow">
            <span class="kb-interest-moscow-label" style="left:0%">Won't</span>
            <span class="kb-interest-moscow-label" style="left:25%">Could</span>
            <span class="kb-interest-moscow-label" style="left:50%">Should</span>
            <span class="kb-interest-moscow-label" style="left:75%">Must</span>
          </div>
        </div>
      `;
      const slider = interestMount.querySelector('.kb-modal-interest-slider');
      const valEl  = interestMount.querySelector('.kb-modal-interest-value');
      let _saveT = null;
      slider.addEventListener('input', () => { valEl.textContent = slider.value; });
      slider.addEventListener('change', () => {
        const newLevel = parseInt(slider.value, 10);
        clearTimeout(_saveT);
        _saveT = setTimeout(() => saveInterestLevel(id, newLevel), 200);
      });
    }
  }

  // V77.1: Deal Status select — Enquiry boards only. On non-Enquiry boards, the
  // legacy top-of-modal Status field handles this. Mirrors the kanban card's stage.
  if (dealBoardForSections === 'sys_sales_enquiry' || dealBoardForSections === 'sys_lease_enquiry') {
    const statusMount = modal.querySelector('.v77-status-mount');
    if (statusMount) {
      const stagesForDeal = resolveCurrentStages(); // current board's columns
      const currentColId = item._columnId || stageToColumnId(item.stage, item._boardId || currentBoardId);
      const statusOptions = stagesForDeal.map(s =>
        `<option value="${s.id}" ${s.id === currentColId ? 'selected' : ''}>${s.label}</option>`
      ).join('');
      statusMount.innerHTML = `
        <div class="kb-section-label" style="margin-top:0">Status</div>
        <select class="kb-input kb-modal-status-select">${statusOptions}</select>
      `;
      const sel = statusMount.querySelector('.kb-modal-status-select');
      sel.addEventListener('change', () => {
        moveToColumn(id, sel.value);
        refreshCardLive(id);
      });
    }
  }

  // V77.1: Lease Enquiry sections — Lease Offer + Validation (only on sys_lease_enquiry)
  if (dealBoardForSections === 'sys_lease_enquiry') {
    if (window.LeaseOfferSection) {
      const mount = modal.querySelector('.v77-lease-offer-mount');
      if (mount) LeaseOfferSection.mount(mount, id);
    }
  }

  // V77.1: Lease Offers Received cross-reference (only on sys_lease_listings)
  if (dealBoardForSections === 'sys_lease_listings') {
    if (window.LeaseOffersReceivedSection) {
      const mount = modal.querySelector('.v77-lease-offers-received-mount');
      if (mount) LeaseOffersReceivedSection.mount(mount, id);
    }
  }

  // V75.7: load Actions for this deal into the Actions section
  (async () => {
    const container = modal.querySelector(`[data-deal-actions="${id}"]`);
    if (!container) return;
    const actions = await fetchActionsForDeal(id);
    _renderDealActionsSection(container, id, actions);
  })();

  // Close
  // V76.12b: All explicit-close paths (X, backdrop, Escape) repaint the
  // kanban board on dismiss. Without this, changes that happened during
  // the modal session — including a new card inserted by openPipelineItem
  // (when "+ New Deal" is clicked from the CRM property modal), or
  // in-modal edits that change card visuals (offer count, DD colour) —
  // stay invisible until the next render trigger. renderBoard() repaints
  // from the in-memory pipeline dict (no fetch, cheap). The Finance-picker
  // transition and the delete-from-modal path do NOT use this helper —
  // Finance is leaving the view, and removeFromPipeline already calls
  // renderBoard itself.
  // V77.2g — Close-time Default Board Role invariant.
  // Before allowing the modal to close, verify the deal has at least one
  // contact whose role is flagged via role_boards for this deal's board. If
  // not, block the close and toast the agent to fix it. This is the primary
  // user-facing enforcement of the invariant — server-side checks (in
  // /api/contacts and /api/deals) are belt-and-braces for direct API access.
  async function canCloseDealModal() {
    const dealEntry = pipeline[id];
    if (!dealEntry) return true;
    const dealBoardId = dealEntry._boardId || currentBoardId;
    if (!dealBoardId) return true;
    let eligibleRoles = [];
    try {
      if (window.Lookups && typeof Lookups.getDefaultRolesForBoard === 'function') {
        eligibleRoles = await Lookups.getDefaultRolesForBoard(dealBoardId);
      }
    } catch (err) { console.warn('[deal-modal close-check] roles lookup failed', err); }
    if (!eligibleRoles.length) return true;
    // Fetch live contact list for the deal — Modal Contacts section may have
    // been mutated since opening; we need the truth, not stale state.
    let contacts = [];
    try {
      const r = await fetch(`/api/contacts?entity_type=deal&entity_id=${encodeURIComponent(id)}`);
      if (r.ok) contacts = await r.json();
    } catch (err) {
      console.warn('[deal-modal close-check] contacts fetch failed', err);
      // Fail open — don't trap the user if we can't verify
      return true;
    }
    const eligibleIds = new Set(eligibleRoles.map(r => r.id));
    const hasOne = contacts.some(c => eligibleIds.has(c.role));
    if (hasOne) return true;
    const labels = eligibleRoles.map(r => r.label).join(' or ');
    showKanbanToast(`Add a contact with ${labels} role before closing this card.`);
    return false;
  }

  const closeAndRefresh = async () => {
    if (!(await canCloseDealModal())) return;
    // V80 — run any registered close-hooks (e.g. inspection trigger flush).
    // Each hook returns truthy on success / falsy on failure. On any
    // failure we abort the close so the user can resolve the error.
    if (Array.isArray(window._dealModalCloseHooks) && window._dealModalCloseHooks.length) {
      const hooks = window._dealModalCloseHooks.slice();
      // Sequential — order matters less than reliability; one toast at a time
      for (const hook of hooks) {
        try {
          const ok = await hook();
          if (ok === false) return; // hook signalled "don't close"
        } catch (err) {
          console.warn('[deal-modal close-hook] failed', err);
          // Hook errors don't block close — they're best-effort cleanup.
        }
      }
      // Drop hooks that belong to this modal (they're tied to DOM elements
      // that are about to be removed). Cleanest: clear the lot, since
      // hooks should only ever exist while a modal is open.
      window._dealModalCloseHooks = [];
    }
    overlay.remove();
    // V81.5 — close is now instant. Edits inside the modal already patch the
    // board card in place via refreshCardLive(id) at each save site, so the old
    // unconditional renderBoard() here was redundant work that blocked the paint
    // (the whole board rebuilt on every close, even view-only opens — the main
    // cause of the "click → wait → gone" lag). We do one final surgical
    // refreshCardLive(id) to cover any close-hook mutation (e.g. inspection
    // flush) that didn't already patch the card; it patches just this card from
    // cache and only falls back to a full render if the card must appear but is
    // missing. No-op cost when nothing changed.
    if (kanbanVisible && typeof refreshCardLive === 'function') refreshCardLive(id);
  };
  overlay.querySelector('.kb-modal-close').addEventListener('click', closeAndRefresh);

  // V75.5.2: Delete deal from inside modal. V76.7+ uses the shared
  // openDeleteCardConfirm modal so this matches the X-button experience.
  // The closeOnConfirm callback dismisses the deal modal so the card
  // doesn't try to render against a deleted entry.
  overlay.querySelector('.kb-modal-delete')?.addEventListener('click', () => {
    openDeleteCardConfirm(id, () => overlay.remove());
  });

  // V76.4: legacy Status select (top-of-modal, non-Enquiry boards) — auto-save on change.
  // Enquiry boards use the v77-status-mount block above instead.
  overlay.querySelector(`#kbModalStatus-${id}`)?.addEventListener('change', (e) => {
    const newColId = e.target.value;
    moveToColumn(id, newColId);
    // V81.5 — patch just this card (matches the modern status mount above);
    // moveToColumn already updated the cache, and refreshCardLive handles the
    // moved/filtered-out cases. Avoids a full renderBoard() mid-edit.
    if (typeof refreshCardLive === 'function') refreshCardLive(id);
    else renderBoard();
  });

  // Finance picker — delegate clicks on all .kb-fin-pick-btn rows
  function parsePickerPrice(s) {
    if (!s) return null;
    const n = parseFloat(String(s).replace(/[^0-9.]/g, ''));
    return (!isNaN(n) && n > 0) ? n : null;
  }

  function openFinanceFromPicker(priceStr) {
    overlay.remove();
    if (!window.FinanceModule) return;
    window.FinanceModule.open(id, pipeline[id], parsePickerPrice(priceStr));
  }

  // Finance picker — delegated click handler for Model btn, delete btn, add offer, cancel
  overlay.addEventListener('click', e => {
    // + Add Offer toggle
    if (e.target.closest(`#kb-add-offer-btn-${id}`)) {
      const popup = overlay.querySelector(`#kb-offer-popup-${id}`);
      if (popup) popup.style.display = popup.style.display === 'none' ? '' : 'none';
      return;
    }
    // Cancel popup
    if (e.target.closest('.kb-offer-popup-cancel')) {
      const popup = overlay.querySelector(`#kb-offer-popup-${id}`);
      if (popup) popup.style.display = 'none';
      return;
    }
    // Model button
    const modelBtn = e.target.closest('.kb-fin-pick-btn');
    if (modelBtn) {
      const row = modelBtn.closest('.kb-fin-pick-row');
      if (row) openFinanceFromPicker(row.dataset.price || '');
      return;
    }
  });
  overlay.addEventListener('click', e => { if (e.target === overlay) closeAndRefresh(); });
  document.addEventListener('keydown', function escClose(e) {
    if (e.key === 'Escape') {
      closeAndRefresh().then(() => {
        // Only deregister if the modal actually closed
        if (!document.body.contains(overlay)) {
          document.removeEventListener('keydown', escClose);
        }
      });
    }
  });

  // Re-run Auto DD — V77.1: only on Acquisition (DD section gated out elsewhere)
  if (modal.querySelector('.kb-rerun-dd-btn')) {
    modal.querySelector('.kb-rerun-dd-btn').addEventListener('click', () => {
      const p       = pipeline[id]?.property;
      const parcels = p?._parcels || [];
      const lat     = p?.lat ?? parcels[0]?.lat ?? null;
      const lng     = p?.lng ?? parcels[0]?.lng ?? null;
      if (!lat || !lng || !window.queryDDRisks) {
        console.warn('[DD] Re-run skipped — no coordinates or queryDDRisks unavailable');
        return;
      }
      const btn = modal.querySelector('.kb-rerun-dd-btn');
      btn.textContent = '↻ Running…';
      btn.disabled = true;
      queryDDRisks(lat, lng).then(dd => {
        if (!pipeline[id]) return;
        Object.entries(dd).forEach(([key, val]) => {
        pipeline[id].dd[key] = val;
      });
      savePipeline(id);
      refreshModalDd(id);
      btn.textContent = '↻ Auto DD';
      btn.disabled = false;
    }).catch(err => {
      console.warn('[DD] Re-run failed:', err);
      btn.textContent = '↻ Auto DD';
      btn.disabled = false;
    });
    });
  } // end V77.1 DD button gate

  // Notes (V75.3 — async, backed by /api/notes)
  function formatNoteDate(ts) {
    const d = new Date(ts);
    const pad = n => String(n).padStart(2, '0');
    return `${pad(d.getDate())}/${pad(d.getMonth()+1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  async function renderNotesList() {
    const listEl = modal.querySelector('.kb-notes-list');
    if (!listEl) return;
    listEl.innerHTML = '<div class="kb-notes-empty">Loading…</div>';
    const notes = await fetchNotesForDeal(id);
    if (!notes.length) { listEl.innerHTML = '<div class="kb-notes-empty">No notes yet</div>'; return; }
    listEl.innerHTML = '';
    notes.forEach(n => {
      const entry = document.createElement('div');
      entry.className = 'kb-note-entry';
      const taggedName = [n.tagged_first_name, n.tagged_last_name].filter(Boolean).join(' ').trim();
      const taggedBadge = taggedName ? `<span class="kb-note-contact-badge">@${taggedName}</span>` : '';
      const author = n.author_name || 'Unknown';
      // V77.1 — type + source badges (server returns *_label fields if available)
      const typeLabel = n.interaction_type_label || (n.interaction_type ? n.interaction_type.replace(/_/g, ' ') : '');
      const srcLabel  = n.source_label || (n.source ? n.source.replace(/_/g, ' ') : '');
      const typeBadge = typeLabel ? `<span class="kb-note-type-badge">${typeLabel}</span>` : '';
      const srcBadge  = srcLabel  ? `<span class="kb-note-source-badge">${srcLabel}</span>`  : '';
      entry.innerHTML = `
        <div class="kb-note-meta">
          <span class="kb-note-date">${formatNoteDate(n.created_at)} · by ${author}${taggedBadge}${typeBadge}${srcBadge}</span>
          <button class="kb-note-delete" data-id="${n.id}" title="Delete note">✕</button>
        </div>
        <div class="kb-note-text">${String(n.note_text || '').split('\n').join('<br>')}</div>`;
      entry.querySelector('.kb-note-delete').addEventListener('click', async () => {
        if (!confirm('Delete this note?')) return;
        const ok = await deleteNote(id, n.id);
        if (ok) {
          renderNotesList();
          refreshCardLive(id);
        }
      });
      listEl.appendChild(entry);
    });
  }
  renderNotesList();

  // V77.1 — Mount the extended NoteForm (type + source + contact tagger + textarea)
  // at .v77-note-form-mount. Replaces the legacy inline note input wiring.
  if (window.NoteForm && modal.querySelector('.v77-note-form-mount')) {
    const noteMount = modal.querySelector('.v77-note-form-mount');
    let _kbNoteFormHandle = null;
    _kbNoteFormHandle = NoteForm.mount(noteMount, {
      placeholder: 'Add a note…',
      showContactTagger: true,
      onAdd: async (vals) => {
        const text = (vals.note_text || '').trim();
        if (!text) return;
        await addNote(id, text, vals.tagged_contact_id || null, vals.interaction_type || null, vals.source || null);
        if (_kbNoteFormHandle?.reset) _kbNoteFormHandle.reset();
        renderNotesList();
        refreshCardLive(id);
      },
    });
  }

  // Terms — V77.1: only wire if Vendor Terms section exists (Acquisition only)
  if (modal.querySelector('.kb-terms-price')) {
    function syncTerms() {
      const t = getTerms(id);
      const rawPrice = modal.querySelector('.kb-terms-price').value;
      const rawSettlement = modal.querySelector('.kb-terms-settlement').value;
      const parsedPrice = parseDepositAmountKanban(rawPrice, null);
      t.price      = parsedPrice || null;  // null not 0 — so falsy check works correctly
      t.settlement = parseSettlementDays(rawSettlement) || null;
      saveTerms(id, t);
      refreshCardLive(id);
    }
    // Sync only on blur so price is fully typed before parsing
    modal.querySelector('.kb-terms-price').addEventListener('blur', function() {
      this.value = formatInputPrice(this.value);
      syncTerms();
    });
    modal.querySelector('.kb-terms-settlement').addEventListener('blur', function() {
    this.value = formatSettlement(this.value);
    syncTerms();
  });

  // Vendor deposits
  function syncDeposits() {
    const t = getTerms(id);
    const price = parseDepositAmountKanban(t.price, null) || 0;
    t.deposits = Array.from(modal.querySelectorAll('.kb-deposits .kb-deposit-row')).map(row => ({
      amount: parseDepositAmountKanban(row.querySelector('.kb-dep-amount').value, price),
      due:    parseSettlementDays(row.querySelector('.kb-dep-due').value),
      note:   row.querySelector('.kb-dep-note').value,
    }));
    saveTerms(id, t);
  }
  modal.querySelector('.kb-deposits').addEventListener('input', e => {
    if (e.target.matches('.kb-dep-amount, .kb-dep-due, .kb-dep-note')) syncDeposits();
  });
  modal.querySelector('.kb-deposits').addEventListener('blur', e => {
    const t = getTerms(id);
    const price = parseDepositAmountKanban(t.price, null) || 0;
    if (e.target.matches('.kb-dep-amount')) {
      const num = parseDepositAmountKanban(e.target.value, price);
      e.target.value = num ? formatDepositAmount(num, price) : '';
      syncDeposits();
    }
    if (e.target.matches('.kb-dep-due')) {
      e.target.value = formatDepositDue(e.target.value);
      syncDeposits();
    }
  }, true);
  modal.querySelector('.kb-deposits').addEventListener('click', e => {
    const btn = e.target.closest('.kb-dep-remove');
    if (!btn) return;
    syncDeposits();
    const idx = parseInt(btn.dataset.idx, 10);
    removeDeposit(id, idx);
    modal.querySelector('.kb-deposits').innerHTML = buildDepositsHtml(getTerms(id).deposits);
  });
  modal.querySelector('.kb-add-deposit').addEventListener('click', () => {
    syncDeposits();
    addDeposit(id);
    modal.querySelector('.kb-deposits').innerHTML = buildDepositsHtml(getTerms(id).deposits);
  });
  } // end V77.1 Vendor Terms gate

  // V77.1: Lease Terms — wires only if section is rendered (Lease Listings only)
  if (modal.querySelector('.kb-lease-rent-amount')) {
    function syncLeaseTerms() {
      const t = getTerms(id);
      const rentAmtRaw   = modal.querySelector('.kb-lease-rent-amount').value;
      const rentPeriod   = modal.querySelector('.kb-lease-rent-period').value || 'weekly';
      const bondRaw      = modal.querySelector('.kb-lease-bond').value;
      const termRaw      = modal.querySelector('.kb-lease-term').value;
      const availFromRaw = modal.querySelector('.kb-lease-available').value;
      const specialRaw   = modal.querySelector('.kb-lease-special').value;

      t.rent_amount = parseDepositAmountKanban(rentAmtRaw, null) || null;
      t.rent_period = rentPeriod;
      t.bond        = parseDepositAmountKanban(bondRaw, null) || null;
      // term — parse "12 months", "1 year", "6m" → integer months
      t.term_months = parseLeaseTermMonths(termRaw);
      t.available_from = availFromRaw || null;
      t.special_terms  = specialRaw.trim() || null;
      saveTerms(id, t);
      refreshCardLive(id);
    }

    modal.querySelector('.kb-lease-rent-amount').addEventListener('blur', function() {
      this.value = this.value.trim() ? formatInputPrice(this.value) : '';
      syncLeaseTerms();
    });
    modal.querySelector('.kb-lease-bond').addEventListener('blur', function() {
      this.value = this.value.trim() ? formatInputPrice(this.value) : '';
      syncLeaseTerms();
    });
    modal.querySelector('.kb-lease-term').addEventListener('blur', function() {
      const months = parseLeaseTermMonths(this.value);
      this.value = months != null ? `${months} months` : '';
      syncLeaseTerms();
    });
    modal.querySelector('.kb-lease-available').addEventListener('change', syncLeaseTerms);
    modal.querySelector('.kb-lease-special').addEventListener('blur', syncLeaseTerms);

    // Period toggle (Weekly / Monthly)
    const toggle = modal.querySelector('[data-role="period-toggle"]');
    toggle.addEventListener('click', e => {
      const btn = e.target.closest('.kb-lease-period-btn');
      if (!btn) return;
      const period = btn.getAttribute('data-period');
      toggle.querySelectorAll('.kb-lease-period-btn').forEach(b => b.classList.toggle('active', b === btn));
      modal.querySelector('.kb-lease-rent-period').value = period;
      syncLeaseTerms();
    });
  }

  // Offer form — delegated on overlay so handlers survive picker HTML rebuilds
  overlay.addEventListener('blur', e => {
    if (e.target.matches('.kb-offer-price')) {
      e.target.value = formatInputPrice(e.target.value);
    }
    if (e.target.matches('.kb-offer-settlement')) {
      e.target.value = formatSettlement(e.target.value);
    }
    if (e.target.matches('.kb-odep-amount')) {
      const price = parseDepositAmountKanban(overlay.querySelector('.kb-offer-price')?.value || '', null) || 0;
      const num = parseDepositAmountKanban(e.target.value, price);
      e.target.value = num ? formatDepositAmount(num, price) : '';
    }
    if (e.target.matches('.kb-odep-due')) {
      e.target.value = formatDepositDue(e.target.value);
    }
  }, true);

  overlay.addEventListener('click', e => {
    if (!e.target.matches('.kb-offer-add-deposit') && !e.target.closest('.kb-offer-add-deposit')) return;
    const el = overlay.querySelector('.kb-offer-deposits');
    const current = Array.from(el.querySelectorAll('.kb-offer-dep-row')).map(row => ({
      amount: row.querySelector('.kb-odep-amount').value,
      due:    parseSettlementDays(row.querySelector('.kb-odep-due').value),
      note:   row.querySelector('.kb-odep-note').value,
    }));
    current.push({ amount: '', due: '', note: '' });
    el.innerHTML = buildOfferDepositsHtml(current);
  });
  overlay.addEventListener('click', e => {
    if (!e.target.closest('.kb-offer-deposits')) return;
    const btn = e.target.closest('.kb-odep-remove');
    if (!btn) return;
    const el = overlay.querySelector('.kb-offer-deposits');
    const current = Array.from(el.querySelectorAll('.kb-offer-dep-row')).map(row => ({
      amount: row.querySelector('.kb-odep-amount').value,
      due:    parseSettlementDays(row.querySelector('.kb-odep-due').value),
      note:   row.querySelector('.kb-odep-note').value,
    }));
    current.splice(parseInt(btn.dataset.idx, 10), 1);
    if (!current.length) current.push({ amount: '', due: '', note: '' });
    el.innerHTML = buildOfferDepositsHtml(current);
  });

  function refreshFinancePicker() {
    const pickerEl = document.getElementById(`kb-finance-picker-${id}`);
    if (pickerEl) pickerEl.innerHTML = buildFinancePickerHtml(getOffers(id), getTerms(id), pipeline[id]?.property || {});
  }

  // Submit offer
  overlay.addEventListener('click', e => {
    if (!e.target.closest('.kb-submit-offer')) return;
    // Force blur all inputs so any unblurred values are committed before we read them
    overlay.querySelectorAll('.kb-offer-price, .kb-offer-settlement, .kb-odep-amount, .kb-odep-due, .kb-odep-note').forEach(el => el.blur());
    const _offerPrice = parseDepositAmountKanban(overlay.querySelector('.kb-offer-price')?.value || '', null) || 0;
    const offerDeposits = Array.from(overlay.querySelectorAll('.kb-offer-dep-row')).map(row => ({
      amount: parseDepositAmountKanban(row.querySelector('.kb-odep-amount').value, _offerPrice),
      due:    parseSettlementDays(row.querySelector('.kb-odep-due').value),
      note:   row.querySelector('.kb-odep-note').value,
    })).filter(d => d.amount || d.due);
    const offer = {
      price:      formatInputPrice(overlay.querySelector('.kb-offer-price')?.value.trim() || ''),
      settlement: parseSettlementDays(overlay.querySelector('.kb-offer-settlement')?.value.trim() || ''),
      deposits:   offerDeposits,
    };
    if (!offer.price && !offer.settlement && !offerDeposits.length) return;
    addOffer(id, offer);
    const _priceEl = overlay.querySelector('.kb-offer-price');
    const _settleEl = overlay.querySelector('.kb-offer-settlement');
    const _depsEl = overlay.querySelector('.kb-offer-deposits');
    if (_priceEl) _priceEl.value = '';
    if (_settleEl) _settleEl.value = '';
    if (_depsEl) _depsEl.innerHTML = buildOfferDepositsHtml([{ amount: '', due: '', note: '' }], 0);
    refreshFinancePicker();
    refreshCardLive(id);
    showKanbanToast('Offer recorded');
  });

  // Delete offer — handled in finance picker (V77.1: Acquisition only)
  if (modal.querySelector(`#kb-finance-picker-${id}`)) {
    modal.querySelector(`#kb-finance-picker-${id}`).addEventListener('click', e => {
      const btn = e.target.closest('.kb-fin-pick-delete');
      if (!btn) return;
      deleteOffer(id, btn.dataset.offerId);
      refreshFinancePicker();
      refreshCardLive(id);
    });
  }

  // DD — V77.1: Acquisition only
  if (modal.querySelector('.kb-dd')) {
    modal.querySelector('.kb-dd').addEventListener('change', e => {
      const sel = e.target.closest('.kb-dd-select');
      if (!sel) return;
      const key = sel.dataset.key;
      const val = sel.value;
      const dd  = getDd(id);
      if (!dd[key]) dd[key] = { status: '', note: '' };
      dd[key].status = val;
      saveDd(id, dd);
      sel.className = `kb-dd-select dd-risk-${val || 'none'}`;
      refreshCardLive(id);
    });
    modal.querySelector('.kb-dd').addEventListener('input', e => {
      if (!e.target.matches('.kb-dd-note')) return;
      const key = e.target.dataset.key;
      const dd  = getDd(id);
      if (!dd[key]) dd[key] = { status: '', note: '' };
      dd[key].note = e.target.value;
      saveDd(id, dd);
    });
    // V78i — paperclip click opens the attachments dialog for this DD risk
    modal.querySelector('.kb-dd').addEventListener('click', e => {
      const btn = e.target.closest('.kb-dd-attach-btn');
      if (!btn) return;
      const ddKey  = btn.dataset.key;
      const dealId = btn.dataset.dealId;
      openDdAttachmentsDialog(dealId, ddKey, modal);
    });
    // V78i — Load and render attachment counts for this deal so the badges
    // reflect existing files when the modal opens.
    refreshDdAttachmentCounts(id, modal);
  }
}

// V78i — Load DD attachment counts for a deal and stamp the badges in the modal.
// Called on modal open and after any upload/delete that changes counts.
async function refreshDdAttachmentCounts(dealId, modal) {
  try {
    const res = await fetch(`/api/dd-attachments?deal_id=${encodeURIComponent(dealId)}`);
    if (!res.ok) return;
    const rows = await res.json();
    const counts = {};
    for (const r of rows) {
      counts[r.dd_key] = (counts[r.dd_key] || 0) + 1;
    }
    modal.querySelectorAll('.kb-dd-attach-count').forEach(span => {
      const key = span.dataset.key;
      const n = counts[key] || 0;
      span.textContent = n > 0 ? ` ${n}` : '';
      const btn = span.closest('.kb-dd-attach-btn');
      if (btn) btn.classList.toggle('kb-dd-attach-has-files', n > 0);
    });
  } catch (err) {
    console.warn('[dd-attachments] count refresh failed:', err);
  }
}

// V78i — Modal dialog listing files for a given DD risk, with upload + delete.
// Uses the existing kb-modal-overlay pattern (same as the v78c contact picker
// and v78g board picker).
function openDdAttachmentsDialog(dealId, ddKey, parentModal) {
  const wrap = document.createElement('div');
  wrap.className = 'kb-modal-overlay kb-dd-attach-overlay';
  // Pretty-case the dd_key for the heading (e.g. "zoning" → "Zoning")
  const niceKey = ddKey.charAt(0).toUpperCase() + ddKey.slice(1);
  wrap.innerHTML = `
    <div class="kb-modal" role="dialog" aria-modal="true" style="max-width:560px">
      <div class="kb-modal-header">
        <h2>Attachments — ${escapeHtml(niceKey)}</h2>
        <button class="kb-modal-close" title="Close" type="button">✕</button>
      </div>
      <div class="kb-modal-body">
        <div class="kb-dd-attach-list" data-list>
          <div class="kb-dd-attach-loading">Loading…</div>
        </div>
        <div class="kb-dd-attach-upload">
          <input type="file" class="kb-dd-attach-file-input" accept=".pdf,.jpg,.jpeg,.png,.heic,.heif,application/pdf,image/jpeg,image/png,image/heic,image/heif">
          <span class="kb-dd-attach-upload-help">PDF, JPEG, PNG, HEIC. Max 10 MB.</span>
        </div>
        <div class="kb-dd-attach-error" data-error style="display:none"></div>
      </div>
      <div class="kb-modal-footer">
        <button type="button" class="kb-dd-attach-done-btn">Done</button>
      </div>
    </div>
  `;
  document.body.appendChild(wrap);

  const listEl  = wrap.querySelector('[data-list]');
  const errEl   = wrap.querySelector('[data-error]');
  const fileInp = wrap.querySelector('.kb-dd-attach-file-input');

  function showError(msg) {
    errEl.textContent = msg || '';
    errEl.style.display = msg ? '' : 'none';
  }

  async function loadList() {
    listEl.innerHTML = '<div class="kb-dd-attach-loading">Loading…</div>';
    try {
      const res = await fetch(`/api/dd-attachments?deal_id=${encodeURIComponent(dealId)}&dd_key=${encodeURIComponent(ddKey)}`);
      if (!res.ok) throw new Error('Load failed: ' + res.status);
      const rows = await res.json();
      renderList(rows);
    } catch (err) {
      listEl.innerHTML = `<div class="kb-dd-attach-empty">Could not load: ${escapeHtml(err.message)}</div>`;
    }
  }

  function renderList(rows) {
    if (!rows.length) {
      listEl.innerHTML = '<div class="kb-dd-attach-empty">No files attached yet.</div>';
      return;
    }
    listEl.innerHTML = rows.map(r => {
      const sizeKb = r.size_bytes ? Math.round(r.size_bytes / 1024) + ' KB' : '';
      const when = r.uploaded_at ? new Date(r.uploaded_at).toLocaleString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' }) : '';
      return `
        <div class="kb-dd-attach-row" data-id="${r.id}">
          <span class="kb-dd-attach-icon">📄</span>
          <a class="kb-dd-attach-name" href="/api/dd-attachments?id=${r.id}&action=view" target="_blank" rel="noopener" title="${escapeHtml(r.filename)}">${escapeHtml(r.filename)}</a>
          <span class="kb-dd-attach-meta">${sizeKb}${when ? ' · ' + when : ''}</span>
          <button type="button" class="kb-dd-attach-remove" data-id="${r.id}" title="Remove">Remove</button>
        </div>`;
    }).join('');
    listEl.querySelectorAll('.kb-dd-attach-remove').forEach(btn => {
      btn.addEventListener('click', () => removeOne(btn.dataset.id));
    });
  }

  async function removeOne(id) {
    if (!confirm('Remove this file?')) return;
    showError('');
    try {
      const res = await fetch(`/api/dd-attachments?id=${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.error || ('Delete failed: ' + res.status));
      }
      await loadList();
      if (parentModal) refreshDdAttachmentCounts(dealId, parentModal);
    } catch (err) {
      showError('Remove failed: ' + err.message);
    }
  }

  fileInp.addEventListener('change', async () => {
    const file = fileInp.files && fileInp.files[0];
    if (!file) return;
    showError('');
    if (file.size > 10 * 1024 * 1024) {
      showError('File too large. Max 10 MB.');
      fileInp.value = '';
      return;
    }
    try {
      const base64 = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload  = () => res(String(r.result).split(',')[1] || '');
        r.onerror = () => rej(new Error('File read failed'));
        r.readAsDataURL(file);
      });
      const res = await fetch('/api/dd-attachments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deal_id:    dealId,
          dd_key:     ddKey,
          filename:   file.name,
          mime_type:  file.type,
          size:       file.size,
          body_base64: base64,
        }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.error || ('Upload failed: ' + res.status));
      }
      fileInp.value = '';
      await loadList();
      if (parentModal) refreshDdAttachmentCounts(dealId, parentModal);
    } catch (err) {
      showError('Upload failed: ' + err.message);
    }
  });

  function close() {
    if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
  }
  wrap.querySelector('.kb-modal-close').addEventListener('click', close);
  wrap.querySelector('.kb-dd-attach-done-btn').addEventListener('click', close);

  loadList();
}

// V76.9: ─── Board sync framework ─────────────────────────────────────────────
//
// Both the deal board and the actions board share the same lifecycle concerns:
//   - Render-card-in-place (after a save, without rebuilding the whole board)
//   - Stale-while-revalidate (paint cached data immediately, refresh from server)
//   - Multi-user sync (pull background changes when the user takes an action)
//
// Rather than duplicate this logic per board, we expose a small generic helper
// (`createBoardSync`) and define one adapter per board. Each adapter knows how
// to: fetch, identify cards, locate them in the DOM, refresh them in place,
// and detect filter mismatches.
//
// Adapter shape:
//   {
//     name:           string           // for log prefixes
//     load():         Promise<Map>     // fetch all rows; returns id→entity Map
//     getCache():     Map              // current in-memory cache (id→entity)
//     setCache(map):  void             // replace in-memory cache
//     fingerprint(e): string           // cheap value identity (eg JSON of entity)
//     cardSelector(id): string         // CSS selector for the DOM card
//     matchesFilter(id, entity): bool  // does this entity match active search?
//     patchCard(id):  void             // update DOM card content in place
//     fullRender():   void             // full re-render of the board
//     boardVisible(): bool             // is this board currently shown?
//   }
//
// The framework returns:
//   {
//     refreshCardLive(id): void              // patch one card after a save
//     refreshIfStale({ editingId, force }): Promise<void>  // multi-user check
//   }
function createBoardSync(adapter) {
  const MIN_INTERVAL_MS = 30_000;
  let inflight = false;
  let lastFreshAt = 0;

  // Single-card refresh — handles three cases without rebuilding the board:
  //   (a) Card on board, still matches filter → patch in place
  //   (b) Card on board, no longer matches filter → remove from DOM
  //   (c) Card not on board, now matches filter → fall back to full render
  //       (column placement & ordering need recomputing)
  function refreshCardLive(id) {
    const cache = adapter.getCache();
    const entity = cache.get(id);
    if (!entity) {
      // Entity removed — drop the card if it's there
      const stale = document.querySelector(adapter.cardSelector(id));
      if (stale) stale.remove();
      return;
    }
    const card = document.querySelector(adapter.cardSelector(id));
    const stillMatches = adapter.matchesFilter(id, entity);
    if (card && stillMatches) { adapter.patchCard(id); return; }
    if (card && !stillMatches) { card.remove(); return; }
    // Card belongs on the board but isn't there → full render
    adapter.fullRender();
  }

  // Stale-while-revalidate refresh. Compares fresh server data against the
  // local cache and surgically updates only the cards that changed. Skips the
  // entity currently being edited so the user isn't disrupted mid-edit.
  // Debounced — at most one call per MIN_INTERVAL_MS unless force=true.
  async function refreshIfStale(opts = {}) {
    const now = Date.now();
    const minInterval = opts.force ? 0 : MIN_INTERVAL_MS;
    if (now - lastFreshAt < minInterval) return;
    if (inflight) return;
    inflight = true;
    try {
      const fresh = await adapter.load();
      if (!fresh) return;

      const editingId = opts.editingId != null ? String(opts.editingId) : null;
      const cache = adapter.getCache();
      const changedIds = new Set();

      // Added or modified
      for (const [id, after] of fresh.entries()) {
        if (editingId && String(id) === editingId) continue;
        const before = cache.get(id);
        if (!before || adapter.fingerprint(before) !== adapter.fingerprint(after)) {
          changedIds.add(id);
        }
      }
      // Removed
      for (const id of cache.keys()) {
        if (editingId && String(id) === editingId) continue;
        if (!fresh.has(id)) changedIds.add(id);
      }

      if (changedIds.size === 0) {
        lastFreshAt = now;
        return;
      }

      // Reconcile cache (preserving the entity being edited as-is)
      const next = new Map();
      if (editingId && cache.has(editingId)) next.set(editingId, cache.get(editingId));
      for (const [id, entity] of fresh.entries()) {
        if (editingId && String(id) === editingId) continue;
        next.set(id, entity);
      }
      adapter.setCache(next);

      // Threshold: if too many cards changed, a full render is cheaper than
      // N in-place updates (and avoids visible flicker from many DOM mutations).
      if (!adapter.boardVisible()) { lastFreshAt = now; return; }
      if (changedIds.size > 5) {
        adapter.fullRender();
      } else {
        changedIds.forEach(id => refreshCardLive(id));
      }
      lastFreshAt = now;
    } catch (err) {
      console.warn(`[${adapter.name}] staleness check failed:`, err.message);
    } finally {
      inflight = false;
    }
  }

  // Mark the cache as freshly loaded right now — useful when an external
  // path has just done its own fetch (e.g. initPipeline or board switch),
  // so our debounce avoids a redundant duplicate fetch right after.
  function markFresh() { lastFreshAt = Date.now(); }

  return { refreshCardLive, refreshIfStale, markFresh };
}

// ─── Adapter: Deal board (uses the `pipeline` dict) ──────────────────────────
const _dealsBoardSync = createBoardSync({
  name: 'pipeline',
  async load() {
    if (!dbAvailable) return null;
    const dict = await dbLoad();
    if (!dict) return null;
    return new Map(Object.entries(dict));
  },
  getCache() {
    return new Map(Object.entries(pipeline));
  },
  setCache(map) {
    for (const k of Object.keys(pipeline)) delete pipeline[k];
    for (const [id, entity] of map.entries()) pipeline[id] = entity;
  },
  fingerprint(entity) { return JSON.stringify(entity); },
  cardSelector(id) { return `.kb-card[data-id="${id}"]`; },
  matchesFilter(id, entity) { return _searchMatches(id, entity); },
  patchCard(id) {
    const item = pipeline[id]; if (!item) return;
    const card = document.querySelector(`.kb-card[data-id="${id}"]`);
    if (!card) return;
    refreshCardIndicators(card, id);
    card.classList.toggle('kb-card-attention', !!item._hasOverdueAction);
    const sel = card.querySelector('.kb-stage-select');
    if (sel) {
      const wantedColId = item._columnId || stageToColumnId(item.stage);
      if (sel.value !== wantedColId) sel.value = wantedColId;
    }
  },
  fullRender() { renderBoard(); },
  boardVisible() {
    if (!kanbanVisible) return false;
    const active = boards.find(b => b.id === currentBoardId);
    return active?.board_type !== 'action';
  },
});

// Public aliases — call sites use these names; the actions equivalents below
// are exported via _actionsBoardSync.
function refreshCardLive(id) { return _dealsBoardSync.refreshCardLive(id); }
function refreshPipelineIfStale(opts) { return _dealsBoardSync.refreshIfStale(opts); }
function markPipelineFresh() { _dealsBoardSync.markFresh(); }

// V76.9: After an optimistic drag-drop, the column header count badges need
// to reflect the new card distribution. Cheaper than a full renderBoard().
function _updateColumnCounts() {
  document.querySelectorAll('.kb-col').forEach(col => {
    const cards = col.querySelectorAll('.kb-cards .kb-card').length;
    const counter = col.querySelector('.kb-col-header .kb-count');
    if (counter) counter.textContent = String(cards);
  });
}

// ─── Adapter: Actions board (uses the `_actionsCache` array) ─────────────────
const _actionsBoardSync = createBoardSync({
  name: 'actions',
  async load() {
    const { actions } = await fetchMyActions();
    if (!actions) return null;
    return new Map(actions.map(a => [String(a.id), a]));
  },
  getCache() {
    return new Map((_actionsCache || []).map(a => [String(a.id), a]));
  },
  setCache(map) {
    _actionsCache = Array.from(map.values());
    if (_actionsBoardCache) _actionsBoardCache.actions = _actionsCache;
  },
  fingerprint(a) {
    // Cheap value identity — only fields that affect rendering.
    return [
      a.description, a.column_id, a.column_order, a.status,
      a.assignee?.id, a.assignee?.name, a.deal?.id, a.deal?.label,
      a.due_date, a.reminder_date, a.effort_days, a.duration_days,
    ].join('|');
  },
  cardSelector(id) { return `.kb-action-card[data-id="${id}"]`; },
  matchesFilter(_id, _entity) { return true; }, // actions board has no search filter (yet)
  patchCard(id) {
    const a = (_actionsCache || []).find(x => String(x.id) === String(id));
    if (!a) return;
    const oldCard = document.querySelector(`.kb-action-card[data-id="${id}"]`);
    if (!oldCard) return;
    // Build a fresh card and swap in place. Cheap because it's one card,
    // and avoids hand-coding every field-level patch (description, dates,
    // assignee, deal link, effort/duration, attention bar).
    const newCard = _buildActionCard(a);
    oldCard.replaceWith(newCard);
  },
  fullRender() { renderBoard(); },
  boardVisible() {
    if (!kanbanVisible) return false;
    const active = boards.find(b => b.id === currentBoardId);
    return active?.board_type === 'action';
  },
});

function refreshActionCardLive(id) { return _actionsBoardSync.refreshCardLive(id); }
function refreshActionsIfStale(opts) { return _actionsBoardSync.refreshIfStale(opts); }
function markActionsFresh() { _actionsBoardSync.markFresh(); }

// Refresh just the indicator pills on a board card without re-rendering the whole board
function refreshCardIndicators(card, id) {
  const item   = pipeline[id]; if (!item) return;
  const p      = item.property;
  const terms  = getTerms(id);
  const offers = getOffers(id);
  const dd     = getDd(id);
  const ddCount = DD_ITEMS.filter(i => dd[i.toLowerCase()]?.status).length;
  const ddHigh  = DD_ITEMS.some(i => dd[i.toLowerCase()]?.status === 'high');
  const ddPoss  = DD_ITEMS.some(i => dd[i.toLowerCase()]?.status === 'possible');
  const ddClass = ddCount === 0 ? '' : ddHigh ? 'dd-high' : ddPoss ? 'dd-possible' : 'dd-low';
  // V80.3 — Terms badge removed from cards.

  // Update price (Lease-aware — Lease Listings show rent, not "Price Unavailable").
  const priceEl = card.querySelector('.kb-card-price');
  if (priceEl) {
    const isLeaseListing = (item._boardId || currentBoardId) === 'sys_lease_listings';
    priceEl.innerHTML = isLeaseListing ? formatKbRent(terms) : formatKbPrice(p.price, terms.price);
  }

  const el = card.querySelector('.kb-card-indicators');
  if (!el) return;
  // V75.3: note indicator reads from the notes cache only — it appears after
  // the card modal has been opened at least once (which populates the cache).
  // This avoids N extra API calls on Kanban board render.
  const cachedNotes = _notesCache.get(id);
  const noteCount = Array.isArray(cachedNotes) ? cachedNotes.length : 0;
  el.innerHTML = `
    ${offers.length ? `<span class="kb-ind kb-ind-offers">${offers.length} Offer${offers.length > 1 ? 's' : ''}</span>` : ''}
    ${ddCount     ? `<span class="kb-ind kb-ind-dd ${ddClass}">DD ${ddCount}/${DD_ITEMS.length}</span>` : ''}
    ${noteCount   ? `<span class="kb-ind kb-ind-note">${noteCount} Note${noteCount > 1 ? 's' : ''}</span>` : ''}
  `;
}

// ─── Highlight a card already in pipeline ────────────────────────────────────

function highlightCard(id) {
  if (!kanbanVisible) toggleKanban(true);
  setTimeout(() => {
    const card = document.querySelector(`.kb-card[data-id="${id}"]`);
    if (card) {
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      card.classList.add('flash');
      setTimeout(() => card.classList.remove('flash'), 1200);
    }
  }, 100);
}

// ─── Toast ────────────────────────────────────────────────────────────────────

function showKanbanToast(msg) {
  let toast = document.getElementById('kanbanToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'kanbanToast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.remove('show'), 2500);
}

// ─── Init ─────────────────────────────────────────────────────────────────────

document.getElementById('kanbanToggleBtn').addEventListener('click', () => toggleKanban());
document.getElementById('kanbanClose').addEventListener('click', () => {
  // V81.3: back-navigate to previous screen (was: always /mapping)
  if (window.Router?.back) window.Router.back();
  else if (window.Router?.navigate) window.Router.navigate('/');
  else toggleKanban(false);
});

// ─── CRM View ─────────────────────────────────────────────────────────────────

let crmVisible = false;

function toggleCRM(show) {
  crmVisible = show !== undefined ? show : !crmVisible;
  const view = document.getElementById('crmView');
  const btn  = document.getElementById('crmNavBtn');
  if (!view || !btn) return;
  view.classList.toggle('visible', crmVisible);
  btn.classList.toggle('active', crmVisible);
  if (crmVisible && window.CRM?.renderCRMView) {
    const container = document.getElementById('crmViewContent');
    if (container && !container.dataset.rendered) {
      container.dataset.rendered = '1';
      CRM.renderCRMView(container);
    }
  }
}

const crmNavBtn = document.getElementById('crmNavBtn');
if (crmNavBtn) crmNavBtn.addEventListener('click', () => toggleCRM());

const crmClose = document.getElementById('crmClose');
if (crmClose) crmClose.addEventListener('click', () => {
  // V81.3: back-navigate to previous screen (was: always /mapping)
  if (window.Router?.back) window.Router.back();
  else if (window.Router?.navigate) window.Router.navigate('/');
  else toggleCRM(false);
});

// Patch renderListings to always refresh add buttons after render
const _origRenderListings = renderListings;
window.renderListings = function () {
  _origRenderListings();
  setTimeout(updateAddButtons, 0);
};

window.backfillAgentFromCache = function () {
  if (!window.matchListingByAddress || !window.getListings) return;
  const currentListings = window.getListings();
  if (!currentListings.length) return;
  let changed = false;
  Object.keys(pipeline).forEach(id => {
    const item = pipeline[id];
    if (!item?.property) return;
    const p = item.property;
    if (p._agent?.name || p._agent?.email || p._agent?.phone) return;
    const hit = matchListingByAddress(currentListings, p.address, p.suburb, p._lotDPs);
    if (!hit) return;
    if (hit.agent) { p._agent = hit.agent; changed = true; }
    if (hit.listingUrl && !p._listingUrl) { p._listingUrl = hit.listingUrl; changed = true; }
    if (changed) dbSave(id, item);
  });
  if (changed) cacheSave(pipeline);
};

// Load pipeline from DB (falls back to localStorage if offline)
initPipeline();

// ─── Pipeline map pins ────────────────────────────────────────────────────────
// Expose pipeline data so map.js can render pipeline pins.
// Call window.refreshPipelinePins() after any pipeline change to sync the map.

window.getPipelineData = () => pipeline;
// V75.6: return current board's columns (with show_on_map flags etc).
// Falls back to static STAGES if boards haven't loaded.
window.getPipelineStages = () => resolveCurrentStages();
window.refreshPipelinePins = function () {
  if (typeof window._renderPipelinePins === 'function') window._renderPipelinePins();
};

// V76.7 — Listen for property/parcel mutations from other modules (CRM, etc).
// When fired, the in-memory `pipeline` dict may be stale, so re-fetch the
// current board's deals from the DB and re-render. dbLoad() is cheap (one
// HTTP roundtrip, ≤50 deals typically), and only runs on user-initiated
// CRM saves so the cost is bounded.
//
// V76.7+ — Two safety improvements:
//   (1) Defer the refresh while the user is actively interacting (drag in
//       progress, modal open). Otherwise cards can shift columns or the modal
//       can re-render mid-edit. The deferred refresh runs as soon as the
//       interaction ends.
//   (2) Show a small "Updating…" overlay during the refresh so the user knows
//       the board is briefly unstable.

let _pendingRefreshReason = null;     // queued reason while deferred
let _refreshInProgress    = false;    // prevents reentry

function _isUserInteracting() {
  // Drag in progress?
  if (document.querySelector('.kb-card.dragging, .kb-action-row.dragging')) return true;
  // Modal open? (any kb-modal-overlay attached to body)
  if (document.querySelector('.kb-modal-overlay')) return true;
  return false;
}

function _showRefreshOverlay() {
  const board = document.getElementById('kanbanBoard');
  if (!board) return;
  if (board.querySelector('.kb-refresh-overlay')) return;
  const ov = document.createElement('div');
  ov.className = 'kb-refresh-overlay';
  ov.innerHTML = '<div class="kb-refresh-overlay-inner">Updating pipeline…</div>';
  board.appendChild(ov);
}
function _hideRefreshOverlay() {
  const ov = document.querySelector('#kanbanBoard .kb-refresh-overlay');
  if (ov) ov.remove();
}

async function _refreshPipelineFromDB(reason) {
  if (!dbAvailable) return;
  // Defer if the user is mid-interaction. Re-check on a short interval and
  // fire as soon as they're idle.
  if (_isUserInteracting()) {
    _pendingRefreshReason = reason;
    if (!_pendingRefreshReason._poller) {
      const poll = setInterval(() => {
        if (!_isUserInteracting()) {
          clearInterval(poll);
          const r = _pendingRefreshReason;
          _pendingRefreshReason = null;
          _refreshPipelineFromDB(r);
        }
      }, 250);
    }
    return;
  }
  if (_refreshInProgress) return;
  _refreshInProgress = true;
  _showRefreshOverlay();
  try {
    const dict = await dbLoad();
    if (!dict) return;
    Object.keys(pipeline).forEach(k => delete pipeline[k]);
    Object.assign(pipeline, dict);
    cacheSave(pipeline);
    // V76.7+ — invalidate the contacts search cache too (deals may have been
    // added/removed and contact links may have changed).
    _searchContactsCache = null;
    if (typeof renderBoard === 'function' && kanbanVisible) renderBoard();
    if (typeof window.refreshPipelinePins === 'function') window.refreshPipelinePins();
    // V76.9: just freshly loaded — debounce subsequent stale-checks so the
    // next user action doesn't immediately re-fetch.
    markPipelineFresh();
    console.log('[kanban] pipeline refreshed (' + reason + ')');
  } catch (err) {
    console.warn('[kanban] pipeline refresh failed:', err);
  } finally {
    _refreshInProgress = false;
    _hideRefreshOverlay();
  }
}

window.addEventListener('propertyChanged', (e) => {
  const propertyId = e?.detail?.propertyId;
  if (!propertyId) return;
  // Quick check: only refresh if at least one pipeline entry references this
  // property. Avoids the round-trip when the user edits a CRM-only property
  // that was never added to a deal.
  const referenced = Object.values(pipeline).some(entry =>
    String(entry?.property?.id) === String(propertyId)
  );
  if (!referenced) return;
  _refreshPipelineFromDB('property ' + propertyId + ' changed');
});

window.addEventListener('parcelChanged', (e) => {
  const parcelId = e?.detail?.parcelId;
  if (!parcelId) return;
  // Parcel deals use the parcel id as their property "id" slot (see
  // dealRowToInternal parcel branch); also check _parcelId on the entry.
  const referenced = Object.values(pipeline).some(entry =>
    String(entry?.property?._parcelId || entry?.property?.id) === String(parcelId)
  );
  if (!referenced) return;
  _refreshPipelineFromDB('parcel ' + parcelId + ' changed');
});

// V76.9: Multi-user sync — when the tab regains focus (user comes back from
// another tab/window), opportunistically check whether the server has fresher
// data than what's cached. Both the deal pipeline and the actions board are
// checked; their respective BoardSync adapters debounce each independently.
window.addEventListener('focus', () => {
  if (!kanbanVisible) return;
  refreshPipelineIfStale();
  refreshActionsIfStale();
});

// Expose for cross-module navigation (CRM deep-links into a pipeline item)
// V76.4.2: handle cross-board navigation. The local `pipeline` dict is scoped
//   to currentBoardId only — clicking a deal link from My Actions used to fail
//   with "no longer exists" if the deal lives on a different board.
// V76.4.4: fast-path the slow case. Previously we fetched the deal, then
//   fetched the entire target board's deals + per-user ordering, then
//   re-rendered the board twice before opening the modal — three sequential
//   round-trips and heavy DOM work for a single-modal request. Now we open
//   the modal as soon as the single-deal fetch returns (one round-trip), and
//   reload the rest of the board in the background. The modal already had
//   everything it needed from that single fetch.
window.openPipelineItem = async function (pipelineId) {
  // Fast path A: deal is already loaded in the current board's cache
  if (pipeline[pipelineId]) {
    if (crmVisible) toggleCRM(false);
    if (!kanbanVisible) toggleKanban(true);
    setTimeout(() => openCardModal(pipelineId), 50);
    return;
  }

  // Slow path: one fetch, then open immediately. The full-board reload runs
  // in the background and the user doesn't wait for it.
  let dealRow = null;
  try {
    const r = await fetch(`/api/deals?id=${encodeURIComponent(pipelineId)}`);
    if (r.ok) dealRow = await r.json();
  } catch (_) { /* fall through */ }

  if (!dealRow || !dealRow.id) {
    alert('That pipeline item no longer exists.');
    return;
  }

  // Reveal Kanban, but DON'T re-render before we have the deal in the dict.
  // Ensure visibility without triggering a wholesale renderBoard for the
  // (about-to-be-changed) currentBoardId, which would briefly show an empty
  // target board.
  if (crmVisible) toggleCRM(false);
  if (!kanbanVisible) {
    kanbanVisible = true;
    window.kanbanVisible = true;
    document.getElementById('kanbanView').classList.toggle('visible', true);
    document.getElementById('kanbanToggleBtn')?.classList.add('active');
    refreshDueBadge();
  }

  const targetBoardId = dealRow.board_id || currentBoardId;
  const switching = targetBoardId !== currentBoardId;

  // Drop the single deal into the dict immediately, even before we know if
  // we're on its board, so openCardModal() finds it.
  pipeline[pipelineId] = dealRowToInternal(dealRow);

  if (switching) {
    currentBoardId = targetBoardId;
    const sel = document.getElementById('kanbanBoardSelect');
    if (sel) sel.value = currentBoardId;
  }

  // Open the modal NOW — it's fully renderable from the single deal we have.
  openCardModal(pipelineId);

  // Background: reload the rest of the target board so when the user closes
  // the modal they see the full board populated. We don't await this; the
  // user is already looking at the modal.
  (async () => {
    try {
      const [dict, _order] = await Promise.all([dbLoad(), loadUserDealOrder()]);
      if (dict) {
        // Preserve the deal we already inserted (it has the freshest data
        // we needed for the modal); merge the rest of the board over it.
        const merged = { ...dict, [pipelineId]: pipeline[pipelineId] || dict[pipelineId] };
        Object.keys(pipeline).forEach(k => delete pipeline[k]);
        Object.assign(pipeline, merged);
      }
      cacheSave(pipeline);
      // Re-render only if Kanban is still visible AND no modal is open
      // (avoid yanking the page out from under the user).
      if (kanbanVisible && !document.getElementById('kb-modal')) {
        renderBoard();
      }
      if (typeof window.refreshPipelinePins === 'function') window.refreshPipelinePins();
    } catch (err) {
      console.warn('[openPipelineItem] background reload failed:', err.message);
    }
  })();
};

// V76.7+ — Expose addPropertyOnly for the map popup's "+ Property" button.
// Called from map.js (via window.addCurrentSelectionAsProperty wrapper).
window.addPropertyOnly = addPropertyOnly;

// V76.7+ — Expose the generic confirm modal so other modules (CRM, map.js)
// can use the same site-styled overlay instead of native confirm() dialogs.
window.openConfirmModal = openConfirmModal;
