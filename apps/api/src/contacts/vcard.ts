// SPDX-License-Identifier: AGPL-3.0-or-later
// vCard 2.1, 3.0 and 4.0 to contacts (11 §3.1): the name, company, first email, every phone and
// the note. Everything else (photos, addresses, birthdays) is ignored.
import type { ContactData } from '@selfphoneng/shared';

type Prop = { group: string; name: string; params: Map<string, string[]>; value: string };

/** "ENCODING=QUOTED-PRINTABLE;CHARSET=utf-8;TYPE=CELL,VOICE;WORK" (2.1 allows bare types). */
function parseParams(parts: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const p of parts) {
    const eq = p.indexOf('=');
    const key = eq < 0 ? 'TYPE' : p.slice(0, eq).toUpperCase();
    const raw = eq < 0 ? p : p.slice(eq + 1);
    const vals = raw.replace(/"/g, '').split(',').filter(Boolean);
    // 2.1's bare QUOTED-PRINTABLE is an encoding, not a type.
    const k = eq < 0 && /^(QUOTED-PRINTABLE|BASE64|8BIT)$/i.test(raw) ? 'ENCODING' : key;
    out.set(k, [...(out.get(k) ?? []), ...vals.map((v) => v.toUpperCase())]);
  }
  return out;
}

/** "[group.]NAME[;params]:value", with ':' allowed inside quoted params. */
function parseLine(line: string): Prop | null {
  let quoted = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') quoted = !quoted;
    else if (line[i] === ':' && !quoted) {
      colon = i;
      break;
    }
  }
  if (colon < 0) return null;
  const [head = '', ...params] = line.slice(0, colon).split(';');
  const dot = head.lastIndexOf('.');
  return {
    group: dot < 0 ? '' : head.slice(0, dot).toUpperCase(),
    name: head.slice(dot + 1).toUpperCase(),
    params: parseParams(params),
    value: line.slice(colon + 1),
  };
}

function decodeQp(v: string, charset: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < v.length; i++) {
    const hex = v.slice(i + 1, i + 3);
    if (v[i] === '=' && /^[0-9A-F]{2}$/i.test(hex)) {
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else bytes.push(v.charCodeAt(i) & 0xff);
  }
  try {
    return new TextDecoder(charset).decode(new Uint8Array(bytes));
  } catch {
    return new TextDecoder('utf-8').decode(new Uint8Array(bytes));
  }
}

/** Splits on unescaped `sep`, then unescapes \n \, \; \\. */
function components(v: string, sep: ';' | ','): string[] {
  const out = [''];
  for (let i = 0; i < v.length; i++) {
    const c = v[i]!;
    if (c === '\\' && i + 1 < v.length) {
      const n = v[++i]!;
      out[out.length - 1] += n === 'n' || n === 'N' ? '\n' : n;
    } else if (c === sep) out.push('');
    else out[out.length - 1] += c;
  }
  return out.map((s) => s.trim());
}
const text = (v: string) => components(v, ';').join(';').trim();

/** cell → mobile, work, home, fax, else other; an Apple X-ABLabel wins. */
function telLabel(types: string[], abLabel: string | undefined): string {
  if (abLabel) {
    const l = abLabel.replace(/^_\$!<|>!\$_$/g, '').trim();
    if (l) return l.toLowerCase() === 'cell' ? 'mobile' : l.toLowerCase();
  }
  if (types.includes('FAX')) return 'fax';
  if (types.some((t) => t === 'CELL' || t === 'MOBILE' || t === 'IPHONE')) return 'mobile';
  if (types.includes('WORK')) return 'work';
  if (types.includes('HOME')) return 'home';
  if (types.includes('MAIN')) return 'main';
  return 'other';
}

/** Every card in the text, in order. A card with no name, company or number is an error. */
export function parseVcards(input: string): { contacts: ContactData[]; errors: string[] } {
  // Unfold: a line starting with a space or tab continues the one before (and 2.1
  // quoted-printable continues a line that ends with "=").
  const lines: string[] = [];
  for (const l of input.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/)) {
    const prev = lines.at(-1);
    if (prev?.endsWith('=') && /QUOTED-PRINTABLE/i.test(prev.split(':')[0]!))
      lines[lines.length - 1] = prev.slice(0, -1) + l.replace(/^[ \t]/, '');
    else if (prev !== undefined && /^[ \t]/.test(l)) lines[lines.length - 1] = prev + l.slice(1);
    else lines.push(l);
  }

  const contacts: ContactData[] = [];
  const errors: string[] = [];
  let card: Prop[] | null = null;
  for (const line of lines) {
    const p = parseLine(line);
    if (!p) continue;
    if (p.name === 'BEGIN' && p.value.toUpperCase() === 'VCARD') card = [];
    else if (p.name === 'END' && p.value.toUpperCase() === 'VCARD' && card) {
      const c = toContact(card);
      if (c) contacts.push(c);
      else errors.push(`Card ${contacts.length + errors.length + 1}: no name or number, skipped`);
      card = null;
    } else if (card) {
      const enc = p.params.get('ENCODING') ?? [];
      if (enc.includes('QUOTED-PRINTABLE'))
        p.value = decodeQp(p.value, p.params.get('CHARSET')?.[0]?.toLowerCase() ?? 'utf-8');
      card.push(p);
    }
  }
  return { contacts, errors };
}

function toContact(props: Prop[]): ContactData | null {
  const first = (n: string) => props.find((p) => p.name === n)?.value;
  const fn = first('FN') ? text(first('FN')!) : '';
  const n = first('N');
  const [family = '', given = '', middle = '', prefix = '', suffix = ''] = n
    ? components(n, ';')
    : [];
  const fromN = [prefix, given, middle, family, suffix].filter(Boolean).join(' ');
  const org = first('ORG') ? components(first('ORG')!, ';')[0] || null : null;
  const email = first('EMAIL') ? text(first('EMAIL')!) || null : null;
  const abLabels = new Map(
    props.filter((p) => p.name === 'X-ABLABEL' && p.group).map((p) => [p.group, text(p.value)]),
  );
  const numbers = props
    .filter((p) => p.name === 'TEL')
    .map((p) => ({
      label: telLabel(p.params.get('TYPE') ?? [], p.group ? abLabels.get(p.group) : undefined),
      number: text(p.value).replace(/^tel:/i, '').split(';')[0]!.trim(),
    }))
    .filter((t) => t.number);
  const note = first('NOTE') ? text(first('NOTE')!) || null : null;
  const name = fn || fromN || org || numbers[0]?.number;
  if (!name) return null;
  return { name, company: org, email, numbers, notes: note };
}
