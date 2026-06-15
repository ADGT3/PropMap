/**
 * api/contact-buyer-profile.js
 * V82.b — Contact buyer profile.
 *
 * GET  ?contact_id=N  → buyer profile row or {} if none
 * PATCH ?contact_id=N → upsert buyer profile; sets updated_at = now()
 */

import { neon } from '@neondatabase/serverless';
import { requireSession } from '../lib/auth.js';
import { getDatabaseUrl } from '../lib/db.js';
const sql = neon(getDatabaseUrl());

export default async function handler(req, res) {
  const session = await requireSession(req, res);
  if (!session) return;

  const contact_id = parseInt(req.query?.contact_id, 10);
  if (!contact_id) return res.status(400).json({ error: 'contact_id required' });

  // ── GET ──────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    try {
      const rows = await sql`
        SELECT * FROM contact_buyer_profile WHERE contact_id = ${contact_id}`;
      return res.status(200).json(rows[0] ?? {});
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── PATCH ────────────────────────────────────────────────────────────────
  if (req.method === 'PATCH') {
    try {
      const {
        listing_types, property_types,
        min_price, max_price,
        min_rent, max_rent,
        min_bedrooms, max_bedrooms,
        min_bathrooms, max_bathrooms,
        min_car_spaces, max_car_spaces,
        min_land_size_sqm, max_land_size_sqm,
        postcode_preferences,
        commercial_listing_type, max_commercial_rent,
      } = req.body ?? {};

      const rows = await sql`
        INSERT INTO contact_buyer_profile (
          contact_id,
          listing_types, property_types,
          min_price, max_price,
          min_rent, max_rent,
          min_bedrooms, max_bedrooms,
          min_bathrooms, max_bathrooms,
          min_car_spaces, max_car_spaces,
          min_land_size_sqm, max_land_size_sqm,
          postcode_preferences,
          commercial_listing_type, max_commercial_rent,
          updated_at
        ) VALUES (
          ${contact_id},
          ${listing_types ?? null}, ${property_types ?? null},
          ${min_price ?? null}, ${max_price ?? null},
          ${min_rent ?? null}, ${max_rent ?? null},
          ${min_bedrooms ?? null}, ${max_bedrooms ?? null},
          ${min_bathrooms ?? null}, ${max_bathrooms ?? null},
          ${min_car_spaces ?? null}, ${max_car_spaces ?? null},
          ${min_land_size_sqm ?? null}, ${max_land_size_sqm ?? null},
          ${postcode_preferences ?? null},
          ${commercial_listing_type ?? null}, ${max_commercial_rent ?? null},
          now()
        )
        ON CONFLICT (contact_id) DO UPDATE SET
          listing_types           = EXCLUDED.listing_types,
          property_types          = EXCLUDED.property_types,
          min_price               = EXCLUDED.min_price,
          max_price               = EXCLUDED.max_price,
          min_rent                = EXCLUDED.min_rent,
          max_rent                = EXCLUDED.max_rent,
          min_bedrooms            = EXCLUDED.min_bedrooms,
          max_bedrooms            = EXCLUDED.max_bedrooms,
          min_bathrooms           = EXCLUDED.min_bathrooms,
          max_bathrooms           = EXCLUDED.max_bathrooms,
          min_car_spaces          = EXCLUDED.min_car_spaces,
          max_car_spaces          = EXCLUDED.max_car_spaces,
          min_land_size_sqm       = EXCLUDED.min_land_size_sqm,
          max_land_size_sqm       = EXCLUDED.max_land_size_sqm,
          postcode_preferences    = EXCLUDED.postcode_preferences,
          commercial_listing_type = EXCLUDED.commercial_listing_type,
          max_commercial_rent     = EXCLUDED.max_commercial_rent,
          updated_at              = now()
        RETURNING *`;

      return res.status(200).json(rows[0]);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  res.setHeader('Allow', 'GET, PATCH');
  return res.status(405).json({ error: 'Method not allowed' });
}
