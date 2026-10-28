// SPDX-License-Identifier: AGPL-3.0-or-later
// Phone numbers (DIDs) and where their calls go (05 §2, 06 §3).
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';
import { DestinationSchema, formatNumber, type DidDto } from '@selfphoneng/shared';
import { didsApi, trunksApi } from '../../api/client.ts';
import { ConfirmDialog, Dialog } from '../../components/Dialog.tsx';
import { DestinationPicker } from '../../components/DestinationPicker.tsx';
import { Alert, Button, Field, inputClass } from '../../components/ui.tsx';

export function NumbersPage() {
  const qc = useQueryClient();
  const dids = useQuery({ queryKey: ['dids'], queryFn: didsApi.list });
  const trunks = useQuery({ queryKey: ['trunks'], queryFn: trunksApi.list });
  const [editing, setEditing] = useState<DidDto | 'new' | null>(null);
  const [deleting, setDeleting] = useState<DidDto | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['dids'] });
  const remove = useMutation({
    mutationFn: (id: string) => didsApi.remove(id),
    onSuccess: () => {
      setDeleting(null);
      void refresh();
    },
  });
  const trunkName = (id: string) => trunks.data?.find((t) => t.id === id)?.name ?? '–';
  const noTrunk = trunks.data?.length === 0;

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Phone numbers</h1>
        <Button variant="primary" onClick={() => setEditing('new')} disabled={noTrunk}>
          Add number
        </Button>
      </div>
      {noTrunk && (
        <p className="text-sm text-muted">Add a trunk first: numbers arrive through one.</p>
      )}
      {dids.isError && <Alert>{dids.error.message}</Alert>}
      {dids.isPending && <p className="text-sm text-muted">Loading…</p>}
      {dids.data?.length === 0 && !noTrunk && (
        <p className="text-sm text-muted">
          No numbers yet. Add the numbers (DIDs) you bought at voip.ms.
        </p>
      )}
      {dids.data && dids.data.length > 0 && (
        <ul className="divide-y divide-line rounded-xl border border-line bg-surface shadow-sm">
          {dids.data.map((d) => (
            <li
              key={d.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm"
            >
              <span className="font-mono">{formatNumber(d.number)}</span>
              {d.label && <span className="text-muted">{d.label}</span>}
              <span className="flex-1 truncate">→ {d.destinationSummary}</span>
              <span className="hidden text-muted sm:inline">{trunkName(d.trunkId)}</span>
              <Button onClick={() => setEditing(d)}>Edit</Button>
              <Button
                variant="ghost"
                onClick={() => {
                  remove.reset();
                  setDeleting(d);
                }}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}

      {editing && trunks.data && (
        <DidDrawer
          did={editing === 'new' ? null : editing}
          trunks={trunks.data.map((t) => ({ id: t.id, name: t.name }))}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void refresh();
          }}
        />
      )}
      <ConfirmDialog
        open={deleting !== null}
        title="Remove number"
        message={
          <p>
            Remove <strong>{deleting && formatNumber(deleting.number)}</strong>? Calls to it will no
            longer be answered here. It stays yours at voip.ms.
          </p>
        }
        confirmLabel="Remove"
        busy={remove.isPending}
        error={remove.error?.message}
        onCancel={() => setDeleting(null)}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </section>
  );
}

const FormSchema = z.object({
  number: z.string().trim().min(1, 'Required'),
  label: z.string().trim().max(60),
  trunkId: z.string().min(1, 'Pick a trunk'),
  destination: DestinationSchema.nullable().refine((d) => d !== null, 'Finish choosing'),
  callerIdNamePrefix: z
    .string()
    .trim()
    .max(12)
    .regex(/^[A-Za-z0-9 :_.#-]*$/, 'Letters, digits, spaces and : _ . # - only'),
  e911Address: z.string().trim().max(200),
  recordInbound: z.boolean(),
});
type FormValues = z.input<typeof FormSchema>;

function DidDrawer({
  did,
  trunks,
  onClose,
  onSaved,
}: {
  did: DidDto | null;
  trunks: { id: string; name: string }[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [error, setError] = useState<string>();
  const form = useForm<FormValues>({
    resolver: zodResolver(FormSchema),
    defaultValues: {
      number: did ? formatNumber(did.number) : '',
      label: did?.label ?? '',
      trunkId: did?.trunkId ?? trunks[0]?.id ?? '',
      destination: did?.destination ?? { type: 'hangup' },
      callerIdNamePrefix: did?.callerIdNamePrefix ?? '',
      e911Address: did?.e911Address ?? '',
      recordInbound: did?.recordInbound ?? false,
    },
  });
  const { errors } = form.formState;

  const onSubmit = form.handleSubmit(async (v) => {
    setError(undefined);
    const body = {
      number: v.number,
      trunkId: v.trunkId,
      label: v.label || null,
      destination: v.destination!,
      callerIdNamePrefix: v.callerIdNamePrefix || null,
      e911Address: v.e911Address || null,
      recordInbound: v.recordInbound,
    };
    try {
      if (did) await didsApi.update(did.id, body);
      else await didsApi.create(body);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  });

  return (
    <Dialog
      open
      drawer
      onClose={onClose}
      title={did ? `Edit ${formatNumber(did.number)}` : 'Add number'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="did-form">
            {did ? 'Save' : 'Add number'}
          </Button>
        </>
      }
    >
      <form id="did-form" onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
        {error && <Alert>{error}</Alert>}
        <Field label="Phone number" error={errors.number?.message}>
          {(a) => (
            <input
              {...a}
              {...form.register('number')}
              inputMode="tel"
              placeholder="(312) 555-1234"
              className={inputClass}
            />
          )}
        </Field>
        <Field label="Label" error={errors.label?.message} hint="For example: Main line.">
          {(a) => <input {...a} {...form.register('label')} className={inputClass} />}
        </Field>
        <Field label="Trunk" error={errors.trunkId?.message}>
          {(a) => (
            <select {...a} {...form.register('trunkId')} className={inputClass}>
              {trunks.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Controller
          control={form.control}
          name="destination"
          render={({ field, fieldState }) => (
            <DestinationPicker
              label="When someone calls this number"
              value={field.value ?? { type: 'hangup' }}
              onChange={field.onChange}
              error={fieldState.error?.message}
            />
          )}
        />
        <Field
          label="Caller name prefix"
          error={errors.callerIdNamePrefix?.message}
          hint="Shown before the caller's name, e.g. SALES: so people know which number was called."
        >
          {(a) => <input {...a} {...form.register('callerIdNamePrefix')} className={inputClass} />}
        </Field>
        <Field
          label="E911 address (for your notes)"
          error={errors.e911Address?.message}
          hint="The address registered for this number at voip.ms (DID → e911). Emergency services get the address stored there, not this one."
        >
          {(a) => <input {...a} {...form.register('e911Address')} className={inputClass} />}
        </Field>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" {...form.register('recordInbound')} />
          <span>
            Record every call to this number
            <span className="block text-xs text-muted">
              Callers hear the recording notice from Settings → Recording first, if you set one.
              Check the consent rules where you and your callers are.
            </span>
          </span>
        </label>
      </form>
    </Dialog>
  );
}
