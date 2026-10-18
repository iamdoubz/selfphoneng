// SPDX-License-Identifier: AGPL-3.0-or-later
// Golden tests (03 §12.1–12.2): render(snapshot.json) must equal expected/*.conf byte for byte.
// `UPDATE_GOLDEN=1 pnpm test` rewrites the expected files; a human reads the diff before committing.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SettingsSchemas, type SettingKey } from '@selfphoneng/shared';
import { GENERATED_FILES, render } from './index.ts';
import type { Snapshot } from './load.ts';

const ROOT = fileURLToPath(new URL('./__golden__', import.meta.url));
const UPDATE = process.env.UPDATE_GOLDEN === '1';

/** snapshot.json holds only what differs from the defaults, to keep cases readable. */
export function loadCase(name: string): Snapshot {
  const raw = JSON.parse(readFileSync(join(ROOT, name, 'snapshot.json'), 'utf8')) as {
    today?: string;
    settings?: Record<string, unknown>;
    extensions?: Partial<Snapshot['extensions'][number]>[];
    dids?: Partial<Snapshot['dids'][number]>[];
    trunks?: Partial<Snapshot['trunks'][number]>[];
  };
  const settings = Object.fromEntries(
    (Object.keys(SettingsSchemas) as SettingKey[])
      .filter((k) => k !== 'sms.webhookToken')
      .map((k) => [k, SettingsSchemas[k].parse(raw.settings?.[k])]),
  ) as Snapshot['settings'];
  return {
    today: raw.today ?? '2026-10-17',
    settings,
    dids: (raw.dids ?? []).map((d) => ({
      trunkId: '7d3e9a52-1c4b-4f6e-9a0d-2b8c5e1f4a37',
      label: null,
      destination: { type: 'hangup' as const },
      callerIdNamePrefix: null,
      ...d,
      id: d.id!,
      number: d.number!,
    })),
    trunks: (raw.trunks ?? []).map((t) => ({
      name: 'voip.ms',
      enabled: true,
      serverHost: 'chicago1.voip.ms',
      serverPort: 5060,
      transport: 'udp',
      authMode: 'registration',
      username: '123456_pbx',
      password: 'TrunkPassw0rd',
      fromUser: null,
      fromDomain: null,
      codecs: ['ulaw'],
      srtp: false,
      maxChannels: null,
      ...t,
      id: t.id!,
    })),
    extensions: (raw.extensions ?? []).map((e, i) => ({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      number: '101',
      name: 'User',
      sipPassword: 'TestPassword0000000000AB',
      webrtcEnabled: true,
      maxContacts: 5,
      ringSeconds: 25,
      voicemailEnabled: true,
      outboundClass: 'national',
      outboundCallerId: null,
      emergencyCallerId: null,
      recordMode: 'never',
      pickupGroup: null,
      language: 'en',
      mohClass: 'default',
      isAdmin: false,
      ...e,
    })),
  };
}

const cases = readdirSync(ROOT).filter((d) => existsSync(join(ROOT, d, 'snapshot.json')));

describe('golden', () => {
  it('has the required cases', () => {
    // 03 §12.1; the rest arrive with their features (M6, M8).
    expect(cases).toEqual(
      expect.arrayContaining([
        'empty',
        'one-user',
        'webrtc-disabled',
        'hostile-names',
        'voipms-basic',
      ]),
    );
  });

  describe.each(cases)('%s', (name) => {
    const snap = loadCase(name);
    const files = render(snap);
    const dir = join(ROOT, name, 'expected');
    if (UPDATE) {
      mkdirSync(dir, { recursive: true });
      for (const f of GENERATED_FILES) writeFileSync(join(dir, f), files[f]);
    }
    it.each(GENERATED_FILES)('%s', (f) => {
      expect(files[f]).toBe(readFileSync(join(dir, f), 'utf8'));
    });

    it('is deterministic: shuffled input order gives identical output', () => {
      const shuffled = { ...snap, extensions: [...snap.extensions].reverse() };
      expect(render(shuffled)).toEqual(files);
    });
  });
});
