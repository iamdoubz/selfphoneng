// SPDX-License-Identifier: AGPL-3.0-or-later
// "Set up a phone app" (07 §5): recommended apps, a Linphone setup QR (24 h), and the plain
// truth about mobile apps without push. Used on /me/settings and the admin Credentials tab.
import { useMutation } from '@tanstack/react-query';
import type { SoftphoneQr } from '@selfphoneng/shared';
import { Alert, Button } from './ui.tsx';

export function PhoneAppSetup({ load }: { load: () => Promise<SoftphoneQr> }) {
  const qr = useMutation({ mutationFn: load });
  return (
    <div className="flex flex-col gap-3 text-sm">
      <p>
        <strong>Linphone</strong> (Android, iPhone, Windows, Mac, Linux) sets itself up from a QR
        code: in the app, choose <em>Fetch remote configuration</em> (or <em>Scan QR code</em>) and
        point the camera at the code below. On a computer, paste the link instead.
      </p>
      <p className="text-zinc-600 dark:text-zinc-400">
        <strong>MicroSIP</strong> (Windows) and <strong>Baresip</strong> (Linux) work too, set up by
        hand: an admin can see the server, user name and password.
      </p>
      {!qr.data ? (
        <Button className="self-start" onClick={() => qr.mutate()} disabled={qr.isPending}>
          Show setup QR code
        </Button>
      ) : (
        <div className="flex flex-col gap-2">
          <img
            src={qr.data.qr}
            alt="Linphone setup QR code"
            width={280}
            height={280}
            className="rounded bg-white"
          />
          <p className="font-mono text-xs break-all">{qr.data.url}</p>
          <p className="text-xs text-zinc-500">
            Works until {new Date(qr.data.expiresAt).toLocaleString()}. It carries your phone
            password: don't share it.
          </p>
        </div>
      )}
      {qr.error && <Alert>{qr.error.message}</Alert>}
      <p className="text-xs text-zinc-500">
        On a mobile phone, apps can miss calls while they're in the background (iPhones and
        battery-saving Android phones stop them). For calls you can't miss, use a desk phone or this
        browser, or forward unanswered calls to your mobile number.
      </p>
    </div>
  );
}
