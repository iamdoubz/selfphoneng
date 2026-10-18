// SPDX-License-Identifier: AGPL-3.0-or-later
// Sounds & music (05 §2): recorded prompts for digital receptionists and announcements.
// Upload by picking or dropping a file; play, rename, delete. Music on hold arrives with M8.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { SOUND_MAX_BYTES, type SoundDto } from '@selfphoneng/shared';
import { soundsApi } from '../../api/client.ts';
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
    </section>
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
