// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { maskSecrets } from './system.ts';

describe('maskSecrets', () => {
  it('hides SIP passwords, AMI secrets and voicemail PINs, nothing else', () => {
    const conf = [
      '[101-auth]',
      'type = auth',
      'username = 101',
      'password = Ab3dEf9hIj2kLm4nOp6qRs8t',
      'secret=abc',
      '[default]',
      '101 => 482913,Dan Doe,,,tz=local|attach=no',
      'exten => 101,1,Gosub(sp-sub-user,s,1(101,25,1,never))',
    ].join('\n');
    const out = maskSecrets(conf);
    expect(out).not.toMatch(/Ab3dEf9h|=abc|482913/);
    expect(out).toContain('password = ********');
    expect(out).toContain('101 => ********,Dan Doe,,,tz=local|attach=no');
    expect(out).toContain('exten => 101,1,Gosub(sp-sub-user,s,1(101,25,1,never))');
    expect(out).toContain('username = 101');
  });
});
