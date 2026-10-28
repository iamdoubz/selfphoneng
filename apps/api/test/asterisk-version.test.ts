// SPDX-License-Identifier: AGPL-3.0-or-later
// A new Asterisk in asterisk/Dockerfile must go through the upgrade check first (verified.ts).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { VERIFIED_ASTERISK, pinnedAsterisk } from './asterisk/verified.ts';

describe('the pinned Asterisk', () => {
  it('is the version the upgrade check last passed on', () => {
    expect(
      pinnedAsterisk(),
      `asterisk/Dockerfile pins ${pinnedAsterisk()}, the upgrade check last passed on ` +
        `${VERIFIED_ASTERISK}. Build the image, run \`pnpm test:asterisk-upgrade\` and ` +
        '`pnpm test:asterisk`, act on what moved, then set VERIFIED_ASTERISK in ' +
        'apps/api/test/asterisk/verified.ts',
    ).toBe(VERIFIED_ASTERISK);
  });

  it('is the one spec 01 §2 names', () => {
    const spec = readFileSync(
      new URL('../../../docs/spec/01-infrastructure.md', import.meta.url),
      'utf8',
    );
    expect(spec).toContain(`**Pinned: \`${pinnedAsterisk()}\``);
    expect(spec).toContain(`ARG ASTERISK_VERSION=${pinnedAsterisk()}`);
  });
});
