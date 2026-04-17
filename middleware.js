/**
 * middleware.js
 * Vercel Routing Middleware — runs on every incoming request before any
 * route handler. Protects the entire site (pages + API routes) behind
 * a session cookie.
 *
 * This file uses the framework-agnostic Web Request/Response API (not
 * next/server) because this project is a static site with serverless
 * functions, not a Next.js app.
 *
 * Flow:
 *   1. Request comes in.
 *   2. If path is in PUBLIC_PATHS or matches a public prefix → allow.
 *   3. Otherwise, read the session cookie and verify the JWT.
 *      - Valid → allow through (attaches user info as request headers).
 *      - Invalid/missing + API request → 401 JSON.
 *      - Invalid/missing + page request → 302 redirect to /login.html.
 *
 * PORTABILITY NOTE (see README § Authentication):
 *   This file is the only Vercel-specific piece of the auth system. If you
 *   migrate to a host without edge middleware, delete this file and call
 *   requireSession() at the top of each API route instead (lib/auth.js
 *   already exposes it).
 */

import { verifySession, parseCookies, COOKIE_NAME } from './lib/auth.js';

// Paths that never require authentication
const PUBLIC_PATHS = new Set([
  '/login.html',
  '/favicon.ico',
  '/api/auth/login',
  '/api/auth/logout',
  '/api/auth/me',       // returns { authenticated: false } when no session
  '/api/health',
]);

// Path prefixes that never require authentication
const PUBLIC_PREFIXES = [
  '/Images/',           // favicons, brand images
  '/_vercel/',          // Vercel internal
];

function isPublic(pathname) {
  if (PUBLIC_PATHS.has(pathname)) return true;
  for (const p of PUBLIC_PREFIXES) {
    if (pathname.startsWith(p)) return true;
  }
  return false;
}

function isApiRequest(pathname) {
  return pathname.startsWith('/api/');
}

export default async function middleware(request) {
  const url = new URL(request.url);
  const pathname = url.pathname;

  if (isPublic(pathname)) {
    return; // undefined = pass-through
  }

  const cookies = parseCookies(request.headers.get('cookie') || '');
  const session = await verifySession(cookies[COOKIE_NAME]);

  if (session) {
    // Pass through. User info is available to downstream handlers via
    // the session cookie (they call getSessionFromReq(req) themselves).
    return;
  }

  // Not authenticated
  if (isApiRequest(pathname)) {
    return new Response(
      JSON.stringify({ error: 'Authentication required' }),
      { status: 401, headers: { 'content-type': 'application/json' } }
    );
  }

  // Page request → redirect to login, preserving intended destination
  const loginUrl = new URL('/login.html', request.url);
  loginUrl.searchParams.set('next', pathname + (url.search || ''));
  return Response.redirect(loginUrl.toString(), 302);
}

// Match every path. Public exemptions are handled in code so the logic
// lives in one place.
export const config = {
  matcher: '/:path*',
};
