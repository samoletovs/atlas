/**
 * Auth helper — read the SWA-injected x-ms-client-principal header.
 * Locally, returns a stub user (matching ATLAS_USER_ID).
 */
import { HttpRequest } from '@azure/functions';
import { ATLAS_USER_ID } from './cosmos.js';

export interface ClientPrincipal {
  userId: string;
  userDetails: string;
  identityProvider: string;
  userRoles: string[];
}

export function getPrincipal(req: HttpRequest): ClientPrincipal | null {
  const header = req.headers.get('x-ms-client-principal');
  if (!header) {
    // Local dev — pretend it's Sam
    if (process.env.NODE_ENV !== 'production') {
      return {
        userId: ATLAS_USER_ID,
        userDetails: 'sam@local',
        identityProvider: 'local',
        userRoles: ['authenticated'],
      };
    }
    return null;
  }
  try {
    const decoded = Buffer.from(header, 'base64').toString('utf-8');
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

export function isAuthorized(p: ClientPrincipal | null): boolean {
  // Single-user atlas
  if (!p) return false;
  if (process.env.NODE_ENV !== 'production') return true;
  const email = p.userDetails?.toLowerCase() ?? '';
  // SWA built-in `aad` provider works with personal Microsoft accounts.
  // Google provider was retired in 2026 (deprecated OAuth admin APIs).
  return (
    email === 'samoletov@live.com' ||
    email === 'samoletov@outlook.com' ||
    email === 'd.samoletov@gmail.com'
  );
}
