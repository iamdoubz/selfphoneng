// SPDX-License-Identifier: AGPL-3.0-or-later
// Snom D-series (07 §3.5), experimental. With the setting server https://<host>/prov/ the phone
// asks for snom<model>.htm, then snom<model>-<MAC>.htm: this file. Format and setting names
// from Snom's "Desk Phone Configuration Files" and "Auto Provisioning" pages, (verify per
// model). Only what those pages show: no time zone (Snom has its own zone codes), voicemail
// key or phonebook yet.
import { xml, type ProvisionContext } from '../context.ts';

/** The first two keys are the phone's own lines by default: BLF keys start after them. */
const FIRST_BLF_KEY = 2;

export function snom(c: ProvisionContext): string {
  const s = (name: string, v: string) => `    <${name} idx="1" perm="">${xml(v)}</${name}>`;
  // Snom's examples give the host alone: the port only when it isn't the usual one.
  const host = c.sipPort === 5060 ? c.host : `${c.host}:${c.sipPort}`;
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<settings>',
    '  <phone-settings>',
    s('user_active', 'on'),
    s('user_realname', c.ext.name),
    s('user_name', c.ext.number),
    s('user_pass', c.ext.sipPassword),
    s('user_host', host),
    '  </phone-settings>',
    '  <functionKeys e="2">',
    ...c.blf.map(
      (b, i) =>
        `    <fkey idx="${i + FIRST_BLF_KEY}" context="active" label="${xml(b.label)}" lp="on" default_text="$name" perm="">blf sip:${xml(b.number)}@${xml(c.host)};user=phone</fkey>`,
    ),
    '  </functionKeys>',
    '</settings>',
    '',
  ].join('\n');
}
