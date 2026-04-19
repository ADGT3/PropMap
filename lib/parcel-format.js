/**
 * lib/parcel-format.js
 *
 * formatParcelTitle(properties) — produce a human-readable aggregated address
 * string for a Parcel, collapsing contiguous street numbers into ranges and
 * grouping by street.
 *
 * Examples:
 *   [32, 33, 34, 35 Smith Rd]        → "32-35 Smith Rd, Suburb"
 *   [32, 34, 35 Smith Rd]            → "32, 34-35 Smith Rd, Suburb"
 *   [32 Smith Rd, 3 Oak Ave]         → "32 Smith Rd & 3 Oak Ave, Suburb"
 *   [2/14, 5/15, 8, 9, 10 Smith Rd]  → "2/14 & 5/15 & 8-10 Smith Rd, Suburb"
 *   [no street number: Lot 23]       → "Lot 23 Smith Rd, Suburb"
 *   [no number, no lot]              → first property's raw address
 *
 * The function accepts any object with { address, suburb } fields — works on
 * both property rows from the DB and parcel lot objects from the old JSONB.
 *
 * Module is plain JS (not ESM-only). Frontend loads via <script>, exposing
 * formatParcelTitle on window. Backend tests can import via require.
 */

(function (global) {

  // Split raw address into { rawLead, streetName }.
  //   rawLead captures the leading number block or "Lot N" token
  //   streetName is everything after, trimmed
  // Returns { rawLead: null, streetName: rawAddr } if unparseable.
  function parseAddressHead(raw) {
    if (!raw) return { rawLead: null, streetName: '' };
    const s = String(raw).trim();

    // Patterns tried in order:
    //   1. "2/14 Smith Rd"         → unit=2, base=14, street=Smith Rd
    //   2. "32 Smith Rd"           → base=32, street=Smith Rd
    //   3. "Lot 23 Smith Rd"       → lot=23, street=Smith Rd
    //   4. Anything else           → null lead, full string as street

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

    // Unparseable → return the full string as street (no lead)
    return { rawLead: null, streetName: s };
  }

  // Group numeric leads into contiguous ranges.
  //   [32, 33, 34, 35]     → "32-35"
  //   [32, 34, 35]         → "32, 34-35"
  //   [1, 2, 5, 7, 8, 9]   → "1-2, 5, 7-9"
  function compressContiguous(numbers) {
    if (!numbers.length) return '';
    const sorted = [...numbers].sort((a, b) => a - b);
    const groups = [];
    let start = sorted[0];
    let prev  = sorted[0];
    for (let i = 1; i < sorted.length; i++) {
      const n = sorted[i];
      if (n === prev + 1) {
        prev = n;
      } else {
        groups.push(start === prev ? `${start}` : `${start}-${prev}`);
        start = n;
        prev  = n;
      }
    }
    groups.push(start === prev ? `${start}` : `${start}-${prev}`);
    return groups.join(', ');
  }

  // Format the list of leads for a single street into a display string.
  // Contiguous plain-numeric leads get compressed into ranges.
  // Unit-prefixed leads (e.g. 2/14) and Lot leads stay standalone joined with ' & '.
  function formatStreetLeads(leads) {
    const plain = [];
    const special = [];

    for (const l of leads) {
      if (!l) continue;
      if (l.unit !== undefined) {
        special.push(`${l.unit}/${l.baseRaw}`);
      } else if (l.lot !== undefined) {
        special.push(`Lot ${l.lot}`);
      } else if (typeof l.base === 'number' && !isNaN(l.base)) {
        plain.push(l.base);
      }
    }

    const parts = [];
    if (special.length) parts.push(special.join(' & '));
    if (plain.length)   parts.push(compressContiguous(plain));
    return parts.join(' & ');
  }

  // Main entry point
  function formatParcelTitle(properties) {
    if (!Array.isArray(properties) || properties.length === 0) return '';

    // Parse each property; group by street name (case-insensitive)
    const byStreet = new Map();   // key = lowercased street, value = { streetName, leads: [], suburbs: Set }
    const unparsed = [];

    for (const p of properties) {
      const addr   = p.address || '';
      const suburb = p.suburb  || '';
      const { rawLead, streetName } = parseAddressHead(addr);
      const streetKey = streetName.toLowerCase();
      if (!byStreet.has(streetKey)) {
        byStreet.set(streetKey, { streetName, leads: [], suburbs: new Set() });
      }
      const entry = byStreet.get(streetKey);
      if (rawLead) entry.leads.push(rawLead);
      else         unparsed.push(addr);
      if (suburb) entry.suburbs.add(suburb);
    }

    if (byStreet.size === 0 && unparsed.length) {
      // No street could be parsed at all — graceful fallback: first property's raw address
      return unparsed[0];
    }

    // Render each street segment
    const streetSegments = [];
    for (const entry of byStreet.values()) {
      if (!entry.leads.length) {
        // Street had properties but no lead parseable → use streetName only
        streetSegments.push(entry.streetName);
        continue;
      }
      const leadsStr = formatStreetLeads(entry.leads);
      streetSegments.push(`${leadsStr} ${entry.streetName}`.trim());
    }

    // Collect all suburbs
    const allSuburbs = new Set();
    for (const entry of byStreet.values()) {
      entry.suburbs.forEach(s => allSuburbs.add(s));
    }

    // Join street segments with ' & '
    const addressPart = streetSegments.join(' & ');
    if (allSuburbs.size === 0) return addressPart;
    if (allSuburbs.size === 1) return `${addressPart}, ${[...allSuburbs][0]}`;
    // Multi-suburb: join as ", suburbA & suburbB"
    return `${addressPart}, ${[...allSuburbs].join(' & ')}`;
  }

  // Export for both ESM-style and global-style consumers
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { formatParcelTitle, parseAddressHead, compressContiguous, formatStreetLeads };
  }
  global.formatParcelTitle = formatParcelTitle;

})(typeof window !== 'undefined' ? window : globalThis);
