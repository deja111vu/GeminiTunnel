import type { Context, MiddlewareHandler } from 'hono';
import { timingSafeEqual } from 'node:crypto';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';

const BEARER_RE = /^Bearer\s+(.+)$/;

// Cookie name for the admin session. Reading + writing goes through
// Hono's cookie helpers so the path/secure/samesite flags stay in sync
// between the login response and the middleware check.
export const ADMIN_COOKIE = 'gemini-tunnel-admin';

// Returns a Hono middleware that gates the route on a Bearer token or
// HttpOnly cookie matching `expected` byte-for-byte. Uses
// crypto.timingSafeEqual so the comparison doesn't leak the secret
// through response-time variance.
// - Missing / non-Bearer and no cookie: 401 + WWW-Authenticate
// - Wrong token: 403 (deliberately distinct from 401 to avoid the
//   trivial "try tokens, see which scheme accepts" probe)
// - Right token: next()
//
// Why a cookie: localStorage is readable by any XSS payload, so the
// admin token would walk out the door with the first injected script.
// HttpOnly + Secure + SameSite=Strict keeps the token away from JS
// entirely, neutralises most MITM (Secure over HTTPS), and rejects
// cross-site POSTs that would otherwise let a CSRF replay an action.
export function requireAdmin(expected: string): MiddlewareHandler {
  const expectedBuf = Buffer.from(expected, 'utf8');
  const compare = (provided: string): boolean => {
    const a = Buffer.from(provided, 'utf8');
    return a.length === expectedBuf.length && timingSafeEqual(a, expectedBuf);
  };
  return async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    const match = BEARER_RE.exec(header);
    const bearerToken = match?.[1];
    const cookieToken = getCookie(c, ADMIN_COOKIE);
    const token = bearerToken ?? cookieToken;
    if (!token) {
      c.header('WWW-Authenticate', 'Bearer realm="gemini-tunnel"');
      return c.json({ error: 'unauthorized' }, 401);
    }
    if (!compare(token)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    await next();
    return;
  };
}

// Validates a candidate token from the login form and on success writes
// it back as an HttpOnly cookie. The cookie carries the adminToken
// itself (no separate session table needed — the token is already a
// 64-byte random secret, indistinguishable from a session id, and there
// is no per-user state to look up). expiresAt(0) + no max-age => a
// session cookie: cleared when the browser closes.
export function setAdminCookie(c: Context, expected: string, provided: string): boolean {
  const expectedBuf = Buffer.from(expected, 'utf8');
  const providedBuf = Buffer.from(provided, 'utf8');
  if (providedBuf.length !== expectedBuf.length) return false;
  if (!timingSafeEqual(providedBuf, expectedBuf)) return false;
  // SameSite=Strict blocks cross-site POSTs (CSRF). HttpOnly blocks JS
  // reads (XSS). Secure requires HTTPS — production deployments are
  // expected to terminate TLS in front of the proxy.
  setCookie(c, ADMIN_COOKIE, provided, {
    httpOnly: true,
    sameSite: 'Strict',
    secure: true,
    path: '/admin',
  });
  return true;
}

export function clearAdminCookie(c: Context): void {
  deleteCookie(c, ADMIN_COOKIE, { path: '/admin' });
}
