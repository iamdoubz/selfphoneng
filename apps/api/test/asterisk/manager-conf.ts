// SPDX-License-Identifier: AGPL-3.0-or-later
// The real manager.conf.template, read/write classes included, so a class the api needs and the
// template lacks fails the tests. Only opened up for the host to reach AMI through the published
// port: the real one is 127.0.0.1-only.
import { readFileSync } from 'node:fs';

export function testManagerConf(): string {
  const real = readFileSync(
    new URL('../../../../asterisk/conf/manager.conf.template', import.meta.url),
    'utf8',
  );
  const open = real
    .replace(/^bindaddr = 127\.0\.0\.1$/m, 'bindaddr = 0.0.0.0')
    .replace(/^permit = 127\.0\.0\.1\/255\.255\.255\.255$/m, 'permit = 0.0.0.0/0.0.0.0');
  if (open.includes('127.0.0.1'))
    throw new Error('manager.conf.template changed: update manager-conf.ts');
  return open;
}
