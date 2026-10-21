// SPDX-License-Identifier: AGPL-3.0-or-later
// Sounds & music (05 §2): recorded prompts for digital receptionists and announcements.
// Upload by picking or dropping a file; play, rename, delete. Music-on-hold classes and their
// files (03 §8) and announcements live here too.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  AnnouncementCreateSchema,
  MohClassName,
  SOUND_MAX_BYTES,
  type AnnouncementCreate,
  type AnnouncementDto,
  type Destination,
  type MohClassDto,
  type MohClassUpdate,
  type SoundDto,
} from '@selfphoneng/shared';
import { announcementsApi, mohApi, soundsApi } from '../../api/client.ts';
import { DestinationPicker } from '../../components/DestinationPicker.tsx';
import { SoundPicker } from '../../components/SoundPicker.tsx';
import { ConfirmDialog, Dialog } from '../../components/Dialog.tsx';
import { Alert, Button, Field, inputClass } from '../../components/ui.tsx';

const secs = (ms: number) =>
  `${Math.floor(ms / 60000)}:${String(Math.round(ms / 1000) % 60).padStart(2, '0')}`;
const stem = (filename: string) =>
  filename
    .replace(/\.[^.]+$/, '')
    .replace(/[_-]+/g, ' ')
    .trim();

export function SoundsPage() {
  const qc = useQueryClient();
  const sounds = useQuery({ queryKey: ['sounds'], queryFn: soundsApi.list });
  const refresh = () => qc.invalidateQueries({ queryKey: ['sounds'] });
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [dragging, setDragging] = useState(false);
  const [renaming, setRenaming] = useState<SoundDto | null>(null);
  const [deleting, setDeleting] = useState<SoundDto | null>(null);

  const add = useMutation({
    mutationFn: () => soundsApi.upload(name.trim(), file!),
    onSuccess: async () => {
      setFile(null);
      setName('');
      await refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => soundsApi.remove(id),
    onSuccess: async () => {
      setDeleting(null);
      await refresh();
    },
  });

  function pick(f: File | undefined) {
    if (!f) return;
    add.reset();
    setFile(f);
    if (!name.trim()) setName(stem(f.name));
  }
  const tooBig = file !== null && file.size > SOUND_MAX_BYTES;

  return (
    <section className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">Sounds &amp; music</h1>
      <form
        aria-label="Upload a sound"
        className={`flex flex-col gap-3 rounded-lg border-2 border-dashed p-4 ${dragging ? 'border-sky-500 bg-sky-50 dark:bg-sky-950' : 'border-zinc-300 dark:border-zinc-700'}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          pick(e.dataTransfer.files[0]);
        }}
        onSubmit={(e) => {
          e.preventDefault();
          if (file && name.trim() && !tooBig) add.mutate();
        }}
      >
        <p className="text-sm">
          Drop an audio file here, or pick one. Any common format works (mp3, wav, m4a, ogg, flac);
          it's converted for phones and evened out in volume. Up to 20 MB.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="File">
            {(p) => (
              <input
                {...p}
                type="file"
                accept="audio/*"
                className="text-sm"
                onChange={(e) => {
                  pick(e.target.files?.[0]);
                  e.target.value = '';
                }}
              />
            )}
          </Field>
          <Field label="Name">
            {(p) => (
              <input
                {...p}
                className={inputClass}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Main greeting"
              />
            )}
          </Field>
          <Button
            type="submit"
            variant="primary"
            disabled={!file || !name.trim() || tooBig || add.isPending}
          >
            {add.isPending ? 'Converting…' : 'Upload'}
          </Button>
        </div>
        {file && <p className="text-sm text-zinc-500">Selected: {file.name}</p>}
        {tooBig && <Alert>That file is larger than 20 MB.</Alert>}
        {add.error && <Alert>{add.error.message}</Alert>}
      </form>

      {sounds.isError && <Alert>{sounds.error.message}</Alert>}
      {sounds.data?.length === 0 && (
        <p className="text-sm text-zinc-500">
          No sounds yet. Upload greetings for your digital receptionist and announcements.
        </p>
      )}
      {sounds.data && sounds.data.length > 0 && (
        <ul className="divide-y divide-zinc-100 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
          {sounds.data.map((s) => (
            <li
              key={s.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2 text-sm"
            >
              <span className="min-w-0 flex-1">
                <span className="font-medium">{s.name}</span>{' '}
                <span className="text-zinc-500">{secs(s.durationMs)}</span>
              </span>
              <audio
                controls
                preload="none"
                src={soundsApi.audioUrl(s.id)}
                aria-label={`Play ${s.name}`}
                className="h-9 w-full sm:w-64"
              />
              <Button onClick={() => setRenaming(s)}>Rename</Button>
              <Button variant="ghost" onClick={() => setDeleting(s)}>
                Delete
              </Button>
            </li>
          ))}
        </ul>
      )}

      {renaming && (
        <RenameDialog sound={renaming} onClose={() => setRenaming(null)} onDone={refresh} />
      )}
      <ConfirmDialog
        open={deleting !== null}
        title="Delete sound"
        message={<p>Delete "{deleting?.name}"? This can't be undone.</p>}
        confirmLabel="Delete"
        busy={remove.isPending}
        error={remove.error?.message}
        onCancel={() => {
          setDeleting(null);
          remove.reset();
        }}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />
      <MusicOnHold />
      <Announcements />
    </section>
  );
}

/** Music on hold (03 §8): sets of music; users and queues pick one. 'default' is built in. */
function MusicOnHold() {
  const qc = useQueryClient();
  const classes = useQuery({ queryKey: ['moh-classes'], queryFn: mohApi.list });
  const refresh = () => qc.invalidateQueries({ queryKey: ['moh-classes'] });
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string>();
  const [deleting, setDeleting] = useState<MohClassDto | null>(null);
  const create = useMutation({
    mutationFn: (n: string) => mohApi.create(n),
    onSuccess: async () => {
      setName('');
      await refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => mohApi.remove(id),
    onSuccess: async () => {
      setDeleting(null);
      await refresh();
    },
  });

  return (
    <section aria-labelledby="moh-h" className="flex flex-col gap-3">
      <h2 id="moh-h" className="text-lg font-semibold">
        Music on hold
      </h2>
      <p className="text-sm text-zinc-500">
        What callers hear on hold or waiting in a queue. Default music is built in. Make your own
        set here, then choose it for a user (Phone tab) or a queue.
      </p>
      <form
        aria-label="New music on hold"
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          const parsed = MohClassName.safeParse(name.trim());
          setNameError(parsed.success ? undefined : parsed.error.issues[0]?.message);
          if (parsed.success) create.mutate(parsed.data);
        }}
      >
        <Field label="New set" error={nameError} hint="Like sales-jazz">
          {(p) => (
            <input
              {...p}
              className={inputClass}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          )}
        </Field>
        <Button type="submit" disabled={!name.trim() || create.isPending}>
          Add set
        </Button>
      </form>
      {create.error && <Alert>{create.error.message}</Alert>}
      {classes.isError && <Alert>{classes.error.message}</Alert>}
      {classes.data?.map((c) => (
        <MohClassCard key={c.id} cls={c} onChanged={refresh} onDelete={() => setDeleting(c)} />
      ))}
      <ConfirmDialog
        open={deleting !== null}
        title="Delete music on hold"
        message={<p>Delete "{deleting?.name}" and its music? This can't be undone.</p>}
        confirmLabel="Delete"
        busy={remove.isPending}
        error={remove.error?.message}
        onCancel={() => {
          setDeleting(null);
          remove.reset();
        }}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </section>
  );
}

function MohClassCard({
  cls,
  onChanged,
  onDelete,
}: {
  cls: MohClassDto;
  onChanged: () => Promise<unknown>;
  onDelete: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const add = useMutation({
    mutationFn: (f: File) => mohApi.addFile(cls.id, stem(f.name) || 'Music', f),
    onSuccess: async () => {
      setFile(null);
      await onChanged();
    },
  });
  const removeFile = useMutation({
    mutationFn: (fileId: string) => mohApi.removeFile(cls.id, fileId),
    onSuccess: onChanged,
  });
  const update = useMutation({
    mutationFn: (body: MohClassUpdate) => mohApi.update(cls.id, body),
    onSuccess: onChanged,
  });
  /** The play order with file i moved one place up (-1) or down (+1). */
  const move = (i: number, by: -1 | 1) => {
    const ids = cls.files.map((f) => f.id);
    [ids[i], ids[i + by]] = [ids[i + by]!, ids[i]!];
    update.mutate({ order: ids });
  };
  const tooBig = file !== null && file.size > SOUND_MAX_BYTES;

  return (
    <div
      aria-label={`Music on hold ${cls.name}`}
      role="group"
      className="flex flex-col gap-2 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex-1 font-medium">{cls.name}</span>
        <Button variant="ghost" onClick={onDelete}>
          Delete set
        </Button>
      </div>
      {cls.files.length === 0 && (
        <p className="text-sm text-zinc-500">No music yet: callers hear the default music.</p>
      )}
      {cls.files.length > 1 && (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={cls.shuffle}
            disabled={update.isPending}
            onChange={(e) => update.mutate({ shuffle: e.target.checked })}
          />
          Shuffle
          <span className="text-zinc-500">
            {cls.shuffle
              ? '(plays in random order)'
              : '(each caller on hold starts at the top, in this order)'}
          </span>
        </label>
      )}
      <ol aria-label={`Play order of ${cls.name}`} className="flex flex-col gap-1">
        {cls.files.map((f, i) => (
          <li key={f.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            {cls.files.length > 1 && !cls.shuffle && (
              <span className="flex items-center gap-0.5">
                <span className="w-5 text-right text-zinc-500 tabular-nums">{i + 1}.</span>
                <Button
                  variant="ghost"
                  aria-label={`Move ${f.name} up`}
                  title="Play earlier"
                  disabled={i === 0 || update.isPending}
                  onClick={() => move(i, -1)}
                >
                  ↑
                </Button>
                <Button
                  variant="ghost"
                  aria-label={`Move ${f.name} down`}
                  title="Play later"
                  disabled={i === cls.files.length - 1 || update.isPending}
                  onClick={() => move(i, 1)}
                >
                  ↓
                </Button>
              </span>
            )}
            <span className="min-w-0 flex-1">
              {f.name} <span className="text-zinc-500">{secs(f.durationMs)}</span>
            </span>
            <audio
              controls
              preload="none"
              src={mohApi.audioUrl(cls.id, f.id)}
              aria-label={`Play ${f.name}`}
              className="h-9 w-full sm:w-64"
            />
            <Button
              variant="ghost"
              disabled={removeFile.isPending}
              onClick={() => removeFile.mutate(f.id)}
            >
              Remove
            </Button>
          </li>
        ))}
      </ol>
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (file && !tooBig) add.mutate(file);
        }}
      >
        <Field label={`Add music to ${cls.name}`}>
          {(p) => (
            <input
              {...p}
              type="file"
              accept="audio/*"
              className="text-sm"
              onChange={(e) => {
                add.reset();
                setFile(e.target.files?.[0] ?? null);
              }}
            />
          )}
        </Field>
        <Button type="submit" disabled={!file || tooBig || add.isPending}>
          {add.isPending ? 'Converting…' : 'Upload'}
        </Button>
      </form>
      {tooBig && <Alert>That file is larger than 20 MB.</Alert>}
      {add.error && <Alert>{add.error.message}</Alert>}
      {removeFile.error && <Alert>{removeFile.error.message}</Alert>}
      {update.error && <Alert>{update.error.message}</Alert>}
    </div>
  );
}

/** Announcements (03 §6.11): play one of these sounds, then send the caller on. */
function Announcements() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['announcements'], queryFn: announcementsApi.list });
  const [editing, setEditing] = useState<AnnouncementDto | 'new' | null>(null);
  const [deleting, setDeleting] = useState<AnnouncementDto | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['announcements'] });
  const remove = useMutation({
    mutationFn: (id: string) => announcementsApi.remove(id),
    onSuccess: async () => {
      setDeleting(null);
      await refresh();
    },
  });
  return (
    <section aria-labelledby="ann-h" className="mt-4 flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="ann-h" className="text-lg font-semibold">
          Announcements
        </h2>
        <Button onClick={() => setEditing('new')}>Add announcement</Button>
      </div>
      <p className="text-sm text-zinc-500">
        An announcement plays a sound ("Our hours are…") and then sends the caller on, e.g. back to
        a menu. Use them from phone numbers, menus and office hours.
      </p>
      {list.data && list.data.length > 0 && (
        <ul className="divide-y divide-zinc-100 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
          {list.data.map((a) => (
            <li
              key={a.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm"
            >
              <span className="font-medium">{a.name}</span>
              <span className="min-w-0 flex-1 truncate text-zinc-500">
                plays "{a.soundName}", then {a.destinationSummary}
              </span>
              <Button onClick={() => setEditing(a)}>Edit</Button>
              <Button variant="ghost" onClick={() => setDeleting(a)}>
                Delete
              </Button>
            </li>
          ))}
        </ul>
      )}
      {editing && (
        <AnnouncementForm
          ann={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={refresh}
        />
      )}
      <ConfirmDialog
        open={deleting !== null}
        title="Delete announcement"
        message={<p>Delete {deleting?.name}?</p>}
        confirmLabel="Delete"
        busy={remove.isPending}
        error={remove.error?.message}
        onCancel={() => {
          setDeleting(null);
          remove.reset();
        }}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </section>
  );
}

function AnnouncementForm({
  ann,
  onClose,
  onSaved,
}: {
  ann: AnnouncementDto | null;
  onClose: () => void;
  onSaved: () => Promise<unknown>;
}) {
  const [name, setName] = useState(ann?.name ?? '');
  const [soundId, setSoundId] = useState<string | null>(ann?.soundId ?? null);
  const [dest, setDest] = useState<Destination | null>(ann?.destination ?? { type: 'hangup' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const save = useMutation({
    mutationFn: (body: AnnouncementCreate) =>
      ann ? announcementsApi.update(ann.id, body) : announcementsApi.create(body),
    onSuccess: async () => {
      await onSaved();
      onClose();
    },
  });
  function submit() {
    const parsed = AnnouncementCreateSchema.safeParse({
      name,
      soundId: soundId ?? undefined,
      destination: dest ?? undefined,
    });
    if (!parsed.success) {
      setErrors(Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0]), i.message])));
      return;
    }
    setErrors({});
    save.mutate(parsed.data);
  }
  return (
    <Dialog
      open
      onClose={onClose}
      title={ann ? ann.name : 'New announcement'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={save.isPending}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Name" error={errors.name}>
          {(p) => (
            <input
              {...p}
              className={inputClass}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          )}
        </Field>
        <SoundPicker label="Sound" value={soundId} onChange={setSoundId} error={errors.soundId} />
        <DestinationPicker
          label="Then"
          value={dest ?? { type: 'hangup' }}
          onChange={setDest}
          error={errors.destination}
          exclude={ann?.id}
        />
        {save.error && <Alert>{save.error.message}</Alert>}
      </div>
    </Dialog>
  );
}

function RenameDialog({
  sound,
  onClose,
  onDone,
}: {
  sound: SoundDto;
  onClose: () => void;
  onDone: () => Promise<unknown>;
}) {
  const [name, setName] = useState(sound.name);
  const save = useMutation({
    mutationFn: () => soundsApi.rename(sound.id, name.trim()),
    onSuccess: async () => {
      await onDone();
      onClose();
    },
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title="Rename sound"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!name.trim() || save.isPending}
            onClick={() => save.mutate()}
          >
            Save
          </Button>
        </>
      }
    >
      <Field label="Name">
        {(p) => (
          <input
            {...p}
            className={inputClass}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        )}
      </Field>
      {save.error && <Alert>{save.error.message}</Alert>}
    </Dialog>
  );
}
