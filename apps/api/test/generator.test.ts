// SPDX-License-Identifier: AGPL-3.0-or-later
// M2-T2: apply() writes files atomically and sends only the reloads it needs (03 §1, §3).
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asc } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/client.ts';
import { generatorRuns } from '../src/db/schema.ts';
import {
  GENERATED_FILES,
  HEADER,
  createGenerator,
  render,
  type Generator,
} from '../src/generator/index.ts';
import { loadSnapshot, todayIn } from '../src/generator/load.ts';
import { getSetting, setSetting } from '../src/services/settings.ts';
import { createTestDb, hasTestDb } from './db.ts';
import { fakeAmi } from './app.ts';

const silent = { info() {}, error() {} };

describe('loadSnapshot / render', () => {
  it('todayIn uses the company timezone, not UTC', () => {
    const lateNightUtc = new Date('2026-03-01T03:30:00Z'); // still Feb 28 in Chicago
    expect(todayIn('America/Chicago', lateNightUtc)).toBe('2026-02-28');
    expect(todayIn('UTC', lateNightUtc)).toBe('2026-03-01');
  });
});

describe.skipIf(!hasTestDb)('generator apply', () => {
  let db: Db;
  let drop: () => Promise<void>;
  let dir: string;
  let ami: ReturnType<typeof fakeAmi>;
  let gen: Generator;
  const applied: unknown[] = [];
  beforeAll(async () => ({ db, drop } = await createTestDb()));
  afterAll(() => drop?.());
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sp-gen-'));
    ami = fakeAmi();
    gen = createGenerator({
      db,
      ami,
      dir,
      log: silent,
      debounceMs: 30,
      onApplied: (r) => applied.push(r),
    });
  });

  it('render() gives every file the header and is deterministic', async () => {
    const snap = await loadSnapshot(db);
    const a = render(snap);
    expect(Object.keys(a).sort()).toEqual([...GENERATED_FILES].sort());
    for (const f of GENERATED_FILES) expect(a[f].startsWith(HEADER)).toBe(true);
    expect(render(structuredClone(snap))).toEqual(a);
  });

  it('first apply writes every file and reloads everything once', async () => {
    const r = await gen.apply({ trigger: 'startup' });
    expect(r).toMatchObject({ ok: true, error: null });
    expect(r.filesChanged.sort()).toEqual([...GENERATED_FILES].sort());
    expect(ami.commands).toEqual([
      'pjsip reload',
      'module reload res_rtp_asterisk.so',
      'dialplan reload', // two dialplan files, one reload
      'voicemail reload',
      'queue reload all',
      'moh reload',
      'module reload app_confbridge.so',
    ]);
    const names = readdirSync(dir).sort();
    expect(names).toEqual(['.prev', ...GENERATED_FILES].sort()); // no leftover .tmp files
    expect(readFileSync(join(dir, 'pjsip_selfphoneng.conf'), 'utf8')).toBe(HEADER);
    expect(await getSetting(db, 'system.restartRequired')).toBe(false);
  });

  it('nothing changed → no writes, no reloads, but a run is recorded', async () => {
    await gen.apply({ trigger: 'startup' });
    ami.commands.length = 0;
    const before = (await db.select().from(generatorRuns)).length;
    const r = await gen.apply({ trigger: 'api-change' });
    expect(r).toMatchObject({ ok: true, filesChanged: [], commands: [] });
    expect(ami.commands).toEqual([]);
    const runs = await db.select().from(generatorRuns).orderBy(asc(generatorRuns.id));
    expect(runs).toHaveLength(before + 1);
    expect(runs.at(-1)).toMatchObject({
      trigger: 'api-change',
      ok: true,
      filesChanged: [],
      commands: [],
    });
  });

  it('only the changed file is rewritten and only its module reloaded; .prev keeps the old one', async () => {
    await gen.apply({ trigger: 'startup' });
    ami.commands.length = 0;
    writeFileSync(join(dir, 'queues_selfphoneng.conf'), '; hand edit\n'); // drift on disk
    const r = await gen.apply({ trigger: 'api-change' });
    expect(r.filesChanged).toEqual(['queues_selfphoneng.conf']);
    expect(ami.commands).toEqual(['queue reload all']);
    expect(readFileSync(join(dir, 'queues_selfphoneng.conf'), 'utf8')).toBe(HEADER);
    expect(readFileSync(join(dir, '.prev', 'queues_selfphoneng.conf'), 'utf8')).toBe(
      '; hand edit\n',
    );
  });

  it('force reloads everything even when no file changed', async () => {
    await gen.apply({ trigger: 'startup' });
    ami.commands.length = 0;
    const r = await gen.apply({ trigger: 'startup', force: true });
    expect(r.filesChanged).toEqual([]);
    expect(ami.commands).toHaveLength(7);
  });

  it('AMI down → files written, run recorded as ami-disconnected', async () => {
    ami.connected = false;
    const r = await gen.apply({ trigger: 'api-change' });
    expect(r).toMatchObject({ ok: false, error: 'ami-disconnected', commands: [] });
    expect(r.filesChanged.length).toBeGreaterThan(0);
    const [last] = await db
      .select()
      .from(generatorRuns)
      .orderBy(asc(generatorRuns.id))
      .limit(1)
      .offset((await db.select().from(generatorRuns)).length - 1);
    expect(last).toMatchObject({ ok: false, error: 'ami-disconnected' });
  });

  it('applies run one at a time and requestApply debounces bursts into one apply', async () => {
    const order: string[] = [];
    const slowAmi = {
      isConnected: () => true,
      command: async (c: string) => {
        order.push(`start ${c}`);
        await new Promise((r) => setTimeout(r, 5));
        order.push(`end ${c}`);
        return '';
      },
    };
    const g = createGenerator({ db, ami: slowAmi, dir, log: silent });
    await Promise.all([
      g.apply({ trigger: 'a', force: true }),
      g.apply({ trigger: 'b', force: true }),
    ]);
    for (let i = 0; i < order.length; i += 2) {
      expect(order[i]!.replace('start', '')).toBe(order[i + 1]!.replace('end', '')); // never interleaved
    }

    applied.length = 0;
    for (let i = 0; i < 5; i++) gen.requestApply('api-change');
    await new Promise((r) => setTimeout(r, 150));
    expect(applied).toHaveLength(1);
  });

  it('transport change → no pjsip reload, restartRequired set', async () => {
    // Simulate a previous apply that recorded a different transport block.
    await setSetting(db, 'system.transportHash', 'an-old-hash');
    await setSetting(db, 'system.restartRequired', false);
    writeFileSync(join(dir, 'pjsip_selfphoneng.conf'), '; old\n');
    const r = await gen.apply({ trigger: 'api-change' });
    expect(r.restartRequired).toBe(true);
    expect(ami.commands).not.toContain('pjsip reload');
    expect(await getSetting(db, 'system.restartRequired')).toBe(true);
    await setSetting(db, 'system.restartRequired', false);
  });

  it('rollback restores .prev and reloads everything', async () => {
    await gen.apply({ trigger: 'startup' });
    writeFileSync(join(dir, 'moh_x'), ''); // unrelated files are ignored
    writeFileSync(join(dir, '.prev', 'musiconhold_selfphoneng.conf'), '; previous\n');
    ami.commands.length = 0;
    const r = await gen.rollback();
    expect(r.ok).toBe(true);
    expect(readFileSync(join(dir, 'musiconhold_selfphoneng.conf'), 'utf8')).toBe('; previous\n');
    expect(ami.commands).toHaveLength(7);
  });

  it('a render error fails the apply loudly without touching the files', async () => {
    await gen.apply({ trigger: 'startup' });
    await db.execute(
      // Bypass the settings service validation the way a bug would.
      (await import('drizzle-orm'))
        .sql`insert into settings (key, value) values ('general.timezone', '"Not/AZone"')
        on conflict (key) do update set value = excluded.value`,
    );
    const r = await gen.apply({ trigger: 'api-change' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/time ?zone/i);
    await db.execute(
      (await import('drizzle-orm')).sql`delete from settings where key = 'general.timezone'`,
    );
  });
});
