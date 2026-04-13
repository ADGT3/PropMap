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

// ─── Stage definitions ────────────────────────────────────────────────────────

const STAGES = [
  { id: 'shortlisted',   label: 'Shortlisted',   color: '#f39c12' },
  { id: 'under-dd',      label: 'Under DD',       color: '#8e44ad' },
  { id: 'offer',         label: 'Offer',          color: '#2980b9' },
  { id: 'acquired',      label: 'Acquired',       color: '#27ae60' },
  { id: 'not-suitable',  label: 'Not Suitable',   color: '#95a5a6' },
  { id: 'lost',          label: 'Lost',           color: '#c0392b' },
];

// ─── State ────────────────────────────────────────────────────────────────────

const STORAGE_KEY = 'propertyPipeline';
const API_BASE    = '/api/pipeline';

// In-memory pipeline — loaded from DB on init, localStorage used as fallback cache
let pipeline = {};
let dbAvailable = false;

// ── localStorage helpers (cache / offline fallback) ──────────────────────────
function cacheLoad() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch (_) { return {}; }
}
function cacheSave(p) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(p)); } catch (_) {}
}

// ── DB helpers ────────────────────────────────────────────────────────────────
async function dbLoad() {
  try {
    const res = await fetch(API_BASE);
    if (!res.ok) throw new Error(res.status);
    const data = await res.json();
    dbAvailable = true;
    return data;
  } catch (_) {
    dbAvailable = false;
    return null;
  }
}

async function dbSave(id, data) {
  if (!dbAvailable) return;
  try {
    await fetch(API_BASE, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ id, data })
    });
  } catch (_) {}
}

async function dbDelete(id) {
  if (!dbAvailable) return;
  try {
    await fetch(`${API_BASE}?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
  } catch (_) {}
}

// ── savePipeline — write to both cache and DB ─────────────────────────────────
// Called after every mutation. id = the specific entry that changed (or null = full sync).
function savePipeline(changedId) {
  cacheSave(pipeline);
  if (changedId && pipeline[changedId]) dbSave(changedId, pipeline[changedId]);
  if (typeof window.refreshPipelinePins === 'function') window.refreshPipelinePins();
}

// ── Init — load from DB, fall back to localStorage ───────────────────────────
async function initPipeline() {
  // Load from localStorage immediately so board is usable at once
  pipeline = cacheLoad();
  updateAddButtons();

  // Then try to sync from DB in background
  const remote = await dbLoad();
  if (remote !== null) {
    pipeline = remote;
    cacheSave(pipeline);
    if (typeof window.refreshPipelinePins === 'function') window.refreshPipelinePins();
    updateAddButtons();
    if (kanbanVisible) renderBoard();
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
  if (kanbanVisible) renderBoard();
}

// ─── Add property to pipeline ────────────────────────────────────────────────

function addToPipeline(listing) {
  const id = String(listing.id);
  if (pipeline[id]) {
    highlightCard(id);
    return;
  }

  // Build _parcels array — multi-parcel entries already have it, single entries get one from lat/lng
  const parcels = listing._parcels && listing._parcels.length > 0
    ? listing._parcels
    : [{ lat: listing.lat, lng: listing.lng, label: `${listing.address}, ${listing.suburb}` }];

  pipeline[id] = {
    stage:   'shortlisted',
    note:    '',
    addedAt: Date.now(),
    property: {
      id:          listing.id,
      address:     listing.address,
      suburb:      listing.suburb,
      price:       listing.price,
      type:        listing.type,
      beds:        listing.beds,
      baths:       listing.baths,
      cars:        listing.cars,
      _parcels:    parcels,
      _lotDPs:        listing._lotDPs         || null,
      _areaSqm:       listing._areaSqm        || null,
      _propertyCount: listing._propertyCount  || 1,
      _agent:         listing.agent           || null,
      _listingUrl:    listing.listingUrl       || null,
    },
    dd: {}
  };
  savePipeline(id);
  updateAddButtons();
  if (kanbanVisible) renderBoard();
  showKanbanToast(`${listing.address} added to pipeline`);

  // Async — fetch Lot/DP from cadastre if not already present
  if (!pipeline[id].property._lotDPs && window.fetchLotDP) {
    const _lat = lat ?? parcels[0]?.lat ?? null;
    const _lng = lng ?? parcels[0]?.lng ?? null;
    if (_lat && _lng) {
      fetchLotDP(_lat, _lng).then(cadastre => {
        if (!pipeline[id] || !cadastre?.lotid) return;
        pipeline[id].property._lotDPs = cadastre.lotid;
        if (!pipeline[id].property._areaSqm && cadastre.areaSqm) pipeline[id].property._areaSqm = cadastre.areaSqm;
        savePipeline(id);
        const modal = document.getElementById('kb-modal');
        if (modal?.dataset?.propertyId === String(id)) {
          const lotEl = modal.querySelector('.kb-modal-lotdp');
          if (lotEl) lotEl.textContent = cadastre.lotid;
        }
        if (kanbanVisible) renderBoard();
      }).catch(() => {});
    }
  }

  // Async — query overlay layers and pre-populate DD risks
  const lat = listing.lat ?? parcels[0]?.lat ?? null;
  const lng = listing.lng ?? parcels[0]?.lng ?? null;
  if (lat && lng && window.queryDDRisks) {
    console.log('[DD] Querying risks for', listing.address, lat, lng);
    queryDDRisks(lat, lng).then(dd => {
      console.log('[DD] Results:', dd);
      if (!pipeline[id]) return;
      Object.entries(dd).forEach(([key, val]) => {
        if (!pipeline[id].dd[key]?.status) pipeline[id].dd[key] = val;
      });
      savePipeline(id);
      if (kanbanVisible) renderBoard();
      // If this card's modal is open, refresh its DD section
      refreshModalDd(id);
    }).catch(err => console.warn('[DD] Risk query failed:', err));
  } else {
    console.warn('[DD] Skipping risk query — lat:', lat, 'lng:', lng, 'queryDDRisks:', !!window.queryDDRisks);
  }
}

function removeFromPipeline(id) {
  const sid = String(id);
  delete pipeline[sid];
  cacheSave(pipeline);
  dbDelete(sid);
  updateAddButtons();
  renderBoard();
  if (typeof window.refreshPipelinePins === 'function') window.refreshPipelinePins();
}

function moveToStage(id, stageId) {
  if (pipeline[id]) {
    pipeline[id].stage = stageId;
    savePipeline(id);
  }
}

function getNotes(id) {
  const raw = pipeline[id]?.note;
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  return [{ text: raw, ts: pipeline[id].addedAt || Date.now() }];
}
function addNote(id, text, contactId = null, contactName = null) {
  if (!pipeline[id] || !text.trim()) return;
  const notes = getNotes(id);
  const entry = { text: text.trim(), ts: Date.now() };
  if (contactId)   entry.contact_id   = contactId;
  if (contactName) entry.contact_name = contactName;
  notes.unshift(entry);
  pipeline[id].note = notes;
  savePipeline(id);
  // Also write to contact_notes API for future CRM contact view
  if (contactId) {
    fetch('/api/contacts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'add_note', contact_id: contactId, pipeline_id: String(id), note_text: text.trim() })
    }).catch(err => console.warn('[CRM] failed to mirror note to contact_notes:', err));
  }
}
function deleteNote(id, ts) {
  if (!pipeline[id]) return;
  pipeline[id].note = getNotes(id).filter(n => n.ts !== ts);
  savePipeline(id);
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
  const fmt = v => {
    if (!v && v !== 0) return null;
    // Already a formatted string with $ — return as-is if it has digits
    if (typeof v === 'string' && /\d/.test(v)) {
      // Strip non-numeric except decimal, reformat as whole dollars
      const num = parseFloat(v.replace(/[^0-9.]/g, ''));
      return isNaN(num) ? v : '$' + Math.round(num).toLocaleString();
    }
    if (typeof v === 'number') return '$' + Math.round(v).toLocaleString();
    if (typeof v === 'object') {
      // Domain API price object { display, from, to }
      const { display, from, to } = v;
      const hasNum = display && /\d/.test(display);
      if (hasNum) {
        const num = parseFloat(display.replace(/[^0-9.]/g, ''));
        return isNaN(num) ? display : '$' + Math.round(num).toLocaleString();
      }
      if (from && to) return '$' + Math.round(from).toLocaleString() + ' – $' + Math.round(to).toLocaleString();
      if (from) return '$' + Math.round(from).toLocaleString();
      if (to)   return '$' + Math.round(to).toLocaleString();
    }
    return null;
  };

  const listed = fmt(price);
  if (listed && listed !== 'Price Unavailable') return listed;

  // Fall back to vendor terms price if listing price is unavailable
  const terms = fmt(termsPrice);
  if (terms) return terms + ' <span style="font-size:10px;opacity:0.7">(vendor terms)</span>';

  return 'Price Unavailable';
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

    const inPipeline = !!pipeline[id];
    btn.textContent = inPipeline ? '✓' : '+';
    btn.classList.toggle('in-pipeline', inPipeline);
    btn.title = inPipeline ? 'In pipeline' : 'Add to pipeline';
  });
}

// ─── Board render ─────────────────────────────────────────────────────────────

function renderBoard() {
  const board = document.getElementById('kanbanBoard');
  board.innerHTML = '';

  STAGES.forEach(stage => {
    const cards = Object.entries(pipeline)
      .filter(([, v]) => v.stage === stage.id)
      .sort((a, b) => a[1].addedAt - b[1].addedAt);

    const col = document.createElement('div');
    col.className = 'kb-col';
    col.dataset.stage = stage.id;

    col.innerHTML = `
      <div class="kb-col-header">
        <span class="kb-stage-dot" style="background:${stage.color}"></span>
        <span class="kb-stage-label">${stage.label}</span>
        <span class="kb-count">${cards.length}</span>
      </div>
      <div class="kb-cards" data-stage="${stage.id}"></div>
    `;

    const cardsEl = col.querySelector('.kb-cards');

    cards.forEach(([id, item]) => {
      const p = item.property;
      if (!p) return; // skip malformed entries
      const card = document.createElement('div');
      card.className = 'kb-card';
      card.draggable = true;
      card.dataset.id = id;

      // Compact summary indicators
      const terms    = getTerms(id);
      const offers   = getOffers(id);
      const dd       = getDd(id);
      const ddCount  = DD_ITEMS.filter(i => dd[i.toLowerCase()]?.status).length;
      const ddHigh   = DD_ITEMS.some(i => dd[i.toLowerCase()]?.status === 'high');
      const ddPoss   = DD_ITEMS.some(i => dd[i.toLowerCase()]?.status === 'possible');
      const ddClass  = ddCount === 0 ? '' : ddHigh ? 'dd-high' : ddPoss ? 'dd-possible' : 'dd-low';
      const hasTerms = (terms.price != null && terms.price !== '' && terms.price !== 0 && terms.price !== null) || (terms.settlement != null && terms.settlement !== '' && terms.settlement !== 0);

      const stageOptions = STAGES.map(s =>
        `<option value="${s.id}" ${s.id === item.stage ? 'selected' : ''}>${s.label}</option>`
      ).join('');

      card.innerHTML = `
        <div class="kb-card-top">
          <span class="kb-card-type">${p.type}</span>
          <button class="kb-remove" title="Remove from pipeline">✕</button>
        </div>
        <div class="kb-card-price">${formatKbPrice(p.price, terms.price)}</div>
        <div class="kb-card-address kb-card-address-link" title="Show on map">📍 ${p.address}</div>
        <div class="kb-card-suburb">${p.suburb} NSW</div>
        <select class="kb-stage-select">${stageOptions}</select>
        <div class="kb-card-indicators">
          ${hasTerms   ? `<span class="kb-ind kb-ind-terms" title="Vendor terms recorded">Terms</span>` : ''}
          ${offers.length ? `<span class="kb-ind kb-ind-offers" title="${offers.length} offer(s)">${offers.length} Offer${offers.length > 1 ? 's' : ''}</span>` : ''}
          ${ddCount    ? `<span class="kb-ind kb-ind-dd ${ddClass}" title="${ddCount} DD items assessed">DD ${ddCount}/${DD_ITEMS.length}</span>` : ''}
          ${(Array.isArray(item.note) ? item.note.length : item.note) ? `<span class="kb-ind kb-ind-note" title="Has notes">Note</span>` : ''}
        </div>
      `;

      // Drag
      card.addEventListener('dragstart', e => {
        e.dataTransfer.setData('text/plain', id);
        card.classList.add('dragging');
      });
      card.addEventListener('dragend', () => card.classList.remove('dragging'));

      // Stage select change
      card.querySelector('.kb-stage-select').addEventListener('change', function (e) {
        e.stopPropagation();
        moveToStage(id, this.value);
        renderBoard();
      });

      // Remove card
      card.querySelector('.kb-remove').addEventListener('click', e => {
        e.stopPropagation();
        removeFromPipeline(id);
      });

      // Address — show on map
      card.querySelector('.kb-card-address-link').addEventListener('click', e => {
        e.stopPropagation();
        toggleKanban(false);
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

    // Drop zone
    cardsEl.addEventListener('dragover', e => {
      e.preventDefault();
      cardsEl.classList.add('drag-over');
    });
    cardsEl.addEventListener('dragleave', () => cardsEl.classList.remove('drag-over'));
    cardsEl.addEventListener('drop', e => {
      e.preventDefault();
      cardsEl.classList.remove('drag-over');
      const id = e.dataTransfer.getData('text/plain');
      if (id && pipeline[id]) {
        moveToStage(id, stage.id);
        renderBoard();
      }
    });

    board.appendChild(col);
  });
}

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
          <div class="kb-modal-price">${formatKbPrice(p.price, terms.price)}</div>
          <div class="kb-modal-address">📍 ${p.address}, ${p.suburb} NSW</div>
          ${p._lotDPs
            ? `<div class="kb-modal-lotdp" style="font-size:11px;color:#888;margin-top:3px;letter-spacing:0.02em">${p._lotDPs}</div>`
            : `<div class="kb-modal-lotdp" style="font-size:11px;color:#bbb;margin-top:3px">Lot/DP loading…</div>`}
          ${p._listingUrl ? `<a href="${p._listingUrl}" target="_blank" rel="noopener" class="kb-domain-link" style="display:inline-block;margin-top:4px;font-size:11px;color:#1ea765;font-weight:600;text-decoration:none">↗ View on Domain</a>` : ''}
        </div>
        <div style="display:flex;align-items:center;gap:8px;flex-shrink:0">
          <button class="kb-modal-close" title="Close">✕</button>
        </div>
      </div>
      <div class="kb-modal-body">

        <div class="crm-section-placeholder"></div>

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

        <div class="kb-finance-picker" id="kb-finance-picker-${id}">${buildFinancePickerHtml(offers, terms, p)}</div>

        <div style="display:flex;align-items:center;justify-content:space-between;margin-top:16px">
          <div class="kb-section-label" style="margin-top:0">Due Diligence</div>
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
              </div>`;
          }).join('')}
        </div>

        <div class="kb-section-label" style="margin-top:16px">Notes</div>
        <div class="kb-notes-section">
          <div class="kb-note-contact-row">
            <input class="kb-input kb-note-contact-search" type="text" placeholder="Tag a contact (optional)…">
            <div class="kb-note-contact-results"></div>
            <div class="kb-note-contact-tag" style="display:none"></div>
          </div>
          <div class="kb-notes-input-row">
            <textarea class="kb-input kb-note-input" placeholder="Add a note…" rows="2"></textarea>
            <button class="kb-note-add-btn">Add</button>
          </div>
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

  // Close
  overlay.querySelector('.kb-modal-close').addEventListener('click', () => overlay.remove());
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
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  document.addEventListener('keydown', function escClose(e) {
    if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', escClose); }
  });

  // Re-run Auto DD
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

  // Notes
  function formatNoteDate(ts) {
    const d = new Date(ts);
    const pad = n => String(n).padStart(2, '0');
    return `${pad(d.getDate())}/${pad(d.getMonth()+1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function renderNotesList() {
    const listEl = modal.querySelector('.kb-notes-list');
    if (!listEl) return;
    const notes = getNotes(id);
    if (!notes.length) { listEl.innerHTML = '<div class="kb-notes-empty">No notes yet</div>'; return; }
    listEl.innerHTML = '';
    notes.forEach(n => {
      const entry = document.createElement('div');
      entry.className = 'kb-note-entry';
      const contactTag = n.contact_name ? `<span class="kb-note-contact-badge">@${n.contact_name}</span>` : '';
      entry.innerHTML = `
        <div class="kb-note-meta">
          <span class="kb-note-date">${formatNoteDate(n.ts)}${contactTag}</span>
          <button class="kb-note-delete" data-ts="${n.ts}" title="Delete note">✕</button>
        </div>
        <div class="kb-note-text">${n.text.split('\n').join('<br>')}</div>`;
      entry.querySelector('.kb-note-delete').addEventListener('click', () => {
        if (!confirm('Delete this note?')) return;
        deleteNote(id, n.ts);
        renderNotesList();
        const boardCard = document.querySelector(`.kb-card[data-id="${id}"]`);
        if (boardCard) refreshCardIndicators(boardCard, id);
      });
      listEl.appendChild(entry);
    });
  }
  renderNotesList();

  // Contact tag for notes
  let _noteContactId = null;
  let _noteContactName = null;
  const contactSearch = modal.querySelector('.kb-note-contact-search');
  const contactResults = modal.querySelector('.kb-note-contact-results');
  const contactTag = modal.querySelector('.kb-note-contact-tag');

  function clearContactTag() {
    _noteContactId = null;
    _noteContactName = null;
    contactTag.style.display = 'none';
    contactTag.innerHTML = '';
    contactSearch.style.display = '';
    contactSearch.value = '';
    contactResults.innerHTML = '';
  }

  let _contactSearchTimer;
  contactSearch.addEventListener('input', () => {
    clearTimeout(_contactSearchTimer);
    const q = contactSearch.value.trim();
    if (q.length < 2) { contactResults.innerHTML = ''; return; }
    _contactSearchTimer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/contacts?pipeline_id=${encodeURIComponent(id)}`);
        const linked = await res.json();
        // Also search all contacts
        const res2 = await fetch(`/api/contacts?search=${encodeURIComponent(q)}`);
        const all = await res2.json();
        // Merge, linked first
        const seen = new Set();
        const combined = [...linked, ...all].filter(c => { if (seen.has(c.id)) return false; seen.add(c.id); return true; })
          .filter(c => {
            const name = `${c.first_name} ${c.last_name}`.toLowerCase();
            return name.includes(q.toLowerCase()) || (c.org_name||'').toLowerCase().includes(q.toLowerCase());
          }).slice(0, 8);
        contactResults.innerHTML = '';
        combined.forEach(c => {
          const item = document.createElement('div');
          item.className = 'kb-note-contact-result';
          item.innerHTML = `<strong>${c.first_name} ${c.last_name}</strong>${c.org_name ? ` · ${c.org_name}` : ''}`;
          item.addEventListener('click', () => {
            _noteContactId = c.id;
            _noteContactName = `${c.first_name} ${c.last_name}`.trim();
            contactResults.innerHTML = '';
            contactSearch.style.display = 'none';
            contactTag.style.display = 'flex';
            contactTag.innerHTML = `<span>@${_noteContactName}</span><button class="kb-note-contact-clear">✕</button>`;
            contactTag.querySelector('.kb-note-contact-clear').addEventListener('click', clearContactTag);
          });
          contactResults.appendChild(item);
        });
      } catch (e) { console.warn('[notes] contact search failed', e); }
    }, 300);
  });

  const noteInput = modal.querySelector('.kb-note-input');
  modal.querySelector('.kb-note-add-btn').addEventListener('click', () => {
    const text = noteInput.value.trim();
    if (!text) return;
    addNote(id, text, _noteContactId, _noteContactName);
    noteInput.value = '';
    clearContactTag();
    renderNotesList();
    const boardCard = document.querySelector(`.kb-card[data-id="${id}"]`);
    if (boardCard) refreshCardIndicators(boardCard, id);
  });
  noteInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) modal.querySelector('.kb-note-add-btn').click();
  });

  // Terms
  function syncTerms() {
    const t = getTerms(id);
    const rawPrice = modal.querySelector('.kb-terms-price').value;
    const rawSettlement = modal.querySelector('.kb-terms-settlement').value;
    const parsedPrice = parseDepositAmountKanban(rawPrice, null);
    t.price      = parsedPrice || null;  // null not 0 — so falsy check works correctly
    t.settlement = parseSettlementDays(rawSettlement) || null;
    saveTerms(id, t);
    const boardCard = document.querySelector(`.kb-card[data-id="${id}"]`);
    if (boardCard) refreshCardIndicators(boardCard, id);
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
    const boardCard = document.querySelector(`.kb-card[data-id="${id}"]`);
    if (boardCard) refreshCardIndicators(boardCard, id);
    showKanbanToast('Offer recorded');
  });

  // Delete offer — handled in finance picker
  modal.querySelector(`#kb-finance-picker-${id}`).addEventListener('click', e => {
    const btn = e.target.closest('.kb-fin-pick-delete');
    if (!btn) return;
    deleteOffer(id, btn.dataset.offerId);
    refreshFinancePicker();
    const boardCard = document.querySelector(`.kb-card[data-id="${id}"]`);
    if (boardCard) refreshCardIndicators(boardCard, id);
  });

  // DD
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
    const boardCard = document.querySelector(`.kb-card[data-id="${id}"]`);
    if (boardCard) refreshCardIndicators(boardCard, id);
  });
  modal.querySelector('.kb-dd').addEventListener('input', e => {
    if (!e.target.matches('.kb-dd-note')) return;
    const key = e.target.dataset.key;
    const dd  = getDd(id);
    if (!dd[key]) dd[key] = { status: '', note: '' };
    dd[key].note = e.target.value;
    saveDd(id, dd);
  });
}

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
  const hasTerms = (terms.price != null && terms.price !== '' && terms.price !== 0 && terms.price !== null) || (terms.settlement != null && terms.settlement !== '' && terms.settlement !== 0);

  // Update price (may now show terms price as fallback)
  const priceEl = card.querySelector('.kb-card-price');
  if (priceEl) priceEl.innerHTML = formatKbPrice(p.price, terms.price);

  const el = card.querySelector('.kb-card-indicators');
  if (!el) return;
  el.innerHTML = `
    ${hasTerms    ? `<span class="kb-ind kb-ind-terms">Terms</span>` : ''}
    ${offers.length ? `<span class="kb-ind kb-ind-offers">${offers.length} Offer${offers.length > 1 ? 's' : ''}</span>` : ''}
    ${ddCount     ? `<span class="kb-ind kb-ind-dd ${ddClass}">DD ${ddCount}/${DD_ITEMS.length}</span>` : ''}
    ${(Array.isArray(item.note) ? item.note.length : item.note) ? `<span class="kb-ind kb-ind-note">Note</span>` : ''}
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
document.getElementById('kanbanClose').addEventListener('click', () => toggleKanban(false));

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
window.getPipelineStages = () => STAGES;
window.refreshPipelinePins = function () {
  if (typeof window._renderPipelinePins === 'function') window._renderPipelinePins();
};
