// SPDX-License-Identifier: AGPL-3.0-or-later
// Digital receptionist (05 §2, 03 §6.9): a greeting, then a keypad where each key sends the
// caller somewhere; what happens on silence or a wrong key.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  IVR_DIGITS,
  IvrCreateSchema,
  type Destination,
  type IvrCreate,
  type IvrDto,
} from '@selfphoneng/shared';
import { extensionsApi, ivrsApi } from '../../api/client.ts';
import { DestinationPicker, useDescribeDestination } from '../../components/DestinationPicker.tsx';
import { ConfirmDialog, Dialog } from '../../components/Dialog.tsx';
import { SoundPicker } from '../../components/SoundPicker.tsx';
import { Alert, Button, Field, inputClass } from '../../components/ui.tsx';

type Digit = (typeof IVR_DIGITS)[number];

export function IvrsPage() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['ivrs'], queryFn: ivrsApi.list });
  const [editing, setEditing] = useState<IvrDto | 'new' | null>(null);
  const [deleting, setDeleting] = useState<IvrDto | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['ivrs'] });
  const remove = useMutation({
    mutationFn: (id: string) => ivrsApi.remove(id),
    onSuccess: async () => {
      setDeleting(null);
      await refresh();
    },
  });

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Digital receptionist</h1>
        <Button variant="primary" onClick={() => setEditing('new')}>
          Add menu
        </Button>
      </div>
      {list.isError && <Alert>{list.error.message}</Alert>}
      {list.data?.length === 0 && (
        <p className="text-sm text-muted">
          No menus yet. A menu greets callers ("Thanks for calling. For sales press 1…") and sends
          them where they choose. Upload the greeting under Sounds &amp; music, or right in the
          form.
        </p>
      )}
      {list.data && list.data.length > 0 && (
        <ul className="divide-y divide-line rounded-xl border border-line bg-surface shadow-sm">
          {list.data.map((r) => (
            <li
              key={r.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm"
            >
              <span className="font-mono">{r.number}</span>
              <span className="font-medium">{r.name}</span>
              <span className="min-w-0 flex-1 truncate text-muted">
                {r.options.map((o) => `${o.digit}: ${o.summary}`).join(' · ') || 'No keys yet'}
              </span>
              <Button onClick={() => setEditing(r)}>Edit</Button>
              <Button variant="ghost" onClick={() => setDeleting(r)}>
                Delete
              </Button>
            </li>
          ))}
        </ul>
      )}
      {editing && (
        <IvrForm
          ivr={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={refresh}
        />
      )}
      <ConfirmDialog
        open={deleting !== null}
        title="Delete menu"
        message={
          <p>
            Delete {deleting?.name} ({deleting?.number})?
          </p>
        }
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

function IvrForm({
  ivr,
  onClose,
  onSaved,
}: {
  ivr: IvrDto | null;
  onClose: () => void;
  onSaved: () => Promise<unknown>;
}) {
  const describe = useDescribeDestination();
  const next = useQuery({
    queryKey: ['next-number', 'ivr'],
    queryFn: () => extensionsApi.nextNumber('ivr'),
    enabled: !ivr,
  });
  const [form, setForm] = useState({
    number: ivr?.number ?? '',
    name: ivr?.name ?? '',
    timeoutSeconds: String(ivr?.timeoutSeconds ?? 5),
    maxRetries: String(ivr?.maxRetries ?? 3),
    allowDirectDial: ivr?.allowDirectDial ?? true,
  });
  const [greeting, setGreeting] = useState<string | null>(ivr?.greetingSoundId ?? null);
  const [invalidSound, setInvalidSound] = useState<string | null>(ivr?.invalidSoundId ?? null);
  // null = the key is in use but its destination isn't finished (e.g. a half-typed number).
  const [keys, setKeys] = useState<Partial<Record<Digit, Destination | null>>>(
    Object.fromEntries(ivr?.options.map((o) => [o.digit, o.destination]) ?? []),
  );
  const [selected, setSelected] = useState<Digit | null>(null);
  const [timeoutDest, setTimeoutDest] = useState<Destination | null>(
    ivr?.timeoutDestination ?? { type: 'hangup' },
  );
  const [invalidDest, setInvalidDest] = useState<Destination | null>(
    ivr?.invalidDestination ?? { type: 'hangup' },
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const number = form.number || (ivr ? '' : (next.data ?? ''));
  const set = (k: keyof typeof form) => (v: string | boolean) => setForm((f) => ({ ...f, [k]: v }));

  const save = useMutation({
    mutationFn: (body: IvrCreate) => (ivr ? ivrsApi.update(ivr.id, body) : ivrsApi.create(body)),
    onSuccess: async () => {
      await onSaved();
      onClose();
    },
  });

  function submit() {
    const incomplete = Object.entries(keys).find(([, d]) => d === null);
    if (incomplete) {
      setErrors({ options: `Finish setting up key ${incomplete[0]}` });
      return;
    }
    const parsed = IvrCreateSchema.safeParse({
      number,
      name: form.name,
      greetingSoundId: greeting ?? undefined,
      invalidSoundId: invalidSound,
      timeoutSeconds: Number(form.timeoutSeconds),
      maxRetries: Number(form.maxRetries),
      allowDirectDial: form.allowDirectDial,
      options: Object.entries(keys).map(([digit, destination]) => ({ digit, destination })),
      timeoutDestination: timeoutDest ?? undefined,
      invalidDestination: invalidDest ?? undefined,
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
      drawer
      onClose={onClose}
      title={ivr ? `Menu ${ivr.number}` : 'New menu'}
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
        <Field
          label="Number"
          error={errors.number}
          hint="Any free number, 1 to 6 digits. Dial it inside, or point a phone number at it"
        >
          {(p) => (
            <input
              {...p}
              className={inputClass}
              inputMode="numeric"
              value={number}
              onChange={(e) => set('number')(e.target.value)}
            />
          )}
        </Field>
        <Field label="Name" error={errors.name}>
          {(p) => (
            <input
              {...p}
              className={inputClass}
              value={form.name}
              placeholder="Main menu"
              onChange={(e) => set('name')(e.target.value)}
            />
          )}
        </Field>
        <SoundPicker
          label="Greeting"
          value={greeting}
          onChange={setGreeting}
          error={errors.greetingSoundId}
        />

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">Keys</legend>
          <div role="group" aria-label="Keypad" className="grid grid-cols-3 gap-2">
            {IVR_DIGITS.map((d) => {
              const dest = keys[d];
              return (
                <button
                  key={d}
                  type="button"
                  aria-label={`Key ${d}`}
                  aria-pressed={selected === d}
                  onClick={() => setSelected(d)}
                  className={`flex min-h-16 flex-col items-start rounded-md border p-2 text-left text-xs ${selected === d ? 'border-primary ring-2 ring-primary' : 'border-line-strong'} ${dest ? 'bg-primary-soft' : ''}`}
                >
                  <span className="text-lg font-semibold">{d}</span>
                  <span className="line-clamp-2 text-muted">
                    {dest ? describe(dest) : dest === null ? 'Not finished' : 'Unused'}
                  </span>
                </button>
              );
            })}
          </div>
          {errors.options && <Alert>{errors.options}</Alert>}
          {selected && (
            <div className="flex flex-col gap-2 rounded-md border border-line p-3">
              {keys[selected] === undefined ? (
                <Button onClick={() => setKeys((k) => ({ ...k, [selected]: { type: 'hangup' } }))}>
                  Use key {selected}
                </Button>
              ) : (
                <>
                  <DestinationPicker
                    key={selected}
                    label={`Key ${selected} goes to`}
                    value={keys[selected] ?? { type: 'hangup' }}
                    onChange={(d) => setKeys((k) => ({ ...k, [selected]: d }))}
                  />
                  <Button
                    variant="ghost"
                    onClick={() =>
                      setKeys((k) => {
                        const { [selected]: _gone, ...rest } = k;
                        return rest;
                      })
                    }
                  >
                    Make key {selected} unused
                  </Button>
                </>
              )}
            </div>
          )}
        </fieldset>

        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-1"
            checked={form.allowDirectDial}
            onChange={(e) => set('allowDirectDial')(e.target.checked)}
          />
          <span>
            Callers may dial an extension directly (e.g. 101)
            <span className="block text-xs text-muted">
              A key that is also the first digit of an extension waits 3 seconds for more digits.
            </span>
          </span>
        </label>
        <Field label="Wait for a key (seconds)" error={errors.timeoutSeconds}>
          {(p) => (
            <input
              {...p}
              className={inputClass}
              inputMode="numeric"
              value={form.timeoutSeconds}
              onChange={(e) => set('timeoutSeconds')(e.target.value)}
            />
          )}
        </Field>
        <Field
          label="Tries"
          error={errors.maxRetries}
          hint="How often the greeting repeats after silence or a wrong key"
        >
          {(p) => (
            <input
              {...p}
              className={inputClass}
              inputMode="numeric"
              value={form.maxRetries}
              onChange={(e) => set('maxRetries')(e.target.value)}
            />
          )}
        </Field>
        <SoundPicker
          label="Wrong key message"
          value={invalidSound}
          onChange={setInvalidSound}
          noneLabel="Standard message"
        />
        <DestinationPicker
          label="If the caller presses nothing"
          value={timeoutDest ?? { type: 'hangup' }}
          onChange={setTimeoutDest}
          error={errors.timeoutDestination}
        />
        <DestinationPicker
          label="After too many wrong keys"
          value={invalidDest ?? { type: 'hangup' }}
          onChange={setInvalidDest}
          error={errors.invalidDestination}
        />
        {save.error && <Alert>{save.error.message}</Alert>}
      </div>
    </Dialog>
  );
}
