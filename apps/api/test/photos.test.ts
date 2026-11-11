// SPDX-License-Identifier: AGPL-3.0-or-later
// Photos (11 §8): people's and builtin contacts', the size and type limits, who sees which.
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PHOTO_MAX_BYTES, photoType } from '@selfphoneng/shared';
import { hasTestDb } from './db.ts';
import { ADMIN, H, createTestApp } from './app.ts';

type Req = (
  method: string,
  url: string,
  payload?: unknown,
  type?: string,
) => Promise<LightMyRequestResponse>;

const jpeg = (size = 64) =>
  Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(size)]);

it('photoType reads the first bytes', () => {
  expect(photoType(jpeg())).toBe('image/jpeg');
  expect(photoType(Buffer.from('89504e470d0a1a0a00', 'hex'))).toBe('image/png');
  expect(photoType(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
  expect(photoType(Buffer.from('<svg onload=alert(1)>'))).toBeNull();
  expect(photoType(Buffer.from('GIF89a'))).toBeNull();
});

describe.skipIf(!hasTestDb)('photos', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let admin: Req;
  let dan: Req;
  let sue: Req;
  let danId: string;

  beforeAll(async () => {
    t = await createTestApp();
    await t.clearMustChange(ADMIN.email);
    const as =
      (cookie: string): Req =>
      (method, url, payload, type) =>
        t.app.inject({
          method: method as 'GET',
          url,
          payload: payload as object,
          headers: { ...H, cookie, ...(type ? { 'content-type': type } : {}) },
        });
    admin = as(await t.login(ADMIN.email, ADMIN.password));
    danId = (await t.addUser('dan@example.com', 'dan-password-123')).id;
    const sueId = (await t.addUser('sue@example.com', 'sue-password-123')).id;
    await admin('POST', '/api/extensions', { number: '101', name: 'Dan Doe', userId: danId });
    await admin('POST', '/api/extensions', { number: '102', name: 'Sue Smith', userId: sueId });
    dan = as(await t.login('dan@example.com', 'dan-password-123'));
    sue = as(await t.login('sue@example.com', 'sue-password-123'));
  });
  afterAll(() => t?.close());

  it('my photo: on /me, the users list and presence; replaced with a new URL; removed', async () => {
    const up = await dan('PUT', '/api/me/photo', jpeg(), 'image/jpeg');
    expect(up.statusCode, up.body).toBe(200);
    const url = (await dan('GET', '/api/auth/me')).json().user.photo as string;
    expect(url).toBe(`/api/photos/${up.json().id}`);
    const users = (await admin('GET', '/api/users')).json().items;
    expect(users.find((u: { id: string }) => u.id === danId).photo).toBe(url);
    expect(t.app.live.snapshot(true).extensions.find((e) => e.number === '101')?.photo).toBe(url);

    const img = await sue('GET', url); // anyone signed in sees people's photos
    expect(img.statusCode).toBe(200);
    expect(img.headers['content-type']).toBe('image/jpeg');
    expect(img.headers['cache-control']).toMatch(/immutable/);
    expect(img.rawPayload.equals(jpeg())).toBe(true);
    expect((await t.app.inject({ method: 'GET', url })).statusCode).toBe(401);

    const again = await dan('PUT', '/api/me/photo', jpeg(80), 'image/jpeg');
    expect(again.json().id).not.toBe(up.json().id);
    expect((await sue('GET', url)).statusCode).toBe(404); // the old URL is gone

    expect((await dan('DELETE', '/api/me/photo')).statusCode).toBe(200);
    expect((await dan('GET', '/api/auth/me')).json().user.photo).toBeNull();
  });

  it('refuses big photos (413), other types (415) and look-alikes (400)', async () => {
    const big = await dan('PUT', '/api/me/photo', jpeg(PHOTO_MAX_BYTES), 'image/jpeg');
    expect(big.statusCode).toBe(413);
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"/>';
    expect((await dan('PUT', '/api/me/photo', svg, 'image/svg+xml')).statusCode).toBe(415);
    const fake = await dan('PUT', '/api/me/photo', Buffer.from(svg), 'image/png');
    expect(fake.statusCode).toBe(400);
    expect(fake.json().error.message).toMatch(/JPEG, PNG or WebP/);
  });

  it("admins set anyone's photo; users can't", async () => {
    expect((await admin('PUT', `/api/users/${danId}/photo`, jpeg(), 'image/jpeg')).statusCode).toBe(
      200,
    );
    expect((await sue('PUT', `/api/users/${danId}/photo`, jpeg(), 'image/jpeg')).statusCode).toBe(
      403,
    );
    expect((await admin('DELETE', `/api/users/${danId}/photo`)).statusCode).toBe(200);
  });

  it("contact photos: in the book, only the book's readers see them", async () => {
    const mine = (
      await dan('POST', '/api/me/contacts', { name: 'Jane', numbers: [{ number: '3125551234' }] })
    ).json();
    expect(mine.photo).toBeNull();
    expect(
      (await sue('PUT', `/api/me/contacts/${mine.id}/photo`, jpeg(), 'image/jpeg')).statusCode,
    ).toBe(404);
    const up = await dan('PUT', `/api/me/contacts/${mine.id}/photo`, jpeg(), 'image/jpeg');
    expect(up.statusCode, up.body).toBe(200);
    const listed = (await dan('GET', '/api/me/contacts')).json().items;
    const url = listed.find((c: { id: string }) => c.id === mine.id).photo;
    expect(url).toBe(`/api/photos/${up.json().id}`);
    expect((await dan('GET', url)).statusCode).toBe(200);
    expect((await sue('GET', url)).statusCode).toBe(404); // Dan's book is his

    const co = (
      await admin('POST', '/api/contacts', { name: 'Pizza', numbers: [{ number: '3125550000' }] })
    ).json();
    expect(
      (await dan('PUT', `/api/contacts/${co.id}/photo`, jpeg(), 'image/jpeg')).statusCode,
    ).toBe(403);
    const coUp = await admin('PUT', `/api/contacts/${co.id}/photo`, jpeg(), 'image/jpeg');
    expect((await sue('GET', `/api/photos/${coUp.json().id}`)).statusCode).toBe(200);

    // Deleting the contact deletes its photo.
    await dan('DELETE', `/api/me/contacts/${mine.id}`);
    expect((await dan('GET', url)).statusCode).toBe(404);
  });
});
