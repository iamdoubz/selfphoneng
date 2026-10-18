// SPDX-License-Identifier: AGPL-3.0-or-later
// Audio uploads → what Asterisk plays (04 §6). ffmpeg is in the api image; spawned without a shell.
import { spawn } from 'node:child_process';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

export class AudioError extends Error {}

const LOUDNORM = 'loudnorm=I=-16:TP=-1.5:LRA=11';
const WAV = ['-ar', '8000', '-af', LOUDNORM, '-c:a', 'pcm_s16le', '-f', 'wav'];
/** The HD copy Asterisk picks for G.722 calls (same base name, .g722). */
const G722 = ['-ar', '16000', '-af', LOUDNORM, '-c:a', 'g722', '-f', 'g722'];

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d: Buffer) => (out += d.toString()));
    p.stderr.on('data', (d: Buffer) => (err += d.toString()));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new AudioError(err.trim()))));
  });
}

/**
 * Any audio ffmpeg reads (wav, mp3, ogg, opus, webm from MediaRecorder, m4a, flac) → each output,
 * mono and loudness-normalized. Outputs are written next to their final name and renamed, so
 * Asterisk never plays a half-written file.
 */
async function convert(input: Buffer, outputs: { path: string; format: string[] }[]) {
  const dir = await mkdtemp(join(tmpdir(), 'sp-audio-'));
  const src = join(dir, 'in'); // ffmpeg sniffs the format; m4a can't be read from a pipe
  try {
    await writeFile(src, input);
    // ponytail: longer files are cut at 15 minutes instead of rejected (04 §6 says max 15 min).
    const args = ['-nostdin', '-y', '-v', 'error', '-i', src, '-t', '900', '-vn'];
    for (const o of outputs) args.push('-ac', '1', ...o.format, `${o.path}.tmp`);
    await run('ffmpeg', args);
    for (const o of outputs) await rename(`${o.path}.tmp`, o.path);
  } catch (e) {
    for (const o of outputs) await rm(`${o.path}.tmp`, { force: true });
    throw e instanceof AudioError ? e : new AudioError((e as Error).message);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Voicemail greetings: 8 kHz PCM wav at `out`. */
export const toPcmWav = (input: Buffer, out: string) =>
  convert(input, [{ path: out, format: WAV }]);

/** Prompts: `<base>.wav` and `<base>.g722`; returns the length in ms. */
export async function toPrompt(input: Buffer, base: string): Promise<number> {
  await convert(input, [
    { path: `${base}.wav`, format: WAV },
    { path: `${base}.g722`, format: G722 },
  ]);
  return (await durationMs(`${base}.wav`)) ?? 0;
}

/** Length of an audio file in ms (ffprobe), or null if it can't be read. */
export async function durationMs(file: string): Promise<number | null> {
  const secs = await run('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'csv=p=0',
    file,
  ]).catch(() => '');
  const n = Number(secs.trim());
  return secs.trim() && Number.isFinite(n) ? Math.round(n * 1000) : null;
}
