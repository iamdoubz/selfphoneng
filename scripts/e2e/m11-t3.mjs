// SPDX-License-Identifier: AGPL-3.0-or-later
// M11-T3: back up one server and restore it on another. Each "server" is a privileged docker:dind
// container running the real compose stack (images loaded from this host, no build): A gets an
// admin with a new password, user Dan with extension 201, a trunk with a password, voicemail, a
// custom sound, music on hold and a recording; "Back up now" makes the file (mode 0600, no
// generated config, no recordings). B is a fresh install with the same .env; restore.sh refuses
// a different APP_SECRET and a "no", then restores: the admin signs in with A's password, 201 and
// the trunk are back, the trunk password decrypts into Asterisk's config, the files match.
// Needs the images built (docker compose build). KEEP=1 leaves the two servers running.
// Usage: node scripts/e2e/m11-t3.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const IMAGES = ['selfphoneng-asterisk:latest', 'selfphoneng-api:latest', 'postgres:18-alpine'];
const [A, B] = ['sp-vm-a', 'sp-vm-b'];
const EMAIL = 'admin@example.com';
const [INITIAL_PW, ADMIN_PW, TRUNK_PW] = [
  'initial-admin-pw',
  'restored-admin-pw-42',
  'TrunkPass-42',
];
/** Files on A: these are restored, the recording is not (backup.includeRecordings is off). */
const FILES = [
  'voicemail/default/201/INBOX/msg0000.txt',
  'voicemail/default/201/INBOX/msg0000.wav',
  'sounds-custom/welcome.wav',
  'moh/default/song.wav',
];
const RECORDING = 'recordings/2026/10/19/call.wav';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const docker = (args, input) => {
  const r = spawnSync('docker', args, { encoding: 'utf8', input, maxBuffer: 64 << 20 });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
};
/** A shell command on a server, in its install folder /srv/sp. */
const sh = (vm, cmd, input) =>
  docker(['exec', '-i', vm, 'sh', '-c', `cd /srv/sp && ${cmd}`], input);
const must = (vm, cmd, input) => {
  const r = sh(vm, cmd, input);
  assert.ok(r.ok, `${vm}: ${cmd}\n${r.out}`);
  return r.out;
};
async function until(what, fn, ms = 180000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(1000)) if (await fn()) return;
  throw new Error(`timed out: ${what}`);
}

/** Runs `body` with node from the api image, next to the server's api; returns what it returns. */
function apiOn(vm, body) {
  const js = `
let cookie = '';
const call = async (method, path, b) => {
  const r = await fetch('http://127.0.0.1:8080' + path, { method, body: b && JSON.stringify(b),
    headers: { ...(b && { 'content-type': 'application/json' }), 'x-requested-with': 'selfphoneng', cookie } });
  const set = r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  if (set) cookie = set;
  const buf = Buffer.from(await r.arrayBuffer());
  let json = null;
  try { json = JSON.parse(buf.toString()); } catch {}
  return { status: r.status, json, size: buf.length };
};
const ok = async (method, path, b) => {
  const r = await call(method, path, b);
  if (r.status >= 300) throw new Error(method + ' ' + path + ': ' + r.status + ' ' + JSON.stringify(r.json));
  return r.json;
};
console.log(JSON.stringify(await (async () => { ${body} })()));`;
  const r = docker(
    [
      'exec',
      '-i',
      vm,
      'docker',
      'run',
      '--rm',
      '-i',
      '--network',
      'host',
      '--entrypoint',
      'node',
    ].concat([IMAGES[1], '--input-type=module', '-']),
    js,
  );
  assert.ok(r.ok, `${vm} api script failed:\n${r.out}`);
  return JSON.parse(r.out.split('\n').at(-1));
}
const signIn = (pw) =>
  `await ok('POST', '/api/auth/login', { email: '${EMAIL}', password: '${pw}' });`;

/** A fresh server: docker:dind, the images, compose file, restore.sh, .env, data folders. */
async function server(vm, images, env) {
  docker(['rm', '-f', vm]);
  const run = docker([
    'run',
    '-d',
    '--privileged',
    '--name',
    vm,
    '-v',
    `${images}:/images.tar:ro`,
    'docker:28-dind',
  ]);
  assert.ok(run.ok, run.out);
  await until(`${vm} dockerd`, () => docker(['exec', vm, 'docker', 'info']).ok, 60000);
  const load = docker(['exec', vm, 'docker', 'load', '-i', '/images.tar']);
  assert.ok(load.ok, load.out);
  docker(['exec', vm, 'mkdir', '-p', '/srv/sp/scripts']);
  docker(['cp', join(REPO, 'docker-compose.yml'), `${vm}:/srv/sp/docker-compose.yml`]);
  docker(['cp', join(REPO, 'scripts', 'restore.sh'), `${vm}:/srv/sp/scripts/restore.sh`]);
  must(vm, 'cat > .env', env);
  // As install.sh does: the app user (1000) owns what asterisk and the api share.
  const shared =
    'asterisk-generated voicemail recordings sounds-custom moh astdb asterisk-logs tls backups';
  must(
    vm,
    `mkdir -p data/postgres && cd data && mkdir -p ${shared} && chown -R 1000:1000 ${shared}`,
  );
  must(vm, 'docker compose up -d 2>&1');
  await until(`${vm} api up`, () => sh(vm, 'wget -qO- http://127.0.0.1:8080/healthz').ok);
}
const sums = (vm, files) => must(vm, `cd data && sha256sum ${files.join(' ')}`);

const work = mkdtempSync(join(tmpdir(), 'sp-m11t3-'));
const images = join(work, 'images.tar');
try {
  for (const img of IMAGES)
    assert.ok(docker(['image', 'inspect', img]).ok, `missing image ${img} (docker compose build)`);
  console.log('saving images…');
  const saved = docker(['save', '-o', images, ...IMAGES]);
  assert.ok(saved.ok, saved.out);
  const env = [
    'PUBLIC_HOSTNAME=pbx.test',
    `POSTGRES_PASSWORD=${randomBytes(12).toString('hex')}`,
    `AMI_SECRET=${randomBytes(12).toString('hex')}`,
    `APP_SECRET=${randomBytes(32).toString('base64')}`,
    `INITIAL_ADMIN_EMAIL=${EMAIL}`,
    `INITIAL_ADMIN_PASSWORD=${INITIAL_PW}`,
    'TZ=America/Chicago',
    '',
  ].join('\n');

  // 1. Server A: data in the database and in the folders, then Back up now.
  await server(A, images, env);
  apiOn(
    A,
    `${signIn(INITIAL_PW)}
    await ok('POST', '/api/auth/change-password', { currentPassword: '${INITIAL_PW}', newPassword: '${ADMIN_PW}' });
    ${signIn(ADMIN_PW)}
    const { user } = await ok('POST', '/api/users', { email: 'dan@example.com', displayName: 'Dan Doe' });
    await ok('POST', '/api/extensions', { number: '201', name: 'Dan Doe', userId: user.id });
    return ok('POST', '/api/trunks', { name: 'voip.ms', serverHost: '127.0.0.1', username: '123456_pbx', password: '${TRUNK_PW}' });`,
  );
  for (const f of [...FILES, RECORDING])
    must(
      A,
      `cd data && mkdir -p "$(dirname ${f})" && head -c 4096 /dev/urandom > ${f} && chown -R 1000:1000 "$(dirname ${f})"`,
    );
  const sumsA = sums(A, FILES);
  const made = apiOn(
    A,
    `${signIn(ADMIN_PW)}
    const b = await ok('POST', '/api/system/backups');
    const list = await ok('GET', '/api/system/backups');
    const dl = await call('GET', '/api/system/backups/' + b.name + '/download');
    return { b, listed: list.map((x) => x.name), dl: [dl.status, dl.size] };`,
  );
  const name = made.b.name;
  assert.match(name, /^selfphoneng-\d{8}-\d{4}\.tar\.gz$/);
  assert.deepEqual(made.listed, [name]);
  assert.deepEqual(made.dl, [200, made.b.size], 'download gives the whole file');
  assert.match(must(A, `ls -l data/backups/${name}`), /^-rw------- /, 'mode 0600');
  const members = must(A, `tar -tzf data/backups/${name}`).split('\n');
  for (const f of ['db.sql', 'manifest.json', ...FILES]) assert.ok(members.includes(f), `has ${f}`);
  assert.ok(
    !members.some((m) => /^(recordings|asterisk-generated)/.test(m)),
    'no recordings or generated config',
  );
  assert.doesNotMatch(
    must(A, `tar -xzOf data/backups/${name} db.sql`),
    new RegExp(TRUNK_PW),
    'trunk password only encrypted',
  );
  console.log(`A: backup ${name} (${made.b.size} bytes, 0600, ${members.length} entries)`);

  // 2. Server B: a fresh install with the same .env, and the backup copied over.
  await server(B, images, env);
  docker(['cp', `${A}:/srv/sp/data/backups/${name}`, join(work, name)]);
  docker(['cp', join(work, name), `${B}:/srv/sp/${name}`]);
  const other = env.replace(/^APP_SECRET=.*$/m, `APP_SECRET=${randomBytes(32).toString('base64')}`);
  must(B, 'cp .env .env.good && cat > .env', other);
  const wrong = sh(B, `sh scripts/restore.sh ${name}`, 'yes\n');
  assert.ok(
    !wrong.ok && /APP_SECRET in .env is not the one/.test(wrong.out),
    `wrong secret refused: ${wrong.out}`,
  );
  must(B, 'mv .env.good .env');
  const no = sh(B, `sh scripts/restore.sh ${name}`, 'no\n');
  assert.ok(!no.ok && /stopped, nothing changed/.test(no.out), `"no" stops: ${no.out}`);
  console.log('B: restore refuses another APP_SECRET and a "no"');
  const restored = sh(B, `sh scripts/restore.sh ${name} 2>&1`, 'yes\n');
  assert.ok(restored.ok, restored.out);
  await until('B api up again', () => sh(B, 'wget -qO- http://127.0.0.1:8080/healthz').ok);

  // 3. What came back.
  const seen = apiOn(
    B,
    `const initial = await call('POST', '/api/auth/login', { email: '${EMAIL}', password: '${INITIAL_PW}' });
    ${signIn(ADMIN_PW)}
    const exts = await ok('GET', '/api/extensions');
    const trunks = await ok('GET', '/api/trunks');
    return { initial: initial.status, exts: (exts.items ?? exts).map((e) => e.number), trunks: (trunks.items ?? trunks).map((t) => t.name) };`,
  );
  assert.equal(seen.initial, 401, "the fresh install's password is gone");
  assert.deepEqual(seen.exts, ['201']);
  assert.deepEqual(seen.trunks, ['voip.ms']);
  await until(
    'trunk password decrypted into the config',
    () =>
      sh(B, `grep -q "password = ${TRUNK_PW}" data/asterisk-generated/pjsip_selfphoneng.conf`).ok,
  );
  await until('201 in Asterisk', () =>
    /Endpoint:\s+201\b/.test(
      sh(B, "docker compose exec -T asterisk asterisk -rx 'pjsip show endpoints'").out,
    ),
  );
  assert.equal(sums(B, FILES), sumsA, 'files restored byte for byte');
  assert.ok(!sh(B, `test -e data/${RECORDING}`).ok, 'recording not restored');
  assert.match(
    must(B, 'stat -c %u:%g data/voicemail/default/201/INBOX/msg0000.wav'),
    /^1000:1000$/,
  );
  console.log('B: admin password, extension 201, trunk (password decrypted), files: restored');
  console.log('M11-T3: PASS');
} catch (e) {
  console.error('FAIL:', e.message);
  process.exitCode = 1;
} finally {
  if (!process.env.KEEP) for (const vm of [A, B]) docker(['rm', '-f', '-v', vm]);
  rmSync(work, { recursive: true, force: true });
}
