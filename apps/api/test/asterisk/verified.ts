// SPDX-License-Identifier: AGPL-3.0-or-later
// What the code relies on Asterisk doing, as last measured by upgrade-test.ts, and on which
// version. asterisk-version.test.ts fails when asterisk/Dockerfile pins another version: run
// `pnpm test:asterisk-upgrade` on the new image, act on each change it lists, then update this.
import { readFileSync } from 'node:fs';

export const VERIFIED_ASTERISK = '24.0.0-rc2';

/** The version asterisk/Dockerfile builds. */
export function pinnedAsterisk(): string {
  const file = readFileSync(new URL('../../../../asterisk/Dockerfile', import.meta.url), 'utf8');
  const v = /^ARG ASTERISK_VERSION=(\S+)$/m.exec(file)?.[1];
  if (!v) throw new Error('asterisk/Dockerfile has no ARG ASTERISK_VERSION');
  return v;
}

/** `expect`: the answer on VERIFIED_ASTERISK. `where`: what depends on it, to change if it moves. */
export const FACTS = {
  riskyModulesGone: {
    expect: true,
    what: 'app_system, func_shell, app_disa, res_agi and app_externalivr are not loaded',
    where: 'asterisk/conf/modules.conf noload lines (08 §6): a renamed module would load again',
  },
  mwiSubscribeReplaces: {
    expect: true,
    what: 'endpoints take mwi_subscribe_replaces_unsolicited',
    where: 'generator/pjsip.ts: without it a phone that SUBSCRIBEs for MWI gets a 500 (03 §5.2)',
  },
  setVarKeepsUnderscores: {
    expect: true,
    what: 'set_var = __SP_DIRECTION=… loads as "__SP_DIRECTION"',
    where: 'generator/pjsip.ts set_var lines; dialplan reads SP_DIRECTION on dialed legs (03 §5.2)',
  },
  staticContactsInShowContacts: {
    expect: false,
    what: 'PJSIPShowContacts lists static (contact =) AOR contacts',
    where: 'live/state.ts reads trunk reachability from PJSIPShowEndpoint instead (04 §5.1)',
  },
  endpointShowsContactStatus: {
    expect: true,
    what: 'PJSIPShowEndpoint has a ContactStatusDetail for a static contact',
    where: 'live/state.ts trunk reachability (04 §5.1)',
  },
  voicemailMoveRemove: {
    expect: true,
    what: 'the AMI actions VoicemailMove and VoicemailRemove exist',
    where: 'services/voicemail.ts mark read and delete (04 §5.6)',
  },
  cdrLinkedId: {
    expect: true,
    what: 'Cdr AMI events carry LinkedID (cdr_manager.conf mapping)',
    where: 'services/cdr.ts groups a call by it (01 §3.15, 04 §5.4)',
  },
  cdrTimesUtcNoZone: {
    expect: true,
    what: 'Cdr StartTime is "YYYY-MM-DD HH:MM:SS" in UTC, no zone',
    where: 'services/cdr.ts utc() adds the Z itself',
  },
  tlsQualifyByHostname: {
    expect: false,
    what: 'a qualify OPTIONS over TLS checks the certificate against the host name, not the IP',
    where:
      'generator/pjsip.ts sets qualify_frequency = 0 on TLS trunks because of this (08 §2.1); ' +
      '24.0.0-rc3 says it fixes it ("Preserve target hostname for qualified OPTIONS destination")',
  },
} as const;

export type Fact = keyof typeof FACTS;
