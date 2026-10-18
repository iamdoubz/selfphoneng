// SPDX-License-Identifier: AGPL-3.0-or-later
// One tab only (05 §5.2): the tab holding the Web Lock registers. "Use here" asks the holder,
// over a BroadcastChannel, to stop and let go; the asking tab then gets the lock.

const NAME = 'selfphoneng-softphone';
const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(NAME);
let release: (() => void) | null = null;

/** Holds the lock until stepDown(); resolves once it's ours. */
function hold(resolve: () => void) {
  return () => {
    resolve();
    return new Promise<void>((r) => (release = r));
  };
}

/** True if this tab is (now) the softphone tab; false if another tab has it. */
export async function tryLead(): Promise<boolean> {
  if (release) return true;
  if (!navigator.locks) return true; // very old browser: no coordination
  return new Promise((resolve) => {
    void navigator.locks.request(NAME, { ifAvailable: true }, (lock) =>
      lock ? hold(() => resolve(true))() : resolve(false),
    );
  });
}

/** "Use here": the other tab stops, then this one leads. */
export async function takeOver(): Promise<void> {
  if (release || !navigator.locks) return;
  channel?.postMessage('take');
  await new Promise<void>((resolve) => void navigator.locks.request(NAME, hold(resolve)));
}

export function stepDown() {
  release?.();
  release = null;
}

/** Runs when another tab takes over; the lock is released after `stop` finishes. */
export function onTakeOver(stop: () => Promise<void>) {
  channel?.addEventListener('message', (e) => {
    if (e.data !== 'take' || !release) return;
    void stop().finally(stepDown);
  });
}
