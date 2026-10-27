// SPDX-License-Identifier: AGPL-3.0-or-later
// The spam check's providers over HTTPS (14 §2). Errors carry only these texts: never the URL
// or fetch's own error, which can quote it (IPQualityScore's key is in the path).

/** A failure whose message is safe to log and show. */
export class SpamError extends Error {}

export async function getJson(
  url: string,
  headers: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  let r: Response;
  try {
    r = await fetch(url, { headers, signal: AbortSignal.timeout(4000) });
  } catch (err) {
    throw new SpamError(
      (err as Error).name === 'TimeoutError' ? 'no answer in 4 s' : "couldn't connect",
    );
  }
  if (!r.ok) throw new SpamError(`HTTP ${r.status}`);
  try {
    return (await r.json()) as Record<string, unknown>;
  } catch {
    throw new SpamError('the answer was not JSON');
  }
}
