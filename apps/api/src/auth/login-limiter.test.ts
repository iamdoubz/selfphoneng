// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from 'vitest';
import {
  isLoginBlocked,
  loginLimiterSize,
  recordLoginFailure,
  resetLoginLimiter,
} from './login-limiter.ts';

it('forgets emails tried long ago instead of growing until restart', () => {
  resetLoginLimiter();
  const t0 = 1_000_000_000;
  for (let i = 0; i < 100; i++) recordLoginFailure(`10.0.0.${i}`, `user${i}@x.test`, t0);
  expect(loginLimiterSize()).toBe(200);
  for (let i = 0; i < 5; i++) recordLoginFailure('10.9.9.9', 'kept@x.test', t0 + 61 * 60_000);
  expect(loginLimiterSize()).toBe(2);
  expect(isLoginBlocked('10.9.9.9', 'other@x.test', t0 + 61 * 60_000)).toBe(true);
});
