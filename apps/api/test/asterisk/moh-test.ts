// SPDX-License-Identifier: AGPL-3.0-or-later
// Music on hold order (owner, 2026-10-21, 03 §8): a class plays its files in the order set in the
// UI, and a shuffled one doesn't. Asterisk plays each class to an echo test while
// res_musiconhold's debug log says which file it opens, in what order.
// Usage: node --conditions=source apps/api/test/asterisk/moh-test.ts   (ASTERISK_IMAGE)
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SettingsSchemas, type SettingKey } from '@selfphoneng/shared';
import { GENERATED_FILES, render } from '../../src/generator/index.ts';
import type { Snapshot } from '../../src/generator/load.ts';

const IMAGE = process.env.ASTERISK_IMAGE ?? 'selfphoneng-asterisk';
const AST = 'sp-test-moh';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const docker = (...args: string[]) => {
  const r = spawnSync('docker', args, { encoding: 'utf8' });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};
const cli = (cmd: string) => docker('exec', AST, 'asterisk', '-rx', cmd).out;
const log = (...a: unknown[]) => console.log('[moh-test]', ...a);

// The play order set in the UI: not the ids' sort order, so a sorted folder wouldn't pass.
const ORDER = [
  'c0000000-0000-4000-8000-000000000003',
  'a0000000-0000-4000-8000-000000000001',
  'b0000000-0000-4000-8000-000000000002',
];
const SHUF = [
  'd0000000-0000-4000-8000-000000000004',
  'e0000000-0000-4000-8000-000000000005',
  'f0000000-0000-4000-8000-000000000006',
];

function snapshot(): Snapshot {
  const settings = Object.fromEntries(
    (Object.keys(SettingsSchemas) as SettingKey[])
      .filter((k) => k !== 'sms.webhookToken')
      .map((k) => [k, SettingsSchemas[k].parse(undefined)]),
  ) as Snapshot['settings'];
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
    mohClasses: [
      { name: 'order-test', shuffle: false, files: ORDER },
      { name: 'shuffle-test', shuffle: true, files: SHUF },
    ],
  };
}

/** The files `cls` opened, in order, from the debug log (ids only). */
const opened = (debug: string, cls: string) =>
  [
    ...debug.matchAll(
      new RegExp(`Opened file \\d+ '/var/lib/asterisk/moh/${cls}/([0-9a-f-]+)'`, 'g'),
    ),
  ].map((m) => m[1]!);

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'sp-moh-'));
  const conf = join(dir, 'conf');
  const moh = join(dir, 'moh');
  mkdirSync(conf);
  for (const c of ['order-test', 'shuffle-test']) mkdirSync(join(moh, c), { recursive: true });
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
      'AMI_SECRET=moh-test-secret',
      '-v',
      `${conf}:/etc/asterisk/selfphoneng`,
      '-v',
      `${moh}:/var/lib/asterisk/moh`,
      IMAGE,
    );
    if (!run.ok) throw new Error(`asterisk: ${run.out}`);
    for (
      let i = 0;
      i < 60 && !docker('exec', AST, 'asterisk', '-rx', 'core waitfullybooted').ok;
      i++
    )
      await sleep(500);
    // Short recordings (spoken digits) so each class goes through its list in a few seconds.
    const copies = [...ORDER, ...SHUF]
      .map(
        (id, i) =>
          `cp /var/lib/asterisk/sounds/en/digits/${i + 1}.wav /var/lib/asterisk/moh/${ORDER.includes(id) ? 'order-test' : 'shuffle-test'}/${id}.wav`,
      )
      .join(' && ');
    const cp = docker('exec', AST, 'sh', '-c', copies);
    if (!cp.ok) throw new Error(`copying sounds: ${cp.out}`);
    cli('moh reload');
    cli('logger add channel moh-debug.log debug');
    cli('core set debug 1 res_musiconhold.so');

    for (const cls of ['order-test', 'shuffle-test']) {
      cli(`channel originate Local/*43@sp-featurecodes application MusicOnHold ${cls},6`);
      await sleep(7000);
    }
    const debug = docker('exec', AST, 'cat', '/var/log/asterisk/moh-debug.log').out;
    const inOrder = opened(debug, 'order-test');
    log(`order-test played: ${inOrder.map((id) => id[0]).join(' ')}`);
    const want = Array.from({ length: inOrder.length }, (_, i) => ORDER[i % ORDER.length]);
    if (inOrder.length < 4 || inOrder.join() !== want.join())
      problems.push(`order-test didn't play c a b c…: ${inOrder.join(', ') || 'nothing'}`);
    const shuffled = opened(debug, 'shuffle-test');
    log(`shuffle-test played: ${shuffled.map((id) => id[0]).join(' ')}`);
    const cyclic = Array.from({ length: shuffled.length }, (_, i) => SHUF[i % SHUF.length]);
    if (shuffled.length < 4 || shuffled.join() === cyclic.join())
      problems.push(`shuffle-test played in list order: ${shuffled.join(', ') || 'nothing'}`);
  } catch (e) {
    problems.push((e as Error).message);
  } finally {
    docker('rm', '-f', AST);
    rmSync(dir, { recursive: true, force: true });
  }
  if (problems.length) {
    console.log('FAIL music on hold');
    for (const p of problems) console.log(`     ${p}`);
    process.exit(1);
  }
  console.log('ok   music on hold (in the order set, and shuffled)');
}

await main();
