// SPDX-License-Identifier: AGPL-3.0-or-later
// The phone-side dial plan: which dialed strings are complete, so phones and analog adapters
// send them at once instead of waiting for # or a timeout. Made from what is dialable: 911/9911,
// the enabled outbound routes, the lengths internal numbers use, and * codes.
import { eq } from 'drizzle-orm';
import type { RoutePattern } from '@selfphoneng/shared';
import type { Db } from '../db/client.ts';
import { outboundRoutes } from '../db/schema.ts';
import { internalNumberLengths } from '../services/numbering.ts';

/** One rule: the characters allowed at each position; `more` = one or more digits follow (x+). */
export type DialRule = { pos: string[]; more: boolean };

const ANY = '0123456789';
const lit = (s: string): DialRule => ({ pos: [...s], more: false });

/** An Asterisk route pattern (X, Z, N, [..], trailing . or !) as a rule. */
export function fromRoutePattern(match: string): DialRule {
  const pos: string[] = [];
  let more = false;
  for (let i = 0; i < match.length; i++) {
    const c = match[i]!;
    if (c === 'X') pos.push(ANY);
    else if (c === 'Z') pos.push('123456789');
    else if (c === 'N') pos.push('23456789');
    else if (c === '.' || c === '!')
      more = true; // ponytail: ! (zero or more) read as . (one or more)
    else if (c === '[') {
      const end = match.indexOf(']', i);
      pos.push(
        match.slice(i + 1, end).replace(/(\d)-(\d)/g, (_, a: string, b: string) => {
          let r = '';
          for (let d = Number(a); d <= Number(b); d++) r += d;
          return r;
        }),
      );
      i = end;
    } else pos.push(c);
  }
  return { pos, more };
}

export function dialRules(routePatterns: string[], internalLengths: number[]): DialRule[] {
  const rules = [lit('911'), lit('9911'), ...routePatterns.map(fromRoutePattern)];
  for (const n of [...new Set(internalLengths)].sort((a, b) => a - b))
    rules.push({ pos: Array<string>(n).fill(ANY), more: false });
  rules.push({ pos: ['*'], more: true }, { pos: ['*', '*'], more: true });
  // A rule another one already covers says nothing new (toll-free inside 1NXXNXXXXXX); of two
  // equal ones, keep the first. 911 and 9911 always stay: dialNowRules sends them at once.
  return rules.filter(
    (r, i) => i < 2 || !rules.some((o, j) => j !== i && covers(o, r) && (j < i || !covers(r, o))),
  );
}

/** Does every string `r` matches also match `o`? */
const covers = (o: DialRule, r: DialRule) =>
  (o.more
    ? r.pos.length > o.pos.length || (r.more && r.pos.length === o.pos.length)
    : !r.more && r.pos.length === o.pos.length) &&
  r.pos.every((set, i) => [...set].every((c) => (o.pos[i] ?? ANY).includes(c)));

/** Can some string `other` matches be longer than `r` and start with a string `r` matches? */
const extends_ = (r: DialRule, other: DialRule) =>
  (other.more || other.pos.length > r.pos.length) &&
  r.pos.every((set, i) =>
    [...set].some((c) => (other.pos[i] ?? (other.more ? ANY : '')).includes(c)),
  );

/**
 * Rules a phone may dial the moment they match: no other number can continue them. 911 and 9911
 * always: no outside number starts with 911, and no internal one may (isReservedNumber).
 */
export const dialNowRules = (rules: DialRule[]): DialRule[] =>
  rules.filter(
    (r) =>
      !r.more &&
      ((r.pos.every((s) => s.length === 1) && ['911', '9911'].includes(r.pos.join(''))) ||
        !rules.some((o) => o !== r && extends_(r, o))),
  );

/** A position in the x / [2-9] / digit syntax both Grandstream and Yealink read. */
function set(s: string): string {
  if (s === ANY) return 'x';
  if (s.length === 1) return s;
  const d = [...s].map(Number).sort((a, b) => a - b);
  const runs: string[] = [];
  for (let i = 0; i < d.length;) {
    let j = i;
    while (j + 1 < d.length && d[j + 1] === d[j]! + 1) j++;
    runs.push(j - i >= 2 ? `${d[i]}-${d[j]}` : d.slice(i, j + 1).join(''));
    i = j + 1;
  }
  return `[${runs.join('')}]`;
}

export const ruleText = (r: DialRule) => r.pos.map(set).join('') + (r.more ? 'x+' : '');

/** Grandstream's Dial Plan: `{ 911 | 9911 | [2-9]xx[2-9]xxxxxx | … }`. */
export const grandstreamDialPlan = (rules: DialRule[]) => `{ ${rules.map(ruleText).join(' | ')} }`;

/** The rules for this install (enabled outbound routes, internal number lengths). */
export async function loadDialRules(db: Db): Promise<DialRule[]> {
  const routes = await db
    .select({ patterns: outboundRoutes.patterns })
    .from(outboundRoutes)
    .where(eq(outboundRoutes.enabled, true));
  return dialRules(
    routes.flatMap((r) => (r.patterns as RoutePattern[]).map((p) => p.match)),
    await internalNumberLengths(db),
  );
}
