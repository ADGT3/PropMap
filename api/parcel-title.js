/**
 * lib/parcel-title.js
 *
 * Server-side helper: produce the canonical formatted parcel title for a
 * parcel id. Wraps the shared lib/parcel-format.js formatter so server-side
 * consumers (notes, dd-attachments, etc.) get the same address string the
 * frontend renders.
 *
 * Loads parcel-format.js as a side-effect to populate globalThis.formatParcelTitle
 * (its IIFE does this when window is undefined, i.e. in Node).
 *
 * Usage:
 *   import { titleForParcel, titleForParcelFromKids } from '../lib/parcel-title.js';
 *   const title = await titleForParcel(sql, parcelId);
 */

import './parcel-format.js';   // side-effect: sets globalThis.formatParcelTitle

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
    if (kids.length && typeof globalThis.formatParcelTitle === 'function') {
      const title = globalThis.formatParcelTitle(kids);
      if (title) return title;
    }
    // Fallback: parcels.name snapshot
    const pa = await sql`SELECT name FROM parcels WHERE id = ${parcelId} LIMIT 1`;
    return pa[0]?.name || parcelId;
  } catch (err) {
    console.warn('[titleForParcel] failed for', parcelId, ':', err.message);
    return parcelId;
  }
}

/**
 * Build a formatted title given the kids array directly (skips the DB lookup
 * when the caller already has them).
 */
export function titleForParcelFromKids(kids) {
  if (!Array.isArray(kids) || !kids.length) return '';
  if (typeof globalThis.formatParcelTitle !== 'function') {
    // Formatter didn't load — concatenate addresses
    return kids.map(k => k.address).filter(Boolean).join(' & ');
  }
  return globalThis.formatParcelTitle(kids);
}
