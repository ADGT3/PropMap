/**
 * Split a merged AU property address into street / suburb / state / postcode.
 * Handles Rex-style imports: "Lot 348 Eastwood Road LEPPINGTON NSW 2179"
 */
const STATES = ['NSW', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'ACT', 'NT'];
const STATE_RE = STATES.join('|');
const STREET_TYPES = new Set([
  'ROAD', 'RD', 'STREET', 'ST', 'AVENUE', 'AVE', 'LANE', 'LN', 'DRIVE', 'DR',
  'PLACE', 'PL', 'COURT', 'CT', 'CLOSE', 'CL', 'CRESCENT', 'CRES', 'PARADE', 'PDE',
  'TERRACE', 'TCE', 'WAY', 'BOULEVARD', 'BLVD', 'HIGHWAY', 'HWY', 'PARKWAY', 'PKWY',
  'CIRCUIT', 'CCT', 'GROVE', 'GR', 'ESPLANADE', 'ESP', 'SQUARE', 'SQ', 'ALLEY',
  'TRAIL', 'TRACK', 'RIDGE', 'GLEN', 'WALK', 'RISE', 'VISTA', 'VIEW', 'VALLEY',
]);

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function maybeTitleCase(s) {
  if (!s) return s;
  const letters = s.replace(/[^A-Za-z]/g, '');
  const upper = (letters.match(/[A-Z]/g) || []).length;
  if (!letters.length || upper / letters.length < 0.75) return s.trim();
  return s
    .toLowerCase()
    .replace(/\b([a-z])/g, c => c.toUpperCase())
    .replace(/\b(Nsw|Vic|Qld|Wa|Sa|Tas|Act|Nt)\b/g, m => m.toUpperCase());
}

export function parsePropertyAddress(raw, known = {}) {
  const knownSuburb = String(known.suburb || '').replace(/\s+/g, ' ').trim();
  let address = String(raw || '').replace(/\s+/g, ' ').trim();
  let suburb = knownSuburb;
  let state = String(known.state || '').trim().toUpperCase();
  let postcode = String(known.postcode || '').replace(/\s+/g, '').trim();

  if (!address) {
    return {
      address: '',
      suburb: maybeTitleCase(suburb),
      state: STATES.includes(state) ? state : (state || 'NSW'),
      postcode,
    };
  }

  const tail = address.match(new RegExp(
    `^(.*?)(?:[,\\s]+)(${STATE_RE})(?:[,\\s]+(\\d{4}))?\\s*$`,
    'i'
  ));
  if (tail) {
    address = tail[1].trim().replace(/[,\s]+$/, '');
    if (!STATES.includes(state)) state = tail[2].toUpperCase();
    if (!postcode && tail[3]) postcode = tail[3];
  }

  if (suburb) {
    const re = new RegExp(`(?:[,\\s]+)${escapeRe(suburb)}\\s*$`, 'i');
    const stripped = address.replace(re, '').replace(/[,\s]+$/, '').trim();
    if (stripped && stripped.toLowerCase() !== address.toLowerCase()) address = stripped;
  } else {
    const tokens = address.split(/\s+/);
    for (let i = tokens.length - 2; i >= 1; i--) {
      if (!STREET_TYPES.has(tokens[i].toUpperCase())) continue;
      const after = tokens.slice(i + 1).join(' ').trim();
      if (after && !/^\d/.test(after) && after.length > 2 && !STREET_TYPES.has(after.toUpperCase())) {
        suburb = after;
        address = tokens.slice(0, i + 1).join(' ');
      }
      break;
    }
  }

  if (!STATES.includes(state)) state = 'NSW';

  return {
    address: maybeTitleCase(address),
    suburb: knownSuburb || maybeTitleCase(suburb),
    state,
    postcode: postcode || '',
  };
}

export function addressNeedsSplit(raw, known = {}) {
  const parsed = parsePropertyAddress(raw, known);
  const orig = String(raw || '').replace(/\s+/g, ' ').trim();
  return parsed.address !== orig
    || (!!parsed.postcode && !String(known.postcode || '').trim())
    || (!!parsed.suburb && !String(known.suburb || '').trim());
}

export default { parsePropertyAddress, addressNeedsSplit };
