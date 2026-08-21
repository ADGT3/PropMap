/**
 * api/repair-v75-4a.js
 * V75.4a repair endpoint — fixes child Property rows created by the V75.4
 * migration.
 *
 * Background: V75.4 split synthetic multi-parcel Property rows into real
 * Parcel + N Properties. The source JSONB `parcels[]` array only contained
 * { lat, lng, label } per entry — the label was the MERGED aggregate address
 * (e.g. "109-115 Deepfields Road"), not a per-lot address. The original
 * lot_dps was comma-joined on the parent property and was lost when the
 * parent was deleted. So every child Property ended up with a nonsense
 * "Lot N 109-115 Deepfields Road" address and an empty lot_dps.
 *
 * This endpoint rebuilds the authoritative per-property data by querying
 * external services for each child's lat/lng:
 *   - NSW cadastre ArcGIS → lot_dps, area_sqm
 *   - ArcGIS reverse-geocode → street address + suburb
 *
 * Dry-run returns the proposed changes WITHOUT making them; execute applies.
 * Safe to re-run — idempotent via _migrations. Skips children that already
 * have real data (address not starting with "Lot ").
 *
 * GET  /api/repair-v75-4a → dry-run
 * POST /api/repair-v75-4a → execute
 */

import { neon } from '@neondatabase/serverless';
import { requireSession, requireAdmin } from '../lib/auth.js';
import { getDatabaseUrl } from '../lib/db.js';
const sql = neon(getDatabaseUrl());

const MIGRATION_ID = 'v75_4a_address_repair';

// NSW cadastre — NSW Spatial Services public ArcGIS endpoint
const NSW_CADASTRE_URL =
  'https://maps.six.nsw.gov.au/arcgis/rest/services/public/NSW_Cadastre/MapServer/9/query';

async function fetchNswCadastre(lat, lng) {
  try {
    const params = new URLSearchParams({
      f:              'json',
      geometry:       `${lng},${lat}`,
      geometryType:   'esriGeometryPoint',
      inSR:           '4326',
      spatialRel:     'esriSpatialRelIntersects',
      outFields:      'lotidstring',
      returnGeometry: 'false',
    });
    const r = await fetch(`${NSW_CADASTRE_URL}?${params}`, {
      signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) return null;
    const j = await r.json();
    const f = j?.features?.[0];
    if (!f) return null;
    return {
      lotid:   f.attributes?.lotidstring || null,
      // NSW public cadastre doesn't expose Shape__Area on this layer
      areaSqm: null,
    };
  } catch (err) {
    console.warn('[repair-v75-4a] cadastre fetch failed:', err.message);
    return null;
  }
}

async function fetchReverseGeocode(lat, lng) {
  try {
    const params = new URLSearchParams({
      location:           `${lng},${lat}`,
      outSR:              '4326',
      returnIntersection: 'false',
      f:                  'json',
    });
    const r = await fetch(
      `https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/reverseGeocode?${params}`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (!r.ok) return null;
    const j = await r.json();
    if (!j?.address) return null;
    const a = j.address;
    return {
      address: a.ShortLabel || a.Address || null,
      // NOTE: ArcGIS .City returns the LGA (e.g. "Camden") not the suburb
      // (e.g. "Bringelly") for Sydney outer areas. We don't trust it here —
      // the repair preserves the existing suburb from the DB. .Neighborhood
      // is sometimes the suburb but often blank; exposed for debugging.
      suburb_neighborhood: a.Neighborhood || null,
      suburb_district:     a.District || null,
      suburb_city:         a.City || null,
    };
  } catch (err) {
    console.warn('[repair-v75-4a] reverse-geocode failed:', err.message);
    return null;
  }
}

// Returns the lowercased street-name portion of an address (minus number prefix)
// Used to check whether a geocoded address refers to the same road as the stored one.
function extractStreetName(addr) {
  if (!addr) return '';
  const s = String(addr).trim();
  // Strip leading number(s) or "Lot N"
  return s.replace(/^lot\s+\d+\s+/i, '').replace(/^[\d/-]+\s+/, '').toLowerCase();
}

// Find candidate child Property rows needing repair.
// Criteria: has parcel_id AND (address starts with "Lot " OR lot_dps is empty)
async function findCandidates() {
  return await sql`
    SELECT id, address, suburb, lat, lng, lot_dps, area_sqm, parcel_id, parcels
    FROM properties
    WHERE parcel_id IS NOT NULL
      AND (address LIKE 'Lot %' OR COALESCE(lot_dps, '') = '')
      AND lat IS NOT NULL AND lng IS NOT NULL`;
}

export default async function handler(req, res) {
  const session = await requireSession(req, res);
  if (!session) return;
  if (!requireAdmin(session, res)) return;
  try {
    if (req.method === 'GET')  return await dryRun(res);
    if (req.method === 'POST') return await execute(res);
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[repair-v75-4a] fatal:', err);
    return res.status(500).json({ error: err.message });
  }
}

async function dryRun(res) {
  const prior = await sql`SELECT 1 FROM _migrations WHERE id = ${MIGRATION_ID}`;
  const alreadyRan = prior.length > 0;

  const candidates = await findCandidates();
  const previews = [];
  for (const p of candidates) {
    const [cadastre, geocode] = await Promise.all([
      fetchNswCadastre(p.lat, p.lng),
      fetchReverseGeocode(p.lat, p.lng),
    ]);
    // Street-name safety: only propose a new address if the geocoded street
    // name matches the stored one (modulo "Lot N" junk in the stored copy).
    const storedStreet = extractStreetName(p.address);
    const geocodedStreet = extractStreetName(geocode?.address);
    // If stored address was garbage ("Lot N ...") the stored street IS the
    // aggregate (e.g. "16-48 Loftus Road") — do a looser "contains" check
    const storedWasGarbage = String(p.address || '').startsWith('Lot ');
    const streetMatches = storedWasGarbage
      ? storedStreet && geocodedStreet && storedStreet.includes(geocodedStreet.split(' ').slice(1).join(' '))
      : storedStreet === geocodedStreet;
    const safeToReplaceAddress = !!(geocode?.address && (storedWasGarbage ? streetMatches : true));

    previews.push({
      id: p.id,
      parcel_id: p.parcel_id,
      lat: p.lat,
      lng: p.lng,
      current: {
        address: p.address,
        suburb:  p.suburb,
        lot_dps: p.lot_dps,
      },
      proposed: {
        address: safeToReplaceAddress ? geocode.address : p.address, // keep current if street mismatch
        // Preserve existing suburb — geocoder returns LGA not suburb here
        suburb:  p.suburb,
        lot_dps: cadastre?.lotid || p.lot_dps,
      },
      geocode_raw: {
        address:            geocode?.address || null,
        suburb_neighborhood: geocode?.suburb_neighborhood || null,
        suburb_district:    geocode?.suburb_district || null,
        suburb_city:        geocode?.suburb_city || null,
      },
      has_cadastre: !!cadastre?.lotid,
      has_geocode:  !!geocode?.address,
      street_match: streetMatches,
      address_will_change: safeToReplaceAddress && geocode.address !== p.address,
    });
  }

  const parcels = await sql`SELECT id, name FROM parcels`;
  const parcelProposals = [];
  for (const pa of parcels) {
    if ((pa.name || '').includes(',')) continue;
    const kids = await sql`
      SELECT suburb FROM properties
      WHERE parcel_id = ${pa.id} AND suburb IS NOT NULL AND suburb <> ''
      LIMIT 1`;
    const suburb = kids[0]?.suburb || null;
    if (!suburb) continue;
    parcelProposals.push({
      id: pa.id,
      current_name: pa.name,
      proposed_name: `${pa.name}, ${suburb}`,
    });
  }

  return res.status(200).json({
    migration_id: MIGRATION_ID,
    already_run: alreadyRan,
    property_repairs: previews,
    parcel_renames: parcelProposals,
    next_action: alreadyRan ? 'nothing — already run' : 'POST to /api/repair-v75-4a to execute',
  });
}

async function execute(res) {
  const prior = await sql`SELECT 1 FROM _migrations WHERE id = ${MIGRATION_ID}`;
  if (prior.length) return res.status(200).json({ ok: true, already_run: true });

  const candidates = await findCandidates();
  const propertyUpdates = [];
  for (const p of candidates) {
    const [cadastre, geocode] = await Promise.all([
      fetchNswCadastre(p.lat, p.lng),
      fetchReverseGeocode(p.lat, p.lng),
    ]);

    const storedStreet = extractStreetName(p.address);
    const geocodedStreet = extractStreetName(geocode?.address);
    const storedWasGarbage = String(p.address || '').startsWith('Lot ');
    const streetMatches = storedWasGarbage
      ? storedStreet && geocodedStreet && storedStreet.includes(geocodedStreet.split(' ').slice(1).join(' '))
      : storedStreet === geocodedStreet;
    const safeToReplaceAddress = !!(geocode?.address && (storedWasGarbage ? streetMatches : true));

    const newAddress = safeToReplaceAddress
      ? geocode.address
      : (storedWasGarbage ? null : p.address); // null so COALESCE falls through to existing if garbage + no replacement

    const newLotDps = cadastre?.lotid || null;

    await sql`
      UPDATE properties
      SET
        address    = COALESCE(${newAddress}, address),
        lot_dps    = COALESCE(${newLotDps}, NULLIF(lot_dps, '')),
        updated_at = now()
      WHERE id = ${p.id}`;

    propertyUpdates.push({
      id: p.id,
      old_address: p.address,
      new_address: newAddress,
      new_lot_dps: newLotDps,
      had_geocode:  !!geocode?.address,
      had_cadastre: !!cadastre?.lotid,
      street_match: streetMatches,
      address_changed: safeToReplaceAddress && geocode?.address !== p.address,
    });
  }

  // Parcel names — suburb is already correct in the DB, append to parcel.name
  const parcels = await sql`SELECT id, name FROM parcels`;
  const parcelUpdates = [];
  for (const pa of parcels) {
    if (!pa.name || pa.name.includes(',')) continue;
    const kids = await sql`
      SELECT suburb FROM properties
      WHERE parcel_id = ${pa.id} AND suburb IS NOT NULL AND suburb <> ''
      LIMIT 1`;
    const suburb = kids[0]?.suburb;
    if (!suburb) continue;
    const newName = `${pa.name}, ${suburb}`;
    await sql`UPDATE parcels SET name = ${newName}, updated_at = now() WHERE id = ${pa.id}`;
    parcelUpdates.push({ id: pa.id, old_name: pa.name, new_name: newName });
  }

  await sql`INSERT INTO _migrations (id, completed_at) VALUES (${MIGRATION_ID}, now()) ON CONFLICT (id) DO NOTHING`;

  return res.status(200).json({
    ok: true,
    already_run: false,
    summary: {
      properties_checked: candidates.length,
      properties_updated: propertyUpdates.length,
      parcels_renamed:    parcelUpdates.length,
    },
    property_updates: propertyUpdates,
    parcel_updates:   parcelUpdates,
  });
}
