// SPDX-License-Identifier: AGPL-3.0-or-later
// Outbound routes (02, 03 §6.12, 06 §4) and Asterisk dial-pattern matching for the test box.
import { z } from 'zod';

export const OUTBOUND_CLASSES = ['internal', 'local', 'national', 'international'] as const;
export type OutboundClass = (typeof OUTBOUND_CLASSES)[number];
/** SP_CLASS numbers in the dialplan: a caller may use a route when theirs is >= the route's. */
export const CLASS_RANK: Record<OutboundClass, number> = {
  internal: 0,
  local: 1,
  national: 2,
  international: 3,
};

export const RoutePatternSchema = z.object({
  /** Asterisk pattern without the leading "_": X Z N [1-5] . ! and digits. */
  match: z
    .string()
    .trim()
    .regex(/^(?:[0-9XZN.!]|\[[0-9-]+\])+$/, 'Digits and X Z N [1-5] . ! only')
    .max(32),
  strip: z.number().int().min(0).max(20),
  prepend: z
    .string()
    .regex(/^[0-9*#+]{0,10}$/, 'Digits only')
    .max(10),
});
export type RoutePattern = z.infer<typeof RoutePatternSchema>;

const RouteFields = z.object({
  name: z.string().trim().min(1, 'Required').max(60),
  enabled: z.boolean(),
  patterns: z.array(RoutePatternSchema).min(1, 'Add at least one pattern').max(50),
  requiredClass: z.enum(OUTBOUND_CLASSES),
  trunkIds: z.array(z.uuid()).min(1, 'Pick at least one trunk').max(10),
  callerIdDidId: z.uuid().nullable(),
});

export const OutboundRouteCreateSchema = RouteFields.partial().required({
  name: true,
  patterns: true,
  requiredClass: true,
  trunkIds: true,
});
export const OutboundRouteUpdateSchema = RouteFields.partial();
export type OutboundRouteCreate = z.input<typeof OutboundRouteCreateSchema>;
export type OutboundRouteUpdate = z.input<typeof OutboundRouteUpdateSchema>;
export type OutboundRouteDto = z.output<typeof RouteFields> & {
  id: string;
  position: number;
  createdAt: string;
};

export const RouteTestSchema = z.object({
  extensionId: z.uuid(),
  number: z.string().trim().min(1).max(32),
});
export type RouteTestResult =
  | {
      ok: true;
      routeId: string;
      routeName: string;
      pattern: string;
      dialed: string;
      trunks: { id: string; name: string }[];
      callerId: string | null;
    }
  | { ok: false; reason: string; routeId?: string; routeName?: string };

/** Asterisk extension pattern (without "_") → RegExp. Same rules Asterisk uses. */
export function patternRegex(match: string): RegExp {
  let re = '';
  for (let i = 0; i < match.length; i++) {
    const c = match[i]!;
    if (c === 'X') re += '[0-9]';
    else if (c === 'Z') re += '[1-9]';
    else if (c === 'N') re += '[2-9]';
    else if (c === '.') re += '.+';
    else if (c === '!') re += '.*';
    else if (c === '[') {
      const end = match.indexOf(']', i);
      re += `[${match.slice(i + 1, end)}]`;
      i = end;
    } else re += c;
  }
  return new RegExp(`^${re}$`);
}

/** The dialed string as the dialplan sees it: what was typed, minus formatting. */
export const dialedDigits = (n: string) => n.replace(/[\s\-.()]/g, '');
