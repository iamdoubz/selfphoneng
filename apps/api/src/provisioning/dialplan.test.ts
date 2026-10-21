// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  dialNowRules,
  dialRules,
  fromRoutePattern,
  grandstreamDialPlan,
  ruleText,
} from './dialplan.ts';

/** The routes createDefaultRoutes makes, international off. */
const DEFAULT_ROUTES = [
  ...['800', '888', '877', '866', '855', '844', '833'].map((p) => `1${p}NXXXXXX`),
  'NXXNXXXXXX',
  '1NXXNXXXXXX',
];

describe('dial plan', () => {
  it('reads Asterisk patterns', () => {
    expect(ruleText(fromRoutePattern('NXXNXXXXXX'))).toBe('[2-9]xx[2-9]xxxxxx');
    expect(ruleText(fromRoutePattern('011.'))).toBe('011x+');
    expect(ruleText(fromRoutePattern('[2-46]Z'))).toBe('[2-46][1-9]');
  });

  it('default routes, three-digit numbers: toll-free folds into 1NXX…, * codes wait', () => {
    const rules = dialRules(DEFAULT_ROUTES, [3]);
    expect(grandstreamDialPlan(rules)).toBe(
      '{ 911 | 9911 | [2-9]xx[2-9]xxxxxx | 1[2-9]xx[2-9]xxxxxx | xxx | *x+ | **x+ }',
    );
    // 911 always; 10 and 11 digits can't grow; 101 could be the start of 1012345678? no (N), but
    // 212 could start 2125551234, so three-digit numbers wait
    expect(dialNowRules(rules).map(ruleText)).toEqual([
      '911',
      '9911',
      '[2-9]xx[2-9]xxxxxx',
      '1[2-9]xx[2-9]xxxxxx',
    ]);
  });

  it('one-digit and six-digit numbers, international on', () => {
    const rules = dialRules([...DEFAULT_ROUTES, '011.'], [1, 3, 6, 3]);
    expect(grandstreamDialPlan(rules)).toBe(
      '{ 911 | 9911 | [2-9]xx[2-9]xxxxxx | 1[2-9]xx[2-9]xxxxxx | 011x+ | x | xxx | xxxxxx | *x+ | **x+ }',
    );
    // 0 can start 011…, and every short number can start a longer one
    expect(dialNowRules(rules).map(ruleText)).toEqual([
      '911',
      '9911',
      '[2-9]xx[2-9]xxxxxx',
      '1[2-9]xx[2-9]xxxxxx',
    ]);
  });

  it('a route that only a longer one could continue', () => {
    // 4-digit internal numbers start 1-9 at the PBX, but the phone can't know: xxxx waits for 5…
    const rules = dialRules(['NXXXXX'], [4]);
    expect(dialNowRules(rules).map(ruleText)).toEqual(['911', '9911', '[2-9]xxxxx']);
  });
});
