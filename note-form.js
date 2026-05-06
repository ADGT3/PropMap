/**
 * note-form.js — V77.1
 *
 * Reusable extended Note form. Replaces the simple textarea-only Note input
 * at every callsite (kanban deal modal, CRM contact modal, parcel modal, etc.)
 * with one that includes:
 *
 *   - Type dropdown   (interaction_types — e.g. File Note, Phone In, Email Out)
 *   - Source dropdown (contact_sources — only visible when type direction is 'inbound')
 *   - Tagged contact picker (existing behaviour, preserved)
 *   - Textarea + Add button
 *
 * Per build plan §4.1.3:
 *   - When user changes type: if direction !== 'inbound', source dropdown hides
 *     and any selected source value is silently cleared
 *   - When user changes type to inbound: source dropdown appears, defaults to '(none)'
 *
 * Public API (attached to window.NoteForm):
 *
 *   NoteForm.mount(containerEl, options) → { getValues, reset, focus, destroy }
 *     options = {
 *       defaultInteractionType: 'file_note' | other id,    (default: 'file_note')
 *       defaultSource:          contact_sources.id,        (default: null)
 *       defaultTaggedContactId: integer,                    (default: null)
 *       showContactTagger:      boolean                     (default: true)
 *       placeholder:            string                      (default: 'Add a note…')
 *       onAdd:                  async (values) => void     (called when Add clicked)
 *     }
 *
 *     getValues() returns { interaction_type, source, tagged_contact_id, note_text }
 *
 *   NoteForm.renderTypeSourceDropdownsHtml(opts) → string
 *     Returns just the HTML markup for the type+source dropdowns row.
 *     Useful when caller wants to assemble the full form themselves.
 *
 * Styling: relies on .nf-* CSS classes defined in styles.css.
 */

(function () {
  'use strict';

  // ── Build markup ──────────────────────────────────────────────────────────

  function buildHtml(opts) {
    const showContactTagger = opts.showContactTagger !== false;
    const placeholder       = opts.placeholder || 'Add a note…';
    // V77.1 — source dropdown removed from this generic NoteForm. Source is
    // an enquiry-origination concept, captured ONLY on the first note of an
    // Enquiry deal via the "+ New Card" wizard (which builds its own UI).
    // Subsequent notes don't have a meaningful source.
    // Type and Tag-a-contact share one row to save vertical space.
    return `
      <div class="nf-top-row">
        <select class="nf-type-select kb-input" data-role="type">
          <option value="">Loading types…</option>
        </select>
        ${showContactTagger ? `
        <div class="nf-contact-wrap">
          <input class="kb-input nf-contact-search" type="text" placeholder="Tag a contact (optional)…" data-role="contact-search">
          <div class="nf-contact-results" data-role="contact-results"></div>
          <div class="nf-contact-tag" data-role="contact-tag" style="display:none"></div>
        </div>` : ''}
      </div>
      <div class="nf-input-row">
        <textarea class="kb-input nf-text-input" placeholder="${placeholder}" rows="2" data-role="text"></textarea>
        <button class="nf-add-btn kb-action-btn" data-role="add">Add</button>
      </div>
    `;
  }

  // Just the type dropdown HTML (no source — see V77.1 note above), for
  // callers that want to assemble the rest of the form themselves.
  function renderTypeSourceDropdownsHtml() {
    return `
      <div class="nf-top-row">
        <select class="nf-type-select kb-input" data-role="type">
          <option value="">Loading types…</option>
        </select>
      </div>
    `;
  }

  // ── Populate dropdowns from cache ─────────────────────────────────────────

  async function populateTypeDropdown(selectEl, defaultId) {
    if (!window.Lookups) {
      selectEl.innerHTML = '<option value="file_note">File Note</option>';
      selectEl.value = 'file_note';
      return;
    }
    const types = await Lookups.getInteractionTypesActive();
    selectEl.innerHTML = types
      .map(t => `<option value="${t.id}" ${t.id === defaultId ? 'selected' : ''}>${escapeHtml(t.label)}</option>`)
      .join('');
    if (defaultId && types.some(t => t.id === defaultId)) {
      selectEl.value = defaultId;
    } else if (types.length) {
      selectEl.value = types[0].id;
    }
  }

  // V77.1 — populateSourceDropdown / applySourceVisibility removed.
  // Source is no longer part of the generic NoteForm. The "+ New Card" wizard
  // captures enquiry source on its own UI when creating an Enquiry deal.

  function escapeHtml(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ── Mount full form ───────────────────────────────────────────────────────

  function mount(containerEl, options = {}) {
    const opts = options || {};
    containerEl.innerHTML = buildHtml(opts);

    const typeSelect    = containerEl.querySelector('[data-role="type"]');
    const textInput     = containerEl.querySelector('[data-role="text"]');
    const addBtn        = containerEl.querySelector('[data-role="add"]');
    const contactSearch = containerEl.querySelector('[data-role="contact-search"]');
    const contactResults = containerEl.querySelector('[data-role="contact-results"]');
    const contactTag     = containerEl.querySelector('[data-role="contact-tag"]');

    let _taggedContactId   = opts.defaultTaggedContactId || null;
    let _taggedContactName = null;

    // Populate type dropdown
    populateTypeDropdown(typeSelect, opts.defaultInteractionType || 'file_note').catch(err => {
      console.warn('[NoteForm] type dropdown populate failed:', err);
    });

    // Contact tagger
    function clearContactTag() {
      _taggedContactId = null;
      _taggedContactName = null;
      if (contactTag) {
        contactTag.style.display = 'none';
        contactTag.innerHTML = '';
      }
      if (contactSearch) {
        contactSearch.style.display = '';
        contactSearch.value = '';
        contactSearch.focus();
      }
      if (contactResults) contactResults.innerHTML = '';
    }

    let _contactSearchTimer = null;
    if (contactSearch) {
      contactSearch.addEventListener('input', () => {
        clearTimeout(_contactSearchTimer);
        const q = contactSearch.value.trim();
        if (!q) {
          contactResults.innerHTML = '';
          return;
        }
        _contactSearchTimer = setTimeout(async () => {
          try {
            const r = await fetch(`/api/contacts?search=${encodeURIComponent(q)}`);
            if (!r.ok) return;
            const rows = await r.json();
            contactResults.innerHTML = '';
            rows.slice(0, 8).forEach(c => {
              const item = document.createElement('div');
              item.className = 'nf-contact-result';
              const name = [c.first_name, c.last_name].filter(Boolean).join(' ').trim() || `Contact #${c.id}`;
              item.textContent = name;
              item.addEventListener('click', () => {
                _taggedContactId = c.id;
                _taggedContactName = name;
                // V77.1 — picked contact replaces the search input visually:
                // hide the input, show the chip in its place (same row).
                contactSearch.style.display = 'none';
                contactSearch.value = '';
                contactResults.innerHTML = '';
                contactTag.style.display = '';
                contactTag.innerHTML = `<span class="nf-contact-tag-name">@${escapeHtml(name)}</span><button class="nf-contact-clear" type="button" title="Clear">✕</button>`;
                contactTag.querySelector('.nf-contact-clear').addEventListener('click', clearContactTag);
              });
              contactResults.appendChild(item);
            });
          } catch (e) {
            console.warn('[NoteForm] contact search failed:', e);
          }
        }, 300);
      });
    }

    // Add button
    addBtn.addEventListener('click', async () => {
      const text = textInput.value.trim();
      if (!text) return;
      addBtn.disabled = true;
      try {
        const values = getValues();
        if (typeof opts.onAdd === 'function') {
          await opts.onAdd(values);
        }
      } catch (err) {
        console.error('[NoteForm] onAdd failed:', err);
      } finally {
        addBtn.disabled = false;
      }
    });

    // Cmd/Ctrl + Enter to submit
    textInput.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        addBtn.click();
      }
    });

    function getValues() {
      return {
        interaction_type: typeSelect.value || 'file_note',
        // V77.1 — source removed from generic NoteForm; captured on Enquiry origination only
        tagged_contact_id: _taggedContactId,
        note_text: textInput.value.trim(),
      };
    }
    function reset() {
      textInput.value = '';
      clearContactTag();
      typeSelect.value = opts.defaultInteractionType || 'file_note';
    }
    function focus() {
      textInput.focus();
    }
    function destroy() {
      containerEl.innerHTML = '';
    }

    return { getValues, reset, focus, destroy };
  }

  // ── Expose ────────────────────────────────────────────────────────────────

  window.NoteForm = {
    mount,
    renderTypeSourceDropdownsHtml,
  };
})();
