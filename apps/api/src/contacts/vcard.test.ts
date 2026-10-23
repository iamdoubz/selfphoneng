// SPDX-License-Identifier: AGPL-3.0-or-later
// C1: vCard and CSV imports read what phones and address books export (11 §3.1).
import { describe, expect, it } from 'vitest';
import { parseCsv } from './csv.ts';
import { parseVcards } from './vcard.ts';

const IPHONE = [
  'BEGIN:VCARD',
  'VERSION:3.0',
  'PRODID:-//Apple Inc.//iPhone OS 17.0//EN',
  'N:Doe;Jane;;;',
  'FN:Jane Doe',
  'ORG:Acme Corp;',
  'EMAIL;type=INTERNET;type=HOME;type=pref:jane@example.com',
  'TEL;type=CELL;type=VOICE;type=pref:(312) 555-1234',
  'item1.TEL:+1 312 555 0000',
  'item1.X-ABLabel:_$!<Main>!$_',
  'NOTE:Met at the fair\\, 2026\\nCall after 5',
  'PHOTO;ENCODING=b;TYPE=JPEG:/9j/4AAQSkZJRgABAQAAAQABAAD',
  ' /2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJ',
  'END:VCARD',
].join('\r\n');

const GOOGLE = `BEGIN:VCARD
VERSION:3.0
FN:Bob Smith
N:Smith;Bob;;;
TEL;TYPE=WORK:+13125559999
TEL;TYPE=HOME:3125558888
EMAIL;TYPE=INTERNET:bob@example.com
ORG:Widgets Inc.
item1.URL:http\\://example.com
END:VCARD
BEGIN:VCARD
VERSION:3.0
N:;;;;
TEL;TYPE=CELL:3125550101
END:VCARD
`;

const V21 = `BEGIN:VCARD
VERSION:2.1
N;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:M=C3=BCller;J=C3=BCrgen;;Dr.;
TEL;CELL:+49301234567
TEL;WORK;FAX:+49301234500
NOTE;ENCODING=QUOTED-PRINTABLE:Line one=0D=0ALine tw=
o
END:VCARD`;

const V40 = `BEGIN:VCARD
VERSION:4.0
FN:Carol Lee
TEL;VALUE=uri;TYPE="voice,cell":tel:+1-312-555-7777
END:VCARD
BEGIN:VCARD
VERSION:4.0
NOTE:nothing to call
END:VCARD`;

describe('parseVcards', () => {
  it('reads an iPhone export: names, company, labels, note; skips the photo', () => {
    expect(parseVcards(IPHONE)).toEqual({
      contacts: [
        {
          name: 'Jane Doe',
          company: 'Acme Corp',
          email: 'jane@example.com',
          numbers: [
            { label: 'mobile', number: '(312) 555-1234' },
            { label: 'main', number: '+1 312 555 0000' },
          ],
          notes: 'Met at the fair, 2026\nCall after 5',
        },
      ],
      errors: [],
    });
  });

  it('reads a Google export, and names a card with only a number after it', () => {
    const { contacts } = parseVcards(GOOGLE);
    expect(contacts.map((c) => [c.name, c.company, c.numbers])).toEqual([
      [
        'Bob Smith',
        'Widgets Inc.',
        [
          { label: 'work', number: '+13125559999' },
          { label: 'home', number: '3125558888' },
        ],
      ],
      ['3125550101', null, [{ label: 'mobile', number: '3125550101' }]],
    ]);
  });

  it('reads vCard 2.1: quoted-printable UTF-8, bare types, soft line breaks', () => {
    const [c] = parseVcards(V21).contacts;
    expect(c).toMatchObject({
      name: 'Dr. Jürgen Müller',
      numbers: [
        { label: 'mobile', number: '+49301234567' },
        { label: 'fax', number: '+49301234500' },
      ],
      notes: 'Line one\r\nLine two',
    });
  });

  it('reads vCard 4.0 tel: URIs, and reports a card with nothing to call', () => {
    expect(parseVcards(V40)).toEqual({
      contacts: [
        {
          name: 'Carol Lee',
          company: null,
          email: null,
          numbers: [{ label: 'mobile', number: '+1-312-555-7777' }],
          notes: null,
        },
      ],
      errors: ['Card 2: no name or number, skipped'],
    });
  });
});

describe('parseCsv', () => {
  it('reads the 04 §7.4 columns in any order, with quotes and line breaks', () => {
    const csv =
      'Number1,Name,label1,company,notes,number2,label2\r\n' +
      '312-555-1234,"Doe, Jane",mobile,Acme,"two\nlines",,\r\n' +
      ',,,,,,\r\n' +
      '3125550000,,work,,,,\r\n' +
      '+44 20 7946 0958,"Bob ""B"" Smith",,,,101,desk\r\n';
    expect(parseCsv(csv)).toEqual({
      contacts: [
        {
          name: 'Doe, Jane',
          company: 'Acme',
          email: null,
          numbers: [{ label: 'mobile', number: '312-555-1234' }],
          notes: 'two\nlines',
        },
        {
          name: 'Bob "B" Smith',
          company: null,
          email: null,
          numbers: [
            { label: '', number: '+44 20 7946 0958' },
            { label: 'desk', number: '101' },
          ],
          notes: null,
        },
      ],
      errors: ['Row 4: no name, skipped'],
    });
  });

  it('needs a header with a name column', () => {
    expect(parseCsv('Jane,3125551234\n').errors[0]).toMatch(/"name" column/);
  });
});
