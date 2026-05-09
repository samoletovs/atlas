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
  // Single-user atlas: only Sam's email is allowed
  if (!p) return false;
  if (process.env.NODE_ENV !== 'production') return true;
  return p.userDetails?.toLowerCase() === 'samoletov@live.com';
}
