// SPDX-License-Identifier: AGPL-3.0-or-later
// OpenID claims → groups, allowed, role (12 §3.4). Pure: no I/O.

type Claims = Record<string, unknown>;

/**
 * The value at a dotted path. The whole remaining path is tried as one key first, so claim
 * names with dots or colons (Zitadel's "urn:zitadel:iam:org:project:roles") work, and
 * "resource_access.selfphoneng.roles" walks down.
 */
export function claimAt(claims: unknown, path: string): unknown {
  if (!claims || typeof claims !== 'object') return undefined;
  const o = claims as Claims;
  if (path in o) return o[path];
  const dot = path.indexOf('.');
  return dot < 0 ? undefined : claimAt(o[path.slice(0, dot)], path.slice(dot + 1));
}

/** A string → [it]; an array → its strings; an object → its keys (Zitadel's roles). */
export function claimValues(claims: unknown, path: string): string[] {
  const v = claimAt(claims, path);
  if (typeof v === 'string') return [v];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  if (v && typeof v === 'object') return Object.keys(v);
  return [];
}

export type OidcRules = { groupsClaim: string; adminGroups: string[]; allowedGroups: string[] };

export type ClaimsDecision = {
  groups: string[];
  allowed: boolean;
  /** null: the role is managed in SelfPhoneNG (no adminGroups). */
  admin: boolean | null;
};

export function decide(rules: OidcRules, claims: Claims): ClaimsDecision {
  const groups = claimValues(claims, rules.groupsClaim);
  const any = (list: string[]) => list.some((g) => groups.includes(g));
  return {
    groups,
    allowed: rules.allowedGroups.length === 0 || any(rules.allowedGroups),
    admin: rules.adminGroups.length === 0 ? null : any(rules.adminGroups),
  };
}

/** The email, when the provider says it's verified (or the admin trusts its emails, 12 §3.3). */
export function verifiedEmail(claims: Claims, trustEmail: boolean): string | null {
  const email = typeof claims.email === 'string' ? claims.email.trim() : '';
  if (!email) return null;
  return claims.email_verified === true || trustEmail ? email : null;
}
