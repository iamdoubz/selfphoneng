// SPDX-License-Identifier: AGPL-3.0-or-later
// Golden files for the phone templates (07 §3): __golden__/ holds what each vendor gets for one
// fixed phone. Update with `vitest -u` and review the diff.
import { describe, expect, it } from 'vitest';
import { phoneTimezone } from '@selfphoneng/shared';
import type { PhonebookEntry, ProvisionContext } from './context.ts';
import { dialRules } from './dialplan.ts';
import { grandstream, grandstreamPhonebook } from './templates/grandstream.ts';
import { yealink, yealinkPhonebook } from './templates/yealink.ts';

const ctx = (over: Partial<ProvisionContext> = {}): ProvisionContext => ({
  mac: '001565abcdef',
  vendor: 'yealink',
  model: 'T54W',
  host: 'pbx.example.com',
  sipPort: 5060,
  transport: 'udp',
  ext: {
    number: '101',
    name: 'Dan "D" <Doe> & Co\r\nx = 1',
    sipPassword: 'Ab3dEf9hIj2kLm4nOp6qRs8t',
  },
  voicemailNumber: '*97',
  blf: [
    { number: '102', label: 'Ann Lee' },
    { number: '701', label: '701' },
  ],
  timezone: { ...phoneTimezone('America/Chicago'), iana: 'America/Chicago' },
  provUrl: 'https://pbx.example.com/prov/',
  provUser: '001565abcdef',
  provPassword: 'Pr0vPassw0rdXyZ12345',
  phonebookUrl:
    'https://001565abcdef:Pr0vPassw0rdXyZ12345@pbx.example.com/prov/phonebook/001565abcdef.xml',
  ntpServer: 'pool.ntp.org',
  dialRules: dialRules(['NXXNXXXXXX', '1NXXNXXXXXX'], [3]),
  ...over,
});
const book: PhonebookEntry[] = [
  { name: 'Ann Lee', numbers: [{ label: 'Extension', number: '102' }] },
  {
    name: 'Acme <Supplies> & "Parts"',
    numbers: [
      { label: 'office', number: '13125551234' },
      { label: 'mobile', number: '13125559876' },
    ],
  },
];

describe('phone templates', () => {
  it('Yealink config: account, BLF keys (the rest cleared), time, phonebook, provisioning', async () => {
    const out = yealink(ctx());
    await expect(out).toMatchFileSnapshot('./__golden__/yealink.cfg');
    // a name can't start a new line (and so a new setting)
    expect(out).not.toMatch(/^x = 1/m);
    expect(out).toContain('linekey.4.type = 0');
    expect(out).toContain('linekey.33.type = 0');
    expect(out).not.toContain('linekey.34');
    expect(out).toMatch(/^dialplan\.dialnow\.rule\.1 = 911$/m);
    expect(out).toMatch(/^dialplan\.dialnow\.rule\.20 =$/m);
  });

  it('Grandstream config: XML-escaped values', async () => {
    const out = grandstream(ctx({ vendor: 'grandstream' }));
    await expect(out).toMatchFileSnapshot('./__golden__/grandstream.xml');
    expect(out).toContain('<P3>Dan &quot;D&quot; &lt;Doe&gt; &amp; Co  x = 1</P3>');
  });

  it('phonebooks', async () => {
    await expect(yealinkPhonebook(book)).toMatchFileSnapshot('./__golden__/yealink-phonebook.xml');
    await expect(grandstreamPhonebook(book)).toMatchFileSnapshot(
      './__golden__/grandstream-phonebook.xml',
    );
  });

  it('a zone phones don’t know falls back to UTC', () => {
    expect(phoneTimezone('Asia/Tokyo')).toEqual({
      yealinkOffset: '0',
      yealinkName: 'UTC',
      posix: 'UTC0',
      supported: false,
    });
    expect(phoneTimezone('America/St_Johns').yealinkOffset).toBe('-3:30');
  });
});
