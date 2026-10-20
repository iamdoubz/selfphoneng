// SPDX-License-Identifier: AGPL-3.0-or-later
// /api/about (08 §4): no sign-in. AGPL-3.0 §13 says everyone using the system over the network
// must be offered its source, so the exact source each image was built from ships inside it
// (apps/api/Dockerfile writes selfphone.tar.gz from the build context) and downloads from here.
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import type { AboutDto } from '@selfphoneng/shared';
import { notFound } from '../errors.ts';

export const REPO_URL = 'https://git.dou.bet/spng/selfphoneng';
/** In the api's working directory (/app in the image), like ./public. */
export const SOURCE_ARCHIVE = 'selfphone.tar.gz';

let version: string | undefined;
/** The image has VERSION (the root package.json's, written at build); a checkout reads that. */
export async function appVersion(): Promise<string> {
  version ??=
    (await readFile('VERSION', 'utf8').catch(() => null))?.trim() ||
    (
      JSON.parse(await readFile(new URL('../../../../package.json', import.meta.url), 'utf8')) as {
        version: string;
      }
    ).version;
  return version;
}

export async function aboutRoutes(app: FastifyInstance) {
  app.get('/api/about', async (): Promise<AboutDto> => {
    const s = await stat(SOURCE_ARCHIVE).catch(() => null);
    return {
      version: await appVersion(),
      repoUrl: REPO_URL,
      source: s ? { bytes: s.size, builtAt: s.mtime.toISOString() } : null,
    };
  });

  app.get('/api/about/source', async (_req, reply) => {
    if (!(await stat(SOURCE_ARCHIVE).catch(() => null)))
      throw notFound('The source archive is only in builds made with Docker');
    return reply
      .header('content-type', 'application/gzip')
      .header('content-disposition', 'attachment; filename="selfphone.tar.gz"')
      .send(createReadStream(SOURCE_ARCHIVE));
  });
}
