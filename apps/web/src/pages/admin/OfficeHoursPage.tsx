// SPDX-License-Identifier: AGPL-3.0-or-later
// Office hours (05 §2, 03 §6.10): when calls go one way or another. A weekly grid (click and drag
// half hours), the exact ranges as a list, holidays, and force open / closed / automatic.
import { X } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  DAYS,
  rangesToSlots,
  slotsToRanges,
  SLOTS,
  TimeConditionCreateSchema,
  type Day,
  type Destination,
  type OpenRange,
  type OverrideState,
  type TimeConditionCreate,
  type TimeConditionDto,
} from '@selfphoneng/shared';
import { holidaysApi, settingsApi, timeConditionsApi } from '../../api/client.ts';
import { DestinationPicker } from '../../components/DestinationPicker.tsx';
import { ConfirmDialog, Dialog } from '../../components/Dialog.tsx';
import { Alert, Button, Field, inputClass } from '../../components/ui.tsx';

const DAY_NAME: Record<Day, string> = {
  mon: 'Mon',
  tue: 'Tue',
  wed: 'Wed',
  thu: 'Thu',
  fri: 'Fri',
  sat: 'Sat',
  sun: 'Sun',
};
const rangeText = (r: OpenRange) =>
  `${r.days.map((d) => DAY_NAME[d]).join(', ')} ${r.start}–${r.end === '24:00' ? 'midnight' : r.end}`;

export function OfficeHoursPage() {
  const [tab, setTab] = useState<'hours' | 'holidays'>('hours');
  const tabClass = (on: boolean) =>
    `rounded-md px-3 py-2 text-sm font-medium ${on ? 'bg-subtle' : 'hover:bg-subtle'}`;
  return (
    <section className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">Office hours</h1>
      <div role="tablist" className="flex gap-1 border-b border-line pb-2">
        <button
          role="tab"
          aria-selected={tab === 'hours'}
          className={tabClass(tab === 'hours')}
          onClick={() => setTab('hours')}
        >
          Office hours
        </button>
        <button
          role="tab"
          aria-selected={tab === 'holidays'}
          className={tabClass(tab === 'holidays')}
          onClick={() => setTab('holidays')}
        >
          Holidays
        </button>
      </div>
      {tab === 'hours' ? <HoursTab /> : <HolidaysTab />}
    </section>
  );
}

function StatusChip({ tc }: { tc: TimeConditionDto }) {
  const { now, reason } = tc.status;
  const look = {
    open: 'bg-green-100 text-green-900 dark:bg-green-900 dark:text-green-100',
    closed: 'bg-red-100 text-red-900 dark:bg-red-900 dark:text-red-100',
    holiday: 'bg-amber-100 text-amber-900 dark:bg-amber-900 dark:text-amber-100',
  }[now];
  const text = { open: 'Open now', closed: 'Closed now', holiday: 'Holiday today' }[now];
  return (
    <span role="status" className={`rounded-full px-3 py-1 text-sm font-semibold ${look}`}>
      {text}
      {reason === 'override' && ' (forced)'}
    </span>
  );
}

function HoursTab() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['time-conditions'], queryFn: timeConditionsApi.list });
  const [editing, setEditing] = useState<TimeConditionDto | 'new' | null>(null);
  const [deleting, setDeleting] = useState<TimeConditionDto | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['time-conditions'] });
  const override = useMutation({
    mutationFn: ({ id, state }: { id: string; state: OverrideState }) =>
      timeConditionsApi.override(id, state),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (id: string) => timeConditionsApi.remove(id),
    onSuccess: async () => {
      setDeleting(null);
      await refresh();
    },
  });

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Button variant="primary" onClick={() => setEditing('new')}>
          Add office hours
        </Button>
      </div>
      {list.isError && <Alert>{list.error.message}</Alert>}
      {override.error && <Alert>{override.error.message}</Alert>}
      {list.data?.length === 0 && (
        <p className="text-sm text-muted">
          No office hours yet. Set your opening hours, then point your phone number at them: callers
          go one way when you're open and another when you're closed.
        </p>
      )}
      {list.data?.map((tc) => (
        <article
          key={tc.id}
          aria-label={tc.name}
          className="flex flex-col gap-3 rounded-xl border border-line bg-surface shadow-sm p-4"
        >
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="flex-1 font-semibold">{tc.name}</h2>
            <StatusChip tc={tc} />
          </div>
          <p className="text-sm text-muted">
            {tc.openRanges.map(rangeText).join('; ') || 'Never open'} · {tc.timezone}
            {tc.useHolidays ? ' · closed on holidays' : ''}
            {tc.overrideDigit !== null &&
              ` · from an admin's phone: *31${tc.overrideDigit} open, *32${tc.overrideDigit} closed, *33${tc.overrideDigit} automatic`}
          </p>
          <div className="flex flex-wrap gap-2">
            {(['open', 'closed', 'auto'] as const).map((s) => {
              const active = s === 'auto' ? tc.overrideState === null : tc.overrideState === s;
              return (
                <Button
                  key={s}
                  aria-pressed={active}
                  variant={active ? 'primary' : 'secondary'}
                  disabled={override.isPending}
                  onClick={() => override.mutate({ id: tc.id, state: s })}
                >
                  {{ open: 'Force open', closed: 'Force closed', auto: 'Automatic' }[s]}
                </Button>
              );
            })}
            <span className="flex-1" />
            <Button onClick={() => setEditing(tc)}>Edit</Button>
            <Button variant="ghost" onClick={() => setDeleting(tc)}>
              Delete
            </Button>
          </div>
        </article>
      ))}
      {editing && (
        <HoursForm
          tc={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={refresh}
        />
      )}
      <ConfirmDialog
        open={deleting !== null}
        title="Delete office hours"
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
    </div>
  );
}

/** Click or drag across half-hour cells to paint them open or closed. Mouse and touch. */
function WeekGrid({
  ranges,
  onChange,
}: {
  ranges: OpenRange[];
  onChange: (r: OpenRange[]) => void;
}) {
  const slots = rangesToSlots(ranges);
  const [paint, setPaint] = useState<boolean | null>(null);
  const set = (d: Day, i: number, v: boolean) => {
    if (slots[d][i] === v) return;
    const next = { ...slots, [d]: slots[d].map((x, j) => (j === i ? v : x)) };
    onChange(slotsToRanges(next));
  };
  return (
    // The list below is the keyboard and screen reader way to edit the same hours.
    <div
      aria-hidden
      className="max-w-full overflow-x-auto select-none"
      onPointerUp={() => setPaint(null)}
      onPointerLeave={() => setPaint(null)}
    >
      <div className="grid w-max grid-cols-[2.5rem_repeat(48,0.75rem)] gap-px text-[10px] text-muted">
        <span />
        {Array.from({ length: SLOTS }, (_, i) => (
          <span key={i} className="text-center">
            {i % 4 === 0 ? i / 2 : ''}
          </span>
        ))}
        {DAYS.map((d) => (
          <div key={d} className="contents">
            <span className="pr-1 text-right text-xs leading-5">{DAY_NAME[d]}</span>
            {slots[d].map((on, i) => (
              <span
                key={i}
                data-cell={`${d}-${i}`}
                className={`h-5 cursor-pointer touch-none rounded-sm ${on ? 'bg-green-500' : 'bg-line'}`}
                onPointerDown={(e) => {
                  // Touch captures the pointer to this cell; let go so dragging paints the others.
                  const el = e.target as Element;
                  if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
                  setPaint(!on);
                  set(d, i, !on);
                }}
                onPointerEnter={() => paint !== null && set(d, i, paint)}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function RangeList({
  ranges,
  onChange,
}: {
  ranges: OpenRange[];
  onChange: (r: OpenRange[]) => void;
}) {
  const [days, setDays] = useState<Day[]>(['mon', 'tue', 'wed', 'thu', 'fri']);
  const [start, setStart] = useState('08:00');
  const [end, setEnd] = useState('17:00');
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col gap-1 text-sm">
        {ranges.map((r, i) => (
          <li key={i} className="flex items-center gap-2">
            <span className="flex-1">{rangeText(r)}</span>
            <Button
              variant="ghost"
              className="px-2 py-1"
              aria-label={`Remove ${rangeText(r)}`}
              onClick={() => onChange(ranges.filter((_, j) => j !== i))}
            >
              <X className="size-4" />
            </Button>
          </li>
        ))}
        {ranges.length === 0 && <li className="text-muted">No open hours: always closed.</li>}
      </ul>
      <fieldset className="flex min-w-0 flex-wrap items-end gap-2 rounded-md border border-line p-2">
        <legend className="px-1 text-xs text-muted">Add hours</legend>
        {DAYS.map((d) => (
          <label key={d} className="flex items-center gap-1 text-sm">
            <input
              type="checkbox"
              checked={days.includes(d)}
              onChange={(e) =>
                setDays((ds) =>
                  e.target.checked
                    ? DAYS.filter((x) => x === d || ds.includes(x))
                    : ds.filter((x) => x !== d),
                )
              }
            />
            {DAY_NAME[d]}
          </label>
        ))}
        <label className="flex w-32 flex-col text-xs">
          From
          <input
            type="time"
            className={inputClass}
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />
        </label>
        <label className="flex w-32 flex-col text-xs">
          Until
          <input
            type="time"
            className={inputClass}
            value={end}
            onChange={(e) => setEnd(e.target.value)}
          />
        </label>
        <Button
          onClick={() => {
            const until = end === '00:00' ? '24:00' : end;
            if (!days.length || !start || !until || start >= until) {
              setError(
                'Pick days, and an end after the start (add two ranges to go past midnight)',
              );
              return;
            }
            setError(null);
            onChange([...ranges, { days, start, end: until }]);
          }}
        >
          Add
        </Button>
        {error && <p className="w-full text-xs text-red-600 dark:text-red-400">{error}</p>}
      </fieldset>
    </div>
  );
}

function HoursForm({
  tc,
  onClose,
  onSaved,
}: {
  tc: TimeConditionDto | null;
  onClose: () => void;
  onSaved: () => Promise<unknown>;
}) {
  const settings = useQuery({ queryKey: ['settings'], queryFn: settingsApi.get, enabled: !tc });
  const zones = Intl.supportedValuesOf?.('timeZone') ?? [];
  const [name, setName] = useState(tc?.name ?? '');
  const [timezone, setTimezone] = useState(tc?.timezone ?? '');
  const [ranges, setRanges] = useState<OpenRange[]>(
    tc?.openRanges ?? [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '08:00', end: '17:00' }],
  );
  const [useHolidays, setUseHolidays] = useState(tc?.useHolidays ?? true);
  const [digit, setDigit] = useState<string>(tc?.overrideDigit ? String(tc.overrideDigit) : '');
  const [open, setOpen] = useState<Destination | null>(tc?.openDestination ?? { type: 'hangup' });
  const [closed, setClosed] = useState<Destination | null>(
    tc?.closedDestination ?? { type: 'hangup' },
  );
  const [holiday, setHoliday] = useState<Destination | null>(tc?.holidayDestination ?? null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const tz = timezone || (tc ? '' : (settings.data?.['general.timezone'] ?? ''));

  const save = useMutation({
    mutationFn: (body: TimeConditionCreate) =>
      tc ? timeConditionsApi.update(tc.id, body) : timeConditionsApi.create(body),
    onSuccess: async () => {
      await onSaved();
      onClose();
    },
  });
  function submit() {
    const parsed = TimeConditionCreateSchema.safeParse({
      name,
      timezone: tz || undefined,
      openRanges: ranges,
      useHolidays,
      overrideDigit: digit ? Number(digit) : null,
      openDestination: open ?? undefined,
      closedDestination: closed ?? undefined,
      holidayDestination: holiday,
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
      title={tc ? tc.name : 'New office hours'}
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
              placeholder="Business hours"
              onChange={(e) => setName(e.target.value)}
            />
          )}
        </Field>
        <Field label="Time zone" error={errors.timezone}>
          {(p) => (
            <>
              <input
                {...p}
                className={inputClass}
                list="tz-list"
                value={tz}
                onChange={(e) => setTimezone(e.target.value)}
              />
              <datalist id="tz-list">
                {zones.map((z) => (
                  <option key={z} value={z} />
                ))}
              </datalist>
            </>
          )}
        </Field>
        <fieldset className="flex min-w-0 flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">Open hours</legend>
          <p className="text-xs text-muted">Click or drag across the grid; green is open.</p>
          <WeekGrid ranges={ranges} onChange={setRanges} />
          {errors.openRanges && <Alert>{errors.openRanges}</Alert>}
          <RangeList ranges={ranges} onChange={setRanges} />
        </fieldset>
        <DestinationPicker
          label="When open"
          value={open ?? { type: 'hangup' }}
          onChange={setOpen}
          error={errors.openDestination}
          exclude={tc?.id}
        />
        <DestinationPicker
          label="When closed"
          value={closed ?? { type: 'hangup' }}
          onChange={setClosed}
          error={errors.closedDestination}
          exclude={tc?.id}
        />
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={useHolidays}
            onChange={(e) => setUseHolidays(e.target.checked)}
          />
          Closed on holidays (the Holidays tab)
        </label>
        {useHolidays && (
          <>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={holiday !== null}
                onChange={(e) => setHoliday(e.target.checked ? { type: 'hangup' } : null)}
              />
              Holidays go somewhere else than "When closed"
            </label>
            {holiday !== null && (
              <DestinationPicker
                label="On holidays"
                value={holiday}
                onChange={setHoliday}
                exclude={tc?.id}
              />
            )}
          </>
        )}
        <Field
          label="Phone override key"
          hint="An admin dials *31N to force open, *32N to force closed, *33N for automatic"
        >
          {(p) => (
            <select
              {...p}
              className={inputClass}
              value={digit}
              onChange={(e) => setDigit(e.target.value)}
            >
              <option value="">None</option>
              {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
                <option key={n} value={n}>
                  {n} (*31{n} / *32{n} / *33{n})
                </option>
              ))}
            </select>
          )}
        </Field>
        {save.error && <Alert>{save.error.message}</Alert>}
      </div>
    </Dialog>
  );
}

function HolidaysTab() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['holidays'], queryFn: holidaysApi.list });
  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ['holidays'] }),
      qc.invalidateQueries({ queryKey: ['time-conditions'] }),
    ]);
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState(thisYear);
  const [form, setForm] = useState({
    name: '',
    startDate: '',
    endDate: '',
    recurringYearly: false,
  });
  const add = useMutation({
    mutationFn: () => holidaysApi.create({ ...form, endDate: form.endDate || form.startDate }),
    onSuccess: async () => {
      setForm({ name: '', startDate: '', endDate: '', recurringYearly: false });
      await refresh();
    },
  });
  const importUs = useMutation({
    mutationFn: () => holidaysApi.importUsFederal(year),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (id: string) => holidaysApi.remove(id),
    onSuccess: refresh,
  });
  const fmt = (d: string) =>
    new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { dateStyle: 'medium' });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor="us-year">
          Year
        </label>
        <select
          id="us-year"
          className={`${inputClass} w-28`}
          value={year}
          onChange={(e) => setYear(Number(e.target.value))}
        >
          {[thisYear, thisYear + 1].map((y) => (
            <option key={y}>{y}</option>
          ))}
        </select>
        <Button onClick={() => importUs.mutate()} disabled={importUs.isPending}>
          Add US federal holidays for {year}
        </Button>
        {importUs.data && (
          <span role="status" className="text-sm text-muted">
            Added {importUs.data.added}.
          </span>
        )}
      </div>
      {list.data?.length === 0 && <p className="text-sm text-muted">No holidays yet.</p>}
      {list.data && list.data.length > 0 && (
        <ul className="divide-y divide-line rounded-xl border border-line bg-surface shadow-sm">
          {list.data.map((h) => (
            <li key={h.id} className="flex flex-wrap items-center gap-x-3 px-3 py-2 text-sm">
              <span className="flex-1 font-medium">{h.name}</span>
              <span className="text-muted">
                {fmt(h.startDate)}
                {h.endDate !== h.startDate && ` – ${fmt(h.endDate)}`}
                {h.recurringYearly && ' · every year'}
              </span>
              <Button
                variant="ghost"
                aria-label={`Remove ${h.name}`}
                onClick={() => remove.mutate(h.id)}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate();
        }}
      >
        <Field label="Holiday">
          {(p) => (
            <input
              {...p}
              className={inputClass}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          )}
        </Field>
        <Field label="From">
          {(p) => (
            <input
              {...p}
              type="date"
              className={inputClass}
              value={form.startDate}
              onChange={(e) => setForm({ ...form, startDate: e.target.value })}
            />
          )}
        </Field>
        <Field label="Until (optional)">
          {(p) => (
            <input
              {...p}
              type="date"
              className={inputClass}
              value={form.endDate}
              onChange={(e) => setForm({ ...form, endDate: e.target.value })}
            />
          )}
        </Field>
        <label className="flex items-center gap-2 pb-2 text-sm">
          <input
            type="checkbox"
            checked={form.recurringYearly}
            onChange={(e) => setForm({ ...form, recurringYearly: e.target.checked })}
          />
          Every year
        </label>
        <Button
          type="submit"
          variant="primary"
          disabled={!form.name || !form.startDate || add.isPending}
        >
          Add holiday
        </Button>
      </form>
      {(add.error ?? importUs.error ?? remove.error) && (
        <Alert>{(add.error ?? importUs.error ?? remove.error)!.message}</Alert>
      )}
    </div>
  );
}
