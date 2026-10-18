// SPDX-License-Identifier: AGPL-3.0-or-later
// Outbound rules (05 §2, 03 §6.12): ordered list (first match wins), form, and a test box.
// ponytail: ↑/↓ buttons instead of drag-to-reorder; keyboard-friendly, no drag library.
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useFieldArray, useForm } from 'react-hook-form';
import { z } from 'zod';
import {
  OUTBOUND_CLASSES,
  RoutePatternSchema,
  formatNumber,
  type OutboundRouteDto,
  type RouteTestResult,
} from '@selfphoneng/shared';
import { didsApi, extensionsApi, routesApi, trunksApi } from '../../api/client.ts';
import { ConfirmDialog, Dialog } from '../../components/Dialog.tsx';
import { Alert, Button, Field, inputClass } from '../../components/ui.tsx';

export const CLASS_LABEL: Record<(typeof OUTBOUND_CLASSES)[number], string> = {
  internal: 'Internal only',
  local: 'Local and toll-free',
  national: 'US/Canada',
  international: 'International',
};

export function OutboundPage() {
  const qc = useQueryClient();
  const routes = useQuery({ queryKey: ['routes'], queryFn: routesApi.list });
  const trunks = useQuery({ queryKey: ['trunks'], queryFn: trunksApi.list });
  const [editing, setEditing] = useState<OutboundRouteDto | 'new' | null>(null);
  const [deleting, setDeleting] = useState<OutboundRouteDto | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['routes'] });
  const remove = useMutation({
    mutationFn: (id: string) => routesApi.remove(id),
    onSuccess: () => {
      setDeleting(null);
      void refresh();
    },
  });
  const move = useMutation({
    mutationFn: ({ from, to }: { from: number; to: number }) => {
      const ids = routes.data!.map((r) => r.id);
      [ids[from], ids[to]] = [ids[to]!, ids[from]!];
      return routesApi.reorder(ids);
    },
    onSettled: () => void refresh(),
  });
  const trunkName = (id: string) => trunks.data?.find((t) => t.id === id)?.name ?? '?';

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Outbound rules</h1>
        <Button variant="primary" onClick={() => setEditing('new')} disabled={!trunks.data?.length}>
          New rule
        </Button>
      </div>
      <p className="max-w-prose text-sm text-zinc-500">
        When someone dials an outside number, the first rule whose pattern matches decides how the
        call goes out. Put more specific rules (like toll-free) above general ones.
      </p>
      {routes.isError && <Alert>{routes.error.message}</Alert>}
      {move.isError && <Alert>{move.error.message}</Alert>}
      {routes.data?.length === 0 && (
        <p className="text-sm text-zinc-500">
          No rules yet. They are created with your first trunk.
        </p>
      )}
      {routes.data && routes.data.length > 0 && (
        <ol className="divide-y divide-zinc-100 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
          {routes.data.map((r, i) => (
            <li
              key={r.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm"
            >
              <span className="flex flex-col">
                <Button
                  variant="ghost"
                  className="px-1 py-0"
                  aria-label={`Move ${r.name} up`}
                  disabled={i === 0 || move.isPending}
                  onClick={() => move.mutate({ from: i, to: i - 1 })}
                >
                  ↑
                </Button>
                <Button
                  variant="ghost"
                  className="px-1 py-0"
                  aria-label={`Move ${r.name} down`}
                  disabled={i === routes.data.length - 1 || move.isPending}
                  onClick={() => move.mutate({ from: i, to: i + 1 })}
                >
                  ↓
                </Button>
              </span>
              <span className="w-5 text-zinc-500">{i + 1}.</span>
              <span className={`font-medium ${r.enabled ? '' : 'text-zinc-400 line-through'}`}>
                {r.name}
              </span>
              {!r.enabled && <span className="text-xs text-zinc-500">off</span>}
              <span className="flex-1 truncate font-mono text-xs text-zinc-500">
                {r.patterns.map((p) => p.match).join(' ')}
              </span>
              <span className="hidden text-zinc-500 sm:inline">
                {CLASS_LABEL[r.requiredClass]} · {r.trunkIds.map(trunkName).join(' → ')}
              </span>
              <Button onClick={() => setEditing(r)}>Edit</Button>
              <Button
                variant="ghost"
                onClick={() => {
                  remove.reset();
                  setDeleting(r);
                }}
              >
                Delete
              </Button>
            </li>
          ))}
        </ol>
      )}
      <TestBox />

      {editing && trunks.data && (
        <RouteDrawer
          route={editing === 'new' ? null : editing}
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
        title="Delete rule"
        message={
          <p>
            Delete <strong>{deleting?.name}</strong>? Numbers only this rule matches can no longer
            be dialed.
          </p>
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

function TestBox() {
  const exts = useQuery({ queryKey: ['extensions'], queryFn: extensionsApi.list });
  const [extId, setExtId] = useState('');
  const [number, setNumber] = useState('');
  const test = useMutation({
    mutationFn: () => routesApi.test(extId || exts.data![0]!.id, number),
  });
  const r: RouteTestResult | undefined = test.data;
  if (!exts.data?.length) return null;
  return (
    <form
      className="flex flex-col gap-3 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800"
      onSubmit={(e) => {
        e.preventDefault();
        if (number.trim()) test.mutate();
      }}
    >
      <h2 className="font-medium">Test a number</h2>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Caller">
          {(a) => (
            <select
              {...a}
              value={extId}
              onChange={(e) => setExtId(e.target.value)}
              className={inputClass}
            >
              {exts.data.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.number} {x.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Dials">
          {(a) => (
            <input
              {...a}
              value={number}
              onChange={(e) => setNumber(e.target.value)}
              inputMode="tel"
              placeholder="3125550000"
              className={inputClass}
            />
          )}
        </Field>
        <Button type="submit" disabled={test.isPending}>
          Test
        </Button>
      </div>
      {test.isError && <Alert>{test.error.message}</Alert>}
      {r && (
        <p role="status" className="text-sm">
          {r.ok ? (
            <>
              <strong>{r.routeName}</strong> sends <span className="font-mono">{r.dialed}</span> via{' '}
              {r.trunks.map((t) => t.name).join(', then ')}
              {r.callerId
                ? `, caller ID ${r.callerId}.`
                : '. No caller ID is set, so the provider uses its own (voip.ms: the sub-account CallerID).'}
            </>
          ) : (
            r.reason
          )}
        </p>
      )}
    </form>
  );
}

const FormSchema = z.object({
  name: z.string().trim().min(1, 'Required').max(60),
  enabled: z.boolean(),
  patterns: z.array(RoutePatternSchema).min(1, 'Add at least one pattern'),
  requiredClass: z.enum(OUTBOUND_CLASSES),
  trunkIds: z.array(z.string()).min(1, 'Pick at least one trunk'),
  callerIdDidId: z.string(),
});
type FormValues = z.input<typeof FormSchema>;

function RouteDrawer({
  route,
  trunks,
  onClose,
  onSaved,
}: {
  route: OutboundRouteDto | null;
  trunks: { id: string; name: string }[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const dids = useQuery({ queryKey: ['dids'], queryFn: didsApi.list });
  const [error, setError] = useState<string>();
  const form = useForm<FormValues>({
    resolver: zodResolver(FormSchema),
    defaultValues: {
      name: route?.name ?? '',
      enabled: route?.enabled ?? true,
      patterns: route?.patterns ?? [{ match: '', strip: 0, prepend: '' }],
      requiredClass: route?.requiredClass ?? 'national',
      trunkIds: route?.trunkIds ?? [trunks[0]!.id],
      callerIdDidId: route?.callerIdDidId ?? '',
    },
  });
  const { errors } = form.formState;
  const patterns = useFieldArray({ control: form.control, name: 'patterns' });
  const [chosen, setChosen] = useState<string[]>(form.getValues('trunkIds'));
  const setTrunks = (ids: string[]) => {
    setChosen(ids);
    form.setValue('trunkIds', ids, { shouldValidate: true });
  };

  const onSubmit = form.handleSubmit(async (v) => {
    setError(undefined);
    const body = { ...v, callerIdDidId: v.callerIdDidId || null };
    try {
      if (route) await routesApi.update(route.id, body);
      else await routesApi.create(body);
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
      title={route ? `Edit ${route.name}` : 'New outbound rule'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="route-form">
            {route ? 'Save' : 'Create rule'}
          </Button>
        </>
      }
    >
      <form id="route-form" onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
        {error && <Alert>{error}</Alert>}
        <Field label="Name" error={errors.name?.message}>
          {(a) => <input {...a} {...form.register('name')} className={inputClass} />}
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" {...form.register('enabled')} className="size-4" />
          Enabled
        </label>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">Patterns</legend>
          <details className="text-xs text-zinc-500">
            <summary className="cursor-pointer">Pattern help</summary>
            <p className="mt-1">
              <code>X</code> any digit, <code>Z</code> 1–9, <code>N</code> 2–9, <code>[1-5]</code>{' '}
              one of those, <code>.</code> one or more of anything. Example: <code>NXXNXXXXXX</code>{' '}
              is a 10-digit US number. <em>Strip</em> removes digits from the front,{' '}
              <em>prepend</em> adds digits, e.g. strip 0 prepend 1 turns 3125550000 into
              13125550000.
            </p>
          </details>
          {patterns.fields.map((f, i) => (
            <div key={f.id} className="flex items-start gap-2">
              <input
                {...form.register(`patterns.${i}.match`)}
                aria-label={`Pattern ${i + 1}`}
                placeholder="NXXNXXXXXX"
                aria-invalid={Boolean(errors.patterns?.[i]?.match)}
                className={`${inputClass} flex-1 font-mono`}
              />
              <input
                {...form.register(`patterns.${i}.strip`, { valueAsNumber: true })}
                aria-label={`Pattern ${i + 1} strip`}
                type="number"
                min={0}
                title="Strip"
                className={`${inputClass} w-16`}
              />
              <input
                {...form.register(`patterns.${i}.prepend`)}
                aria-label={`Pattern ${i + 1} prepend`}
                placeholder="prepend"
                className={`${inputClass} w-24 font-mono`}
              />
              <Button
                variant="ghost"
                aria-label={`Remove pattern ${i + 1}`}
                onClick={() => patterns.remove(i)}
                disabled={patterns.fields.length === 1}
              >
                ✕
              </Button>
            </div>
          ))}
          {errors.patterns && (
            <p className="text-xs text-red-600 dark:text-red-400">
              {errors.patterns.message ??
                errors.patterns.root?.message ??
                'Check the patterns: digits and X Z N [1-5] . ! only'}
            </p>
          )}
          <Button onClick={() => patterns.append({ match: '', strip: 0, prepend: '' })}>
            Add pattern
          </Button>
        </fieldset>

        <Field label="Who may use it" hint="Users whose calling permission is at least this.">
          {(a) => (
            <select {...a} {...form.register('requiredClass')} className={inputClass}>
              {OUTBOUND_CLASSES.map((c) => (
                <option key={c} value={c}>
                  {CLASS_LABEL[c]}
                </option>
              ))}
            </select>
          )}
        </Field>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">Trunks, in the order to try them</legend>
          <ol className="flex flex-col gap-1">
            {chosen.map((id, i) => (
              <li key={id} className="flex items-center gap-2 text-sm">
                <span className="w-5 text-zinc-500">{i + 1}.</span>
                <span className="flex-1">{trunks.find((t) => t.id === id)?.name ?? id}</span>
                <Button
                  variant="ghost"
                  aria-label="Try earlier"
                  disabled={i === 0}
                  onClick={() => {
                    const ids = [...chosen];
                    [ids[i - 1], ids[i]] = [ids[i]!, ids[i - 1]!];
                    setTrunks(ids);
                  }}
                >
                  ↑
                </Button>
                <Button
                  variant="ghost"
                  aria-label="Remove trunk"
                  onClick={() => setTrunks(chosen.filter((x) => x !== id))}
                >
                  ✕
                </Button>
              </li>
            ))}
          </ol>
          {trunks.some((t) => !chosen.includes(t.id)) && (
            <select
              aria-label="Add a trunk"
              value=""
              onChange={(e) => e.target.value && setTrunks([...chosen, e.target.value])}
              className={inputClass}
            >
              <option value="">Add a trunk…</option>
              {trunks
                .filter((t) => !chosen.includes(t.id))
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
            </select>
          )}
          {errors.trunkIds && (
            <p className="text-xs text-red-600 dark:text-red-400">{errors.trunkIds.message}</p>
          )}
        </fieldset>

        <Field
          label="Caller ID"
          hint="Overrides the caller's own outbound caller ID for calls through this rule."
        >
          {(a) => (
            <select {...a} {...form.register('callerIdDidId')} className={inputClass}>
              <option value="">The caller's own (default)</option>
              {dids.data?.map((d) => (
                <option key={d.id} value={d.id}>
                  {formatNumber(d.number)}
                  {d.label ? ` (${d.label})` : ''}
                </option>
              ))}
            </select>
          )}
        </Field>
      </form>
    </Dialog>
  );
}
