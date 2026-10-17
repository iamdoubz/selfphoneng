// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { redact } from './audit.ts';

describe('audit redact', () => {
  it('masks secret strings at any depth and keeps flags and other values', () => {
    expect(
      redact({
        password: 'hunter2',
        sipPasswordEnc: 'abc',
        nested: [{ apiToken: 'sp_x', voicemailPin: '1234', name: 'Ann' }],
        mustChangePassword: true,
        secret: null,
        count: 3,
      }),
    ).toEqual({
      password: '********',
      sipPasswordEnc: '********',
      nested: [{ apiToken: '********', voicemailPin: '********', name: 'Ann' }],
      mustChangePassword: true,
      secret: null,
      count: 3,
    });
  });
});
