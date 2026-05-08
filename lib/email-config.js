/**
 * lib/email-config.js — V77.1
 *
 * Hardcoded email and public-form configuration constants for V77.1.
 *
 * V77.1 doesn't actually send any emails — these constants exist so that
 * V77.2 has a single point to migrate from when the System Settings →
 * Notifications page is built and these values move to the system_settings
 * table.
 *
 * After V77.2 ships, this file remains as a fallback for local dev / tests
 * (used if system_settings query fails or in non-DB environments).
 *
 * See V77 BUILD PLAN v0.17 §6.2.0 for the staging plan.
 */

export const APP_PUBLIC_URL          = 'https://propmap.edanproperty.com.au';
export const EMAIL_SENDING_DOMAIN    = 'edanproperty.com.au';
export const EMAIL_LEASING_FROM      = 'leasing@edanproperty.com.au';
export const EMAIL_SALES_FROM        = 'sales@edanproperty.com.au';
export const EMAIL_REPLY_TO_HANDLING = 'route_to_from';

// Public form path — appended to APP_PUBLIC_URL to form full URL like
// https://propmap.edanproperty.com.au/lease-offer/{token}
export const LEASE_OFFER_FORM_PATH = '/lease-offer';

/**
 * Build the full public form URL for a lease-offer token.
 * Example: leaseOfferUrl('abc123') → 'https://propmap.edanproperty.com.au/lease-offer/abc123'
 */
export function leaseOfferUrl(token) {
  return `${APP_PUBLIC_URL}${LEASE_OFFER_FORM_PATH}/${token}`;
}
