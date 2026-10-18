// SPDX-License-Identifier: AGPL-3.0-or-later
// "Where should the call go?" (05 §3): a type, then the target (or a number).
// Types join as their features land; M6-T6 finishes the list.
import { useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { normalizeNumber, type Destination } from '@selfphoneng/shared';
import { extensionsApi, ivrsApi, ringGroupsApi, timeConditionsApi } from '../api/client.ts';
import { inputClass } from './ui.tsx';

type IdKind = 'user' | 'voicemail' | 'ring_group' | 'ivr' | 'time_condition';
type Kind = IdKind | 'external' | 'hangup';

const KINDS: { kind: Kind; label: string }[] = [
  { kind: 'user', label: 'Ring a user' },
  { kind: 'voicemail', label: 'Voicemail of a user' },
  { kind: 'ring_group', label: 'Ring group' },
  { kind: 'ivr', label: 'Digital receptionist' },
  { kind: 'time_condition', label: 'Office hours' },
  { kind: 'external', label: 'Forward to an outside number' },
  { kind: 'hangup', label: 'Hang up' },
];
/** Names the second select for screen readers (and the e2e scripts). */
const TARGET_NOUN: Record<IdKind, string> = {
  user: 'user',
  voicemail: 'user',
  ring_group: 'ring group',
  ivr: 'digital receptionist',
  time_condition: 'office hours',
};
const isIdKind = (k: Kind): k is IdKind => k !== 'external' && k !== 'hangup';
/** Kinds whose targets are the same rows: switching between them keeps the pick. */
const family = (k: Kind) => (k === 'voicemail' ? 'user' : k);

export function DestinationPicker({
  label,
  value,
  onChange,
  error,
  exclude,
}: {
  label: string;
  value: Destination;
  onChange: (d: Destination | null) => void; // null = incomplete (e.g. half-typed number)
  error?: string;
  /** The id of the thing being edited, so it can't send calls to itself. */
  exclude?: string;
}) {
  const id = useId();
  const [kind, setKind] = useState<Kind>(value.type as Kind);
  const [number, setNumber] = useState(value.type === 'external' ? value.number : '');
  const [numberError, setNumberError] = useState<string>();
  const targetId = 'id' in value ? value.id : '';

  const all = useTargets();
  const targets = (k: IdKind) => (all[k] ?? []).filter((t) => t.id !== exclude);

  function pickKind(k: Kind) {
    setKind(k);
    if (k === 'hangup') onChange({ type: 'hangup' });
    else if (k === 'external') typed(number);
    else if (targetId && family(k) === family(kind)) onChange({ type: k, id: targetId });
    else onChange(null); // the admin picks the target: never guess
  }

  function typed(v: string) {
    setNumber(v);
    try {
      onChange({ type: 'external', number: normalizeNumber(v) });
      setNumberError(undefined);
    } catch {
      onChange(null);
      setNumberError(v ? 'A phone number like (312) 555-1234' : undefined);
    }
  }

  const what = KINDS.find((k) => k.kind === kind)?.label.toLowerCase() ?? '';
  return (
    <fieldset className="flex flex-col gap-2" aria-describedby={error ? `${id}-err` : undefined}>
      <legend className="mb-1 text-sm font-medium">{label}</legend>
      <select
        aria-label={`${label}: type`}
        value={kind}
        onChange={(e) => pickKind(e.target.value as Kind)}
        className={inputClass}
      >
        {KINDS.map((k) => (
          <option key={k.kind} value={k.kind}>
            {k.label}
          </option>
        ))}
      </select>
      {isIdKind(kind) && (
        <select
          aria-label={`${label}: ${TARGET_NOUN[kind]}`}
          value={targetId}
          onChange={(e) => onChange({ type: kind, id: e.target.value })}
          className={inputClass}
        >
          {!targetId && <option value="">Pick one…</option>}
          {targets(kind).map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
      )}
      {kind === 'external' && (
        <input
          aria-label={`${label}: number`}
          value={number}
          onChange={(e) => typed(e.target.value)}
          inputMode="tel"
          placeholder="(312) 555-1234"
          aria-invalid={Boolean(numberError)}
          className={inputClass}
        />
      )}
      {(numberError || error) && (
        <p id={`${id}-err`} className="text-xs text-red-600 dark:text-red-400">
          {numberError ?? error}
        </p>
      )}
      {isIdKind(kind) && all[kind] && targets(kind).length === 0 && (
        <p className="text-xs text-zinc-500">Nothing to pick yet ({what}).</p>
      )}
    </fieldset>
  );
}

/** Everything a destination can point at, per kind, as {id, label} ("101 Dan Doe"). */
function useTargets() {
  const exts = useQuery({ queryKey: ['extensions'], queryFn: extensionsApi.list });
  const groups = useQuery({ queryKey: ['ring-groups'], queryFn: ringGroupsApi.list });
  const ivrs = useQuery({ queryKey: ['ivrs'], queryFn: ivrsApi.list });
  const tcs = useQuery({ queryKey: ['time-conditions'], queryFn: timeConditionsApi.list });
  const rows = (q: { data?: { id: string; name: string; number?: string }[] }) =>
    q.data?.map((x) => ({ id: x.id, label: x.number ? `${x.number} ${x.name}` : x.name }));
  return {
    user: rows(exts),
    voicemail: rows(exts),
    ring_group: rows(groups),
    ivr: rows(ivrs),
    time_condition: rows(tcs),
  } satisfies Record<IdKind, unknown>;
}

/** Client-side "Ring a user: 101 Dan Doe" for destinations not saved yet (the API has its own). */
export function useDescribeDestination() {
  const targets = useTargets();
  return (d: Destination): string => {
    if (d.type === 'hangup') return 'Hang up';
    if (d.type === 'external') return `Call ${d.number}`;
    const what = KINDS.find((k) => k.kind === d.type)?.label ?? d.type;
    const t = targets[d.type as IdKind]?.find((x) => x.id === d.id);
    return t ? `${what}: ${t.label}` : what;
  };
}
