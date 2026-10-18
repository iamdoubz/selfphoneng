// SPDX-License-Identifier: AGPL-3.0-or-later
// baresip "desk phones" for the e2e scripts: one container, one baresip per phone.
// Each phone auto-answers (or not) and "talks" with a sine tone; its log shows MWI and DTMF.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const docker = (...a) => {
  const r = spawnSync('docker', a, { encoding: 'utf8' });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};

/**
 * phones: [{ ext, password, answer: 'auto' | 'manual', toneHz = 440 }]
 * Returns { log(ext) → text so far, stop() }.
 */
export function startPhones({ name, net, ast, phones }) {
  const dir = mkdtempSync(join(tmpdir(), `${name}-`));
  phones.forEach((p, i) => {
    const d = join(dir, p.ext);
    mkdirSync(d);
    writeFileSync(
      join(d, 'config'),
      [
        `sip_listen 0.0.0.0:${5080 + 2 * i}`,
        'module_path /usr/lib/baresip/modules',
        ...['g711', 'ausine', 'aufile', 'menu', 'account', 'mwi'].map((m) => `module ${m}.so`),
        `audio_source ausine,${p.toneHz ?? 440}`,
        'ausrc_srate 48000',
        'auplay_srate 48000',
        'audio_player aufile,/dev/null',
        'audio_alert aufile,/dev/null',
        `rtp_ports ${30000 + 100 * i}-${30099 + 100 * i}`,
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(d, 'accounts'),
      `<sip:${p.ext}@${ast};transport=udp>;auth_pass=${p.password};answermode=${p.answer};audio_codecs=PCMU\n`,
    );
  });
  const run = phones.map((p) => `(baresip -f /phones/${p.ext} > /phones/${p.ext}/log 2>&1 &)`);
  docker('rm', '-f', name);
  const r = docker(
    'run',
    '-d',
    '--rm',
    '--name',
    name,
    '--network',
    net,
    '-v',
    `${dir}:/phones`,
    'debian:trixie-slim',
    'sh',
    '-c',
    `apt-get update -qq >/dev/null && apt-get install -y -qq --no-install-recommends baresip-core >/dev/null 2>&1 && ${run.join(' && ')} && sleep 3600`,
  );
  if (!r.ok) throw new Error(`phones: ${r.out}`);
  return {
    log: (ext) => {
      const f = join(dir, ext, 'log');
      return existsSync(f) ? readFileSync(f, 'utf8') : '';
    },
    stop: () => docker('rm', '-f', name),
  };
}
