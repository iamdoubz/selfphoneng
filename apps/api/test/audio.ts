// SPDX-License-Identifier: AGPL-3.0-or-later
// Audio test helpers.
import { spawnSync } from 'node:child_process';

export const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

/** 8 kHz mono 16-bit silence as a wav file. */
export function silenceWav(seconds = 1) {
  const data = Buffer.alloc(8000 * 2 * seconds);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(8000, 24);
  h.writeUInt32LE(16000, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
