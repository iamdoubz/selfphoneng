// SPDX-License-Identifier: AGPL-3.0-or-later
// M1-T1: the migration matches the DDL in docs/spec/02-data-model.md for five key tables.
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/client.ts';
import { createTestDb, hasTestDb } from './db.ts';

// column → "data_type|nullable|default-ish", straight from the spec DDL (+ created_at/updated_at).
const ts = {
  created_at: 'timestamp with time zone|NO|now()',
  updated_at: 'timestamp with time zone|NO|now()',
};
const EXPECTED: Record<string, Record<string, string>> = {
  users: {
    id: 'uuid|NO|gen_random_uuid()',
    email: 'USER-DEFINED:citext|NO|',
    display_name: 'text|NO|',
    password_hash: 'text|YES|',
    role: "USER-DEFINED:user_role|NO|'user'::user_role",
    is_active: 'boolean|NO|true',
    totp_secret_enc: 'text|YES|',
    totp_recovery_hashes: "ARRAY:_text|NO|'{}'::text[]",
    totp_last_step: 'bigint|YES|',
    must_change_password: 'boolean|NO|false',
    last_login_at: 'timestamp with time zone|YES|',
    contrack_token_enc: 'text|YES|',
    contrack_log_calls: 'boolean|NO|true',
    contrack_log_summaries: 'boolean|NO|false',
    contrack_log_since: 'timestamp with time zone|YES|',
    ...ts,
  },
  extensions: {
    id: 'uuid|NO|gen_random_uuid()',
    number: 'text|NO|',
    user_id: 'uuid|YES|',
    name: 'text|NO|',
    sip_password_enc: 'text|NO|',
    webrtc_enabled: 'boolean|NO|true',
    max_contacts: 'integer|NO|5',
    ring_seconds: 'integer|NO|25',
    voicemail_enabled: 'boolean|NO|true',
    voicemail_pin_enc: 'text|NO|',
    voicemail_email: 'boolean|NO|true',
    voicemail_attach_audio: 'boolean|NO|true',
    voicemail_delete_after_email: 'boolean|NO|false',
    outbound_class: "USER-DEFINED:outbound_class|NO|'national'::outbound_class",
    outbound_caller_id_did_id: 'uuid|YES|',
    emergency_caller_id_did_id: 'uuid|YES|',
    emergency_location: 'text|YES|',
    record_mode: "USER-DEFINED:record_mode|NO|'never'::record_mode",
    pickup_group: 'text|YES|',
    language: "text|NO|'en'::text",
    moh_class: "text|NO|'default'::text",
    blf_numbers: "ARRAY:_text|NO|'{}'::text[]",
    call_report: "USER-DEFINED:call_report|NO|'off'::call_report",
    call_report_time: "text|NO|'08:00'::text",
    call_report_weekday: 'integer|NO|1',
    call_report_summaries: 'boolean|NO|false',
    call_report_sent_at: 'timestamp with time zone|YES|',
    ...ts,
  },
  trunks: {
    id: 'uuid|NO|gen_random_uuid()',
    name: 'text|NO|',
    provider: "USER-DEFINED:trunk_provider|NO|'voipms'::trunk_provider",
    enabled: 'boolean|NO|true',
    server_host: 'text|NO|',
    server_port: 'integer|NO|5060',
    transport: "USER-DEFINED:sip_transport|NO|'udp'::sip_transport",
    auth_mode: "USER-DEFINED:trunk_auth_mode|NO|'registration'::trunk_auth_mode",
    username: 'text|YES|',
    password_enc: 'text|YES|',
    from_user: 'text|YES|',
    from_domain: 'text|YES|',
    codecs: "ARRAY:_text|NO|'{ulaw}'::text[]",
    srtp: 'boolean|NO|false',
    max_channels: 'integer|YES|',
    voipms_api_username: 'text|YES|',
    voipms_api_password_enc: 'text|YES|',
    ...ts,
  },
  calls: {
    id: 'uuid|NO|gen_random_uuid()',
    linkedid: 'text|NO|',
    direction: 'USER-DEFINED:call_direction|NO|',
    status: 'USER-DEFINED:call_status|NO|',
    started_at: 'timestamp with time zone|NO|',
    answered_at: 'timestamp with time zone|YES|',
    ended_at: 'timestamp with time zone|NO|',
    from_number: 'text|YES|',
    from_name: 'text|YES|',
    to_number: 'text|YES|',
    did_id: 'uuid|YES|',
    answered_by_extension_id: 'uuid|YES|',
    talk_seconds: 'integer|NO|0',
    recording_id: 'uuid|YES|',
    ...ts,
  },
  audit_log: {
    id: "bigint|NO|nextval('audit_log_id_seq'::regclass)",
    created_at: 'timestamp with time zone|NO|now()',
    actor_user_id: 'uuid|YES|',
    actor_ip: 'inet|YES|',
    action: 'text|NO|',
    entity_type: 'text|YES|',
    entity_id: 'text|YES|',
    summary: 'text|NO|',
    diff: 'jsonb|YES|',
  },
};

describe.skipIf(!hasTestDb)('schema matches spec 02', () => {
  let db: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => ({ db, drop } = await createTestDb()));
  afterAll(() => drop?.());

  it('creates all 44 tables', async () => {
    const r = await db.execute(
      sql`select count(*)::int as n from information_schema.tables where table_schema = 'public'`,
    );
    expect(r.rows[0]).toEqual({ n: 44 });
  });

  it.each(Object.keys(EXPECTED))('%s columns', async (table) => {
    const r = await db.execute<{
      column_name: string;
      data_type: string;
      udt_name: string;
      is_nullable: string;
      column_default: string | null;
    }>(sql`select column_name, data_type, udt_name, is_nullable, column_default
           from information_schema.columns where table_schema = 'public' and table_name = ${table}`);
    const actual = Object.fromEntries(
      r.rows.map((c) => {
        const type = ['USER-DEFINED', 'ARRAY'].includes(c.data_type)
          ? `${c.data_type}:${c.udt_name}`
          : c.data_type;
        return [c.column_name, `${type}|${c.is_nullable}|${c.column_default ?? ''}`];
      }),
    );
    expect(actual).toEqual(EXPECTED[table]);
  });

  it('enforces the spec check constraints', async () => {
    await expect(
      db.execute(
        sql`insert into holidays (name, start_date, end_date) values ('x', '2026-01-01', '2026-01-01')`,
      ),
    ).resolves.toBeDefined();
    await expect(
      db.execute(
        sql`insert into time_conditions (name, timezone, open_ranges, override_digit, open_destination, closed_destination)
            values ('t', 'UTC', '[]', 12, '{}', '{}')`,
      ),
    ).rejects.toThrow();
  });
});
