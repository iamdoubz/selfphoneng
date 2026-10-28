// SPDX-License-Identifier: AGPL-3.0-or-later
// Softphone on every /me page (05 §5.3): a bar at the bottom that opens a panel with the
// dialpad and audio devices; call cards with mute/hold/keypad/transfer; the incoming call dialog.
// Not yet: DND toggle (M6), Record via *1 and recent calls (M7).
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { formatNumber } from '@selfphoneng/shared';
import { meApi } from '../api/client.ts';
import { SpamNote } from '../components/SpamNote.tsx';
import { Button, inputClass } from '../components/ui.tsx';
import { useLive } from '../live/store.ts';
import { onTakeOver, stepDown, takeOver, tryLead } from './leader.ts';
import { CALL_DRAG, softphone, type CallInfo } from './SoftphoneEngine.ts';
import { useSoftphone } from './useSoftphone.ts';
import { startRinging, stopRinging } from './sounds.ts';
import { useContactName } from '../pages/user/ContactsPage.tsx';

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

// The incoming call notification comes from public/sw.js so it can have Answer/Decline buttons.
// No service worker (plain http, some private windows): no notification, the ringtone still plays.
const sw = 'serviceWorker' in navigator ? navigator.serviceWorker : null;
void sw?.register('/sw.js').catch(() => {});
const notifyCall = (id: string, body: string) =>
  void sw?.ready.then((r) => r.active?.postMessage({ notifyCall: { id, body } }));
// ponytail: a call that stops ringing before its notification is up leaves it showing; its
// buttons then do nothing (answer/decline ignore unknown calls). Close it from sw.js if that bites.
const closeCallNotes = (id?: string) =>
  void sw?.ready
    .then((r) => r.getNotifications(id ? { tag: id } : {}))
    .then((ns) => ns.forEach((n) => n.close()));

onTakeOver(async () => {
  await softphone.stop();
  softphone.setElsewhere();
});

/** Registers in this tab, unless another tab has the softphone (then "Use here" forces it). */
async function startSoftphone(force = false) {
  if (force) await takeOver();
  else if (!(await tryLead())) return softphone.setElsewhere();
  await softphone.start(await meApi.webrtc());
}

const STATUS = {
  off: 'Off',
  connecting: 'Connecting…',
  registered: 'Ready',
  error: 'Error',
  elsewhere: 'Active in another tab',
};
const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];
const clean = (s: string) => s.replace(/[^0-9*#+]/g, '');

/** Caller name: extensions (live presence) → my contacts and the company's → the name the caller
 * sent → the number (11 §1). */
function useNameOf() {
  const exts = useLive((s) => s.extensions);
  const contact = useContactName();
  return (c: { remote: string; remoteName: string | null }) =>
    exts[c.remote]?.name ??
    contact(c.remote) ??
    c.remoteName ??
    (c.remote.length > 6 ? formatNumber(c.remote) : c.remote || 'Unknown');
}

/** The spam check for an outside caller (14 §5.1): asked once, as it starts ringing. */
function CallerCheck({ call }: { call: CallInfo }) {
  const contact = useContactName();
  const check = useQuery({
    queryKey: ['caller-check', call.remote],
    queryFn: () => meApi.callerCheck(call.remote),
    enabled: call.direction === 'in' && call.remote.length >= 10 && !contact(call.remote),
    staleTime: Infinity,
    retry: false,
  });
  return <SpamNote check={check.data} />;
}

function useNow(on: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

const elapsed = (from: number, now: number) => {
  const s = Math.max(0, Math.floor((now - from) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export function SoftphoneDock() {
  const { reg, error, calls } = useSoftphone();
  const nameOf = useNameOf();
  const [open, setOpen] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const run = (p: Promise<unknown>) => {
    setProblem(null);
    p.catch((e: Error) => setProblem(e.message));
  };

  useEffect(() => {
    if (remembered() && softphone.state.reg === 'off')
      startSoftphone().catch((e: Error) => setProblem(e.message));
  }, []);

  // Ring while anything is ringing here; tell an unfocused tab with a notification that stays
  // up until the call stops ringing (answered, declined, or the caller hung up).
  const incoming = calls.filter((c) => c.state === 'incoming');
  const ringingIds = incoming.map((c) => c.id).join(',');
  const notified = useRef(new Set<string>());
  useEffect(() => {
    if (ringingIds) startRinging();
    else stopRinging();
    const ringing = softphone.state.calls.filter((x) => x.state === 'incoming');
    for (const id of notified.current) {
      if (ringing.some((c) => c.id === id)) continue;
      closeCallNotes(id);
      notified.current.delete(id);
    }
    for (const c of ringing) {
      if (notified.current.has(c.id)) continue;
      notified.current.add(c.id);
      if (
        !document.hasFocus() &&
        typeof Notification !== 'undefined' &&
        Notification.permission === 'granted'
      )
        notifyCall(c.id, nameOf(c));
    }
  }, [ringingIds, nameOf]);
  useEffect(
    () => () => {
      stopRinging();
      closeCallNotes();
    },
    [],
  );
  // The notification's Answer/Decline buttons (sw.js); stale ids are ignored by the engine.
  useEffect(() => {
    if (!sw) return;
    const onMessage = (e: MessageEvent<{ softphone?: string; id?: string }>) => {
      const { softphone: action, id } = e.data ?? {};
      if (!id) return;
      if (action === 'answer') run(softphone.answer(id));
      else if (action === 'decline') run(softphone.decline(id));
    };
    sw.addEventListener('message', onMessage);
    sw.startMessages();
    return () => sw.removeEventListener('message', onMessage);
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

  const talking = calls.some((c) => c.state !== 'incoming');
  // The big dialog for a call that rings while nothing else is going on; otherwise a card.
  const dialogCall = !talking ? incoming[0] : undefined;

  return (
    <section
      aria-label="Softphone"
      className="sticky bottom-0 mt-auto flex flex-col gap-2 border-t border-zinc-200 bg-white py-3 dark:border-zinc-800 dark:bg-zinc-950"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">
          Softphone: <span role="status">{STATUS[reg]}</span>
        </span>
        <span className="flex-1" />
        {reg === 'off' && (
          <Button variant="primary" onClick={enable}>
            Enable softphone
          </Button>
        )}
        {reg === 'elsewhere' && (
          <Button variant="primary" onClick={() => run(startSoftphone(true))}>
            Use here
          </Button>
        )}
        {(reg === 'registered' || reg === 'connecting' || reg === 'error') && (
          <>
            <Button
              aria-expanded={open}
              aria-controls="sp-panel"
              onClick={() => setOpen((o) => !o)}
            >
              {open ? 'Hide keypad' : 'Keypad'}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                remember(false);
                run(softphone.stop().then(stepDown));
              }}
            >
              Turn off
            </Button>
          </>
        )}
      </div>
      {(problem ?? error) && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {problem ?? error}
        </p>
      )}
      {calls
        .filter((c) => c.id !== dialogCall?.id)
        .map((c) => (
          <CallCard key={c.id} call={c} name={nameOf(c)} onError={setProblem} />
        ))}
      {open && reg === 'registered' && (
        <div id="sp-panel" className="flex flex-col gap-3">
          <Dialer disabled={calls.length >= 2} onCall={(n) => run(softphone.call(n))} />
          <Devices />
        </div>
      )}
      {dialogCall && (
        <IncomingCall
          call={dialogCall}
          name={nameOf(dialogCall)}
          onAnswer={() => run(softphone.answer(dialogCall.id))}
          onDecline={() => run(softphone.decline(dialogCall.id))}
        />
      )}
    </section>
  );
}

// Feather's phone; turned 135° it's the hang-up handset.
const PHONE =
  'M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z';

function RoundButton({
  label,
  color,
  hangUp = false,
  onClick,
}: {
  label: string;
  color: string;
  hangUp?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex flex-col items-center gap-2 rounded-lg text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-sky-500"
    >
      <span
        className={`grid size-16 place-items-center rounded-full text-white transition-transform group-active:scale-95 motion-reduce:transition-none ${color}`}
      >
        <svg
          viewBox="0 0 24 24"
          aria-hidden="true"
          className={`size-7 ${hangUp ? 'rotate-[135deg]' : ''}`}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d={PHONE} />
        </svg>
      </span>
      {label}
    </button>
  );
}

/** The ringing screen: full screen on a phone, a card on wider screens. Esc declines. */
function IncomingCall({
  call,
  name,
  onAnswer,
  onDecline,
}: {
  call: CallInfo;
  name: string;
  onAnswer: () => void;
  onDecline: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby="ring-title"
      onCancel={(e) => {
        e.preventDefault();
        onDecline();
      }}
      className="m-0 h-dvh max-h-none w-full max-w-none bg-white p-0 text-zinc-900 backdrop:bg-black/60 sm:m-auto sm:h-auto sm:max-w-sm sm:rounded-2xl sm:shadow-xl dark:bg-zinc-900 dark:text-zinc-100"
    >
      <div className="flex h-full flex-col items-center justify-between gap-10 px-6 py-16 text-center sm:py-8">
        <div className="flex flex-col items-center gap-2">
          <h2 id="ring-title" className="text-sm font-medium text-zinc-600 dark:text-zinc-400">
            Incoming call
          </h2>
          <p className="text-3xl font-semibold break-words">{name}</p>
          {name !== call.remote && (
            <p className="text-zinc-600 tabular-nums dark:text-zinc-400">
              {call.remote.length > 6 ? formatNumber(call.remote) : call.remote}
            </p>
          )}
          <CallerCheck call={call} />
        </div>
        <div className="flex gap-16">
          <RoundButton label="Decline" color="bg-red-600" hangUp onClick={onDecline} />
          <RoundButton label="Answer" color="bg-emerald-600" onClick={onAnswer} />
        </div>
      </div>
    </dialog>
  );
}

function Keypad({ onKey, label }: { onKey: (k: string) => void; label: string }) {
  return (
    <div role="group" aria-label={label} className="grid w-56 grid-cols-3 gap-1">
      {KEYS.map((k) => (
        <Button key={k} onClick={() => onKey(k)} className="text-lg">
          {k}
        </Button>
      ))}
    </div>
  );
}

function Dialer({ onCall, disabled }: { onCall: (n: string) => void; disabled: boolean }) {
  const [number, setNumber] = useState('');
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (clean(number)) onCall(clean(number));
        setNumber('');
      }}
    >
      <div className="flex gap-2">
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
          // Pasted numbers like "(312) 555-1234" become dialable digits.
          onPaste={(e) => {
            e.preventDefault();
            setNumber((n) => n + clean(e.clipboardData.getData('text')));
          }}
        />
        <Button type="submit" variant="primary" disabled={disabled}>
          Call
        </Button>
      </div>
      <Keypad label="Dialpad" onKey={(k) => setNumber((n) => n + k)} />
    </form>
  );
}

function CallCard({
  call,
  name,
  onError,
}: {
  call: CallInfo;
  name: string;
  onError: (m: string | null) => void;
}) {
  const now = useNow(call.state === 'active');
  const exts = useLive((s) => s.extensions);
  const [keypad, setKeypad] = useState(false);
  const [transfer, setTransfer] = useState(false);
  const [target, setTarget] = useState('');
  const [consultId, setConsultId] = useState<string | null>(null);
  const all = useSoftphone().calls;
  const consult = all.find((c) => c.id === consultId);
  // Held here while talking on another call (call waiting, or "Talk first" from People).
  const other = all.find((c) => c.id !== call.id && c.state === 'active' && !c.held);
  const run = (p: Promise<unknown>) => {
    onError(null);
    p.catch((e: Error) => onError(e.message));
  };
  const label =
    call.state === 'incoming'
      ? 'Incoming call'
      : call.state === 'calling'
        ? 'Calling…'
        : call.held
          ? 'On hold'
          : 'On call';
  const listId = `sp-dir-${call.id}`;

  return (
    <div
      role="group"
      aria-label={`${label}: ${name}`}
      className="flex flex-col gap-2 rounded-md bg-zinc-100 p-2 dark:bg-zinc-900"
      // Drop it on a person in People to transfer it there.
      draggable={call.state === 'active'}
      onDragStart={(e) => e.dataTransfer.setData(CALL_DRAG, call.id)}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex-1 text-sm">
          <span className="font-medium">{name}</span> · {label}
          {call.answeredAt && <> · {elapsed(call.answeredAt, now)}</>}
          {call.poorQuality && (
            <span className="ml-2 text-amber-700 dark:text-amber-400">Poor connection</span>
          )}
          <CallerCheck call={call} />
        </span>
        {call.state === 'incoming' ? (
          <>
            <Button variant="primary" onClick={() => run(softphone.answer(call.id))}>
              Answer
            </Button>
            <Button variant="ghost" onClick={() => run(softphone.decline(call.id))}>
              Decline
            </Button>
          </>
        ) : (
          <>
            {call.held && other && !consultId && (
              <Button
                variant="primary"
                onClick={() => run(softphone.attendedTransfer(call.id, other.id))}
              >
                Complete transfer
              </Button>
            )}
            {call.state === 'active' && (
              <>
                <Button
                  aria-pressed={call.muted}
                  onClick={() => softphone.mute(call.id, !call.muted)}
                >
                  {call.muted ? 'Unmute' : 'Mute'}
                </Button>
                <Button
                  aria-pressed={call.held}
                  onClick={() => run(softphone.hold(call.id, !call.held))}
                >
                  {call.held ? 'Resume' : 'Hold'}
                </Button>
                <Button aria-pressed={keypad} onClick={() => setKeypad((k) => !k)}>
                  Keypad
                </Button>
                <Button aria-pressed={transfer} onClick={() => setTransfer((t) => !t)}>
                  Transfer
                </Button>
              </>
            )}
            <Button variant="danger" onClick={() => run(softphone.hangup(call.id))}>
              Hang up
            </Button>
          </>
        )}
      </div>
      {keypad && call.state === 'active' && (
        <Keypad label="Send tones" onKey={(k) => softphone.dtmf(call.id, k)} />
      )}
      {transfer && call.state === 'active' && (
        <div className="flex flex-col gap-2">
          {consultId ? (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="flex-1">
                Talking to {target} first{consult?.state === 'calling' ? ' (ringing)' : ''}.
              </span>
              <Button
                variant="primary"
                disabled={consult?.state !== 'active'}
                onClick={() => run(softphone.attendedTransfer(call.id, consultId))}
              >
                Complete transfer
              </Button>
              <Button
                onClick={() =>
                  run(
                    softphone.hangup(consultId).then(() => {
                      setConsultId(null);
                      return softphone.hold(call.id, false);
                    }),
                  )
                }
              >
                Cancel
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <label htmlFor={`${listId}-in`} className="sr-only">
                Transfer to
              </label>
              <input
                id={`${listId}-in`}
                className={`${inputClass} max-w-56`}
                list={listId}
                placeholder="Transfer to"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
              />
              <datalist id={listId}>
                {Object.values(exts).map((e) => (
                  <option key={e.number} value={e.number}>
                    {e.name}
                  </option>
                ))}
              </datalist>
              <Button
                disabled={!clean(target)}
                onClick={() => run(softphone.blindTransfer(call.id, clean(target)))}
              >
                Transfer now
              </Button>
              <Button
                disabled={!clean(target)}
                onClick={() => run(softphone.call(clean(target)).then(setConsultId))}
              >
                Talk first
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Devices() {
  const { inputDeviceId, outputDeviceId } = useSoftphone();
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [perm, setPerm] = useState(() =>
    typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
  );
  useEffect(() => {
    const load = () => void navigator.mediaDevices.enumerateDevices().then(setDevices);
    load();
    navigator.mediaDevices.addEventListener('devicechange', load);
    return () => navigator.mediaDevices.removeEventListener('devicechange', load);
  }, []);
  const mics = devices.filter((d) => d.kind === 'audioinput');
  const speakers = devices.filter((d) => d.kind === 'audiooutput');
  const canPickSpeaker = 'setSinkId' in HTMLMediaElement.prototype && speakers.length > 0;
  return (
    <div className="flex flex-wrap items-end gap-3 text-sm">
      <label className="flex flex-col gap-1">
        Microphone
        <select
          className={inputClass}
          value={inputDeviceId ?? ''}
          onChange={(e) => softphone.setInputDevice(e.target.value || null)}
        >
          <option value="">Default</option>
          {mics.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || 'Microphone'}
            </option>
          ))}
        </select>
      </label>
      {canPickSpeaker && (
        <label className="flex flex-col gap-1">
          Speaker
          <select
            className={inputClass}
            value={outputDeviceId ?? ''}
            onChange={(e) => void softphone.setOutputDevice(e.target.value || null)}
          >
            <option value="">Default</option>
            {speakers.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || 'Speaker'}
              </option>
            ))}
          </select>
        </label>
      )}
      {perm === 'default' && (
        <Button onClick={() => void Notification.requestPermission().then(setPerm)}>
          Notify me of calls
        </Button>
      )}
      {perm === 'denied' && (
        <p className="text-zinc-600 dark:text-zinc-400">
          Call notifications are blocked. To get them, allow notifications for this site in your
          browser’s site settings (the icon left of the address), then reload the page.
        </p>
      )}
    </div>
  );
}
