// SPDX-License-Identifier: AGPL-3.0-or-later
// My voicemail (05 §4): messages (play marks read, download, delete) and greetings.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { formatNumber, type GreetingKind, type VoicemailDto } from '@selfphoneng/shared';
import { meApi } from '../../api/client.ts';
import { ConfirmDialog } from '../../components/Dialog.tsx';
import { Alert, Button } from '../../components/ui.tsx';

export const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
export const callerOf = (m: VoicemailDto) =>
  m.callerName ?? (m.callerNumber ? formatNumber(m.callerNumber) : 'Unknown caller');
export const isNew = (m: VoicemailDto) => m.folder !== 'Old';

export function VoicemailPage() {
  return (
    <div className="flex flex-col gap-8">
      <Messages />
      <Greetings />
    </div>
  );
}

function Messages() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['me', 'voicemail'], queryFn: meApi.voicemail });
  const [deleting, setDeleting] = useState<VoicemailDto | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['me', 'voicemail'] });
  const markRead = useMutation({
    mutationFn: (id: string) => meApi.moveVoicemail(id, 'Old'),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (id: string) => meApi.deleteVoicemail(id),
    onSuccess: async () => {
      setDeleting(null);
      await refresh();
    },
  });

  return (
    <section aria-labelledby="vm-h" className="flex flex-col gap-3">
      <h2 id="vm-h" className="text-lg font-semibold">
        Voicemail
      </h2>
      {list.error && <Alert>{list.error.message}</Alert>}
      {list.data?.length === 0 && <p className="text-sm text-zinc-500">No messages.</p>}
      <ul className="flex flex-col gap-2">
        {list.data?.map((m) => (
          <li
            key={m.id}
            className="flex flex-col gap-2 rounded-lg border border-zinc-200 p-3 sm:flex-row sm:items-center dark:border-zinc-800"
          >
            <div className="min-w-0 flex-1">
              <p className={isNew(m) ? 'font-semibold' : ''}>
                {callerOf(m)}
                {isNew(m) && (
                  <span className="ml-2 rounded bg-sky-100 px-1.5 py-0.5 text-xs text-sky-800 dark:bg-sky-900 dark:text-sky-200">
                    New
                  </span>
                )}
              </p>
              <p className="text-sm text-zinc-500">
                {m.callerName && m.callerNumber ? `${formatNumber(m.callerNumber)} · ` : ''}
                {new Date(m.receivedAt).toLocaleString()} · {mmss(m.durationS)}
              </p>
            </div>
            <audio
              controls
              preload="none"
              src={meApi.audioUrl(m.id)}
              aria-label={`Voicemail from ${callerOf(m)}`}
              className="w-full sm:w-64"
              onPlay={() => isNew(m) && !markRead.isPending && markRead.mutate(m.id)}
            />
            <div className="flex gap-2">
              <a
                href={meApi.audioUrl(m.id, true)}
                className="inline-flex items-center rounded-md px-3 py-2 text-sm font-medium hover:bg-zinc-100 dark:hover:bg-zinc-800"
              >
                Download
              </a>
              <Button variant="ghost" onClick={() => setDeleting(m)}>
                Delete
              </Button>
            </div>
          </li>
        ))}
      </ul>
      <ConfirmDialog
        open={deleting !== null}
        title="Delete voicemail"
        message={
          <p>Delete the message from {deleting && callerOf(deleting)}? This can't be undone.</p>
        }
        confirmLabel="Delete"
        busy={remove.isPending}
        error={remove.error?.message}
        onCancel={() => setDeleting(null)}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </section>
  );
}

const GREETING_LABELS: [GreetingKind, string, string][] = [
  ['unavail', "When you don't answer", 'Callers hear the standard "is unavailable" message.'],
  ['busy', "When you're on another call", 'Callers hear the standard "is busy" message.'],
  ['greet', 'Your name', 'Callers hear your extension number.'],
];

function Greetings() {
  const status = useQuery({ queryKey: ['me', 'greetings'], queryFn: meApi.greetings });
  return (
    <section aria-labelledby="gr-h" className="flex flex-col gap-3">
      <h2 id="gr-h" className="text-lg font-semibold">
        Greetings
      </h2>
      {status.error && <Alert>{status.error.message}</Alert>}
      {status.data &&
        GREETING_LABELS.map(([kind, label, fallback]) => (
          <Greeting
            key={kind}
            kind={kind}
            label={label}
            fallback={fallback}
            recorded={status.data[kind]}
            version={status.dataUpdatedAt}
          />
        ))}
    </section>
  );
}

function Greeting(props: {
  kind: GreetingKind;
  label: string;
  fallback: string;
  recorded: boolean;
  version: number;
}) {
  const { kind, label, recorded } = props;
  const qc = useQueryClient();
  const file = useRef<HTMLInputElement>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const [recording, setRecording] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  const done = () => qc.invalidateQueries({ queryKey: ['me', 'greetings'] });
  const upload = useMutation({
    mutationFn: (audio: Blob) => meApi.putGreeting(kind, audio),
    onSuccess: done,
  });
  const remove = useMutation({ mutationFn: () => meApi.deleteGreeting(kind), onSuccess: done });

  async function startRecording() {
    setMicError(null);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setMicError('No microphone, or the browser blocked it.');
      return;
    }
    const rec = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => chunks.push(e.data);
    rec.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      upload.mutate(new Blob(chunks, { type: rec.mimeType }));
    };
    rec.start();
    recorder.current = rec;
    setRecording(true);
  }

  function stopRecording() {
    recorder.current?.stop();
    recorder.current = null;
    setRecording(false);
  }

  const id = `greeting-${kind}`;
  return (
    <div
      role="group"
      aria-labelledby={id}
      className="flex flex-col gap-2 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800"
    >
      <p id={id} className="font-medium">
        {label}
      </p>
      {recorded ? (
        <audio
          controls
          preload="none"
          src={`${meApi.greetingUrl(kind)}?v=${props.version}`}
          aria-label={`${label} greeting`}
          className="w-full sm:w-80"
        />
      ) : (
        <p className="text-sm text-zinc-500">Not recorded. {props.fallback}</p>
      )}
      <div className="flex flex-wrap gap-2">
        {recording ? (
          <Button variant="danger" onClick={stopRecording}>
            Stop and save
          </Button>
        ) : (
          <Button onClick={startRecording} disabled={upload.isPending}>
            Record
          </Button>
        )}
        <Button onClick={() => file.current?.click()} disabled={recording || upload.isPending}>
          Upload a file
        </Button>
        <input
          ref={file}
          type="file"
          accept="audio/*"
          hidden
          aria-label={`Upload ${label} greeting`}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) upload.mutate(f);
            e.target.value = '';
          }}
        />
        {recorded && (
          <Button variant="ghost" onClick={() => remove.mutate()} disabled={remove.isPending}>
            Delete
          </Button>
        )}
      </div>
      {recording && <p className="text-sm text-red-600 dark:text-red-400">Recording…</p>}
      {upload.isPending && <p className="text-sm text-zinc-500">Saving…</p>}
      {upload.isSuccess && !upload.isPending && <p className="text-sm text-zinc-500">Saved.</p>}
      {(micError ?? upload.error?.message ?? remove.error?.message) && (
        <Alert>{micError ?? upload.error?.message ?? remove.error?.message}</Alert>
      )}
    </div>
  );
}
