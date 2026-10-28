// SPDX-License-Identifier: AGPL-3.0-or-later
// Blocked numbers (05 §2): calls from these numbers are rejected before anything rings.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { formatNumber } from '@selfphoneng/shared';
import { blockedApi } from '../../api/client.ts';
import { Alert, Button, Field, inputClass } from '../../components/ui.tsx';

export function BlockedPage() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['blocked'], queryFn: blockedApi.list });
  const refresh = () => qc.invalidateQueries({ queryKey: ['blocked'] });
  const [number, setNumber] = useState('');
  const [reason, setReason] = useState('');
  const add = useMutation({
    mutationFn: () => blockedApi.create({ number, reason: reason.trim() || null }),
    onSuccess: async () => {
      setNumber('');
      setReason('');
      await refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => blockedApi.remove(id),
    onSuccess: refresh,
  });

  return (
    <section className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">Blocked numbers</h1>
      <p className="text-sm text-muted">
        Calls from these numbers are rejected before any phone rings. Emergency calls you make are
        never affected.
      </p>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate();
        }}
      >
        <Field label="Number to block">
          {(p) => (
            <input
              {...p}
              className={inputClass}
              inputMode="tel"
              placeholder="(312) 555-1234"
              value={number}
              onChange={(e) => setNumber(e.target.value)}
            />
          )}
        </Field>
        <Field label="Note (optional)">
          {(p) => (
            <input
              {...p}
              className={inputClass}
              placeholder="Robocaller"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          )}
        </Field>
        <Button type="submit" variant="primary" disabled={!number.trim() || add.isPending}>
          Block
        </Button>
      </form>
      {(add.error ?? remove.error) && <Alert>{(add.error ?? remove.error)!.message}</Alert>}
      {list.data?.length === 0 && <p className="text-sm text-muted">Nobody is blocked.</p>}
      {list.data && list.data.length > 0 && (
        <ul className="divide-y divide-line rounded-xl border border-line bg-surface shadow-sm">
          {list.data.map((b) => (
            <li key={b.id} className="flex flex-wrap items-center gap-x-3 px-3 py-2 text-sm">
              <span className="font-mono">{formatNumber(b.number)}</span>
              <span className="flex-1 text-muted">{b.reason}</span>
              <Button
                variant="ghost"
                aria-label={`Unblock ${formatNumber(b.number)}`}
                onClick={() => remove.mutate(b.id)}
              >
                Unblock
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
