// SPDX-License-Identifier: AGPL-3.0-or-later
// Asterisk load test (03 §12.3): boot the asterisk image with each golden case's generated files and
// fail if Asterisk logs ERROR while loading, or if an endpoint/context we generated is missing.
// Needs Docker and a built image (ASTERISK_IMAGE, default "selfphoneng-asterisk").
// Usage: pnpm test:asterisk [case ...]
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const GOLDEN = fileURLToPath(new URL('../../src/generator/__golden__', import.meta.url));
const IMAGE = process.env.ASTERISK_IMAGE ?? 'selfphoneng-asterisk';
const NAME = `sp-golden-${process.pid}`;

const docker = (...args) => {
  const r = spawnSync('docker', args, { encoding: 'utf8' });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};
const cli = (cmd) => docker('exec', NAME, 'asterisk', '-rx', cmd);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** What the generated files promise Asterisk will have. */
function expectations(dir) {
  const pjsip = readFileSync(join(dir, 'pjsip_selfphoneng.conf'), 'utf8');
  const endpoints = [...pjsip.matchAll(/^\[([^\]]+)\]\ntype = endpoint$/gm)].map((m) => m[1]);
  const ext = readFileSync(join(dir, 'extensions_selfphoneng.conf'), 'utf8');
  const contexts = [...ext.matchAll(/^\[([^\]]+)\]$/gm)].map((m) => m[1]);
  const vm = readFileSync(join(dir, 'voicemail_selfphoneng.conf'), 'utf8');
  const mailboxes = [...vm.matchAll(/^(\d+) =>/gm)].map((m) => m[1]);
  // queue number → how many agents it lists
  const queues = readFileSync(join(dir, 'queues_selfphoneng.conf'), 'utf8')
    .split(/^\[/m)
    .slice(1)
    .map((sec) => [sec.slice(0, sec.indexOf(']')), (sec.match(/^member =>/gm) ?? []).length]);
  return { endpoints, contexts, mailboxes, queues };
}

async function check(name) {
  const tmp = mkdtempSync(join(tmpdir(), `sp-golden-${name}-`));
  cpSync(join(GOLDEN, name, 'expected'), tmp, { recursive: true });
  const problems = [];
  // The api makes each MOH class's folder when the class is created (routes/moh.ts); do the same.
  const moh = mkdtempSync(join(tmpdir(), `sp-golden-moh-`));
  const mohConf = readFileSync(join(tmp, 'musiconhold_selfphoneng.conf'), 'utf8');
  for (const [, d] of mohConf.matchAll(/^directory = \/var\/lib\/asterisk\/moh\/(.+)$/gm))
    mkdirSync(join(moh, d));
  const run = docker(
    'run',
    '-d',
    '--rm',
    '--name',
    NAME,
    '-e',
    'AMI_SECRET=golden-test-secret',
    '-v',
    `${tmp}:/etc/asterisk/selfphoneng`,
    '-v',
    `${moh}:/var/lib/asterisk/moh`,
    IMAGE,
  );
  if (!run.ok) throw new Error(`docker run failed: ${run.out}`);
  try {
    let booted = false;
    for (let i = 0; i < 60 && !booted; i++) {
      await sleep(500);
      booted = cli('core waitfullybooted').ok;
    }
    if (!booted) problems.push('Asterisk did not finish booting');
    await sleep(500);

    const { endpoints, contexts, mailboxes, queues } = expectations(tmp);
    const shown = cli('pjsip show endpoints').out;
    for (const e of endpoints)
      if (!new RegExp(`Endpoint:\\s+${e}[\\s/]`).test(shown))
        problems.push(`endpoint ${e} not loaded`);
    for (const c of contexts) {
      const d = cli(`dialplan show ${c}`).out;
      if (!d.includes(`'${c}'`)) problems.push(`context ${c} not loaded`);
    }
    const users = cli('voicemail show users').out;
    for (const m of mailboxes)
      if (!new RegExp(`^default\\s+${m}\\s`, 'm').test(users))
        problems.push(`mailbox ${m} not loaded`);
    for (const [q, members] of queues) {
      const shownQ = cli(`queue show ${q}`).out;
      const listed = (shownQ.match(/Local\/\d+@sp-queue-member/g) ?? []).length;
      if (!shownQ.startsWith(`${q} has`) || listed !== members)
        problems.push(`queue ${q}: expected ${members} members, got: ${shownQ.trim()}`);
    }
    // Asterisk colors its log: strip the escape codes before looking for ERROR[.
    // eslint-disable-next-line no-control-regex -- matching ANSI escapes is the point
    const log = docker('logs', NAME).out.replace(/\x1b\[[0-9;]*m/g, '');
    const errors = log.split('\n').filter((l) => /ERROR\[/.test(l));
    problems.push(...errors.map((l) => `log: ${l.trim()}`));
    return { name, problems, endpoints: endpoints.length, contexts: contexts.length };
  } finally {
    docker('rm', '-f', NAME);
    rmSync(tmp, { recursive: true, force: true });
    rmSync(moh, { recursive: true, force: true });
  }
}

const cases = process.argv.slice(2).length
  ? process.argv.slice(2)
  : readdirSync(GOLDEN).filter((d) => existsSync(join(GOLDEN, d, 'expected')));
let failed = 0;
for (const c of cases) {
  const r = await check(c);
  const status = r.problems.length ? 'FAIL' : 'ok  ';
  console.log(`${status} ${c} (${r.endpoints} endpoints, ${r.contexts} contexts)`);
  for (const p of r.problems) console.log(`     ${p}`);
  if (r.problems.length) failed++;
}
process.exit(failed ? 1 : 0);
