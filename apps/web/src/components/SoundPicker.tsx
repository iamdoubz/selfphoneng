// SPDX-License-Identifier: AGPL-3.0-or-later
// SoundPicker (05 §3): pick a recorded prompt, play it, or upload a new one right here.
import { Play } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useRef } from 'react';
import { soundsApi } from '../api/client.ts';
import { Button, inputClass } from './ui.tsx';

export function SoundPicker({
  label,
  value,
  onChange,
  noneLabel,
  error,
}: {
  label: string;
  value: string | null;
  onChange: (id: string | null) => void;
  /** Offer "none" with this label (e.g. "Standard message"); omit when a sound is required. */
  noneLabel?: string;
  error?: string;
}) {
  const id = useId();
  const qc = useQueryClient();
  const sounds = useQuery({ queryKey: ['sounds'], queryFn: soundsApi.list });
  const file = useRef<HTMLInputElement>(null);
  const player = useRef<HTMLAudioElement>(null);
  const upload = useMutation({
    mutationFn: (f: File) => soundsApi.upload(f.name.replace(/\.[^.]+$/, ''), f),
    onSuccess: async (s) => {
      await qc.invalidateQueries({ queryKey: ['sounds'] });
      onChange(s.id);
    },
  });

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <div className="flex gap-2">
        <select
          id={id}
          className={inputClass}
          value={value ?? ''}
          aria-invalid={Boolean(error)}
          onChange={(e) => onChange(e.target.value || null)}
        >
          {(noneLabel !== undefined || !value) && (
            <option value="">{noneLabel ?? 'Pick a sound…'}</option>
          )}
          {sounds.data?.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <Button
          aria-label={`Play ${label}`}
          disabled={!value}
          onClick={() => {
            const a = player.current!;
            a.src = soundsApi.audioUrl(value!);
            void a.play().catch(() => undefined);
          }}
        >
          <Play className="size-4" />
        </Button>
        <Button onClick={() => file.current?.click()} disabled={upload.isPending}>
          {upload.isPending ? 'Uploading…' : 'Upload new'}
        </Button>
        <input
          ref={file}
          type="file"
          accept="audio/*"
          hidden
          aria-label={`Upload a new sound for ${label}`}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) upload.mutate(f);
            e.target.value = '';
          }}
        />
        <audio ref={player} hidden />
      </div>
      {(error ?? upload.error?.message) && (
        <p className="text-xs text-red-600 dark:text-red-400">{error ?? upload.error?.message}</p>
      )}
    </div>
  );
}
