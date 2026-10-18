// SPDX-License-Identifier: AGPL-3.0-or-later
// Softphone bar on every /me page (05 §5.3). M5-T1: enable, status, dial, answer, hang up.
// M5-T2 adds the expanding panel, hold/mute/DTMF, transfer, devices and notifications.
import { useEffect, useState, useSyncExternalStore } from 'react';
import { formatNumber } from '@selfphoneng/shared';
import { meApi } from '../api/client.ts';
import { Button, inputClass } from '../components/ui.tsx';
import { softphone, type CallInfo } from './SoftphoneEngine.ts';

const KEY = 'softphone.enabled';
const remembered = () => {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
};
const remember = (on: boolean) => {
  try {
    if (on) localStorage.setItem(KEY, '1');
    else localStorage.removeItem(KEY);
  } catch {
    /* private mode: just don't remember */
  }
};

export const useSoftphone = () => useSyncExternalStore(softphone.subscribe, () => softphone.state);

const STATUS = { off: 'Off', connecting: 'Connecting…', registered: 'Ready', error: 'Error' };

async function startSoftphone() {
  const creds = await meApi.webrtc();
  await softphone.start(creds);
}

export function SoftphoneDock() {
  const { reg, error, calls } = useSoftphone();
  const [number, setNumber] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (remembered() && softphone.state.reg === 'off')
      startSoftphone().catch((e: Error) => setProblem(e.message));
  }, []);

  async function enable() {
    setProblem(null);
    try {
      // Ask for the microphone now, on a click, not in the middle of the first call.
      const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
      mic.getTracks().forEach((t) => t.stop());
      await startSoftphone();
      remember(true);
    } catch (e) {
      setProblem(
        (e as Error).name === 'NotAllowedError'
          ? 'Microphone access was blocked.'
          : (e as Error).message,
      );
    }
  }

  async function dial() {
    const n = number.replace(/[^0-9*#+]/g, '');
    if (!n) return;
    setProblem(null);
    await softphone.call(n).catch((e: Error) => setProblem(e.message));
  }

  return (
    <section
      aria-label="Softphone"
      className="sticky bottom-0 mt-auto flex flex-col gap-2 border-t border-zinc-200 bg-white py-3 dark:border-zinc-800 dark:bg-zinc-950"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">
          Softphone: <span role="status">{STATUS[reg]}</span>
        </span>
        {reg === 'off' ? (
          <Button variant="primary" onClick={enable}>
            Enable softphone
          </Button>
        ) : (
          <Button
            variant="ghost"
            onClick={() => {
              remember(false);
              void softphone.stop();
            }}
          >
            Turn off
          </Button>
        )}
      </div>
      {(problem ?? error) && (
        <p className="text-sm text-red-600 dark:text-red-400">{problem ?? error}</p>
      )}
      {reg === 'registered' && (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void dial();
          }}
        >
          <label htmlFor="sp-number" className="sr-only">
            Number to call
          </label>
          <input
            id="sp-number"
            className={inputClass}
            inputMode="tel"
            autoComplete="off"
            placeholder="Number or extension"
            value={number}
            onChange={(e) => setNumber(e.target.value)}
          />
          <Button type="submit" variant="primary">
            Call
          </Button>
        </form>
      )}
      {calls.map((c) => (
        <CallRow key={c.id} call={c} />
      ))}
    </section>
  );
}

function CallRow({ call }: { call: CallInfo }) {
  const who = call.remoteName ?? (call.remote.length > 6 ? formatNumber(call.remote) : call.remote);
  const label = { incoming: 'Incoming call', calling: 'Calling…', active: 'On call' }[call.state];
  return (
    <div
      role="group"
      aria-label={`${label}: ${who}`}
      className="flex flex-wrap items-center gap-2 rounded-md bg-zinc-100 p-2 dark:bg-zinc-900"
    >
      <span className="flex-1 text-sm">
        <span className="font-medium">{who}</span> · {label}
      </span>
      {call.state === 'incoming' && (
        <>
          <Button variant="primary" onClick={() => void softphone.answer(call.id)}>
            Answer
          </Button>
          <Button variant="ghost" onClick={() => void softphone.decline(call.id)}>
            Decline
          </Button>
        </>
      )}
      {call.state !== 'incoming' && (
        <Button variant="danger" onClick={() => void softphone.hangup(call.id)}>
          Hang up
        </Button>
      )}
    </div>
  );
}
