// SPDX-License-Identifier: AGPL-3.0-or-later
// Golden case loader (03 §12.1), shared by the golden tests and other generator tests.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SettingsSchemas, type SettingKey } from '@selfphoneng/shared';
import type { Snapshot } from './load.ts';

export const GOLDEN_ROOT = fileURLToPath(new URL('./__golden__', import.meta.url));

/** snapshot.json holds only what differs from the defaults, to keep cases readable. */
export function loadCase(name: string): Snapshot {
  const raw = JSON.parse(readFileSync(join(GOLDEN_ROOT, name, 'snapshot.json'), 'utf8')) as {
    today?: string;
    settings?: Record<string, unknown>;
    extensions?: Partial<Snapshot['extensions'][number]>[];
    dids?: Partial<Snapshot['dids'][number]>[];
    trunks?: Partial<Snapshot['trunks'][number]>[];
    routes?: Partial<Snapshot['routes'][number]>[];
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
    routes: (raw.routes ?? []).map((r, i) => ({
      name: `Route ${i + 1}`,
      position: i,
      enabled: true,
      patterns: [],
      requiredClass: 'national',
      trunkIds: [],
      callerId: null,
      ...r,
      id: r.id!,
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
      voicemailPin: '4826',
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
