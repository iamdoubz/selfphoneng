// SPDX-License-Identifier: AGPL-3.0-or-later
// 05 §3: idle green, ringing amber pulsing, in use red, on hold blue, unavailable gray, DND purple.
import type { ExtensionLive } from '@selfphoneng/shared';

const LOOK: Record<string, { color: string; label: string }> = {
  idle: { color: 'bg-green-500', label: 'Available' },
  ringing: { color: 'bg-amber-400 animate-pulse', label: 'Ringing' },
  ringinuse: { color: 'bg-amber-400 animate-pulse', label: 'Ringing (on a call)' },
  inuse: { color: 'bg-red-500', label: 'On a call' },
  busy: { color: 'bg-red-500', label: 'Busy' },
  onhold: { color: 'bg-blue-500', label: 'On hold' },
  unavailable: { color: 'bg-zinc-400 dark:bg-zinc-600', label: 'Offline' },
  dnd: { color: 'bg-purple-500', label: 'Do not disturb' },
};

export function StatusDot({ ext }: { ext: ExtensionLive | undefined }) {
  const key = !ext ? 'unavailable' : ext.dnd && ext.state === 'idle' ? 'dnd' : ext.state;
  const { color, label } = LOOK[key] ?? LOOK.unavailable!;
  return (
    <span className="inline-flex items-center" title={label}>
      <span aria-hidden className={`inline-block size-2.5 rounded-full ${color}`} />
      <span className="sr-only">{label}</span>
    </span>
  );
}

export const statusLabel = (ext: ExtensionLive | undefined) =>
  !ext
    ? 'Offline'
    : ext.dnd && ext.state === 'idle'
      ? 'Do not disturb'
      : (LOOK[ext.state]?.label ?? ext.state);
