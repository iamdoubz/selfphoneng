// SPDX-License-Identifier: AGPL-3.0-or-later
// <option>s for a music-on-hold <select>: the built-in default, then the classes made on Sounds &
// music. `current` is always offered, so a saved value shows before the list loads.
import { useQuery } from '@tanstack/react-query';
import { mohApi } from '../api/client.ts';

export function MohOptions({ current }: { current: string }) {
  const classes = useQuery({ queryKey: ['moh-classes'], queryFn: mohApi.list });
  const names = [...new Set(['default', current, ...(classes.data?.map((c) => c.name) ?? [])])];
  return names.map((n) => (
    <option key={n} value={n}>
      {n === 'default' ? 'Default music' : n}
    </option>
  ));
}
