// SPDX-License-Identifier: AGPL-3.0-or-later
// IPQualityScore (14 §2.1). Its key goes in the URL's path: see http.ts.
import type { IpqsInfo, SpamRisk } from '@selfphoneng/shared';
import { SpamError, getJson } from './http.ts';

const BASE = 'https://www.ipqualityscore.com/api/json';
export type IpqsAnswer = { kind: 'ok'; risk: SpamRisk; info: IpqsInfo } | { kind: 'exhausted' };

const get = (path: string) => getJson(`${BASE}/${path}`);

const str = (v: unknown) => (typeof v === 'string' && v.trim() && v !== 'N/A' ? v.trim() : null);
const used = (msg: unknown) => typeof msg === 'string' && /insufficient credits/i.test(msg);
/** The provider's own message, cut short and without the key in case it quotes it. */
const said = (msg: unknown, key: string) =>
  new SpamError(
    typeof msg === 'string' && msg
      ? msg.replaceAll(key, '***').slice(0, 200)
      : 'the request failed',
  );

/** Risk (owner, 2026-10-27): IPQualityScore's own advice, 75 suspicious and 85 high risk. */
export function ipqsRisk(a: {
  fraudScore: number;
  spammer: boolean;
  recentAbuse: boolean;
  risky: boolean;
}): SpamRisk {
  if (a.spammer || a.fraudScore >= 85) return 'high';
  if (a.fraudScore >= 75 || a.recentAbuse || a.risky) return 'medium';
  return 'low';
}

/** One phone lookup: `number` is 1NXXNXXXXXX. */
export async function ipqsLookup(key: string, number: string): Promise<IpqsAnswer> {
  const j = await get(`phone/${encodeURIComponent(key)}/${number}?country[]=US`);
  if (j.success !== true) {
    if (used(j.message)) return { kind: 'exhausted' };
    throw said(j.message, key);
  }
  const info: IpqsInfo = {
    fraudScore: typeof j.fraud_score === 'number' ? j.fraud_score : 0,
    spammer: j.spammer === true,
    recentAbuse: j.recent_abuse === true,
    lineType: str(j.line_type),
    carrier: str(j.carrier),
    name: str(j.name),
    city: str(j.city),
    region: str(j.region),
  };
  return { kind: 'ok', risk: ipqsRisk({ ...info, risky: j.risky === true }), info };
}

/** The Credit Usage API: credits left in this billing period (Test, and 14 §3). */
export async function ipqsCredits(key: string): Promise<number> {
  const j = await get(`account/${encodeURIComponent(key)}`);
  if (j.success === false) throw said(j.message, key);
  const credits = Number(j.credits);
  if (!Number.isFinite(credits)) throw new SpamError('the answer had no credit count');
  return credits;
}
