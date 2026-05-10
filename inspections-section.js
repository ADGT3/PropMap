/**
 * inspections-section.js — V77.1
 *
 * Renders the Inspection Schedule + Inspection Attendances sections on a
 * Sales Listing or Lease Listing deal modal.
 *
 * Two sub-sections inside one parent section:
 *
 *   1. Inspection Schedule
 *      - Sortable list (ascending by scheduled_date — agents care about
 *        upcoming events, not when records were created)
 *      - Each row shows date, time-range, type, attendee count, status
 *      - "+ Schedule Inspection" inline form (date + start + end + type)
 *      - Status select per row (planned / conducted / cancelled)
 *      - Click row to expand and reveal Attendance check-in
 *
 *   2. Attendance check-in (only shown when an inspection is expanded)
 *      - Search & pick contact → adds attendee row
 *      - Each attendee row has 6 tickboxes per build plan §4.3.4:
 *          Action triggers (write to attendance + auto-create Action):
 *            • Followup
 *            • Send offer form
 *            • Send contract
 *          Contact preferences (write to contact, NOT attendance):
 *            • Privacy consent
 *            • Email marketing consent
 *            • SMS marketing consent
 *      - Toast on save shows what auto-Actions were created
 *
 * Public API (window.InspectionsSection):
 *   InspectionsSection.render(containerEl, dealId, boardId)
 *     - Renders the whole section into containerEl
 *     - boardId is used to validate the deal is on a Listings board
 *     - Re-renders the inspection list after each create/edit/delete
 */

(function () {
  'use strict';

  // ── Constants ─────────────────────────────────────────────────────────────

  const INSPECTION_TYPES = [
    { id: 'open_home',         label: 'Open Home' },
    { id: 'private',           label: 'Private' },
    { id: 'twilight',          label: 'Twilight' },
    { id: 'auction_view',      label: 'Auction View' },
    { id: 'final_walkthrough', label: 'Final Walkthrough' },
  ];

  const INSPECTION_STATUSES = [
    { id: 'planned',   label: 'Planned' },
    { id: 'conducted', label: 'Conducted' },
    { id: 'cancelled', label: 'Cancelled' },
  ];

  // ── Helpers ───────────────────────────────────────────────────────────────

  function esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtDate(d) {
    if (!d) return '—';
    const dt = new Date(d);
    if (isNaN(dt.getTime())) return '—';
    const pad = n => String(n).padStart(2, '0');
    return `${pad(dt.getDate())}/${pad(dt.getMonth()+1)}/${dt.getFullYear()}`;
  }

  function fmtTime(t) {
    if (!t) return '';
    // t is "HH:MM:SS" — strip seconds
    return String(t).slice(0, 5);
  }

  function todayIso() {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  }

  function showToast(message, kind = 'success') {
    let toast = document.querySelector('.v77-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'v77-toast';
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.remove('v77-toast-success', 'v77-toast-error', 'v77-toast-info');
    toast.classList.add(`v77-toast-${kind}`);
    toast.classList.add('v77-toast-visible');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => {
      toast.classList.remove('v77-toast-visible');
    }, 4000);
  }

  // ── Render ────────────────────────────────────────────────────────────────

  async function render(containerEl, dealId, boardId) {
    if (boardId !== 'sys_sales_listings' && boardId !== 'sys_lease_listings') {
      containerEl.innerHTML = '';
      return;
    }

    containerEl.innerHTML = `
      <div class="kb-section-label" style="margin-top:16px">Inspection Schedule</div>
      <div class="insp-section" data-deal-id="${esc(dealId)}">
        <div class="insp-list" data-role="list">
          <div class="insp-loading">Loading inspections…</div>
        </div>
        <div class="insp-add-row" data-role="add-row">
          <button class="kb-toolbar-btn insp-add-btn" data-role="add-btn">+ Schedule Inspection</button>
        </div>
        <div class="insp-add-form" data-role="add-form" style="display:none"></div>
      </div>
    `;

    const listEl   = containerEl.querySelector('[data-role="list"]');
    const addBtn   = containerEl.querySelector('[data-role="add-btn"]');
    const addForm  = containerEl.querySelector('[data-role="add-form"]');

    addBtn.addEventListener('click', () => {
      renderAddForm(addForm);
      addBtn.style.display = 'none';
    });

    await renderList(listEl, dealId, addBtn, addForm);
  }

  // ── Render inspection list ────────────────────────────────────────────────

  async function renderList(listEl, dealId, addBtn, addForm) {
    listEl.innerHTML = '<div class="insp-loading">Loading inspections…</div>';
    try {
      const r = await fetch(`/api/scheduled-inspections?listing_deal_id=${encodeURIComponent(dealId)}`);
      if (!r.ok) throw new Error(r.status);
      const inspections = await r.json();
      // Sort ascending by scheduled_date — per Q1 (agents care about upcoming events)
      inspections.sort((a, b) => {
        const da = a.scheduled_date || '';
        const db = b.scheduled_date || '';
        if (da !== db) return da < db ? -1 : 1;
        return (a.start_time || '') < (b.start_time || '') ? -1 : 1;
      });

      if (!inspections.length) {
        listEl.innerHTML = '<div class="insp-empty">No inspections scheduled yet.</div>';
        return;
      }

      listEl.innerHTML = inspections.map(i => renderInspectionRow(i)).join('');

      // Wire row events
      listEl.querySelectorAll('[data-role="inspection-row"]').forEach(row => {
        const inspectionId = row.getAttribute('data-id');
        const inspection = inspections.find(x => String(x.id) === String(inspectionId));
        if (!inspection) {
          console.warn('[inspections] could not find inspection for row id', inspectionId);
          return;
        }

        // Status select change
        row.querySelector('[data-role="status-select"]')?.addEventListener('change', async (e) => {
          await updateInspection(inspectionId, { status: e.target.value });
          // Don't re-render — UI already shows the new status
        });

        // Edit button
        row.querySelector('[data-role="edit-btn"]')?.addEventListener('click', () => {
          renderEditForm(row, inspection, async () => {
            await renderList(listEl, dealId, addBtn, addForm);
          });
        });

        // Delete button
        row.querySelector('[data-role="delete-btn"]')?.addEventListener('click', async () => {
          if (!confirm(`Delete inspection on ${fmtDate(inspection.scheduled_date)}?`)) return;
          try {
            const dr = await fetch(`/api/scheduled-inspections?id=${inspectionId}`, { method: 'DELETE' });
            if (!dr.ok) {
              const err = await dr.json();
              alert(err.error || 'Delete failed');
              return;
            }
            await renderList(listEl, dealId, addBtn, addForm);
          } catch (err) {
            alert('Delete failed: ' + err.message);
          }
        });

        // Expand row to show attendances
        const headerEl = row.querySelector('[data-role="row-header"]');
        const attEl    = row.querySelector('[data-role="attendances"]');
        headerEl.addEventListener('click', (e) => {
          // Don't expand if clicking on a control (status select, edit, delete)
          if (e.target.closest('[data-role="status-select"], [data-role="edit-btn"], [data-role="delete-btn"]')) return;
          const expanded = row.classList.toggle('insp-row-expanded');
          if (expanded) renderAttendances(attEl, inspection, dealId);
        });
      });
    } catch (err) {
      listEl.innerHTML = `<div class="insp-error">Could not load inspections: ${esc(err.message)}</div>`;
    }
  }

  function renderInspectionRow(i) {
    const dateLabel = fmtDate(i.scheduled_date);
    const timeLabel = `${fmtTime(i.start_time)} – ${fmtTime(i.end_time)}`;
    const typeLabel = INSPECTION_TYPES.find(t => t.id === i.inspection_type)?.label || i.inspection_type;
    const attCount  = i.attendance_count ?? 0;
    return `
      <div class="insp-row" data-role="inspection-row" data-id="${i.id}">
        <div class="insp-row-header" data-role="row-header">
          <span class="insp-row-chev">▾</span>
          <div class="insp-row-main">
            <div class="insp-row-date">${esc(dateLabel)}</div>
            <div class="insp-row-time">${esc(timeLabel)}</div>
            <div class="insp-row-type">${esc(typeLabel)}</div>
            <div class="insp-row-count">${attCount} attendee${attCount === 1 ? '' : 's'}</div>
          </div>
          <div class="insp-row-controls">
            <select class="kb-input insp-status-select" data-role="status-select" title="Status">
              ${INSPECTION_STATUSES.map(s => `<option value="${s.id}" ${s.id === i.status ? 'selected' : ''}>${esc(s.label)}</option>`).join('')}
            </select>
            <button class="insp-row-btn" data-role="edit-btn" title="Edit">✎</button>
            <button class="insp-row-btn" data-role="delete-btn" title="Delete">✕</button>
          </div>
        </div>
        <div class="insp-attendances" data-role="attendances"></div>
      </div>
    `;
  }

  // ── Add / edit form ───────────────────────────────────────────────────────

  function renderAddForm(formEl) {
    formEl.innerHTML = `
      <div class="insp-form">
        <div class="insp-form-row">
          <input class="kb-input" type="date" data-field="scheduled_date" min="${todayIso()}" value="${todayIso()}">
          <input class="kb-input" type="time" data-field="start_time" value="10:00">
          <input class="kb-input" type="time" data-field="end_time" value="11:00">
          <select class="kb-input" data-field="inspection_type">
            ${INSPECTION_TYPES.map(t => `<option value="${t.id}">${esc(t.label)}</option>`).join('')}
          </select>
        </div>
        <div class="insp-form-actions">
          <button class="params-save-btn" data-role="form-save">Schedule</button>
          <button class="params-cancel-btn" data-role="form-cancel">Cancel</button>
        </div>
      </div>
    `;
    formEl.style.display = '';

    const cancel = formEl.querySelector('[data-role="form-cancel"]');
    const save   = formEl.querySelector('[data-role="form-save"]');
    cancel.addEventListener('click', () => {
      formEl.style.display = 'none';
      formEl.innerHTML = '';
      formEl.parentElement.querySelector('[data-role="add-btn"]').style.display = '';
    });
    save.addEventListener('click', async () => {
      const dealId = formEl.closest('.insp-section').getAttribute('data-deal-id');
      const body = {
        listing_deal_id: dealId,
        scheduled_date:  formEl.querySelector('[data-field="scheduled_date"]').value,
        start_time:      formEl.querySelector('[data-field="start_time"]').value + ':00',
        end_time:        formEl.querySelector('[data-field="end_time"]').value + ':00',
        inspection_type: formEl.querySelector('[data-field="inspection_type"]').value,
      };
      try {
        const r = await fetch('/api/scheduled-inspections', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!r.ok) {
          const err = await r.json();
          alert(err.error || 'Create failed');
          return;
        }
        formEl.style.display = 'none';
        formEl.innerHTML = '';
        formEl.parentElement.querySelector('[data-role="add-btn"]').style.display = '';
        // Re-render list
        const listEl = formEl.parentElement.querySelector('[data-role="list"]');
        const addBtn = formEl.parentElement.querySelector('[data-role="add-btn"]');
        await renderList(listEl, dealId, addBtn, formEl);
        showToast('Inspection scheduled', 'success');
      } catch (err) {
        alert('Save failed: ' + err.message);
      }
    });
  }

  function renderEditForm(rowEl, inspection, onDone) {
    const headerEl = rowEl.querySelector('[data-role="row-header"]');
    const original = headerEl.innerHTML;
    headerEl.innerHTML = `
      <div class="insp-form">
        <div class="insp-form-row">
          <input class="kb-input" type="date" data-field="scheduled_date" value="${esc(inspection.scheduled_date)}">
          <input class="kb-input" type="time" data-field="start_time" value="${esc(fmtTime(inspection.start_time))}">
          <input class="kb-input" type="time" data-field="end_time" value="${esc(fmtTime(inspection.end_time))}">
          <select class="kb-input" data-field="inspection_type">
            ${INSPECTION_TYPES.map(t => `<option value="${t.id}" ${t.id === inspection.inspection_type ? 'selected' : ''}>${esc(t.label)}</option>`).join('')}
          </select>
        </div>
        <div class="insp-form-actions">
          <button class="params-save-btn" data-role="edit-save">Save</button>
          <button class="params-cancel-btn" data-role="edit-cancel">Cancel</button>
        </div>
      </div>
    `;

    headerEl.querySelector('[data-role="edit-cancel"]').addEventListener('click', () => {
      headerEl.innerHTML = original;
      onDone();
    });
    headerEl.querySelector('[data-role="edit-save"]').addEventListener('click', async () => {
      const body = {
        id: inspection.id,
        scheduled_date:  headerEl.querySelector('[data-field="scheduled_date"]').value,
        start_time:      headerEl.querySelector('[data-field="start_time"]').value + ':00',
        end_time:        headerEl.querySelector('[data-field="end_time"]').value + ':00',
        inspection_type: headerEl.querySelector('[data-field="inspection_type"]').value,
      };
      try {
        await updateInspection(inspection.id, body);
        onDone();
        showToast('Inspection updated', 'success');
      } catch (err) {
        alert('Save failed: ' + err.message);
      }
    });
  }

  async function updateInspection(id, body) {
    body.id = id;
    const r = await fetch('/api/scheduled-inspections', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const err = await r.json();
      throw new Error(err.error || r.status);
    }
    return r.json();
  }

  // ── Attendances sub-section ───────────────────────────────────────────────

  async function renderAttendances(containerEl, inspection, dealId) {
    if (!containerEl) return;
    containerEl.innerHTML = '<div class="insp-loading">Loading attendees…</div>';
    try {
      const r = await fetch(`/api/inspection-attendances?scheduled_inspection_id=${inspection.id}`);
      if (!r.ok) throw new Error(r.status);
      const attendees = await r.json();

      let html = '<div class="insp-att-block">';
      html += '<div class="insp-att-header">Attendees</div>';
      html += attendees.length
        ? attendees.map(a => renderAttendeeRow(a)).join('')
        : '<div class="insp-empty">No attendees recorded yet.</div>';
      // Add-attendee picker at bottom
      html += `
        <div class="insp-att-add">
          <input class="kb-input insp-att-search" data-role="att-search" type="text" placeholder="Search contact to register attendance…">
          <div class="insp-att-results" data-role="att-results"></div>
        </div>
      </div>
      `;
      containerEl.innerHTML = html;

      // Wire existing attendee rows for trigger toggles + delete
      containerEl.querySelectorAll('[data-role="attendee-row"]').forEach(row => {
        wireAttendeeRow(row, inspection, dealId, containerEl);
      });

      // Wire contact search
      const searchEl   = containerEl.querySelector('[data-role="att-search"]');
      const resultsEl  = containerEl.querySelector('[data-role="att-results"]');
      let _searchTimer = null;

      // Position the (fixed) results dropdown directly under the search input,
      // flipping above when there's not enough room below (search sits at the
      // bottom of the attendees container, often near the viewport bottom).
      const positionResults = () => {
        const r = searchEl.getBoundingClientRect();
        // Make the dropdown measurable without a visible flash. .is-open sets
        // display:block; we briefly add it (and visibility:hidden) to read the
        // rendered height of the populated content.
        const hadOpen = resultsEl.classList.contains('is-open');
        const prevVis = resultsEl.style.visibility;
        if (!hadOpen) {
          resultsEl.style.visibility = 'hidden';
          resultsEl.classList.add('is-open');
        }
        const dropdownH = resultsEl.offsetHeight || 200;
        if (!hadOpen) {
          resultsEl.classList.remove('is-open');
          resultsEl.style.visibility = prevVis;
        }

        const viewportH   = window.innerHeight;
        const spaceBelow  = viewportH - r.bottom;
        const spaceAbove  = r.top;
        // Prefer below if there's room; otherwise flip above
        const flipUp = (spaceBelow < dropdownH + 12) && (spaceAbove > spaceBelow);

        resultsEl.style.left  = r.left + 'px';
        resultsEl.style.width = r.width + 'px';
        if (flipUp) {
          const top = Math.max(8, r.top - dropdownH - 2);
          resultsEl.style.top    = top + 'px';
          resultsEl.style.bottom = '';
          resultsEl.style.maxHeight = (r.top - 12) + 'px';
        } else {
          resultsEl.style.top    = (r.bottom + 2) + 'px';
          resultsEl.style.bottom = '';
          resultsEl.style.maxHeight = Math.max(120, viewportH - r.bottom - 12) + 'px';
        }
      };
      const openResults  = () => { positionResults(); resultsEl.classList.add('is-open'); };
      const closeResults = () => { resultsEl.classList.remove('is-open'); resultsEl.innerHTML = ''; };

      // Close when clicking outside or scrolling the modal
      const onDocClick = (e) => {
        if (!resultsEl.contains(e.target) && e.target !== searchEl) closeResults();
      };
      document.addEventListener('mousedown', onDocClick);
      // Reposition on scroll/resize
      const onReflow = () => { if (resultsEl.classList.contains('is-open')) positionResults(); };
      window.addEventListener('resize', onReflow);
      // Capture scroll on any ancestor (modal body scrolls)
      document.addEventListener('scroll', onReflow, true);

      searchEl.addEventListener('input', () => {
        clearTimeout(_searchTimer);
        const q = searchEl.value.trim();
        if (!q) { closeResults(); return; }
        _searchTimer = setTimeout(async () => {
          try {
            const sr = await fetch(`/api/contacts?search=${encodeURIComponent(q)}`);
            if (!sr.ok) return;
            const contacts = await sr.json();
            const taken = new Set(attendees.map(a => a.contact_id));
            const available = contacts.filter(c => !taken.has(c.id));
            // V77.3 — render available matches PLUS a "+ Create new contact"
            // row at the bottom. Empty state is replaced by just the create row.
            const matchesHtml = available.slice(0, 20).map(c => {
              const name = [c.first_name, c.last_name].filter(Boolean).join(' ').trim() || `Contact #${c.id}`;
              const detailParts = [c.email, c.mobile].filter(Boolean);
              const detailHtml = detailParts.length
                ? `<div class="insp-att-result-meta">${esc(detailParts.join(' · '))}</div>`
                : '';
              return `<div class="insp-att-result" data-contact-id="${c.id}" data-contact-name="${esc(name)}"><div class="insp-att-result-name">${esc(name)}</div>${detailHtml}</div>`;
            }).join('');
            const noMatchesHtml = available.length
              ? ''
              : '<div class="insp-att-result-empty">No matches.</div>';
            const createRowHtml = `
              <div class="insp-att-result insp-att-result-create" data-role="att-create">
                <div class="insp-att-result-name"><strong>+ Create new contact</strong></div>
                <div class="insp-att-result-meta">Open the contact form to add their details</div>
              </div>`;
            resultsEl.innerHTML = matchesHtml + noMatchesHtml + createRowHtml;
            openResults();
            resultsEl.querySelectorAll('.insp-att-result').forEach(item => {
              if (item.getAttribute('data-role') === 'att-create') {
                item.addEventListener('click', () => {
                  // Ensure CRM markup is mounted so the standalone helper exists.
                  const crmContainer = document.getElementById('crmViewContent');
                  if (crmContainer && !crmContainer.dataset.rendered && window.CRM?.renderCRMView) {
                    crmContainer.dataset.rendered = '1';
                    window.CRM.renderCRMView(crmContainer);
                  }
                  if (typeof window.openContactModalStandalone !== 'function') {
                    alert('Contact modal unavailable — please refresh the page.');
                    return;
                  }
                  searchEl.value = '';
                  closeResults();
                  window.openContactModalStandalone(null, async (createdId) => {
                    if (!createdId) return;
                    // Re-fetch the new contact's display name then jump straight
                    // into the check-in dialog (no extra search step).
                    try {
                      const r = await fetch(`/api/contacts?id=${createdId}`);
                      if (!r.ok) throw new Error(r.status);
                      const data = await r.json();
                      const ct = Array.isArray(data) ? data[0] : data;
                      if (!ct) return;
                      const name = [ct.first_name, ct.last_name].filter(Boolean).join(' ').trim() || `Contact #${ct.id}`;
                      openCheckInDialog({
                        contactId:   ct.id,
                        contactName: name,
                        inspection,
                        dealId,
                        onDone: () => { renderAttendances(containerEl, inspection, dealId); },
                      });
                    } catch (err) {
                      console.warn('[insp] failed to fetch newly-created contact:', err);
                      alert('Contact created. Search for them by name to register attendance.');
                    }
                  });
                });
              } else if (item.getAttribute('data-contact-id')) {
                item.addEventListener('click', () => {
                  openCheckInDialog({
                    contactId:    parseInt(item.getAttribute('data-contact-id'), 10),
                    contactName:  item.getAttribute('data-contact-name'),
                    inspection,
                    dealId,
                    onDone: () => { renderAttendances(containerEl, inspection, dealId); },
                  });
                  searchEl.value = '';
                  closeResults();
                });
              }
            });
          } catch (e) {
            console.warn('[insp] contact search failed', e);
          }
        }, 300);
      });
    } catch (err) {
      containerEl.innerHTML = `<div class="insp-error">Could not load attendees: ${esc(err.message)}</div>`;
    }
  }

  function renderAttendeeRow(a) {
    const name = [a.contact_first_name, a.contact_last_name].filter(Boolean).join(' ').trim() || `Contact #${a.contact_id}`;
    return `
      <div class="insp-att-row" data-role="attendee-row" data-id="${a.id}" data-contact-id="${a.contact_id}">
        <div class="insp-att-row-name">${esc(name)}</div>
        <div class="insp-att-row-checks">
          <label title="Follow-up"><input type="checkbox" data-trigger="followup" ${a.requested_followup_at ? 'checked' : ''}> Follow-up</label>
          <label title="Send offer form"><input type="checkbox" data-trigger="offer_form" ${a.requested_offer_form_at ? 'checked' : ''}> Send Offer</label>
          <label title="Send contract"><input type="checkbox" data-trigger="contract" ${a.requested_contract_at ? 'checked' : ''}> Send Contract</label>
        </div>
        <div class="insp-att-row-meta">${a.notes ? esc(a.notes) : ''}</div>
        <div class="insp-att-row-actions">
          <button class="insp-row-btn" data-role="att-delete-btn" title="Remove attendance">✕</button>
        </div>
      </div>
    `;
  }

  function wireAttendeeRow(row, inspection, dealId, containerEl) {
    const attendanceId = parseInt(row.getAttribute('data-id'), 10);

    // Trigger checkbox changes — PUT to update the attendance
    row.querySelectorAll('[data-trigger]').forEach(cb => {
      cb.addEventListener('change', async (e) => {
        const triggerKey = `trigger_${cb.getAttribute('data-trigger')}`;
        try {
          const r = await fetch('/api/inspection-attendances', {
            method:  'PUT',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ id: attendanceId, [triggerKey]: cb.checked }),
          });
          if (!r.ok) {
            const err = await r.json();
            alert(err.error || 'Update failed');
            cb.checked = !cb.checked; // revert
            return;
          }
          const data = await r.json();
          // Show toast for any auto-Actions created
          if (cb.checked && data.actions_created && data.actions_created.length) {
            const triggerLabels = { followup: 'Followup', offer_form: 'Send offer form', contract: 'Send contract' };
            const lbl = triggerLabels[cb.getAttribute('data-trigger')] || 'Action';
            showToast(`✓ Action created: ${lbl}`, 'success');
          }
        } catch (err) {
          alert('Update failed: ' + err.message);
          cb.checked = !cb.checked;
        }
      });
    });

    // Delete button
    row.querySelector('[data-role="att-delete-btn"]')?.addEventListener('click', async () => {
      if (!confirm('Remove this attendance record?')) return;
      try {
        const r = await fetch(`/api/inspection-attendances?id=${attendanceId}`, { method: 'DELETE' });
        if (!r.ok) { alert('Delete failed'); return; }
        renderAttendances(containerEl, inspection, dealId);
      } catch (err) {
        alert('Delete failed: ' + err.message);
      }
    });
  }

  // ── Check-in dialog ───────────────────────────────────────────────────────
  // Modal for first-time check-in: 6 tickboxes + notes field + save.
  // The 3 trigger checkboxes create auto-Actions; the 3 contact preference
  // checkboxes write to the contact directly.

  function openCheckInDialog({ contactId, contactName, inspection, dealId, onDone }) {
    const overlay = document.createElement('div');
    overlay.className = 'v77-modal-overlay';
    overlay.innerHTML = `
      <div class="v77-modal" style="max-width:540px">
        <div class="v77-modal-header">
          <div class="v77-modal-title">Register Attendance — <span data-role="dialog-name">${esc(contactName)}</span></div>
          <button class="v77-modal-close" data-role="close">✕</button>
        </div>
        <div class="v77-modal-body">
          <div class="kb-section-label">Contact details</div>
          <p class="insp-checkin-help">Update if needed — changes save to the contact's CRM record on Register.</p>
          <div class="insp-checkin-contact-grid">
            <div class="kb-field-wrap">
              <label class="kb-field-label">First name</label>
              <input class="kb-input" data-contact-field="first_name" type="text" value="" disabled>
            </div>
            <div class="kb-field-wrap">
              <label class="kb-field-label">Last name</label>
              <input class="kb-input" data-contact-field="last_name" type="text" value="" disabled>
            </div>
            <div class="kb-field-wrap">
              <label class="kb-field-label">Email</label>
              <input class="kb-input" data-contact-field="email" type="email" value="" disabled>
            </div>
            <div class="kb-field-wrap">
              <label class="kb-field-label">Mobile</label>
              <input class="kb-input" data-contact-field="mobile" type="tel" value="" disabled>
            </div>
          </div>

          <div class="kb-section-label" style="margin-top:14px">Contact preferences</div>
          <div class="insp-checkin-checks insp-checkin-prefs" data-region="prefs">
            <label class="insp-pref-row"><input type="checkbox" data-pref="not_set"> Marketing Preferences not yet set</label>
            <label class="insp-pref-row"><input type="checkbox" data-pref="dns"> Do not send Marketing</label>
            <label class="insp-pref-row"><input type="checkbox" data-pref="email"> Email marketing</label>
            <label class="insp-pref-row"><input type="checkbox" data-pref="sms"> SMS marketing</label>
          </div>

          <div class="kb-section-label" style="margin-top:14px">Actions requested (assigned to Listing Agent)</div>
          <div class="insp-checkin-checks">
            <label><input type="checkbox" data-flag="trigger_followup"> Followup requested</label>
            <label><input type="checkbox" data-flag="trigger_offer_form"> Send offer form</label>
            <label><input type="checkbox" data-flag="trigger_contract"> Send contract</label>
          </div>

          <div class="kb-field-wrap" style="margin-top:14px">
            <label class="kb-field-label">Notes (optional)</label>
            <textarea class="kb-input" data-field="notes" rows="2" placeholder="Any context about this attendance…"></textarea>
          </div>
        </div>
        <div class="v77-modal-footer">
          <button class="params-cancel-btn" data-role="close">Cancel</button>
          <button class="params-save-btn" data-role="save" disabled>Register</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.querySelectorAll('[data-role="close"]').forEach(b => b.addEventListener('click', close));
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

    // Track original snapshot so we can detect what's changed at Register time
    let originalContact = null;

    // ─── V79 — Mutual-exclusion + save-validation logic for prefs ─────────
    // The four checkboxes don't act independently: ticking certain ones
    // un-ticks/disables others. Save is disabled until at least one is on.
    const prefRegion  = overlay.querySelector('[data-region="prefs"]');
    const prefNotSet  = prefRegion.querySelector('[data-pref="not_set"]');
    const prefDns     = prefRegion.querySelector('[data-pref="dns"]');
    const prefEmail   = prefRegion.querySelector('[data-pref="email"]');
    const prefSms     = prefRegion.querySelector('[data-pref="sms"]');
    const saveBtn     = overlay.querySelector('[data-role="save"]');

    function syncPrefs(source) {
      // Mutual exclusion rules:
      //  - "not_set" exclusive with everything; ticking it unticks the others
      //  - "dns" exclusive with email + sms (DNS = hard no on marketing channels)
      //  - email + sms independent of each other
      if (source === prefNotSet && prefNotSet.checked) {
        prefDns.checked = false;
        prefEmail.checked = false;
        prefSms.checked = false;
      } else if ((source === prefDns || source === prefEmail || source === prefSms) && source.checked) {
        prefNotSet.checked = false;
      }
      if (source === prefDns && prefDns.checked) {
        prefEmail.checked = false;
        prefSms.checked   = false;
      }
      if ((source === prefEmail || source === prefSms) && source.checked) {
        prefDns.checked = false;
      }
      // Disable email/sms while DNS is on
      const dnsOn = prefDns.checked;
      prefEmail.disabled = dnsOn;
      prefSms.disabled   = dnsOn;
      // Save validation: at least one ticked
      const anyTicked = prefNotSet.checked || prefDns.checked || prefEmail.checked || prefSms.checked;
      saveBtn.disabled = !anyTicked;
    }
    [prefNotSet, prefDns, prefEmail, prefSms].forEach(cb => {
      cb.addEventListener('change', () => syncPrefs(cb));
    });

    // Load the contact record so the four fields are populated and editable
    (async () => {
      try {
        const r = await fetch(`/api/contacts?id=${contactId}`);
        if (!r.ok) throw new Error(r.status);
        const c = await r.json();
        originalContact = {
          first_name: c.first_name || '',
          last_name:  c.last_name  || '',
          email:      c.email      || '',
          mobile:     c.mobile     || '',
          // V79 consent state — used to compute a patch on save
          marketing_pref_set_at:      c.marketing_pref_set_at      || null,
          do_not_send_marketing_at:   c.do_not_send_marketing_at   || null,
          marketing_email_consent_at: c.marketing_email_consent_at || null,
          marketing_sms_consent_at:   c.marketing_sms_consent_at   || null,
        };
        overlay.querySelectorAll('[data-contact-field]').forEach(input => {
          const k = input.getAttribute('data-contact-field');
          input.value    = originalContact[k] || '';
          input.disabled = false;
        });
        // Pre-fill consent checkboxes from DB
        const hasDns   = !!originalContact.do_not_send_marketing_at;
        const hasEmail = !!originalContact.marketing_email_consent_at;
        const hasSms   = !!originalContact.marketing_sms_consent_at;
        const hasPref  = !!originalContact.marketing_pref_set_at;
        if (hasDns) {
          prefDns.checked = true;
          // email/sms forced off (DNS is exclusive)
        } else if (hasEmail || hasSms) {
          prefEmail.checked = hasEmail;
          prefSms.checked   = hasSms;
        } else if (!hasPref) {
          // Genuinely never asked — default to "Not yet set"
          prefNotSet.checked = true;
        }
        // If hasPref but no specific consent (asked, declined all marketing) →
        // none of the four checked. UI shows that state truthfully and Save
        // stays disabled until the agent picks something. That's acceptable.
        syncPrefs(null);
      } catch (err) {
        console.warn('[insp checkin] could not load contact', err);
        overlay.querySelectorAll('[data-contact-field]').forEach(input => {
          input.placeholder = 'Could not load — type to set';
          input.disabled = false;
        });
        // No consent data loaded — start with "Not yet set" ticked as default
        prefNotSet.checked = true;
        syncPrefs(null);
      }
    })();

    overlay.querySelector('[data-role="save"]').addEventListener('click', async () => {
      const saveBtn = overlay.querySelector('[data-role="save"]');
      saveBtn.disabled = true;
      const origText = saveBtn.textContent;
      saveBtn.textContent = 'Saving…';

      // Step 1: collect Contact-edit patch (only changed fields)
      const edited = {};
      overlay.querySelectorAll('[data-contact-field]').forEach(input => {
        const k = input.getAttribute('data-contact-field');
        edited[k] = input.value.trim();
      });

      // Light email-format check (only if email is non-empty)
      if (edited.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(edited.email)) {
        alert('Please enter a valid email address (or leave blank).');
        saveBtn.disabled = false;
        saveBtn.textContent = origText;
        return;
      }

      // Compute patch — only fields that actually changed
      const contactPatch = {};
      if (originalContact) {
        for (const k of ['first_name', 'last_name', 'email', 'mobile']) {
          if ((edited[k] || '') !== (originalContact[k] || '')) {
            contactPatch[k] = edited[k] || null;
          }
        }
      }

      // V79 — Build consent patch from the 4 checkboxes.
      // Map to the four DB columns:
      //   - "Not yet set"  → all 4 NULL
      //   - "DNS"          → do_not_send=now, others NULL, pref_set=now
      //   - "Email" only   → email=now, sms NULL, dns NULL, pref_set=now
      //   - "SMS" only     → sms=now, email NULL, dns NULL, pref_set=now
      //   - "Email + SMS"  → both=now, dns NULL, pref_set=now
      // The contacts PUT endpoint accepts ISO timestamps and nulls directly.
      const nowIso  = new Date().toISOString();
      const wantNotSet = prefNotSet.checked;
      const wantDns    = prefDns.checked;
      const wantEmail  = prefEmail.checked && !wantDns;
      const wantSms    = prefSms.checked   && !wantDns;
      // Always send the patch (we want to also support clearing).
      contactPatch.marketing_pref_set_at      = wantNotSet ? null : (originalContact?.marketing_pref_set_at || nowIso);
      contactPatch.do_not_send_marketing_at   = wantDns    ? (originalContact?.do_not_send_marketing_at   || nowIso) : null;
      contactPatch.marketing_email_consent_at = wantEmail  ? (originalContact?.marketing_email_consent_at || nowIso) : null;
      contactPatch.marketing_sms_consent_at   = wantSms    ? (originalContact?.marketing_sms_consent_at   || nowIso) : null;
      // For DNS/Email/SMS that flipped from off→on, stamp pref_set_at fresh
      if (!wantNotSet && !originalContact?.marketing_pref_set_at) {
        contactPatch.marketing_pref_set_at = nowIso;
      }

      // Step 2: PATCH the Contact (always — consent might be the only change)
      try {
        const r = await fetch('/api/contacts', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: contactId, ...contactPatch }),
        });
        if (!r.ok) {
          const err = await r.json().catch(() => ({}));
          alert('Could not save contact details: ' + (err.error || r.status));
          saveBtn.disabled = false;
          saveBtn.textContent = origText;
          return;
        }
      } catch (err) {
        alert('Could not save contact details: ' + err.message);
        saveBtn.disabled = false;
        saveBtn.textContent = origText;
        return;
      }

      // Step 3: create the attendance row
      const body = {
        scheduled_inspection_id: inspection.id,
        contact_id:              contactId,
        notes:                   overlay.querySelector('[data-field="notes"]').value || null,
      };
      overlay.querySelectorAll('[data-flag]').forEach(cb => {
        body[cb.getAttribute('data-flag')] = cb.checked;
      });
      // Don't send marketing prefs through this endpoint — already saved via PUT

      try {
        const r = await fetch('/api/inspection-attendances', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body:   JSON.stringify(body),
        });
        if (!r.ok) {
          const err = await r.json();
          alert(err.error || 'Register failed');
          saveBtn.disabled = false;
          saveBtn.textContent = origText;
          return;
        }
        const data = await r.json();
        const actionsCount = (data.actions_created || []).length;
        const finalName = [edited.first_name, edited.last_name].filter(Boolean).join(' ').trim() || contactName;
        const contactUpdatedNote = Object.keys(contactPatch).length
          ? ' Contact details updated.'
          : '';
        const msg = actionsCount > 0
          ? `${finalName} registered.${contactUpdatedNote} ${actionsCount} Action${actionsCount === 1 ? '' : 's'} created on Listing Agent.`
          : `${finalName} registered.${contactUpdatedNote}`;
        showToast(msg, 'success');
        close();
        if (onDone) onDone();
      } catch (err) {
        alert('Register failed: ' + err.message);
        saveBtn.disabled = false;
        saveBtn.textContent = origText;
      }
    });
  }

  // ── Expose ────────────────────────────────────────────────────────────────

  window.InspectionsSection = { render };
})();
