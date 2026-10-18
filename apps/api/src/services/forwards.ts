// SPDX-License-Identifier: AGPL-3.0-or-later
// Call forwarding targets (04 §5.3): an internal number, or an outside number the user's calling
// permission allows (the same outbound rules a call would use). Used by PATCH /api/me and by
// *72 from a phone (SpToggle CFU).
import { dialedDigits, formatNumber, normalizeNumber } from '@selfphoneng/shared';
import type { Db } from '../db/client.ts';
import { badRequest } from '../errors.ts';
import { ownerOf } from './numbering.ts';
import { testRoute } from './outbound.ts';

export const FORWARD_KINDS = ['cfu', 'cfb', 'cfna'] as const;
export type ForwardKind = (typeof FORWARD_KINDS)[number];

/** Returns what to store (internal number or normalized outside number), or throws 400. */
export async function checkForward(
  db: Db,
  ext: { id: string; number: string },
  input: string,
): Promise<string> {
  const digits = dialedDigits(input);
  if (!digits) throw badRequest('Enter a number');
  if (digits === ext.number) throw badRequest("You can't forward calls to yourself");
  if (/^\d{3,6}$/.test(digits)) {
    if (await ownerOf(db, digits)) return digits;
    throw badRequest(`${digits} isn't an extension or group here`);
  }
  let n: string;
  try {
    n = normalizeNumber(input);
  } catch {
    throw badRequest('A phone number like (312) 555-1234');
  }
  const r = await testRoute(db, ext.id, n);
  if (!r.ok)
    throw badRequest(
      r.routeId
        ? `Your calling permission doesn't allow forwarding to ${formatNumber(n)}`
        : `Calls to ${formatNumber(n)} can't go out (no outbound rule matches)`,
    );
  return n;
}
