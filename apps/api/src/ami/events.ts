// SPDX-License-Identifier: AGPL-3.0-or-later
// AMI wire format (04 §4): one banner line, then messages of "Key: Value\r\n" lines ending with an
// empty line. Keys can repeat (Output:, ChanVariable:), so a repeated key becomes an array.

export type AmiMessage = Record<string, string | string[]>;

const BANNER = /^Asterisk Call Manager\/[^\r\n]*\r\n/;

/** Incremental parser: feed it TCP chunks, get whole messages back. */
export class AmiParser {
  private buf = '';
  private sawBanner = false;
  banner: string | null = null;

  push(chunk: string): AmiMessage[] {
    this.buf += chunk;
    if (!this.sawBanner) {
      const m = BANNER.exec(this.buf);
      if (!m) {
        // Wait for the whole banner line, unless this clearly isn't one.
        if (this.buf.length < 64 && !this.buf.includes('\n')) return [];
      } else {
        this.banner = m[0].trim();
        this.buf = this.buf.slice(m[0].length);
      }
      this.sawBanner = true;
    }
    const out: AmiMessage[] = [];
    for (let end = this.buf.indexOf('\r\n\r\n'); end !== -1; end = this.buf.indexOf('\r\n\r\n')) {
      const block = this.buf.slice(0, end);
      this.buf = this.buf.slice(end + 4);
      const msg = parseBlock(block);
      if (Object.keys(msg).length) out.push(msg);
    }
    return out;
  }

  reset(): void {
    this.buf = '';
    this.sawBanner = false;
    this.banner = null;
  }
}

export function parseBlock(block: string): AmiMessage {
  const msg: AmiMessage = {};
  for (const line of block.split('\r\n')) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const key = line.slice(0, i);
    // Asterisk sometimes ends a value with a bare LF ("No Contacts found\n"): drop stray line ends.
    const value = line
      .slice(i + 1)
      .replace(/^ /, '')
      .replace(/[\r\n]+$/, '');
    const prev = msg[key];
    if (prev === undefined) msg[key] = value;
    else msg[key] = Array.isArray(prev) ? [...prev, value] : [prev, value];
  }
  return msg;
}

export function serialize(fields: Record<string, string>): string {
  let s = '';
  for (const [k, v] of Object.entries(fields)) {
    // A CR or LF in a value would start a new header or end the message: AMI injection.
    if (/[\r\n]/.test(k) || /[\r\n]/.test(v)) throw new Error(`AMI field ${k} contains a newline`);
    s += `${k}: ${v}\r\n`;
  }
  return `${s}\r\n`;
}

/** First value of a possibly repeated key. */
export const field = (m: AmiMessage, key: string): string | undefined => {
  const v = m[key];
  return Array.isArray(v) ? v[0] : v;
};

/** All values of a possibly repeated key. */
export const fields = (m: AmiMessage, key: string): string[] => {
  const v = m[key];
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
};
