// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { mergeSides, sideFiles, speechStretches, transcriptText, wavSlice } from './calls.ts';

describe('call transcripts', () => {
  it('side files sit next to the recording', () => {
    expect(sideFiles('2026/10/21/1792.5.wav')).toEqual([
      '2026/10/21/1792.5-in.wav',
      '2026/10/21/1792.5-out.wav',
    ]);
  });

  it('merges by time; the caller first when both start together', () => {
    expect(
      mergeSides(
        [
          { at: 0, text: 'Hello?' },
          { at: 5, text: 'Bye.' },
        ],
        [
          { at: 0, text: 'Hi.' },
          { at: 2.5, text: 'How can I help?' },
        ],
      ).map((l) => `${l.side} ${l.at}`),
    ).toEqual(['caller 0', 'other 0', 'other 2.5', 'caller 5']);
  });

  it('labels the lines and cuts a long call', () => {
    const lines = mergeSides([{ at: 0, text: 'a'.repeat(50) }], [{ at: 1, text: 'b' }]);
    expect(transcriptText(lines)).toBe(`Caller: ${'a'.repeat(50)}\nOther side: b`);
    expect(transcriptText(lines, 20)).toBe(
      `Caller: ${'a'.repeat(12)}\n[the rest of the call is cut]`,
    );
  });
});

describe('speech stretches', () => {
  /** 8 kHz mono 16-bit: [seconds, loud?] pieces one after another. */
  const wav = (parts: [number, boolean][]) => {
    const samples = parts.flatMap(([s, loud]) =>
      Array.from({ length: s * 8000 }, (_, i) => (loud ? Math.round(5000 * Math.sin(i / 3)) : 0)),
    );
    const b = Buffer.alloc(44 + samples.length * 2);
    b.writeUInt32LE(8000, 24);
    b.writeUInt32LE(16000, 28);
    samples.forEach((v, i) => b.writeInt16LE(v, 44 + i * 2));
    return b;
  };
  const round = (x: { from: number; to: number }[]) =>
    x.map((s) => [Math.round(s.from * 10) / 10, Math.round(s.to * 10) / 10]);

  it('finds each stretch of speech, joining short pauses, with a little margin', () => {
    const w = wav([
      [1, false],
      [2, true],
      [0.4, false], // a breath: same stretch
      [1, true],
      [3, false],
      [1, true],
      [1, false],
    ]);
    expect(round(speechStretches(w))).toEqual([
      [0.8, 4.6],
      [7.2, 8.6],
    ]);
  });

  it('silence and a click are nothing', () => {
    expect(speechStretches(wav([[3, false]]))).toEqual([]);
    expect(
      speechStretches(
        wav([
          [1, false],
          [0.1, true],
          [1, false],
        ]),
      ),
    ).toEqual([]);
  });

  it('a slice is a WAV of just those seconds', () => {
    const w = wav([[2, true]]);
    const s = wavSlice(w, 0.5, 1.5);
    expect(s.length).toBe(44 + 16000);
    expect(s.readUInt32LE(40)).toBe(16000);
    expect(s.readUInt32LE(4)).toBe(36 + 16000);
    expect(s.subarray(44, 54)).toEqual(w.subarray(44 + 8000, 54 + 8000));
  });
});
