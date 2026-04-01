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
  showKanbanToast('Loading pipeline…');
  const remote = await dbLoad();
  if (remote && Object.keys(remote).length >= 0) {
    pipeline = remote;
    cacheSave(pipeline);
  } else {
    pipeline = cacheLoad();
  }
  updateAddButtons();
  const statusMsg = dbAvailable ? 'Pipeline loaded' : 'Offline — using local data';
  showKanbanToast(statusMsg);
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
    // Already exists — flash the card
    highlightCard(id);
    return;
  }
  pipeline[id] = {
    stage:   'shortlisted',
    note:    '',
    addedAt: Date.now(),
    property: {
      id:      listing.id,
      address: listing.address,
      suburb:  listing.suburb,
      price:   listing.price,
      type:    listing.type,
      beds:    listing.beds,
      baths:   listing.baths,
      cars:    listing.cars,
    }
  };
  savePipeline(id);
  updateAddButtons();
  if (kanbanVisible) renderBoard();
  showKanbanToast(`${listing.address} added to pipeline`);
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
  'Zoning','Yield','Access','Sewer','Water','Easements','Electricity',
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
      const card = document.createElement('div');
      card.className = 'kb-card';
      card.draggable = true;
      card.dataset.id = id;

      const statsHtml = p.type !== 'land'
        ? `<span>🛏 ${p.beds}</span><span>🚿 ${p.baths}</span><span>🚗 ${p.cars}</span>`
        : `<span>Land</span>`;

      // Stage mover select
      const stageOptions = STAGES.map(s =>
        `<option value="${s.id}" ${s.id === item.stage ? 'selected' : ''}>${s.label}</option>`
      ).join('');

      const terms = getTerms(id);

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

      card.innerHTML = `
        <div class="kb-card-top">
          <span class="kb-card-type">${p.type}</span>
          <button class="kb-remove" title="Remove from pipeline">✕</button>
        </div>
        <div class="kb-card-price">${p.price}</div>
        <div class="kb-card-address kb-card-address-link" title="Show on map">📍 ${p.address}</div>
        <div class="kb-card-suburb">${p.suburb} NSW</div>
        <div class="kb-card-stats">${statsHtml}</div>
        <select class="kb-stage-select">${stageOptions}</select>

        <div class="kb-section-label">Vendor Terms</div>
        <div class="kb-terms">
          <div class="kb-terms-row">
            <div class="kb-field-wrap">
              <label class="kb-field-label">Price</label>
              <input class="kb-input kb-terms-price" type="text" placeholder="e.g. $1,250,000" value="${terms.price || ''}">
            </div>
            <div class="kb-field-wrap">
              <label class="kb-field-label">Settlement</label>
              <input class="kb-input kb-terms-settlement" type="text" placeholder="e.g. 90 days" value="${terms.settlement || ''}">
            </div>
          </div>
          <label class="kb-field-label" style="margin-top:8px;display:block">Deposit Structure</label>
          <div class="kb-deposits">${buildDepositsHtml(terms.deposits)}</div>
          <button class="kb-add-deposit">+ Add tranche</button>
        </div>

        <div class="kb-section-label" style="margin-top:12px">Terms Offered</div>
        <div class="kb-offer-form">
          <div class="kb-terms-row">
            <div class="kb-field-wrap">
              <label class="kb-field-label">Price</label>
              <input class="kb-input kb-offer-price" type="text" placeholder="e.g. $1,200,000">
            </div>
            <div class="kb-field-wrap">
              <label class="kb-field-label">Settlement</label>
              <input class="kb-input kb-offer-settlement" type="text" placeholder="e.g. 90 days">
            </div>
          </div>
          <label class="kb-field-label" style="margin-top:8px;display:block">Deposit Structure</label>
          <div class="kb-offer-deposits">${buildOfferDepositsHtml([{ amount: '', due: '', note: '' }])}</div>
          <button class="kb-offer-add-deposit">+ Add tranche</button>
          <button class="kb-submit-offer">+ Submit Offer</button>
        </div>

        <div class="kb-offers-list" id="kb-offers-${id}">${buildOffersHtml(getOffers(id))}</div>

        <div class="kb-section-label" style="margin-top:12px">Due Diligence</div>
        <div class="kb-dd">
          ${DD_ITEMS.map(item => {
            const key = item.toLowerCase();
            const dd  = getDd(id);
            const status = dd[key]?.status || '';
            const note   = dd[key]?.note   || '';
            return `
              <div class="kb-dd-row" data-key="${key}">
                <span class="kb-dd-label">${item}</span>
                <select class="kb-dd-select dd-risk-${status || 'none'}" data-key="${key}">
                  ${DD_RISK_OPTIONS.map(o => `
                    <option value="${o.value}" ${o.value === status ? 'selected' : ''}>${o.label}</option>
                  `).join('')}
                </select>
                <input class="kb-input kb-dd-note" type="text" placeholder="Note…"
                  value="${note}" data-key="${key}">
              </div>`;
          }).join('')}
        </div>

        <div class="kb-section-label" style="margin-top:8px">Notes</div>
        <textarea class="kb-note" placeholder="Add a note…" rows="2">${item.note || ''}</textarea>
      `;

      // ── Wire up all events ──

      // Drag
      card.addEventListener('dragstart', e => {
        e.dataTransfer.setData('text/plain', id);
        card.classList.add('dragging');
      });
      card.addEventListener('dragend', () => card.classList.remove('dragging'));

      // Stage select
      card.querySelector('.kb-stage-select').addEventListener('change', function () {
        moveToStage(id, this.value);
        renderBoard();
      });

      // Note
      card.querySelector('.kb-note').addEventListener('input', function () {
        saveNote(id, this.value);
      });

      // DD — risk select
      card.querySelector('.kb-dd').addEventListener('change', e => {
        const sel = e.target.closest('.kb-dd-select');
        if (!sel) return;
        const key = sel.dataset.key;
        const val = sel.value;
        const dd  = getDd(id);
        if (!dd[key]) dd[key] = { status: '', note: '' };
        dd[key].status = val;
        saveDd(id, dd);
        // Update colour class
        sel.className = `kb-dd-select dd-risk-${val || 'none'}`;
      });

      // DD — notes
      card.querySelector('.kb-dd').addEventListener('input', e => {
        if (!e.target.matches('.kb-dd-note')) return;
        const key = e.target.dataset.key;
        const dd  = getDd(id);
        if (!dd[key]) dd[key] = { status: '', note: '' };
        dd[key].note = e.target.value;
        saveDd(id, dd);
      });

      // Terms — price & settlement
      function syncTerms() {
        const t = getTerms(id);
        t.price      = card.querySelector('.kb-terms-price').value;
        t.settlement = card.querySelector('.kb-terms-settlement').value;
        // deposits already synced by deposit handlers
        saveTerms(id, t);
      }
      card.querySelector('.kb-terms-price').addEventListener('input', syncTerms);
      card.querySelector('.kb-terms-settlement').addEventListener('input', syncTerms);

      // Deposit field sync helper
      function syncDeposits() {
        const t = getTerms(id);
        const rows = card.querySelectorAll('.kb-deposit-row');
        t.deposits = Array.from(rows).map(row => ({
          amount: row.querySelector('.kb-dep-amount').value,
          due:    row.querySelector('.kb-dep-due').value,
          note:   row.querySelector('.kb-dep-note').value,
        }));
        saveTerms(id, t);
      }

      card.querySelector('.kb-deposits').addEventListener('input', e => {
        if (e.target.matches('.kb-dep-amount, .kb-dep-due, .kb-dep-note')) syncDeposits();
      });

      // Remove deposit tranche
      card.querySelector('.kb-deposits').addEventListener('click', e => {
        const btn = e.target.closest('.kb-dep-remove');
        if (!btn) return;
        e.stopPropagation();
        syncDeposits(); // save current values first
        const idx = parseInt(btn.dataset.idx, 10);
        removeDeposit(id, idx);
        // Re-render just the deposits section
        const t = getTerms(id);
        card.querySelector('.kb-deposits').innerHTML = buildDepositsHtml(t.deposits);
      });

      // Add deposit tranche
      card.querySelector('.kb-add-deposit').addEventListener('click', e => {
        e.stopPropagation();
        syncDeposits();
        addDeposit(id);
        const t = getTerms(id);
        card.querySelector('.kb-deposits').innerHTML = buildDepositsHtml(t.deposits);
      });

      // Add offer deposit tranche
      card.querySelector('.kb-offer-add-deposit').addEventListener('click', e => {
        e.stopPropagation();
        const offerDepsEl = card.querySelector('.kb-offer-deposits');
        const rows = offerDepsEl.querySelectorAll('.kb-offer-dep-row');
        const current = Array.from(rows).map(row => ({
          amount: row.querySelector('.kb-odep-amount').value,
          due:    row.querySelector('.kb-odep-due').value,
          note:   row.querySelector('.kb-odep-note').value,
        }));
        current.push({ amount: '', due: '', note: '' });
        offerDepsEl.innerHTML = buildOfferDepositsHtml(current);
      });

      // Remove offer deposit tranche
      card.querySelector('.kb-offer-deposits').addEventListener('click', e => {
        const btn = e.target.closest('.kb-odep-remove');
        if (!btn) return;
        e.stopPropagation();
        const offerDepsEl = card.querySelector('.kb-offer-deposits');
        const rows = offerDepsEl.querySelectorAll('.kb-offer-dep-row');
        const current = Array.from(rows).map(row => ({
          amount: row.querySelector('.kb-odep-amount').value,
          due:    row.querySelector('.kb-odep-due').value,
          note:   row.querySelector('.kb-odep-note').value,
        }));
        const idx = parseInt(btn.dataset.idx, 10);
        current.splice(idx, 1);
        if (current.length === 0) current.push({ amount: '', due: '', note: '' });
        offerDepsEl.innerHTML = buildOfferDepositsHtml(current);
      });

      // Submit offer
      card.querySelector('.kb-submit-offer').addEventListener('click', e => {
        e.stopPropagation();
        // Collect offer deposit tranches from the offer form's own rows
        const offerDepRows = card.querySelectorAll('.kb-offer-dep-row');
        const offerDeposits = Array.from(offerDepRows).map(row => ({
          amount: row.querySelector('.kb-odep-amount').value,
          due:    row.querySelector('.kb-odep-due').value,
          note:   row.querySelector('.kb-odep-note').value,
        })).filter(d => d.amount || d.due);

        const offer = {
          price:      card.querySelector('.kb-offer-price').value.trim(),
          settlement: card.querySelector('.kb-offer-settlement').value.trim(),
          deposits:   offerDeposits,
        };
        if (!offer.price && !offer.settlement && offerDeposits.length === 0) return;
        addOffer(id, offer);
        // Reset form to single empty deposit row
        card.querySelector('.kb-offer-price').value = '';
        card.querySelector('.kb-offer-settlement').value = '';
        card.querySelector('.kb-offer-deposits').innerHTML = buildOfferDepositsHtml([{ amount: '', due: '', note: '' }]);
        // Re-render offers list
        document.getElementById('kb-offers-' + id).innerHTML = buildOffersHtml(getOffers(id));
        showKanbanToast('Offer recorded');
      });

      // Delete offer
      card.querySelector('.kb-offers-list').addEventListener('click', e => {
        const btn = e.target.closest('.kb-offer-delete');
        if (!btn) return;
        e.stopPropagation();
        const offerId = Number(btn.dataset.offerId);
        deleteOffer(id, offerId);
        document.getElementById('kb-offers-' + id).innerHTML = buildOffersHtml(getOffers(id));
      });

      // Remove card
      card.querySelector('.kb-remove').addEventListener('click', e => {
        e.stopPropagation();
        removeFromPipeline(id);
      });

      // Click address to populate search, close pipeline and run search
      card.querySelector('.kb-card-address-link').addEventListener('click', e => {
        e.stopPropagation();
        const prop = pipeline[id] && pipeline[id].property;
        const addressText = prop ? `${prop.address}, ${prop.suburb}` : p.address;

        // Close pipeline first so map is visible
        toggleKanban(false);

        // Populate input and fire the input event to trigger geocode + debounce
        const input = document.getElementById('addressInput');
        const clearBtn = document.getElementById('searchClear');
        if (input) {
          input.value = addressText;
          if (clearBtn) clearBtn.classList.add('visible');
          input.dispatchEvent(new Event('input', { bubbles: true }));

          // After debounce + geocode (~600ms), pick the first suggestion
          setTimeout(() => {
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
          }, 700);
        }
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
