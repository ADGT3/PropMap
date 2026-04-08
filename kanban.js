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
    updateAddButtons();
    if (kanbanVisible) renderBoard();
  }
}

// pipeline: { [propertyId]: { stage, note, addedAt, property, terms, offers, dd } }

// ─── View toggle ──────────────────────────────────────────────────────────────

let kanbanVisible = false;

function toggleKanban(show) {
  kanbanVisible = show !== undefined ? show : !kanbanVisible;
  document.getElementById('kanbanView').classList.toggle('visible', kanbanVisible);
  const btn = document.getElementById('kanbanToggleBtn');
  btn.classList.toggle('active', kanbanVisible);
  btn.innerHTML = (kanbanVisible ? '⬢' : '⬡') + ' Pipeline';
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
    },
    dd: {}
  };
  savePipeline(id);
  updateAddButtons();
  if (kanbanVisible) renderBoard();
  showKanbanToast(`${listing.address} added to pipeline`);

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
}

function moveToStage(id, stageId) {
  if (pipeline[id]) {
    pipeline[id].stage = stageId;
    savePipeline(id);
  }
}

function saveNote(id, note) {
  if (pipeline[id]) {
    pipeline[id].note = note;
    savePipeline(id);
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
  if (!val) return '';
  const num = parseFloat(String(val).replace(/[^0-9.]/g, ''));
  return isNaN(num) ? val : '$' + Math.round(num).toLocaleString();
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

function getTerms(id) {
  return pipeline[id]?.terms || { price: '', settlement: '', deposits: [{ amount: '', due: '', note: '' }] };
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
  pipeline[propertyId].offers = (pipeline[propertyId].offers || []).filter(o => o.id !== offerId);
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
      const hasTerms = terms.price || terms.settlement;

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
          ${item.note  ? `<span class="kb-ind kb-ind-note" title="Has notes">Note</span>` : ''}
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

function openCardModal(id) {
  const item = pipeline[id];
  if (!item) return;
  const p = item.property;

  // Remove any existing modal
  const existing = document.getElementById('kb-modal');
  if (existing) existing.remove();

  const terms = getTerms(id);
  const offers = getOffers(id);

  function buildDepositsHtml(deps) {
    return deps.map((d, i) => `
      <div class="kb-deposit-row" data-idx="${i}">
        <div class="kb-deposit-fields">
          <input class="kb-input kb-dep-amount" type="text" placeholder="Amount e.g. $50,000" value="${d.amount || ''}" data-idx="${i}">
          <input class="kb-input kb-dep-due" type="text" placeholder="Due e.g. 14 days" value="${d.due || ''}" data-idx="${i}">
        </div>
        <input class="kb-input kb-dep-note" type="text" placeholder="Note e.g. on exchange" value="${d.note || ''}" data-idx="${i}">
        ${deps.length > 1 ? `<button class="kb-dep-remove" data-idx="${i}" title="Remove tranche">✕</button>` : ''}
      </div>`).join('');
  }

  function buildOfferDepositsHtml(deps) {
    return deps.map((d, i) => `
      <div class="kb-deposit-row kb-offer-dep-row" data-idx="${i}">
        <div class="kb-deposit-fields">
          <input class="kb-input kb-odep-amount" type="text" placeholder="Amount e.g. $50,000" value="${d.amount || ''}" data-idx="${i}">
          <input class="kb-input kb-odep-due" type="text" placeholder="Due e.g. 14 days" value="${d.due || ''}" data-idx="${i}">
        </div>
        <input class="kb-input kb-odep-note" type="text" placeholder="Note e.g. on exchange" value="${d.note || ''}" data-idx="${i}">
        ${deps.length > 1 ? `<button class="kb-odep-remove" data-idx="${i}" title="Remove tranche">✕</button>` : ''}
      </div>`).join('');
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
          <span class="kb-offer-field"><span class="kb-offer-lbl">Settlement</span> ${o.settlement || '—'}</span>
        </div>
        ${o.deposits && o.deposits.length ? `
          <div class="kb-offer-deps-label">Deposit structure</div>
          <div class="kb-offer-deposits-list">${o.deposits.map(d=>`<span class="kb-offer-dep">${[d.amount,d.due,d.note].filter(Boolean).join(' · ')}</span>`).join('')}</div>` : ''}
      </div>`).join('');
  }

  const dd = getDd(id);

  const overlay = document.createElement('div');
  overlay.id = 'kb-modal';
  overlay.className = 'kb-modal-overlay';
  overlay.dataset.propertyId = String(id);
  overlay.innerHTML = `
    <div class="kb-modal">
      <div class="kb-modal-header">
        <div>
          <div class="kb-modal-price">${formatKbPrice(p.price, terms.price)}</div>
          <div class="kb-modal-address">📍 ${p.address}, ${p.suburb} NSW</div>
          ${p._lotDPs ? `<div class="kb-modal-lotdp" style="font-size:11px;color:#888;margin-top:3px;letter-spacing:0.02em">${p._lotDPs}</div>` : ''}
        </div>
        <button class="kb-modal-close" title="Close">✕</button>
      </div>
      <div class="kb-modal-body">

        <div class="kb-section-label">Vendor Terms</div>
        <div class="kb-terms">
          <div class="kb-terms-row">
            <div class="kb-field-wrap">
              <label class="kb-field-label">Price</label>
              <input class="kb-input kb-terms-price" type="text" placeholder="e.g. $1,250,000" value="${terms.price || ''}">
            </div>
            <div class="kb-field-wrap">
              <label class="kb-field-label">Settlement</label>
              <input class="kb-input kb-terms-settlement" type="text" placeholder="e.g. 90, 3 months, 1 year" value="${terms.settlement || ''}">
            </div>
          </div>
          <label class="kb-field-label" style="margin-top:8px;display:block">Deposit Structure</label>
          <div class="kb-deposits">${buildDepositsHtml(terms.deposits)}</div>
          <button class="kb-add-deposit">+ Add tranche</button>
        </div>

        <div class="kb-section-label" style="margin-top:16px">Terms Offered</div>
        <div class="kb-offer-form">
          <div class="kb-terms-row">
            <div class="kb-field-wrap">
              <label class="kb-field-label">Price</label>
              <input class="kb-input kb-offer-price" type="text" placeholder="e.g. $1,200,000">
            </div>
            <div class="kb-field-wrap">
              <label class="kb-field-label">Settlement</label>
              <input class="kb-input kb-offer-settlement" type="text" placeholder="e.g. 90, 3 months, 1 year">
            </div>
          </div>
          <label class="kb-field-label" style="margin-top:8px;display:block">Deposit Structure</label>
          <div class="kb-offer-deposits">${buildOfferDepositsHtml([{ amount: '', due: '', note: '' }])}</div>
          <button class="kb-offer-add-deposit">+ Add tranche</button>
          <button class="kb-submit-offer">+ Submit Offer</button>
        </div>
        <div class="kb-offers-list" id="kb-modal-offers-${id}">${buildOffersHtml(offers)}</div>

        <div class="kb-section-label" style="margin-top:16px">Due Diligence</div>
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

        <div class="kb-section-label" style="margin-top:16px">Agent</div>
        <div class="kb-agent">
          <div class="kb-terms-row">
            <div class="kb-field-wrap" style="flex:2">
              <label class="kb-field-label">Name</label>
              <input class="kb-input kb-agent-name" type="text" placeholder="Agent name" value="${p._agent?.name || ''}">
            </div>
          </div>
          <div class="kb-terms-row" style="margin-top:6px">
            <div class="kb-field-wrap">
              <label class="kb-field-label">Email</label>
              <input class="kb-input kb-agent-email" type="text" placeholder="agent@agency.com.au" value="${p._agent?.email || ''}">
            </div>
            <div class="kb-field-wrap">
              <label class="kb-field-label">Phone</label>
              <input class="kb-input kb-agent-phone" type="text" placeholder="04xx xxx xxx" value="${p._agent?.phone || ''}">
            </div>
          </div>
        </div>

        <div class="kb-section-label" style="margin-top:16px">Notes</div>
        <textarea class="kb-note" placeholder="Add a note…" rows="3">${item.note || ''}</textarea>

      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  const modal = overlay.querySelector('.kb-modal');

  // Close
  overlay.querySelector('.kb-modal-close').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  document.addEventListener('keydown', function escClose(e) {
    if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', escClose); }
  });

  // Agent
  function syncAgent() {
    if (!pipeline[id]) return;
    pipeline[id].property._agent = pipeline[id].property._agent || {};
    pipeline[id].property._agent.name  = modal.querySelector('.kb-agent-name').value;
    pipeline[id].property._agent.email = modal.querySelector('.kb-agent-email').value;
    pipeline[id].property._agent.phone = modal.querySelector('.kb-agent-phone').value;
    savePipeline(id);
  }
  modal.querySelector('.kb-agent-name').addEventListener('input', syncAgent);
  modal.querySelector('.kb-agent-email').addEventListener('input', syncAgent);
  modal.querySelector('.kb-agent-phone').addEventListener('input', syncAgent);

  // Note
  modal.querySelector('.kb-note').addEventListener('input', function () {
    saveNote(id, this.value);
    // Refresh indicators on board card
    const boardCard = document.querySelector(`.kb-card[data-id="${id}"]`);
    if (boardCard) refreshCardIndicators(boardCard, id);
  });

  // Terms
  function syncTerms() {
    const t = getTerms(id);
    t.price      = modal.querySelector('.kb-terms-price').value;
    t.settlement = modal.querySelector('.kb-terms-settlement').value;
    saveTerms(id, t);
    const boardCard = document.querySelector(`.kb-card[data-id="${id}"]`);
    if (boardCard) refreshCardIndicators(boardCard, id);
  }
  modal.querySelector('.kb-terms-price').addEventListener('input', syncTerms);
  modal.querySelector('.kb-terms-price').addEventListener('blur', function() {
    this.value = formatInputPrice(this.value);
    syncTerms();
  });
  modal.querySelector('.kb-terms-settlement').addEventListener('input', syncTerms);
  modal.querySelector('.kb-terms-settlement').addEventListener('blur', function() {
    this.value = formatSettlement(this.value);
    syncTerms();
  });

  // Vendor deposits
  function syncDeposits() {
    const t = getTerms(id);
    t.deposits = Array.from(modal.querySelectorAll('.kb-deposits .kb-deposit-row')).map(row => ({
      amount: row.querySelector('.kb-dep-amount').value,
      due:    row.querySelector('.kb-dep-due').value,
      note:   row.querySelector('.kb-dep-note').value,
    }));
    saveTerms(id, t);
  }
  modal.querySelector('.kb-deposits').addEventListener('input', e => {
    if (e.target.matches('.kb-dep-amount, .kb-dep-due, .kb-dep-note')) syncDeposits();
  });
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

  // Offer deposits
  modal.querySelector('.kb-offer-add-deposit').addEventListener('click', () => {
    const el = modal.querySelector('.kb-offer-deposits');
    const current = Array.from(el.querySelectorAll('.kb-offer-dep-row')).map(row => ({
      amount: row.querySelector('.kb-odep-amount').value,
      due:    row.querySelector('.kb-odep-due').value,
      note:   row.querySelector('.kb-odep-note').value,
    }));
    current.push({ amount: '', due: '', note: '' });
    el.innerHTML = buildOfferDepositsHtml(current);
  });
  modal.querySelector('.kb-offer-deposits').addEventListener('click', e => {
    const btn = e.target.closest('.kb-odep-remove');
    if (!btn) return;
    const el = modal.querySelector('.kb-offer-deposits');
    const current = Array.from(el.querySelectorAll('.kb-offer-dep-row')).map(row => ({
      amount: row.querySelector('.kb-odep-amount').value,
      due:    row.querySelector('.kb-odep-due').value,
      note:   row.querySelector('.kb-odep-note').value,
    }));
    current.splice(parseInt(btn.dataset.idx, 10), 1);
    if (!current.length) current.push({ amount: '', due: '', note: '' });
    el.innerHTML = buildOfferDepositsHtml(current);
  });

  // Submit offer
  modal.querySelector('.kb-submit-offer').addEventListener('click', () => {
    const offerDeposits = Array.from(modal.querySelectorAll('.kb-offer-dep-row')).map(row => ({
      amount: row.querySelector('.kb-odep-amount').value,
      due:    row.querySelector('.kb-odep-due').value,
      note:   row.querySelector('.kb-odep-note').value,
    })).filter(d => d.amount || d.due);
    const offer = {
      price:      formatInputPrice(modal.querySelector('.kb-offer-price').value.trim()),
      settlement: formatSettlement(modal.querySelector('.kb-offer-settlement').value.trim()),
      deposits:   offerDeposits,
    };
    if (!offer.price && !offer.settlement && !offerDeposits.length) return;
    addOffer(id, offer);
    modal.querySelector('.kb-offer-price').value = '';
    modal.querySelector('.kb-offer-settlement').value = '';
    modal.querySelector('.kb-offer-deposits').innerHTML = buildOfferDepositsHtml([{ amount: '', due: '', note: '' }]);
    document.getElementById('kb-modal-offers-' + id).innerHTML = buildOffersHtml(getOffers(id));
    const boardCard = document.querySelector(`.kb-card[data-id="${id}"]`);
    if (boardCard) refreshCardIndicators(boardCard, id);
    showKanbanToast('Offer recorded');
  });

  // Delete offer
  modal.querySelector('.kb-offers-list').addEventListener('click', e => {
    const btn = e.target.closest('.kb-offer-delete');
    if (!btn) return;
    deleteOffer(id, Number(btn.dataset.offerId));
    document.getElementById('kb-modal-offers-' + id).innerHTML = buildOffersHtml(getOffers(id));
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
  const hasTerms = terms.price || terms.settlement;

  // Update price (may now show terms price as fallback)
  const priceEl = card.querySelector('.kb-card-price');
  if (priceEl) priceEl.innerHTML = formatKbPrice(p.price, terms.price);

  const el = card.querySelector('.kb-card-indicators');
  if (!el) return;
  el.innerHTML = `
    ${hasTerms    ? `<span class="kb-ind kb-ind-terms">Terms</span>` : ''}
    ${offers.length ? `<span class="kb-ind kb-ind-offers">${offers.length} Offer${offers.length > 1 ? 's' : ''}</span>` : ''}
    ${ddCount     ? `<span class="kb-ind kb-ind-dd ${ddClass}">DD ${ddCount}/${DD_ITEMS.length}</span>` : ''}
    ${item.note   ? `<span class="kb-ind kb-ind-note">Note</span>` : ''}
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

// Load pipeline from DB (falls back to localStorage if offline)
initPipeline();
