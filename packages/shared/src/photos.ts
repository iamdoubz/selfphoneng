// SPDX-License-Identifier: AGPL-3.0-or-later
// Photos of people and contacts (11 §8). The browser makes them PHOTO_PX square JPEGs before
// upload; the server refuses anything over PHOTO_MAX_BYTES and anything that isn't JPEG, PNG or
// WebP by its first bytes, and the database checks both again (photos table).

/** Width and height the browser shrinks a picked photo to: 2x a 128 px avatar. */
export const PHOTO_PX = 256;
/** Hard limit for one stored photo. A 256 px JPEG is 10–40 KB. */
export const PHOTO_MAX_BYTES = 256 * 1024;
export const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type PhotoType = (typeof PHOTO_TYPES)[number];

/** The type by the first bytes, never by a header or a file name. */
export function photoType(b: Uint8Array): PhotoType | null {
  const starts = (sig: number[], at = 0) => sig.every((x, i) => b[at + i] === x);
  if (starts([0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  // RIFF....WEBP
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  return null;
}

/** Where a stored photo is served. A new upload gets a new id, so the URL can be cached forever. */
export const photoUrl = (id: string | null | undefined) => (id ? `/api/photos/${id}` : null);
