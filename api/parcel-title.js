/**
 * lib/parcel-title.js
 *
 * Server-side helper: produce the canonical formatted parcel title for a
 * parcel id, in the SAME format the frontend renders via
 * lib/parcel-format.js / formatParcelTitle.
 *
 * Self-contained pure ESM. The formatting logic is duplicated here from
 * lib/parcel-format.js because that file is an IIFE-wrapped browser script
 * loaded via <script> tag — importing it as a side-effect from an ESM
 * route handler on Vercel's serverless runtime can crash module init.
 * If you change rules here, also change them in lib/parcel-format.js
 * (and vice-versa). Both files must produce identical output for the
 * same inputs.
 *
 * Usage:
 *   import { titleForParcel } from '../lib/parcel-title.js';
 *   const title = await titleForParcel(sql, parcelId);
 */

function parseAddressHead(raw) {
  if (!raw) return { rawLead: null, streetName: '' };
  const s = String(raw).trim();
  let m;

  m = s.match(/^(\d+[a-z]?)\/(\d+[a-z]?)\s+(.+)$/i);
  if (m) {
    return {
      rawLead: { unit: m[1], base: parseInt(m[2], 10), baseRaw: m[2] },
      streetName: m[3].trim(),
    };
  }

  m = s.match(/^(\d+[a-z]?)\s+(.+)$/i);
  if (m) {
    return {
      rawLead: { base: parseInt(m[1], 10), baseRaw: m[1] },
      streetName: m[2].trim(),
    };
  }

  m = s.match(/^lot\s+(\d+[a-z]?)\s+(.+)$/i);
  if (m) {
    return {
      rawLead: { lot: m[1] },
      streetName: m[2].trim(),
    };
  }

  return { rawLead: null, streetName: s };
}

function parseLotDP(lotdpRaw) {
  if (!lotdpRaw) return null;
  const s = String(lotdpRaw).trim();
  const m = s.match(/^(\d+)[a-z]?\s*\/+\s*(DP\d+)$/i);
  if (m) return { lotNum: parseInt(m[1], 10), dp: m[2].toUpperCase() };
  const m2 = s.match(/^(\d+)$/);
  if (m2) return { lotNum: parseInt(m2[1], 10), dp: null };
  return null;
}

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
  const groups = [];
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
  return [...groups, ...special].join(' & ');
}

export function formatParcelTitle(properties) {
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

/**
 * Build a formatted title for a parcel id. Loads its child properties
 * (address, suburb, lot_dps) and runs them through formatParcelTitle.
 * Falls back to the parcels.name column or the bare id if anything fails.
 */
export async function titleForParcel(sql, parcelId) {
  if (!parcelId) return '';
  try {
    const kids = await sql`
      SELECT p.address, p.suburb, p.lot_dps
      FROM parcel_properties pp
      JOIN properties p ON p.id = pp.property_id
      WHERE pp.parcel_id = ${parcelId}`;
    if (kids.length) {
      const title = formatParcelTitle(kids);
      if (title) return title;
    }
    const pa = await sql`SELECT name FROM parcels WHERE id = ${parcelId} LIMIT 1`;
    return pa[0]?.name || parcelId;
  } catch (err) {
    console.warn('[titleForParcel] failed for', parcelId, ':', err.message);
    return parcelId;
  }
}

/**
 * Build a formatted title given the kids array directly.
 */
export function titleForParcelFromKids(kids) {
  if (!Array.isArray(kids) || !kids.length) return '';
  return formatParcelTitle(kids);
}
