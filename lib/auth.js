/**
 * lib/auth.js
 * Shared authentication helpers — JWT signing/verification, session cookie handling,
 * admin/module access checks.
 *
 * IMPORTANT: this file is imported by both middleware.js (Edge runtime) and
 * API routes (Node runtime). It must only use Edge-compatible APIs:
 *   - jose (OK)
 *   - Web Crypto / TextEncoder (OK)
 *   - Node built-ins like 'crypto', 'buffer' — NOT OK in Edge
 *
 * bcrypt is NOT imported here. Password hashing/verification lives in
 * api/auth/login.js and api/auth/set-password.js (Node runtime only).
 */

import { SignJWT, jwtVerify } from 'jose';

// ── Config ─────────────────────────────────────────────────────────────────
export const COOKIE_NAME = 'spm_session';
export const SESSION_DAYS = 30;
const SESSION_SECONDS = SESSION_DAYS * 24 * 60 * 60;

// Fallback env-var superuser (break-glass)
export const FALLBACK_EMAIL = (process.env.ADMIN_FALLBACK_EMAIL || '').toLowerCase().trim();

function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('JWT_SECRET env var missing or too short (must be ≥ 32 chars)');
  }
  return new TextEncoder().encode(secret);
}

// ── JWT ────────────────────────────────────────────────────────────────────
/**
 * Issue a signed JWT.
 * Payload: { sub: <contactId|'fallback'>, email, name, isAdmin, modules: string[], src: 'db'|'env' }
 */
export async function signSession(payload) {
  return await new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_DAYS}d`)
    .sign(getJwtSecret());
}

/**
 * Verify a JWT and return its payload, or null if invalid/expired.
 */
export async function verifySession(token) {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, getJwtSecret());
    return payload;
  } catch {
    return null;
  }
}

// ── Cookie helpers ─────────────────────────────────────────────────────────
/**
 * Parse cookies from a header string. Works in both runtimes.
 */
export function parseCookies(cookieHeader) {
  const out = {};
  if (!cookieHeader) return out;
  cookieHeader.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx < 0) return;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

/**
 * Serialise a Set-Cookie header value for the session cookie.
 * `token` = null clears the cookie.
 */
export function buildSessionCookie(token) {
  if (token === null) {
    return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
  }
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_SECONDS}`;
}

// ── Extract session from a Node.js-style req object ────────────────────────
/**
 * For Vercel Node serverless functions.
 * Returns parsed JWT payload or null.
 */
export async function getSessionFromReq(req) {
  const cookies = parseCookies(req.headers?.cookie || '');
  return await verifySession(cookies[COOKIE_NAME]);
}

// ── Access helpers ─────────────────────────────────────────────────────────
export function isAdmin(session) {
  return !!session?.isAdmin;
}

export function hasModule(session, mod) {
  if (!session) return false;
  const mods = session.modules || [];
  return mods.includes('*') || mods.includes(mod);
}

// ── Standard responses ─────────────────────────────────────────────────────
export function sendUnauthorized(res, msg = 'Authentication required') {
  return res.status(401).json({ error: msg });
}

export function sendForbidden(res, msg = 'Forbidden') {
  return res.status(403).json({ error: msg });
}

/**
 * Guard helper for Node API routes.
 * Usage:
 *   const session = await requireSession(req, res);
 *   if (!session) return; // response already sent
 *   if (!requireAdmin(session, res)) return;
 */
export async function requireSession(req, res) {
  const session = await getSessionFromReq(req);
  if (!session) { sendUnauthorized(res); return null; }
  return session;
}

export function requireAdmin(session, res) {
  if (!isAdmin(session)) { sendForbidden(res, 'Admin access required'); return false; }
  return true;
}
