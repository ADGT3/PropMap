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
    return `
      <div class="nf-type-row">
        <select class="nf-type-select kb-input" data-role="type">
          <option value="">Loading types…</option>
        </select>
        <select class="nf-source-select kb-input" data-role="source" style="display:none">
          <option value="">— Select source —</option>
        </select>
      </div>
      ${showContactTagger ? `
      <div class="nf-contact-row">
        <input class="kb-input nf-contact-search" type="text" placeholder="Tag a contact (optional)…" data-role="contact-search">
        <div class="nf-contact-results" data-role="contact-results"></div>
        <div class="nf-contact-tag" data-role="contact-tag" style="display:none"></div>
      </div>` : ''}
      <div class="nf-input-row">
        <textarea class="kb-input nf-text-input" placeholder="${placeholder}" rows="2" data-role="text"></textarea>
        <button class="nf-add-btn kb-action-btn" data-role="add">Add</button>
      </div>
    `;
  }

  // Just the type+source dropdown HTML, for callers that want to assemble
  // the rest of the form themselves
  function renderTypeSourceDropdownsHtml() {
    return `
      <div class="nf-type-row">
        <select class="nf-type-select kb-input" data-role="type">
          <option value="">Loading types…</option>
        </select>
        <select class="nf-source-select kb-input" data-role="source" style="display:none">
          <option value="">— Select source —</option>
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

  async function populateSourceDropdown(selectEl, defaultId) {
    if (!window.Lookups) {
      selectEl.innerHTML = '<option value="">— Select source —</option>';
      return;
    }
    const sources = await Lookups.getSourcesActive();
    selectEl.innerHTML =
      '<option value="">— Select source —</option>' +
      sources
        .map(s => `<option value="${s.id}" ${s.id === defaultId ? 'selected' : ''}>${escapeHtml(s.label)}</option>`)
        .join('');
    if (defaultId && sources.some(s => s.id === defaultId)) {
      selectEl.value = defaultId;
    }
  }

  function escapeHtml(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ── Direction-dependent source visibility ─────────────────────────────────

  function applySourceVisibility(typeSelect, sourceSelect) {
    if (!window.Lookups) {
      sourceSelect.style.display = 'none';
      return;
    }
    const dir = Lookups.interactionDirection(typeSelect.value);
    if (dir === 'inbound') {
      sourceSelect.style.display = '';
    } else {
      // Per Q2 (a) — silently clear value when direction changes away from inbound
      sourceSelect.value = '';
      sourceSelect.style.display = 'none';
    }
  }

  // ── Mount full form ───────────────────────────────────────────────────────

  function mount(containerEl, options = {}) {
    const opts = options || {};
    containerEl.innerHTML = buildHtml(opts);

    const typeSelect    = containerEl.querySelector('[data-role="type"]');
    const sourceSelect  = containerEl.querySelector('[data-role="source"]');
    const textInput     = containerEl.querySelector('[data-role="text"]');
    const addBtn        = containerEl.querySelector('[data-role="add"]');
    const contactSearch = containerEl.querySelector('[data-role="contact-search"]');
    const contactResults = containerEl.querySelector('[data-role="contact-results"]');
    const contactTag     = containerEl.querySelector('[data-role="contact-tag"]');

    let _taggedContactId   = opts.defaultTaggedContactId || null;
    let _taggedContactName = null;

    // Populate dropdowns
    Promise.all([
      populateTypeDropdown(typeSelect, opts.defaultInteractionType || 'file_note'),
      populateSourceDropdown(sourceSelect, opts.defaultSource || null),
    ]).then(() => {
      applySourceVisibility(typeSelect, sourceSelect);
    }).catch(err => {
      console.warn('[NoteForm] dropdown populate failed:', err);
    });

    // Type change → show/hide source dropdown
    typeSelect.addEventListener('change', () => {
      applySourceVisibility(typeSelect, sourceSelect);
    });

    // Contact tagger
    function clearContactTag() {
      _taggedContactId = null;
      _taggedContactName = null;
      if (contactTag) {
        contactTag.style.display = 'none';
        contactTag.innerHTML = '';
      }
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
                contactSearch.value = '';
                contactResults.innerHTML = '';
                contactTag.style.display = '';
                contactTag.innerHTML = `<span>@${escapeHtml(name)}</span><button class="nf-contact-clear" type="button">✕</button>`;
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
        source: sourceSelect.value || null,
        tagged_contact_id: _taggedContactId,
        note_text: textInput.value.trim(),
      };
    }
    function reset() {
      textInput.value = '';
      clearContactTag();
      // Reset type to default; source clears automatically via change handler
      typeSelect.value = opts.defaultInteractionType || 'file_note';
      applySourceVisibility(typeSelect, sourceSelect);
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
