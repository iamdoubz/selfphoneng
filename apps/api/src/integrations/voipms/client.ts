// SPDX-License-Identifier: AGPL-3.0-or-later
// voip.ms REST/JSON API (06 §5.1): GET rest.php?api_username&api_password&method&…, JSON back with
// `status` = "success" or an error code. The password is in the query string, so the URL is never
// logged or put in an error.
// TODO(spec): most response shapes and error codes are from the 06 spec, not a real account yet;
// voip.ms's example bundle (docs/voip.ms-api) only shows getCDR's. Check with the owner's account.
import { normalizeNumber } from '@selfphoneng/shared';

export type VoipmsCreds = { username: string; password: string };

export class VoipmsError extends Error {
  /** voip.ms's status code ("invalid_credentials", …), or "unreachable" / "bad_response". */
  readonly status: string;
  constructor(status: string) {
    super(voipmsMessage(status));
    this.status = status;
  }
}

/** What to tell the admin for a voip.ms status code. */
export function voipmsMessage(status: string): string {
  switch (status) {
    case 'invalid_credentials':
      return 'voip.ms rejected the API username or password';
    case 'ip_not_enabled':
    case 'invalid_ip':
      return "voip.ms refused this server's IP address: allow it under Main Menu → SOAP and REST/JSON API";
    case 'api_not_enabled':
      return 'The voip.ms API is not enabled on this account (Main Menu → SOAP and REST/JSON API)';
    case 'unreachable':
      return "Can't reach voip.ms right now";
    case 'bad_response':
      return 'voip.ms sent an answer we could not read';
    default:
      return `voip.ms said: ${status.replace(/[^a-z0-9_]/gi, '').slice(0, 60)}`;
  }
}

/** One API call; resolves with the JSON body when status is "success". 15 s timeout. */
export async function voipmsApi(
  baseUrl: string,
  creds: VoipmsCreds,
  method: string,
  params: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  const url = new URL(baseUrl);
  for (const [k, v] of Object.entries({
    api_username: creds.username,
    api_password: creds.password,
    method,
    ...params,
  }))
    url.searchParams.set(k, v);
  let body: unknown;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    body = await r.json();
  } catch (e) {
    throw new VoipmsError(e instanceof SyntaxError ? 'bad_response' : 'unreachable');
  }
  const status = (body as { status?: unknown } | null)?.status;
  if (typeof status !== 'string') throw new VoipmsError('bad_response');
  if (status !== 'success') throw new VoipmsError(status);
  return body as Record<string, unknown>;
}

const list = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v)
    ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
    : [];
const str = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');

/** POP servers (getServersInfo) → hostnames, sorted. */
export async function getServers(baseUrl: string, creds: VoipmsCreds): Promise<string[]> {
  const r = await voipmsApi(baseUrl, creds, 'getServersInfo');
  return [
    ...new Set(
      list(r.servers)
        .map((s) => str(s.server_hostname))
        .filter(Boolean),
    ),
  ].sort();
}

export type VoipmsDid = { number: string; description: string; smsEnabled: boolean };

/** The account's DIDs (getDIDsInfo), numbers normalized (10-digit NANP → 1NXX…). */
export async function getDids(baseUrl: string, creds: VoipmsCreds): Promise<VoipmsDid[]> {
  let r: Record<string, unknown>;
  try {
    r = await voipmsApi(baseUrl, creds, 'getDIDsInfo');
  } catch (e) {
    if (e instanceof VoipmsError && e.status === 'no_did') return []; // an account without DIDs
    throw e;
  }
  return list(r.dids).flatMap((d) => {
    const raw = str(d.did);
    if (!/^\d{7,15}$/.test(raw)) return [];
    return [
      {
        number: normalizeNumber(raw),
        description: str(d.description).slice(0, 60),
        smsEnabled: str(d.sms_enabled) === '1',
      },
    ];
  });
}

export type VoipmsCall = {
  at: Date;
  destination: string;
  account: string;
  disposition: string;
  seconds: number;
  total: string;
  uniqueid: string;
};

/**
 * One sub-account's call records between two UTC dates (getCDR, 06 §5.1). `timezone=0` makes
 * `date` UTC. The request, `no_cdr` and most fields are in voip.ms's examples; `account`,
 * `disposition` and `uniqueid` aren't (verify), and come back '' if missing.
 */
export async function getCdr(
  baseUrl: string,
  creds: VoipmsCreds,
  q: { from: string; to: string; account: string },
): Promise<VoipmsCall[]> {
  let r: Record<string, unknown>;
  try {
    r = await voipmsApi(baseUrl, creds, 'getCDR', {
      date_from: q.from,
      date_to: q.to,
      answered: '1',
      noanswer: '1',
      busy: '1',
      failed: '1',
      timezone: '0',
      account: q.account,
    });
  } catch (e) {
    if (e instanceof VoipmsError && e.status === 'no_cdr') return [];
    throw e;
  }
  return list(r.cdr).flatMap((c) => {
    const at = new Date(`${str(c.date).replace(' ', 'T')}Z`);
    if (Number.isNaN(at.getTime())) return [];
    return [
      {
        at,
        destination: str(c.destination),
        account: str(c.account),
        disposition: str(c.disposition),
        seconds: Number(str(c.seconds)) || 0,
        total: str(c.total),
        uniqueid: str(c.uniqueid),
      },
    ];
  });
}

/**
 * The account's balance (getBalance → balance.current_balance, in the account's currency).
 * (verify) against a real account: the shape is from voip.ms's API docs (06 §5.1).
 */
export async function getBalance(baseUrl: string, creds: VoipmsCreds): Promise<number> {
  const r = await voipmsApi(baseUrl, creds, 'getBalance');
  const b = r.balance as Record<string, unknown> | undefined;
  const n = Number(str(b?.current_balance));
  if (!b || str(b.current_balance) === '' || !Number.isFinite(n))
    throw new VoipmsError('bad_response');
  return n;
}
