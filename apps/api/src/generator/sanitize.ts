// SPDX-License-Identifier: AGPL-3.0-or-later
// Every value that goes into generated Asterisk config passes through one of these (03 §2).
// The API validates with the same rules first, so a throw here means a bug: apply fails loudly.

export class SanitizeError extends Error {}

function check(re: RegExp, kind: string, max = 200) {
  return (v: string): string => {
    if (typeof v !== 'string' || v.length > max || !re.test(v))
      throw new SanitizeError(`${kind}: invalid value ${JSON.stringify(String(v).slice(0, 40))}`);
    return v;
  };
}

/** Internal numbers, DIDs. */
export const digits = check(/^[0-9]+$/, 'digits', 32);
/** Forward targets, external numbers. */
export const dialable = check(/^[0-9*#+]+$/, 'dialable', 32);
/** Outbound route patterns. */
export const pattern = check(/^[0-9XZN.![\]-]+$/, 'pattern', 32);
/** Sound file names for Playback/Background. */
export const sound = check(/^[a-z0-9/_-]+$/, 'sound', 100);
/** Context-name parts (uuids), MOH class names. */
export const ident = check(/^[a-z0-9-]+$/, 'ident', 64);
/** Generated SIP passwords. */
export const secret = check(/^[A-Za-z0-9]+$/, 'secret', 64);
/** Voicemail / conference PINs. */
export const pin = check(/^[0-9]{4,10}$/, 'pin', 10);
/** Trunk server host: a hostname or an IPv4 address. */
export const host = check(
  /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/,
  'host',
  253,
);
const octet = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
/** IPv4 address. */
export const ipv4 = check(new RegExp(`^${octet}(?:\\.${octet}){3}$`), 'ipv4', 15);
/** IPv4 CIDR, e.g. local nets. */
export const cidr = check(
  new RegExp(`^${octet}(?:\\.${octet}){3}/(?:3[0-2]|[12]?\\d)$`),
  'cidr',
  18,
);

/**
 * Caller ID names and labels: removes characters that mean something in dialplan or config
 * (" ' \ ; , ( ) [ ] { } $ < > |) and control characters, trims, max 40. Never throws.
 */
export function name(v: string): string {
  return String(v)
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, '') // controls, incl. CR/LF, and invisible format chars
    .replace(/["'\\;,()[\]{}$<>|]/g, '')
    .trim()
    .slice(0, 40)
    .trim();
}
