// SPDX-License-Identifier: AGPL-3.0-or-later
// "Where should the call go?" (05 §3). M3: a user, an outside number, or hang up. Voicemail (M4),
// ring groups, queues, IVRs, office hours, conferences and announcements join later (M6-T6).
import { useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { normalizeNumber, type Destination } from '@selfphoneng/shared';
import { extensionsApi } from '../api/client.ts';
import { inputClass } from './ui.tsx';

type Kind = 'user' | 'voicemail' | 'external' | 'hangup';

export function DestinationPicker({
  label,
  value,
  onChange,
  error,
}: {
  label: string;
  value: Destination;
  onChange: (d: Destination | null) => void; // null = incomplete (e.g. half-typed number)
  error?: string;
}) {
  const id = useId();
  const exts = useQuery({ queryKey: ['extensions'], queryFn: extensionsApi.list });
  const [kind, setKind] = useState<Kind>(value.type as Kind);
  const [number, setNumber] = useState(value.type === 'external' ? value.number : '');
  const [numberError, setNumberError] = useState<string>();
  const extId = value.type === 'user' || value.type === 'voicemail' ? value.id : '';

  function pickKind(k: Kind) {
    setKind(k);
    if (k === 'hangup') onChange({ type: 'hangup' });
    else if (k === 'external') typed(number);
    else if (extId) onChange({ type: k, id: extId });
    else onChange(null); // the admin picks the user: never guess
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

  return (
    <fieldset className="flex flex-col gap-2" aria-describedby={error ? `${id}-err` : undefined}>
      <legend className="mb-1 text-sm font-medium">{label}</legend>
      <select
        aria-label={`${label}: type`}
        value={kind}
        onChange={(e) => pickKind(e.target.value as Kind)}
        className={inputClass}
      >
        <option value="user">Ring a user</option>
        <option value="external">Forward to an outside number</option>
        <option value="hangup">Hang up</option>
      </select>
      {(kind === 'user' || kind === 'voicemail') && (
        <select
          aria-label={`${label}: user`}
          value={extId}
          onChange={(e) => onChange({ type: kind, id: e.target.value })}
          className={inputClass}
        >
          {!extId && <option value="">Pick a user…</option>}
          {exts.data?.map((x) => (
            <option key={x.id} value={x.id}>
              {x.number} {x.name}
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
      {exts.data?.length === 0 && (kind === 'user' || kind === 'voicemail') && (
        <p className="text-xs text-zinc-500">No users with an extension yet.</p>
      )}
    </fieldset>
  );
}
