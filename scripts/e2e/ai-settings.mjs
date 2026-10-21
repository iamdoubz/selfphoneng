// SPDX-License-Identifier: AGPL-3.0-or-later
// Settings → AI (spec 10) in a browser, against a fake OpenAI-style server on 127.0.0.1:18001:
// Test for speech to text and text to speech (the voice plays), Save with voicemail transcripts on,
// and an address off the local network refused. Runs after m1-t4.mjs. Usage:
//   node scripts/e2e/ai-settings.mjs <baseUrl> <adminEmail> <adminPassword> <shotsDir>
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { launch } from './cdp.mjs';

const [base, email, pw, shotsDir] = process.argv.slice(2);
const wav = Buffer.alloc(44 + 16000);
wav.write('RIFF', 0);
wav.write('WAVEfmt ', 8);
const fake = createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    if (req.url === '/v1/audio/transcriptions') return res.end('{"text":""}');
    if (req.url === '/v1/audio/speech') return res.end(wav);
    res.writeHead(404).end('no such model');
  });
});
await new Promise((r) => fake.listen(18001, '127.0.0.1', r));
const AI = 'http://127.0.0.1:18001/v1';

const text = (s) => `document.body.innerText.includes(${JSON.stringify(s)})`;
const fillAria = (p, label, value) =>
  p.evaluate(`(() => {
    const el = document.querySelector('input[aria-label=${JSON.stringify(label)}]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);

const p = await launch({ shotsDir });
try {
  await p.goto(`${base}/login`);
  await p.waitFor(`!!document.querySelector('input[type=email]')`);
  await p.fill('Email', email);
  await p.fill('Password', pw);
  await p.click('Sign in');
  await p.waitFor(`location.pathname === '/admin'`, 'signed in');

  await p.goto(`${base}/admin/settings/ai`);
  await p.waitFor(text('Calls and text never go anywhere else'), 'AI tab');
  await fillAria(p, 'Speech to text address', AI);
  await fillAria(p, 'Speech to text model', 'Systran/faster-whisper-small');
  await p.click('Test', 'fieldset:nth-of-type(2)');
  await p.waitFor(text('Transcribed a second of silence'), 'STT test');
  await fillAria(p, 'Text to speech address', AI);
  await fillAria(p, 'Text to speech model', 'kokoro');
  await fillAria(p, 'Text to speech voice', 'af_heart');
  await p.click('Test', 'fieldset:nth-of-type(3)');
  await p.waitFor(`!!document.querySelector('audio[aria-label="Test voice"]')`, 'TTS test voice');
  await p.evaluate(
    `[...document.querySelectorAll('label')].find(l => l.textContent.startsWith('Voicemail transcripts')).querySelector('input').click()`,
  );
  await p.click('Save');
  await p.waitFor(text('Saved.'), 'saved');
  await p.shot('ai-01-settings');
  console.log('AI: speech to text and voice tested, saved with voicemail transcripts on');

  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'selfphoneng' },
    body: JSON.stringify({ email, password: pw }),
  });
  const cookie = login.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  const s = await (
    await fetch(`${base}/api/settings`, { headers: { cookie, 'x-requested-with': 'selfphoneng' } })
  ).json();
  assert.deepEqual(s['ai.stt'], { url: AI, model: 'Systran/faster-whisper-small' });
  assert.deepEqual(s['ai.tts'], { url: AI, model: 'kokoro', voice: 'af_heart' });
  assert.equal(s['ai.voicemailTranscripts'], true);
  assert.equal(s['ai.llm'], null);

  await fillAria(p, 'Language model address', 'http://8.8.8.8/v1');
  await fillAria(p, 'Language model model', 'qwen3:4b');
  await p.click('Save');
  await p.waitFor(text('8.8.8.8 is not on this server or the local network'), 'refused');
  await p.shot('ai-02-refused');
  console.log('AI: an address off the local network is refused');
} finally {
  await p.close();
  fake.close();
}
