// SPDX-License-Identifier: AGPL-3.0-or-later
// M11-T8: a Linphone setup token is a credential, so the request log never shows it.
import { describe, expect, it } from 'vitest';
import { logUrl } from './app.ts';

describe('logUrl', () => {
  it('masks the Linphone token and leaves other URLs alone', () => {
    expect(logUrl('/prov/linphone/AbC_123-xyzxyzxyzxyzxyz.xml')).toBe('/prov/linphone/…');
    expect(logUrl('/PROV/linphone/secret.xml?x=1')).toBe('/PROV/linphone/…?x=1');
    expect(logUrl('/prov/001565123456.cfg')).toBe('/prov/001565123456.cfg');
    expect(logUrl('/api/calls?from=2026-10-01')).toBe('/api/calls?from=2026-10-01');
  });
});
