// SPDX-License-Identifier: AGPL-3.0-or-later
// M11-T1: the phone-side PIN check (asterisk/sp-vm-pincheck) and the api's rules agree.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isTrivialPin } from '../crypto/secrets.ts';

const SCRIPT = fileURLToPath(new URL('../../../../asterisk/sp-vm-pincheck', import.meta.url));
const hasSh = spawnSync('sh', ['-c', 'true']).status === 0;
const script = (box: string, pin: string) =>
  spawnSync('sh', [SCRIPT, box, 'default', '0000', pin], { encoding: 'utf8' }).stdout.trim();
const api = (box: string, pin: string) =>
  /^\d{4,10}$/.test(pin) && !isTrivialPin(pin, box) ? 'VALID' : 'INVALID';

describe.skipIf(!hasSh)('sp-vm-pincheck', () => {
  it('says what the api says', () => {
    const pins = [
      '4826',
      '1111',
      '000000',
      '1234',
      '123456',
      '4321',
      '9876543210',
      '0123456789',
      '90123',
      '101101',
      '1011',
      '10110',
      '12a4',
      '123',
      '12345678901',
      '',
      '5550199',
      '2024',
    ];
    for (const box of ['101', '2000', '55'])
      for (const pin of pins) expect(script(box, pin), `${box} ${pin}`).toBe(api(box, pin));
  });
});
