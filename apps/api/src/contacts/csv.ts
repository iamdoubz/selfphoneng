// SPDX-License-Identifier: AGPL-3.0-or-later
// CSV to contacts (04 §7.4): name,company,email,label1,number1,label2,number2,… with a header row
// (any order, any case; notes too).
import type { ContactData } from '@selfphoneng/shared';

/** RFC 4180 rows (blank ones too): quoted cells may hold commas, quotes ("") and line breaks. */
export function csvRows(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const s = input.replace(/^\uFEFF/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell || row.length) rows.push([...row, cell]);
  return rows;
}

export function parseCsv(input: string): { contacts: ContactData[]; errors: string[] } {
  const [header, ...rows] = csvRows(input);
  if (!header) return { contacts: [], errors: [] };
  const col = new Map(header.map((h, i) => [h.trim().toLowerCase(), i]));
  if (!col.has('name'))
    return { contacts: [], errors: ['The first row must name the columns, with a "name" column'] };
  const contacts: ContactData[] = [];
  const errors: string[] = [];
  rows.forEach((r, i) => {
    if (!r.some((c) => c.trim())) return;
    const get = (k: string) => {
      const at = col.get(k);
      return at === undefined ? '' : (r[at] ?? '').trim();
    };
    const numbers: ContactData['numbers'] = [];
    for (let n = 1; col.has(`number${n}`); n++)
      if (get(`number${n}`)) numbers.push({ label: get(`label${n}`), number: get(`number${n}`) });
    const name = get('name');
    if (!name) {
      errors.push(`Row ${i + 2}: no name, skipped`);
      return;
    }
    contacts.push({
      name,
      company: get('company') || null,
      email: get('email') || null,
      numbers,
      notes: get('notes') || null,
    });
  });
  return { contacts, errors };
}
