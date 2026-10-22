// SPDX-License-Identifier: AGPL-3.0-or-later
// Local AI (spec 10): OpenAI-style APIs (Ollama, Speaches, llama.cpp, …) on this server or the
// local network. Nothing else is called: an address must be an IP on a local network or
// localhost, written as such, so no DNS answer can send audio or text anywhere else.
import { BlockList, isIP } from 'node:net';
import type { AiEndpoint, AiTestResult, AiTtsEndpoint } from '@selfphoneng/shared';

export class AiError extends Error {}

const LOCAL = new BlockList();
for (const [net, bits] of [
  ['127.0.0.0', 8],
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
] as const)
  LOCAL.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
] as const)
  LOCAL.addSubnet(net, bits, 'ipv6');

/** Throws unless `url` is http(s) to localhost or a local-network IP. */
export function assertLocalUrl(url: string): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new AiError(`${url} is not an address`);
  }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!/^https?:$/.test(u.protocol)) throw new AiError(`${url}: only http and https`);
  if (host === 'localhost') return;
  const v = isIP(host);
  if (!v)
    throw new AiError(
      `${host}: use an IP address (or localhost), so the address can't lead off this network`,
    );
  if (!LOCAL.check(host, v === 6 ? 'ipv6' : 'ipv4'))
    throw new AiError(`${host} is not on this server or the local network`);
}

async function call(
  base: string,
  path: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  assertLocalUrl(base);
  const url = new URL(path, base.endsWith('/') ? base : `${base}/`);
  let r: Response;
  try {
    r = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const e = err as Error & { cause?: { code?: string } };
    throw new AiError(
      e.name === 'TimeoutError'
        ? `${url.host} didn't answer within ${timeoutMs / 1000} s`
        : `Can't reach ${url.host}${e.cause?.code ? ` (${e.cause.code})` : ''}`,
    );
  }
  if (!r.ok) {
    const body = (await r.text().catch(() => '')).slice(0, 300);
    throw new AiError(`${url.pathname}: HTTP ${r.status}${body ? `: ${body}` : ''}`);
  }
  return r;
}

/** Speech to text: the words in a WAV (or any format the server reads). */
export async function transcribe(ep: AiEndpoint, audio: Buffer, timeoutMs = 180_000) {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(audio)], { type: 'audio/wav' }), 'audio.wav');
  form.append('model', ep.model);
  form.append('response_format', 'json');
  const r = await call(ep.url, 'audio/transcriptions', { method: 'POST', body: form }, timeoutMs);
  const { text } = (await r.json()) as { text?: unknown };
  if (typeof text !== 'string') throw new AiError('audio/transcriptions: no text in the answer');
  return text.trim();
}

/** Speech to text with timings (verbose_json): what was said, and from which second. */
export async function transcribeSegments(ep: AiEndpoint, audio: Buffer, timeoutMs = 600_000) {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(audio)], { type: 'audio/wav' }), 'audio.wav');
  form.append('model', ep.model);
  form.append('response_format', 'verbose_json');
  const r = await call(ep.url, 'audio/transcriptions', { method: 'POST', body: form }, timeoutMs);
  const j = (await r.json()) as {
    text?: unknown;
    segments?: { start?: unknown; text?: unknown }[];
  };
  // A server without segments: the whole text, from the start.
  const segs = Array.isArray(j.segments)
    ? j.segments.map((s) => ({ at: Number(s.start) || 0, text: String(s.text ?? '').trim() }))
    : [{ at: 0, text: typeof j.text === 'string' ? j.text.trim() : '' }];
  return segs.filter((s) => s.text);
}

/** Text to speech: a WAV. */
export async function speak(ep: AiTtsEndpoint, input: string, timeoutMs = 60_000) {
  const r = await call(
    ep.url,
    'audio/speech',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: ep.model, voice: ep.voice, input, response_format: 'wav' }),
    },
    timeoutMs,
  );
  return Buffer.from(await r.arrayBuffer());
}

/** One chat answer from the LLM. */
export async function chat(
  ep: AiEndpoint,
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[],
  opts: { maxTokens?: number; timeoutMs?: number } = {},
) {
  const r = await call(
    ep.url,
    'chat/completions',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: ep.model,
        messages,
        max_tokens: opts.maxTokens,
        stream: false,
      }),
    },
    opts.timeoutMs ?? 120_000,
  );
  const j = (await r.json()) as { choices?: { message?: { content?: unknown } }[] };
  const content = j.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new AiError('chat/completions: no answer');
  // Thinking models (Qwen3, …) may put their reasoning inline; only the answer is wanted.
  return content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

/** One second of 8 kHz silence: enough for a speech-to-text server to load its model and answer. */
export function silentWav(seconds = 1): Buffer {
  const n = 8000 * seconds;
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + n * 2, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); // PCM
  b.writeUInt16LE(1, 22); // mono
  b.writeUInt32LE(8000, 24);
  b.writeUInt32LE(16000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(n * 2, 40);
  return b;
}

/** Settings → AI → Test: a tiny real request. The first one may load a model, so it can be slow. */
export async function testEndpoint(
  kind: 'llm' | 'stt' | 'tts',
  ep: AiEndpoint | AiTtsEndpoint,
): Promise<AiTestResult> {
  const t0 = Date.now();
  try {
    if (kind === 'llm') {
      const a = await chat(ep, [{ role: 'user', content: 'Reply with just: OK' }], {
        maxTokens: 400, // room for a thinking model to think first
      });
      return { ok: true, ms: Date.now() - t0, detail: `Answered: ${a.slice(0, 80)}` };
    }
    if (kind === 'stt') {
      await transcribe(ep, silentWav());
      return { ok: true, ms: Date.now() - t0, detail: 'Transcribed a second of silence' };
    }
    if (!('voice' in ep)) throw new AiError('A voice is needed');
    const wav = await speak(ep, 'Hello, this is your phone system.');
    if (wav.length < 1000) throw new AiError('audio/speech: the audio is empty');
    return {
      ok: true,
      ms: Date.now() - t0,
      detail: `${Math.round(wav.length / 1024)} KB of audio`,
      audio: `data:audio/wav;base64,${wav.toString('base64')}`,
    };
  } catch (err) {
    return { ok: false, error: err instanceof AiError ? err.message : String(err) };
  }
}
