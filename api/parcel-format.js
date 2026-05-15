/**
 * lib/parcel-format.js
 *
 * formatParcelTitle(properties) — produce a human-readable aggregated address
 * string for a Parcel.
 *
 * Grouping & compression rules (V78h.7):
 *   - Properties on the same street + suburb + DP are candidates for compression.
 *   - Within a candidate group, properties are sorted by LOT NUMBER.
 *   - Consecutive lot numbers → display as a STREET NUMBER range with hyphen,
 *     e.g. lots 121,122 with street numbers 49,57 → "49 - 57 Smith Rd".
 *   - Non-consecutive lot numbers → ampersand-joined street numbers,
 *     e.g. lots 121,125 with street numbers 49,57 → "49 & 57 Smith Rd".
 *   - Mixed runs (e.g. lots 121,122,125) → range + singleton: "49 - 53 & 61 Smith Rd".
 *   - Different DPs on the same street stay separate groups joined with " & ".
 *   - Different streets stay separate, joined with " & ".
 *   - Suburb appears once at the end (deduped case-insensitive).
 *
 * Input: array of { address, suburb, lot_dps } — works for both property
 * rows from the DB and parcel lot objects.
 *   - address: full street address ("49 Catherine Fields Road")
 *   - suburb:  suburb name
 *   - lot_dps: lot/DP string like "121//DP27602". A property has a single
 *     lot/DP (that's what defines it as a property — a parcel is multiple
 *     properties grouped). If missing/unparseable, the property's row is
 *     placed in its own group (no compression).
 *
 * Module is plain JS (not ESM-only). Frontend loads via <script>, exposing
 * formatParcelTitle on window. Backend tests can import via require.
 */

(function (global) {

  // Split raw address into { rawLead, streetName }.
  function parseAddressHead(raw) {
    if (!raw) return { rawLead: null, streetName: '' };
    const s = String(raw).trim();
    let m;

    // Unit pattern: N/N Street
    m = s.match(/^(\d+[a-z]?)\/(\d+[a-z]?)\s+(.+)$/i);
    if (m) {
      return {
        rawLead: { unit: m[1], base: parseInt(m[2], 10), baseRaw: m[2] },
        streetName: m[3].trim(),
      };
    }

    // Plain number pattern
    m = s.match(/^(\d+[a-z]?)\s+(.+)$/i);
    if (m) {
      return {
        rawLead: { base: parseInt(m[1], 10), baseRaw: m[1] },
        streetName: m[2].trim(),
      };
    }

    // Lot pattern
    m = s.match(/^lot\s+(\d+[a-z]?)\s+(.+)$/i);
    if (m) {
      return {
        rawLead: { lot: m[1] },
        streetName: m[2].trim(),
      };
    }

    return { rawLead: null, streetName: s };
  }

  // Parse a Lot/DP string. Accepts "121//DP27602" or "121/DP27602" or just
  // "121" (no DP). Returns { lotNum, dp } or null if unparseable.
  function parseLotDP(lotdpRaw) {
    if (!lotdpRaw) return null;
    const s = String(lotdpRaw).trim();
    const m = s.match(/^(\d+)[a-z]?\s*\/+\s*(DP\d+)$/i);
    if (m) return { lotNum: parseInt(m[1], 10), dp: m[2].toUpperCase() };
    const m2 = s.match(/^(\d+)$/);
    if (m2) return { lotNum: parseInt(m2[1], 10), dp: null };
    return null;
  }

  // Given a list of leads, build the display string.
  function compressByLotContiguity(leads) {
    if (!leads.length) return '';

    const numeric = [];
    const special = [];

    for (const l of leads) {
      if (l.specialDisplay !== undefined) {
        special.push(l.specialDisplay);
        continue;
      }
      if (typeof l.streetNumber === 'number' && !isNaN(l.streetNumber)
          && typeof l.lotNum === 'number' && !isNaN(l.lotNum)) {
        numeric.push(l);
      } else {
        special.push(l.streetNumberDisplay || String(l.streetNumber || '').trim());
      }
    }

    let groups = [];
    if (numeric.length) {
      numeric.sort((a, b) => a.lotNum - b.lotNum);
      let runStart = 0;
      for (let i = 1; i <= numeric.length; i++) {
        const ended = (i === numeric.length) || (numeric[i].lotNum !== numeric[i - 1].lotNum + 1);
        if (ended) {
          const segment = numeric.slice(runStart, i);
          if (segment.length === 1) {
            groups.push(String(segment[0].streetNumberDisplay || segment[0].streetNumber));
          } else {
            const first = segment[0];
            const last  = segment[segment.length - 1];
            groups.push(`${first.streetNumberDisplay || first.streetNumber} - ${last.streetNumberDisplay || last.streetNumber}`);
          }
          runStart = i;
        }
      }
    }

    const parts = [...groups, ...special];
    return parts.join(' & ');
  }

  function formatParcelTitle(properties) {
    if (!Array.isArray(properties) || properties.length === 0) return '';

    const byStreet = new Map();
    const unparsed = [];

    for (const p of properties) {
      const addr   = p.address || '';
      const suburb = p.suburb  || '';
      const lotDP  = parseLotDP(p.lot_dps);
      const { rawLead, streetName } = parseAddressHead(addr);

      const streetKey = streetName.toLowerCase();
      if (!byStreet.has(streetKey)) {
        byStreet.set(streetKey, { streetName, byDp: new Map(), suburbs: new Set() });
      }
      const entry = byStreet.get(streetKey);

      if (suburb) {
        const key = suburb.trim().toLowerCase();
        let alreadyHave = false;
        for (const existing of entry.suburbs) {
          if (existing.trim().toLowerCase() === key) { alreadyHave = true; break; }
        }
        if (!alreadyHave) entry.suburbs.add(suburb.trim());
      }

      if (!rawLead) {
        unparsed.push(addr);
        continue;
      }

      let lead;
      if (rawLead.unit !== undefined) {
        lead = { specialDisplay: `${rawLead.unit}/${rawLead.baseRaw}` };
      } else if (rawLead.lot !== undefined) {
        lead = { specialDisplay: `Lot ${rawLead.lot}` };
      } else if (typeof rawLead.base === 'number') {
        lead = {
          streetNumber: rawLead.base,
          streetNumberDisplay: rawLead.baseRaw,
          lotNum: lotDP ? lotDP.lotNum : null,
        };
      } else {
        unparsed.push(addr);
        continue;
      }

      const dpKey = lotDP && lotDP.dp ? lotDP.dp : '__none';
      if (!entry.byDp.has(dpKey)) entry.byDp.set(dpKey, []);
      entry.byDp.get(dpKey).push(lead);
    }

    if (byStreet.size === 0 && unparsed.length) {
      return unparsed[0];
    }

    const streetSegments = [];
    for (const entry of byStreet.values()) {
      const dpSegments = [];
      for (const leads of entry.byDp.values()) {
        const s = compressByLotContiguity(leads);
        if (s) dpSegments.push(s);
      }
      if (!dpSegments.length) {
        streetSegments.push(entry.streetName);
        continue;
      }
      streetSegments.push(`${dpSegments.join(' & ')} ${entry.streetName}`.trim());
    }

    const addressPart = streetSegments.join(' & ');

    const seen = new Set();
    const finalSuburbs = [];
    for (const entry of byStreet.values()) {
      for (const s of entry.suburbs) {
        const k = s.trim().toLowerCase();
        if (!seen.has(k)) { seen.add(k); finalSuburbs.push(s.trim()); }
      }
    }

    if (finalSuburbs.length === 0) return addressPart;
    if (finalSuburbs.length === 1) return `${addressPart}, ${finalSuburbs[0]}`;
    return `${addressPart}, ${finalSuburbs.join(' & ')}`;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { formatParcelTitle, parseAddressHead, parseLotDP, compressByLotContiguity };
  }
  global.formatParcelTitle = formatParcelTitle;

})(typeof window !== 'undefined' ? window : globalThis);
