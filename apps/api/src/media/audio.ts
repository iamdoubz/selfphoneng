// SPDX-License-Identifier: AGPL-3.0-or-later
// Audio uploads → what Asterisk plays (04 §6). ffmpeg is in the api image; spawned without a shell.
import { spawn } from 'node:child_process';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

export class AudioError extends Error {}

/**
 * Any audio ffmpeg reads (wav, mp3, ogg, opus, webm from MediaRecorder, m4a, flac) → 8 kHz mono
 * 16-bit PCM wav at `out`, loudness-normalized. Written next to `out` and renamed, so Asterisk
 * never plays a half-written file.
 */
export async function toPcmWav(input: Buffer, out: string): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'sp-audio-'));
  const src = join(dir, 'in'); // ffmpeg sniffs the format; m4a can't be read from a pipe
  try {
    await writeFile(src, input);
    // ponytail: longer files are cut at 15 minutes instead of rejected (04 §6 says max 15 min).
    const args = ['-nostdin', '-y', '-v', 'error', '-i', src, '-t', '900', '-vn', '-ac', '1'];
    args.push('-ar', '8000', '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-c:a', 'pcm_s16le');
    args.push('-f', 'wav', `${out}.tmp`);
    await new Promise<void>((resolve, reject) => {
      const p = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      p.stderr.on('data', (d: Buffer) => (err += d.toString()));
      p.on('error', reject);
      p.on('close', (code) => (code === 0 ? resolve() : reject(new AudioError(err.trim()))));
    });
    await rename(`${out}.tmp`, out);
  } catch (e) {
    await rm(`${out}.tmp`, { force: true });
    throw e instanceof AudioError ? e : new AudioError((e as Error).message);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
