// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from 'vitest';
import { spamLine } from './SpamNote.tsx';

it('says what the spam check knows, in one line (14 §5.1)', () => {
  expect(
    spamLine({
      risk: 'high',
      provider: 'ipqs',
      info: {
        fraudScore: 92,
        spammer: true,
        recentAbuse: false,
        lineType: 'VOIP',
        carrier: 'Verizon',
        name: null,
        city: 'Austin',
        region: 'TX',
      },
    }),
  ).toBe('Fraud score 92 · spammer · VOIP · Verizon · Austin, TX');
  const ftc = (complaints: number, robocalls: number, subject: string | null) =>
    spamLine({
      risk: 'high',
      provider: 'ftc',
      info: { complaints, robocalls, lastReportedAt: '2026-10-20T15:00:00Z', subject },
    });
  expect(ftc(4, 3, 'Warranties')).toMatch(
    /^Reported to the FTC 4 times \(3 robocalls\), last on .+: Warranties$/,
  );
  expect(ftc(1, 0, null)).toMatch(/^Reported to the FTC once, last on [^:]+$/);
});
