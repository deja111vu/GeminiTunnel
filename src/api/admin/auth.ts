import type { MiddlewareHandler } from 'hono';
import { timingSafeEqual } from 'node:crypto';

const BEARER_RE = /^Bearer\s+(.+)$/;

// Returns a Hono middleware that gates the route on a Bearer token matching
// `expected` byte-for-byte. Uses crypto.timingSafeEqual so the comparison
// doesn't leak the secret through response-time variance.
// - Missing / non-Bearer header: 401 + WWW-Authenticate
// - Wrong token: 403 (deliberately distinct from 401 to avoid the trivial
//   "try tokens, see which scheme accepts" probe)
// - Right token: next()
export function requireAdmin(expected: string): MiddlewareHandler {
  const expectedBuf = Buffer.from(expected, 'utf8');
  return async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    const match = BEARER_RE.exec(header);
    if (!match) {
      c.header('WWW-Authenticate', 'Bearer realm="gemini-tunnel"');
      return c.json({ error: 'unauthorized' }, 401);
    }
    const provided = Buffer.from(match[1], 'utf8');
    if (provided.length !== expectedBuf.length || !timingSafeEqual(provided, expectedBuf)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    await next();
    return;
  };
}
