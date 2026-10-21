// SPDX-License-Identifier: AGPL-3.0-or-later
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertLocalUrl, chat, silentWav, speak, testEndpoint, transcribe } from './client.ts';

describe('assertLocalUrl', () => {
  it.each([
    'http://127.0.0.1:11434/v1',
    'http://localhost:8000/v1',
    'https://192.168.1.50/v1',
    'http://10.0.0.5:8000',
    'http://172.20.0.1:8000',
    'http://[::1]:8000/v1',
    'http://[fd00::5]/v1',
  ])('%s is local', (u) => expect(() => assertLocalUrl(u)).not.toThrow());

  it.each([
    ['http://api.openai.com/v1', /use an IP address/],
    ['http://ollama.lan:11434', /use an IP address/],
    ['http://8.8.8.8/v1', /not on this server or the local network/],
    ['http://100.64.1.2/v1', /not on this server/], // CGNAT / Tailscale: may cross the internet
    ['http://172.32.0.1/v1', /not on this server/],
    ['ftp://127.0.0.1/', /only http/],
    ['nonsense', /not an address/],
  ])('%s is refused', (u, msg) => expect(() => assertLocalUrl(u)).toThrow(msg));
});

describe('OpenAI-style calls', () => {
  let server: Server;
  let base: string;
  const seen: { path: string; type: string; body: string }[] = [];
  const read = (req: IncomingMessage) =>
    new Promise<string>((r) => {
      let b = '';
      req.setEncoding('latin1').on('data', (c: string) => (b += c));
      req.on('end', () => r(b));
    });

  beforeAll(async () => {
    server = createServer((req, res) => {
      void read(req).then((body) => {
        seen.push({ path: req.url!, type: req.headers['content-type'] ?? '', body });
        if (req.url === '/v1/audio/transcriptions') return res.end('{"text":"  Call me back. "}');
        if (req.url === '/v1/audio/speech') return res.end(silentWav());
        if (req.url === '/v1/chat/completions')
          return res.end(
            JSON.stringify({
              choices: [{ message: { content: '<think>\nhm\n</think>\n\n OK ' } }],
            }),
          );
        res.writeHead(404).end('model "nope" not found');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });
  afterAll(() => server.close());

  it('transcribe: multipart with the file and model, the text trimmed', async () => {
    expect(await transcribe({ url: base, model: 'whisper' }, silentWav())).toBe('Call me back.');
    const r = seen.at(-1)!;
    expect(r.type).toMatch(/^multipart\/form-data; boundary=/);
    expect(r.body).toContain('name="model"\r\n\r\nwhisper');
    expect(r.body).toContain('filename="audio.wav"');
    expect(r.body).toContain('RIFF');
  });

  it('speak: JSON in, WAV out; chat: the answer', async () => {
    const wav = await speak({ url: `${base}/`, model: 'kokoro', voice: 'af_heart' }, 'Hi');
    expect(wav.subarray(0, 4).toString()).toBe('RIFF');
    expect(JSON.parse(seen.at(-1)!.body)).toEqual({
      model: 'kokoro',
      voice: 'af_heart',
      input: 'Hi',
      response_format: 'wav',
    });
    expect(await chat({ url: base, model: 'm' }, [{ role: 'user', content: 'x' }])).toBe('OK');
  });

  it('errors say what went wrong; tests report them', async () => {
    await expect(transcribe({ url: `${base}/wrong`, model: 'm' }, silentWav())).rejects.toThrow(
      /wrong\/audio\/transcriptions: HTTP 404: model "nope" not found/,
    );
    await expect(
      transcribe({ url: 'http://127.0.0.1:1/v1', model: 'm' }, silentWav()),
    ).rejects.toThrow(/Can't reach 127.0.0.1:1/);
    expect(await testEndpoint('stt', { url: 'http://8.8.8.8/v1', model: 'm' })).toEqual({
      ok: false,
      error: '8.8.8.8 is not on this server or the local network',
    });
    const tts = await testEndpoint('tts', { url: base, model: 'k', voice: 'v' });
    expect(tts).toMatchObject({
      ok: true,
      audio: expect.stringMatching(/^data:audio\/wav;base64,UklG/),
    });
  });
});
