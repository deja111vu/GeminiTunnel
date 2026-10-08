import { OAuth2Client } from 'google-auth-library';
import { config } from '../config.js';

export const OAUTH_SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
];

export const REDIRECT_URI = 'http://127.0.0.1:1/callback';

export function oauthClient(): OAuth2Client {
  return new OAuth2Client({
    clientId: config.googleOauthClientId,
    clientSecret: config.googleOauthClientSecret,
    redirectUri: REDIRECT_URI,
  });
}
