# PropMap UI Style Guide

This file is the source of truth for the visual conventions of the app.
Claude (and any future AI assistant) MUST read this before touching any
modal, section, or table render. Failure to do so wastes the user's time
and re-introduces fixed bugs.

## Section pattern (modals)

Every collapsible section in a CRM/Kanban modal follows the same shape:

```html
<div class="crm-modal-section crm-section-collapsible" data-section="X" [data-collapsed="1"]>
  <div class="crm-modal-section-title crm-section-header">
    <span class="crm-section-header-left">
      <span class="crm-section-chev">▾</span> Section Title
      [<span class="crm-section-count">(N)</span>]   <!-- optional count -->
    </span>
    [<button class="...kb-add-offer-btn">Action</button>]  <!-- optional, inline right-justified -->
  </div>
  <div class="crm-section-body">
    ... body content ...
  </div>
</div>
```

### Rules

1. **The section heading is plain title text only.** Do NOT inline status,
   badges, values, or anything else into the heading. Status info goes in
   the body. (e.g. NEVER `Not Suitable <span>Until 20/5/2026</span>` in
   the header.)

2. **Action buttons sit inline-right-of the heading text**, as a direct
   child of `.crm-section-header` (sibling to `.crm-section-header-left`).
   The flex layout pushes them to the right edge automatically. This
   includes Clear flag, Save Changes, + New Deal, Open Active Deal,
   + Add Offer, etc. Do NOT put these inside the section body.

3. **Body content uses `.crm-detail-grid` for label/value pairs.** Two
   columns, fixed-width label, flexible value. Both 13px regular weight.
   No mid-sentence `<strong>`, no inline styles overriding the grid font.

   ```html
   <div class="crm-detail-grid">
     <div class="crm-detail-label">Status</div>
     <div>Flagged as not suitable · Until 20/5/2026</div>
   </div>
   ```

4. **Empty / "no items" state** uses `.crm-empty` with placeholder text.

5. **Collapsed default** when the section is empty/inactive — set
   `data-collapsed="1"` on the outer div, set `style="display:none"` on
   `.crm-section-body`, set chevron to `▸`. When active, no
   `data-collapsed`, no body inline style, chevron `▾`.

## Tables

`.crm-contact-table` is shared by Contacts, Organisations, Properties,
Parcels. Each one has different columns and different content widths.

**Always add a modifier class** for the specific table when applying
column-width rules: `crm-contact-table--properties`, `--contacts` etc.
Never apply `:nth-child` widths directly to `.crm-contact-table` because
it'll break the other tables.

When column widths matter (e.g. content shifts when the row set changes),
use `table-layout: fixed` plus explicit widths on the short fixed columns,
letting the flexible column (usually Address or Name) take the rest.

## Buttons

- Primary action: `.kb-add-offer-btn` (yellow accent).
- Secondary / link-style: `.crm-deal-open` etc.
- Don't reinvent — reuse existing classes.

## Text styles

- Section heading: `.crm-modal-section-title` — 11px, uppercase, bold,
  secondary colour. Set by CSS, don't override per-instance.
- Body label: `.crm-detail-label` — 12px, secondary colour.
- Body value: 13px regular in plain `<div>`.
- Code identifiers: `<code style="font-size:11px">`.
- Don't use `<strong>` for emphasis inside body values. Sectioning carries
  the meaning.

## Things I keep getting wrong (corrected here so I don't again)

- Putting action buttons inside the body instead of inline with the heading.
- Inlining status badges next to heading text.
- Using `<strong>` inside a body row.
- Forgetting `crm-detail-grid` and rolling my own div-and-style markup.
- Applying table column widths without a modifier class.

If you (Claude) catch yourself doing one of the above, STOP. Re-read this
file. Apply the pattern.
