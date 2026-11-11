// SPDX-License-Identifier: AGPL-3.0-or-later
// Photos (11 §8): a round photo, or the name's initials when there is none, and the editor that
// shrinks a picked picture to a PHOTO_PX square JPEG in the browser before it's uploaded.
import { UserRound } from 'lucide-react';
import { useRef, useState } from 'react';
import { PHOTO_MAX_BYTES, PHOTO_PX } from '@selfphoneng/shared';
import { Button } from './ui.tsx';

const SIZES = {
  sm: 'size-6 text-[10px]',
  md: 'size-8 text-xs',
  lg: 'size-16 text-xl',
  xl: 'size-24 text-3xl',
};

/** Up to two initials from words that start with a letter; "" for a number or "Unknown". */
const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter((w) => /^\p{L}/u.test(w))
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');

/** Decorative (alt=""): the name is always written next to it. */
export function Avatar({
  name,
  photo,
  size = 'md',
  className = '',
}: {
  name: string;
  photo: string | null | undefined;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const [broken, setBroken] = useState<string>();
  const base = `inline-flex shrink-0 select-none items-center justify-center overflow-hidden rounded-full bg-primary-soft font-semibold text-primary-ink ${SIZES[size]} ${className}`;
  if (photo && broken !== photo)
    return (
      <img
        src={photo}
        alt=""
        loading="lazy"
        onError={() => setBroken(photo)}
        className={`${base} object-cover`}
      />
    );
  const i = initials(name);
  return (
    <span aria-hidden className={base}>
      {i || <UserRound className="size-3/5" />}
    </span>
  );
}

/** A picked picture as a PHOTO_PX square JPEG, cropped to the middle. */
export async function shrinkPhoto(file: Blob): Promise<Blob> {
  const img = await createImageBitmap(file).catch(() => {
    throw new Error("This browser can't read that picture. Try a JPEG or PNG.");
  });
  const side = Math.min(img.width, img.height);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = PHOTO_PX;
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#fff'; // a transparent PNG would turn black as a JPEG
  g.fillRect(0, 0, PHOTO_PX, PHOTO_PX);
  g.drawImage(
    img,
    (img.width - side) / 2,
    (img.height - side) / 2,
    side,
    side,
    0,
    0,
    PHOTO_PX,
    PHOTO_PX,
  );
  img.close();
  for (const quality of [0.85, 0.6]) {
    const b = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', quality));
    if (b && b.size <= PHOTO_MAX_BYTES) return b;
  }
  throw new Error('That picture is still too big after shrinking it');
}

/** The photo with Add/Change and Remove. `save` gets the shrunk JPEG. */
export function PhotoEditor({
  name,
  photo,
  save,
  remove,
}: {
  name: string;
  photo: string | null;
  save: (jpeg: Blob) => Promise<unknown>;
  remove: () => Promise<unknown>;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const run = async (f: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await f();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-3">
        <Avatar name={name} photo={photo} size="lg" />
        <input
          ref={input}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void run(async () => save(await shrinkPhoto(f)));
          }}
        />
        <Button disabled={busy} onClick={() => input.current?.click()}>
          {photo ? 'Change photo' : 'Add photo'}
        </Button>
        {photo && (
          <Button variant="ghost" disabled={busy} onClick={() => void run(remove)}>
            Remove
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
