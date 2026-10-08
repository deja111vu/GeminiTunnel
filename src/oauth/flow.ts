import crypto from 'node:crypto';
import { OAUTH_SCOPES, REDIRECT_URI, oauthClient } from './client.js';
import { config } from '../config.js';

const BASE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';

export function generatePkce(): { verifier: string; challenge: string } {
  const verifierBytes = crypto.randomBytes(32);
  const verifier = verifierBytes.toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function randomState(): string {
  return crypto.randomBytes(16).toString('hex');
}

export interface AuthorizationParams {
  accountLabel: string;
}

export interface AuthorizationResult {
  url: string;
  state: string;
  verifier: string;
  accountLabel: string;
}

export function buildAuthorizationUrl(params: AuthorizationParams): AuthorizationResult {
  const { verifier, challenge } = generatePkce();
  const state = randomState();
  const u = new URL(BASE_URL);
  u.searchParams.set('client_id', config.googleOauthClientId);
  u.searchParams.set('redirect_uri', REDIRECT_URI);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', OAUTH_SCOPES.join(' '));
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('state', state);
  u.searchParams.set('access_type', 'offline');
  u.searchParams.set('prompt', 'consent');
  u.searchParams.set('include_granted_scopes', 'true');
  return { url: u.toString(), state, verifier, accountLabel: params.accountLabel };
}

export async function exchangeCode(args: {
  code: string;
  verifier: string;
}): Promise<{ refreshToken: string | null; accessToken: string; expiresAt: number; idToken?: string }> {
  const client = oauthClient();
  const { tokens } = await client.getToken({
    code: args.code,
    codeVerifier: args.verifier,
    redirect_uri: REDIRECT_URI,
  });
  if (!tokens.access_token) throw new Error('no access_token in response');
  return {
    refreshToken: tokens.refresh_token ?? null,
    accessToken: tokens.access_token,
    expiresAt: tokens.expiry_date ?? Date.now() + 60 * 60 * 1000,
    idToken: tokens.id_token ?? undefined,
  };
}

export async function fetchUserEmail(accessToken: string): Promise<string> {
  const res = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`userinfo ${res.status}`);
  const body = (await res.json()) as { email?: string };
  if (!body.email) throw new Error('no email in userinfo');
  return body.email;
}
