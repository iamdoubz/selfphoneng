// SPDX-License-Identifier: AGPL-3.0-or-later
// Builds the network test probe (08 §2.6) for machines without Docker:
//   dist/selfphoneng-probe.cjs              one file; runs with Node 22 or newer
//   dist/selfphoneng-probe-linux-x64        standalone executables with Node inside (Node's
//   dist/selfphoneng-probe-linux-arm64      single executable applications), nothing to install
//   dist/SHA256SUMS
// The executables carry this Node's version, downloaded from nodejs.org and checked against its
// SHASUMS256.txt. Run on Linux (needs tar with xz): node apps/probe/build-binary.mjs
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import postject from 'postject';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, 'dist');
const NAME = 'selfphoneng-probe';
const version = process.version;
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist);
const script = join(dist, `${NAME}.cjs`);
await build({
  entryPoints: [join(here, 'src/index.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: script,
  banner: { js: '#!/usr/bin/env node\n// SPDX-License-Identifier: AGPL-3.0-or-later' },
});
chmodSync(script, 0o755);

const work = mkdtempSync(join(tmpdir(), 'sp-probe-'));
try {
  const blob = join(work, 'sea.blob');
  writeFileSync(
    join(work, 'sea.json'),
    JSON.stringify({
      main: script,
      output: blob,
      disableExperimentalSEAWarning: true,
      // Neither is portable between CPU architectures; the probe starts in milliseconds anyway.
      useSnapshot: false,
      useCodeCache: false,
    }),
  );
  execFileSync(process.execPath, ['--experimental-sea-config', join(work, 'sea.json')], {
    stdio: 'inherit',
  });

  const base = `https://nodejs.org/dist/${version}`;
  const sums = await (await fetch(`${base}/SHASUMS256.txt`)).text();
  for (const arch of ['x64', 'arm64']) {
    const file = `node-${version}-linux-${arch}.tar.xz`;
    const want = sums
      .split('\n')
      .find((l) => l.endsWith(`  ${file}`))
      ?.split(' ')[0];
    const tarball = Buffer.from(await (await fetch(`${base}/${file}`)).arrayBuffer());
    if (!want || sha256(tarball) !== want) throw new Error(`${file}: checksum doesn't match`);
    writeFileSync(join(work, file), tarball);
    const inner = `node-${version}-linux-${arch}/bin/node`;
    execFileSync('tar', ['-xJf', join(work, file), '-C', work, inner]);
    const out = join(dist, `${NAME}-linux-${arch}`);
    copyFileSync(join(work, inner), out);
    await postject.inject(out, 'NODE_SEA_BLOB', readFileSync(blob), {
      sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
    });
    chmodSync(out, 0o755);
    console.log(`${out} (Node ${version})`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

const files = [`${NAME}.cjs`, `${NAME}-linux-x64`, `${NAME}-linux-arm64`];
writeFileSync(
  join(dist, 'SHA256SUMS'),
  files.map((f) => `${sha256(readFileSync(join(dist, f)))}  ${f}\n`).join(''),
);
console.log(readFileSync(join(dist, 'SHA256SUMS'), 'utf8'));
