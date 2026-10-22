// SPDX-License-Identifier: AGPL-3.0-or-later
// Call transcripts (spec 10 §3): with ai.callTranscripts on, sp-sub-record writes the mixed
// recording plus <call>-in.wav (what the caller said) and <call>-out.wav (what they heard). A Local
// channel records itself through sp-sub-record and dials one that answers and stays silent; the
// other half plays digits as "the caller". So -in must have sound and -out (nearly) none.
// Usage: node --conditions=source apps/api/test/asterisk/rec-test.ts   (ASTERISK_IMAGE)
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SettingsSchemas, type SettingKey } from '@selfphoneng/shared';
import { GENERATED_FILES, render } from '../../src/generator/index.ts';
import type { Snapshot } from '../../src/generator/load.ts';

const IMAGE = process.env.ASTERISK_IMAGE ?? 'selfphoneng-asterisk';
const AST = 'sp-test-rec';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const docker = (...args: string[]) => {
  const r = spawnSync('docker', args, { encoding: 'utf8' });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};
const cli = (cmd: string) => docker('exec', AST, 'asterisk', '-rx', cmd).out;
const log = (...a: unknown[]) => console.log('[rec-test]', ...a);

function snapshot(): Snapshot {
  const settings = Object.fromEntries(
    (Object.keys(SettingsSchemas) as SettingKey[])
      .filter((k) => k !== 'sms.webhookToken')
      .map((k) => [k, SettingsSchemas[k].parse(undefined)]),
  ) as Snapshot['settings'];
  settings['ai.callTranscripts'] = true;
  settings['ai.stt'] = { url: 'http://127.0.0.1:8000/v1', model: 'whisper' };
  return {
    today: '2026-10-21',
    settings,
    dids: [],
    trunks: [],
    routes: [],
    ringGroups: [],
    queues: [],
    conferences: [],
    pagingGroups: [],
    ivrs: [],
    timeConditions: [],
    holidays: [],
    announcements: [],
    recordingAnnouncement: null,
    extensions: [],
    mohClasses: [],
  };
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'sp-rec-'));
  const conf = join(dir, 'conf');
  mkdirSync(conf);
  const files = render(snapshot());
  for (const f of GENERATED_FILES) writeFileSync(join(conf, f), files[f]);
  const problems: string[] = [];
  try {
    docker('rm', '-f', AST);
    const run = docker(
      'run',
      '-d',
      '--rm',
      '--name',
      AST,
      '-e',
      'AMI_SECRET=rec-test-secret',
      '-v',
      `${conf}:/etc/asterisk/selfphoneng`,
      IMAGE,
    );
    if (!run.ok) throw new Error(`asterisk: ${run.out}`);
    for (
      let i = 0;
      i < 60 && !docker('exec', AST, 'asterisk', '-rx', 'core waitfullybooted').ok;
      i++
    )
      await sleep(500);
    log(
      cli('dialplan show sp-sub-record')
        .split('\n')
        .filter((l) => l.includes('MixMonitor'))
        .join(' | '),
    );
    for (const line of [
      'dialplan add extension rec,1,Gosub,"sp-sub-record,s,1" into sp-rectest',
      'dialplan add extension rec,2,Dial,"Local/play@sp-rectest/n" into sp-rectest',
      'dialplan add extension play,1,Answer, into sp-rectest',
      'dialplan add extension play,2,Wait,4 into sp-rectest',
    ])
      cli(line);
    cli('channel originate Local/rec@sp-rectest/n application Playback digits/1&digits/2&digits/3');
    await sleep(6000);
    const ls = docker(
      'exec',
      AST,
      'sh',
      '-c',
      'find /var/spool/asterisk/monitor -name "*.wav" -exec stat -c "%s %n" {} \\;',
    ).out.trim();
    log(ls.replaceAll('\n', ' | ') || 'no files');
    const sized = ls
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [size, name] = l.split(' ');
        return { size: Number(size), name: name! };
      });
    const mixed = sized.find((f) => /\/\d+\.\d+\.wav$/.test(f.name));
    if (!mixed) problems.push('no mixed recording');
    else {
      for (const side of ['-in.wav', '-out.wav']) {
        const f = sized.find((x) => x.name === mixed.name.replace(/\.wav$/, side));
        if (!f) problems.push(`no ${side} next to ${mixed.name}`);
        else if (f.size < 8000) problems.push(`${side} has no audio (${f.size} bytes)`);
      }
      // Each side on its own, the right way round: the caller's file has the digits, the silent
      // side's has nothing (a copy of the mix would have them too).
      const loud = (side: string) => {
        const wav = spawnSync('docker', ['exec', AST, 'cat', mixed.name.replace(/\.wav$/, side)])
          .stdout as Buffer;
        let sum = 0;
        for (let i = 44; i + 1 < wav.length; i += 2) sum += Math.abs(wav.readInt16LE(i));
        return Math.round(sum / ((wav.length - 44) / 2));
      };
      const [mix, caller, other] = [loud('.wav'), loud('-in.wav'), loud('-out.wav')];
      log(`average level: mix ${mix}, -in ${caller}, -out ${other}`);
      if (!(mix > 200 && caller > 200 && other < caller / 10))
        problems.push(
          `-in should be the caller (loud), -out the silent side: ${caller} / ${other}`,
        );
    }
  } catch (e) {
    problems.push((e as Error).message);
  } finally {
    docker('rm', '-f', AST);
    rmSync(dir, { recursive: true, force: true });
  }
  if (problems.length) {
    console.log('FAIL call recording sides');
    for (const p of problems) console.log(`     ${p}`);
    process.exit(1);
  }
  console.log('ok   call recording sides (mixed, -in and -out with audio)');
}

await main();
