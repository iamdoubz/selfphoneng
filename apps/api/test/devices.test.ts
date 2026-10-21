// SPDX-License-Identifier: AGPL-3.0-or-later
// M10-T1: /api/devices and /prov (07 §1–§2): Basic auth, unknown MAC, rate limit and IP block,
// LAN-only, what's served.
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { auditLog, contacts, devices } from '../src/db/schema.ts';
import { resetProvLimiter } from '../src/provisioning/limiter.ts';
import { setSetting } from '../src/services/settings.ts';
import { hasTestDb } from './db.ts';
import { ADMIN, H, createTestApp } from './app.ts';

describe.skipIf(!hasTestDb)('/api/devices and /prov', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let req: (method: string, url: string, payload?: unknown) => Promise<LightMyRequestResponse>;
  let extId: string;
  let sipPassword: string;
  let device: { id: string; mac: string; provisioningPassword: string };
  /** A phone's request from `ip`, with Basic auth when `pass` is given. */
  const prov = (file: string, ip = '192.168.1.20', pass?: string, user = device.mac) =>
    t.app.inject({
      method: 'GET',
      url: `/prov/${file}`,
      headers: {
        'x-forwarded-for': ip,
        ...(pass !== undefined
          ? { authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}` }
          : {}),
      },
    });

  beforeAll(async () => {
    t = await createTestApp();
    await t.clearMustChange(ADMIN.email);
    const cookie = await t.login(ADMIN.email, ADMIN.password);
    req = (method, url, payload) =>
      t.app.inject({
        method: method as 'GET',
        url,
        payload: payload as object,
        headers: { ...H, cookie },
      });
    extId = (await req('POST', '/api/extensions', { number: '101', name: 'Dan "D" <Doe>' })).json()
      .id;
    sipPassword = (await req('GET', `/api/extensions/${extId}/sip-credentials`)).json().password;
  });
  afterAll(() => t?.close());
  beforeEach(() => resetProvLimiter());

  it('adds a phone: MAC in any format, a provisioning password, the URL to type in', async () => {
    const r = await req('POST', '/api/devices', {
      mac: '00:15:65:AB:CD:EF',
      vendor: 'yealink',
      model: 'T54W',
      extensionId: extId,
    });
    expect(r.statusCode, r.body).toBe(201);
    device = r.json();
    expect(device).toMatchObject({
      mac: '001565abcdef',
      extensionNumber: '101',
      provisioningUrl: 'https://pbx.test/prov/',
      lastProvisionedAt: null,
    });
    expect(device.provisioningPassword).toMatch(/^[A-Za-z0-9]{20}$/);
    const [row] = await t.db.select().from(devices);
    expect(row!.provisioningPasswordEnc).not.toContain(device.provisioningPassword);
    const again = await req('POST', '/api/devices', {
      mac: '0015.65ab.cdef',
      vendor: 'yealink',
      extensionId: extId,
    });
    expect(again.statusCode).toBe(409);
    for (const mac of ['00:15:65:ab:cd', 'zz:15:65:ab:cd:ef', '0015-65ab-cdef-00'])
      expect(
        (await req('POST', '/api/devices', { mac, vendor: 'yealink', extensionId: extId }))
          .statusCode,
        mac,
      ).toBe(400);
  });

  it('serves the Yealink file with Basic auth; asks for it first without counting a failure', async () => {
    const first = await prov(`${device.mac}.cfg`);
    expect(first.statusCode).toBe(401);
    expect(first.headers['www-authenticate']).toBe('Basic realm="selfphoneng"');
    const r = await prov(`${device.mac}.cfg`, '192.168.1.20', device.provisioningPassword);
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body).toContain('account.1.user_name = 101');
    expect(r.body).toContain(`account.1.password = ${sipPassword}`);
    expect(r.body).toContain('account.1.display_name = Dan "D" <Doe>');
    expect(r.body).toContain('static.auto_provision.server.url = https://pbx.test/prov/');
    // the phone may send its MAC upper case (Basic auth can't carry colons in the user name)
    const upper = await prov(
      `${device.mac.toUpperCase()}.cfg`,
      '192.168.1.20',
      device.provisioningPassword,
      device.mac.toUpperCase(),
    );
    expect(upper.statusCode).toBe(200);
    const [row] = await t.db.select().from(devices).where(eq(devices.id, device.id));
    expect(row!.lastProvisionedAt).not.toBeNull();
    expect(row!.lastProvisionedIp).toBe('192.168.1.20');
    // the common file needs no password (it's empty)
    expect((await prov('y000000000044.cfg')).body).toBe('#!version:1.0.0.1\n');
  });

  it('unknown MAC and the other vendor’s file answer like a known MAC; ten failures block the IP', async () => {
    // 08 §6: the answers mustn't tell which MACs exist.
    const known = await prov(`${device.mac}.cfg`);
    for (const f of ['001565000000.cfg', `cfg${device.mac}.xml`]) {
      const r = await prov(f);
      expect([r.statusCode, r.headers['www-authenticate'], r.body]).toEqual([
        401,
        known.headers['www-authenticate'],
        known.body,
      ]);
    }
    expect((await prov('anything.boot')).statusCode).toBe(404);
    // with credentials they're failures, like a wrong password
    expect(
      (await prov('001565000000.cfg', '192.168.1.20', 'guess', '001565000000')).statusCode,
    ).toBe(401);
    expect(
      (await prov(`cfg${device.mac}.xml`, '192.168.1.20', device.provisioningPassword)).statusCode,
    ).toBe(401); // a Yealink here
    for (let i = 0; i < 8; i++)
      expect((await prov(`${device.mac}.cfg`, '192.168.1.20', 'guess')).statusCode).toBe(401);
    // 10 failures (2 unknown MACs, 8 wrong passwords): even the right password is refused now
    expect(
      (await prov(`${device.mac}.cfg`, '192.168.1.20', device.provisioningPassword)).statusCode,
    ).toBe(429);
    // another phone is fine
    expect(
      (await prov(`${device.mac}.cfg`, '192.168.1.21', device.provisioningPassword)).statusCode,
    ).toBe(200);
  });

  it('outside the local nets: 20 requests per 10 minutes; LAN-only refuses them', async () => {
    for (let i = 0; i < 20; i++)
      expect(
        (await prov(`${device.mac}.cfg`, '203.0.113.9', device.provisioningPassword)).statusCode,
      ).toBe(200);
    expect(
      (await prov(`${device.mac}.cfg`, '203.0.113.9', device.provisioningPassword)).statusCode,
    ).toBe(429);
    await setSetting(t.db, 'provisioning.lanOnly', true);
    expect(
      (await prov(`${device.mac}.cfg`, '198.51.100.7', device.provisioningPassword)).statusCode,
    ).toBe(403);
    expect(
      (await prov(`${device.mac}.cfg`, '10.1.2.3', device.provisioningPassword)).statusCode,
    ).toBe(200);
    await setSetting(t.db, 'provisioning.lanOnly', false);
    await setSetting(t.db, 'provisioning.enabled', false);
    expect(
      (await prov(`${device.mac}.cfg`, '10.1.2.3', device.provisioningPassword)).statusCode,
    ).toBe(404);
    await setSetting(t.db, 'provisioning.enabled', true);
  });

  it('Grandstream: XML, values escaped', async () => {
    const r = await req('POST', '/api/devices', {
      mac: '000B82123456',
      vendor: 'grandstream',
      extensionId: extId,
    });
    const gs = r.json();
    const file = await prov(
      'cfg000b82123456.xml',
      '192.168.1.30',
      gs.provisioningPassword,
      '000b82123456',
    );
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toMatch(/application\/xml/);
    expect(file.body).toContain('<P35>101</P35>');
    expect(file.body).toContain('<P3>Dan &quot;D&quot; &lt;Doe&gt;</P3>');
    expect(file.body).toContain(`<P1361>${gs.provisioningPassword}</P1361>`);
  });

  it('config preview masks the passwords; generic phones have no file', async () => {
    const p = (await req('GET', `/api/devices/${device.id}/config-preview`)).json();
    expect(p.file).toBe('001565abcdef.cfg');
    expect(p.content).toContain('account.1.password = ********');
    expect(p.content).not.toContain(sipPassword);
    expect(p.content).not.toContain(device.provisioningPassword);
    const generic = (
      await req('POST', '/api/devices', {
        mac: '112233445566',
        vendor: 'generic',
        extensionId: extId,
      })
    ).json();
    expect((await req('GET', `/api/devices/${generic.id}/config-preview`)).statusCode).toBe(400);
    expect(
      (await prov('112233445566.cfg', '192.168.1.40', generic.provisioningPassword, '112233445566'))
        .statusCode,
    ).toBe(401);
  });

  it('M10-T2: BLF keys named after their users, the time zone, and the phonebook', async () => {
    await req('POST', '/api/extensions', { number: '102', name: 'Ann Lee' });
    await req('PATCH', `/api/extensions/${extId}`, { blfNumbers: ['102', '701'] });
    await t.db.insert(contacts).values([
      { name: 'Acme', numbers: [{ label: 'office', number: '13125551234' }] },
      { name: 'Private', ownerUserId: null, numbers: [] }, // no numbers: left out
    ]);
    const cfg = (await prov(`${device.mac}.cfg`, '192.168.1.60', device.provisioningPassword)).body;
    expect(cfg).toContain('linekey.2.value = 102\nlinekey.2.label = Ann Lee');
    expect(cfg).toContain('linekey.3.label = 701');
    expect(cfg).toContain('local_time.time_zone_name = United States-Central Time');
    expect(cfg).toContain(
      `remote_phonebook.data.1.url = https://${device.mac}:${device.provisioningPassword}@pbx.test/prov/phonebook/${device.mac}.xml`,
    );
    const book = await prov(
      `phonebook/${device.mac}.xml`,
      '192.168.1.60',
      device.provisioningPassword,
    );
    expect(book.statusCode).toBe(200);
    expect(book.body).toContain('<Name>Ann Lee</Name><Telephone label="Extension">102</Telephone>');
    expect(book.body).toContain('<Telephone label="office">13125551234</Telephone>');
    expect(book.body).not.toContain('Private');
    expect((await prov(`phonebook/${device.mac}.xml`, '192.168.1.60')).statusCode).toBe(401);
    // Grandstream asks for <path>/phonebook.xml and gets its own format
    const gs = (await req('GET', '/api/devices'))
      .json()
      .items.find((d: { vendor: string }) => d.vendor === 'grandstream');
    const gsBook = await prov(
      `phonebook/${gs.mac}/phonebook.xml`,
      '192.168.1.61',
      gs.provisioningPassword,
      gs.mac,
    );
    expect(gsBook.body).toContain('<AddressBook>');
    // the preview hides the password in the phonebook URL too
    const p = (await req('GET', `/api/devices/${device.id}/config-preview`)).json();
    expect(p.content).not.toContain(device.provisioningPassword);
    expect(p.timezoneWarning).toBe(false);
    await setSetting(t.db, 'general.timezone', 'Asia/Tokyo');
    const tokyo = (await req('GET', `/api/devices/${device.id}/config-preview`)).json();
    expect(tokyo.timezoneWarning).toBe(true);
    expect(tokyo.content).toContain('local_time.time_zone_name = UTC');
    await setSetting(t.db, 'general.timezone', 'America/Chicago');
  });

  it('M10-T3: Linphone QR (admin and me), the token is the credential, audited', async () => {
    const r = await req('GET', `/api/extensions/${extId}/softphone-qr`);
    expect(r.statusCode, r.body).toBe(200);
    const { url, qr } = r.json();
    expect(qr).toMatch(/^data:image\/png;base64,/);
    expect(url).toMatch(/^https:\/\/pbx\.test\/prov\/linphone\/[A-Za-z0-9_-]+\.xml$/);
    const path = new URL(url).pathname.slice('/prov/'.length);
    const x = await prov(path, '203.0.113.20'); // a mobile phone, no Basic auth
    expect(x.statusCode).toBe(200);
    expect(x.body).toContain('<entry name="username">101</entry>');
    expect(x.body).toContain(`<entry name="passwd">${sipPassword}</entry>`);
    // the token is case-sensitive: a lower-cased one is just a bad token
    expect((await prov(path.toLowerCase(), '203.0.113.21')).statusCode).toBe(404);
    expect((await prov('linphone/AAAAAAAAAAAAAAAAAAAAAAAA.xml', '203.0.113.21')).statusCode).toBe(
      404,
    );
    const logged = JSON.stringify(await t.db.select().from(auditLog));
    expect(logged).toContain('Made a phone app setup QR for extension 101');
    // a user with no extension gets a 404 from /api/me
    expect((await req('GET', '/api/me/softphone-qr')).statusCode).toBe(404);
  });

  it('delete: the phone gets nothing any more', async () => {
    expect((await req('DELETE', `/api/devices/${device.id}`)).statusCode).toBe(200);
    expect(
      (await prov(`${device.mac}.cfg`, '192.168.1.50', device.provisioningPassword)).statusCode,
    ).toBe(401);
  });
});
