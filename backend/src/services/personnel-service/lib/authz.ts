import type { VerifiedAccessToken } from '../../platform-service/authorizer/tokenVerifier.js';

export class ForbiddenError extends Error {}

const ADMIN_GATED_GROUPS = new Set(['ADMIN', 'OFFICER', 'CHIEF']);

export type AuthzDecision = 'allow' | 'deny';

// TODO: E8-S3 replace this cognito:groups check with IsAuthorizedWithToken (Verified
// Permissions / Cedar) once the policy store lands; this is the single seam every
// admin-gate call goes through, so the swap touches only this function.
export function isAuthorized(ctx: VerifiedAccessToken): AuthzDecision {
  const groups = ctx['cognito:groups'].split(' ').filter((group) => group.length > 0);
  return groups.some((group) => ADMIN_GATED_GROUPS.has(group)) ? 'allow' : 'deny';
}

export function requireAdminRole(ctx: VerifiedAccessToken): void {
  if (isAuthorized(ctx) === 'deny') {
    throw new ForbiddenError('caller does not hold an admin-gated role (ADMIN, OFFICER, or CHIEF)');
  }
}

/**
 * Assigning roles is CHIEF/ADMIN only (F2.7). OFFICER passes requireAdminRole, so reusing
 * it here would let an officer grant themselves or a friend ADMIN.
 */
const ROLE_MANAGER_GROUPS = new Set(['ADMIN', 'CHIEF']);

export function requireRoleManager(ctx: VerifiedAccessToken): void {
  const groups = ctx['cognito:groups'].split(' ').filter((group) => group.length > 0);
  if (!groups.some((group) => ROLE_MANAGER_GROUPS.has(group))) {
    throw new ForbiddenError('only ADMIN or CHIEF may change member roles');
  }
}
