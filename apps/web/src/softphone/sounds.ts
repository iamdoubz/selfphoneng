// SPDX-License-Identifier: AGPL-3.0-or-later
// Ringtone and beep made with WebAudio (US ring: 440 + 480 Hz, 2 s on, 4 s off).
// ponytail: synthesized instead of the ringtone.mp3 in 05 §5.2, so there's no file or license.

let ctx: AudioContext | null = null;
let ringing: ReturnType<typeof setInterval> | undefined;

function tone(freqs: number[], seconds: number, volume: number) {
  ctx ??= new AudioContext();
  const gain = ctx.createGain();
  gain.gain.value = volume;
  gain.connect(ctx.destination);
  for (const f of freqs) {
    const o = ctx.createOscillator();
    o.frequency.value = f;
    o.connect(gain);
    o.start();
    o.stop(ctx.currentTime + seconds);
  }
}

export function startRinging() {
  if (ringing) return;
  tone([440, 480], 2, 0.15);
  ringing = setInterval(() => tone([440, 480], 2, 0.15), 6000);
}

export function stopRinging() {
  clearInterval(ringing);
  ringing = undefined;
}

export function beep(): Promise<void> {
  tone([1000], 0.2, 0.2);
  return new Promise((r) => setTimeout(r, 300));
}
