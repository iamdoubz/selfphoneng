// SPDX-License-Identifier: AGPL-3.0-or-later
// Phones (05 §2, 07): desk phones the PBX sets up. Table: MAC, vendor, model, user, last
// provisioned. The drawer shows what to type into the phone, a config preview, and for generic
// phones the manual settings (07 §4).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  DeviceCreateSchema,
  PHONE_VENDORS,
  phoneTimezone,
  type DeviceCreate,
  type DeviceDto,
  type PhoneVendor,
} from '@selfphoneng/shared';
import { devicesApi, extensionsApi, settingsApi } from '../../api/client.ts';
import { ConfirmDialog, Dialog } from '../../components/Dialog.tsx';
import { Alert, Button, Field, inputClass } from '../../components/ui.tsx';

const VENDOR: Record<PhoneVendor, string> = {
  yealink: 'Yealink',
  grandstream: 'Grandstream',
  generic: 'Other (set up by hand)',
};
const fmtMac = (m: string) => m.match(/../g)!.join(':');

export function PhonesPage() {
  const qc = useQueryClient();
  const phones = useQuery({ queryKey: ['devices'], queryFn: devicesApi.list });
  const settings = useQuery({ queryKey: ['settings'], queryFn: settingsApi.get });
  const tz = settings.data?.['general.timezone'];
  const [editing, setEditing] = useState<DeviceDto | 'new' | null>(null);
  const [deleting, setDeleting] = useState<DeviceDto | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['devices'] });
  const remove = useMutation({
    mutationFn: (id: string) => devicesApi.remove(id),
    onSuccess: async () => {
      setDeleting(null);
      await refresh();
    },
  });

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Phones</h1>
        <Button variant="primary" onClick={() => setEditing('new')}>
          Add phone
        </Button>
      </div>
      <p className="max-w-prose text-sm text-zinc-500">
        Add a desk phone by its MAC address (on a sticker under the phone) and it sets itself up:
        account, voicemail and pickup keys.
      </p>
      {tz && !phoneTimezone(tz).supported && (
        <Alert>
          Desk phones don't know the time zone {tz}, so they show UTC. Phones know the US and Canada
          zones, UTC and London.
        </Alert>
      )}
      {phones.isError && <Alert>{phones.error.message}</Alert>}
      {phones.data?.length === 0 && <p className="text-sm text-zinc-500">No phones yet.</p>}
      {phones.data && phones.data.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
          <table className="w-full text-left text-sm">
            <thead className="text-zinc-500">
              <tr>
                <th className="px-3 py-2 font-medium">MAC</th>
                <th className="px-3 py-2 font-medium">Phone</th>
                <th className="px-3 py-2 font-medium">User</th>
                <th className="px-3 py-2 font-medium">Last set up</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {phones.data.map((d) => (
                <tr key={d.id}>
                  <td className="px-3 py-2 font-mono">{fmtMac(d.mac)}</td>
                  <td className="px-3 py-2">
                    {VENDOR[d.vendor].replace(' (set up by hand)', '')} {d.model}
                    {d.label && <span className="text-zinc-500"> · {d.label}</span>}
                  </td>
                  <td className="px-3 py-2">
                    {d.extensionNumber} {d.extensionName}
                  </td>
                  <td className="px-3 py-2 text-zinc-500">
                    {d.lastProvisionedAt
                      ? `${new Date(d.lastProvisionedAt).toLocaleString()} from ${d.lastProvisionedIp}`
                      : 'Never'}
                  </td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    <Button onClick={() => setEditing(d)}>Open</Button>{' '}
                    <Button variant="ghost" onClick={() => setDeleting(d)}>
                      Delete
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <PhoneDrawer
          phone={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async (d) => {
            await refresh();
            setEditing(d);
          }}
        />
      )}
      <ConfirmDialog
        open={deleting !== null}
        title="Delete phone"
        message={
          <p>Delete phone {deleting && fmtMac(deleting.mac)}? It stops getting its settings.</p>
        }
        confirmLabel="Delete"
        busy={remove.isPending}
        error={remove.error?.message}
        onCancel={() => {
          setDeleting(null);
          remove.reset();
        }}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </section>
  );
}

function PhoneDrawer({
  phone,
  onClose,
  onSaved,
}: {
  phone: DeviceDto | null;
  onClose: () => void;
  onSaved: (d: DeviceDto) => Promise<void>;
}) {
  const exts = useQuery({ queryKey: ['extensions'], queryFn: extensionsApi.list });
  const [form, setForm] = useState({
    mac: phone ? fmtMac(phone.mac) : '',
    vendor: phone?.vendor ?? ('yealink' as PhoneVendor),
    model: phone?.model ?? '',
    label: phone?.label ?? '',
    extensionId: phone?.extensionId ?? '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const save = useMutation({
    mutationFn: (body: DeviceCreate) =>
      phone ? devicesApi.update(phone.id, body) : devicesApi.create(body),
    onSuccess: onSaved,
  });

  function submit() {
    const parsed = DeviceCreateSchema.safeParse({
      ...form,
      model: form.model.trim() || null,
      label: form.label.trim() || null,
    });
    if (!parsed.success) {
      setErrors(Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0]), i.message])));
      return;
    }
    setErrors({});
    save.mutate(parsed.data);
  }
  const set = (k: keyof typeof form) => (v: string) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <Dialog
      open
      drawer
      onClose={onClose}
      title={phone ? `Phone ${fmtMac(phone.mac)}` : 'New phone'}
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          <Button variant="primary" onClick={submit} disabled={save.isPending}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {phone && <SetupInfo phone={phone} />}
        <Field label="MAC address" error={errors.mac} hint="Like 00:15:65:ab:cd:ef">
          {(p) => (
            <input
              {...p}
              className={`${inputClass} font-mono`}
              value={form.mac}
              onChange={(e) => set('mac')(e.target.value)}
            />
          )}
        </Field>
        <Field label="Make" error={errors.vendor}>
          {(p) => (
            <select
              {...p}
              className={inputClass}
              value={form.vendor}
              onChange={(e) => set('vendor')(e.target.value)}
            >
              {PHONE_VENDORS.map((v) => (
                <option key={v} value={v}>
                  {VENDOR[v]}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Model" error={errors.model} hint="Optional, like T54W">
          {(p) => (
            <input
              {...p}
              className={inputClass}
              value={form.model}
              onChange={(e) => set('model')(e.target.value)}
            />
          )}
        </Field>
        <Field label="Where it is" error={errors.label} hint="Optional, like Front desk">
          {(p) => (
            <input
              {...p}
              className={inputClass}
              value={form.label}
              onChange={(e) => set('label')(e.target.value)}
            />
          )}
        </Field>
        <Field label="User" error={errors.extensionId}>
          {(p) => (
            <select
              {...p}
              className={inputClass}
              value={form.extensionId}
              onChange={(e) => set('extensionId')(e.target.value)}
            >
              <option value="">Pick a user…</option>
              {exts.data?.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.number} {x.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        {form.vendor === 'grandstream' && (
          <p className="text-sm text-zinc-500">
            Grandstream line keys differ by model, so busy-lamp keys aren't set: add them on the
            phone.
          </p>
        )}
        {save.error && <Alert>{save.error.message}</Alert>}
      </div>
    </Dialog>
  );
}

/** What to type into the phone, or (generic) the settings to enter by hand. */
function SetupInfo({ phone }: { phone: DeviceDto }) {
  const [preview, setPreview] = useState<string | null>(null);
  const load = useMutation({
    mutationFn: () => devicesApi.configPreview(phone.id),
    onSuccess: (r) => setPreview(r.content),
  });
  const creds = useQuery({
    queryKey: ['sip-credentials', phone.extensionId],
    queryFn: () => extensionsApi.credentials(phone.extensionId),
    enabled: phone.vendor === 'generic',
  });
  const row = (k: string, v: string) => (
    <div className="contents">
      <dt className="text-zinc-500">{k}</dt>
      <dd className="font-mono break-all">{v}</dd>
    </div>
  );
  if (phone.vendor === 'generic')
    return (
      <section
        aria-label="Manual settings"
        className="rounded-md bg-zinc-50 p-3 text-sm dark:bg-zinc-900"
      >
        <p className="mb-2">Enter these on the phone:</p>
        {creds.data && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            {row('Server', creds.data.server)}
            {row('Port', String(creds.data.port))}
            {row('Transport', creds.data.transport.toUpperCase())}
            {row('Username', creds.data.username)}
            {row('Password', creds.data.password)}
            {row('Voicemail', '*97')}
            {row('Dial plan', creds.data.dialPlan)}
          </dl>
        )}
      </section>
    );
  return (
    <section
      aria-label="Set up the phone"
      className="rounded-md bg-zinc-50 p-3 text-sm dark:bg-zinc-900"
    >
      <p className="mb-2">
        In the phone's web page (Settings → Auto Provision), or with DHCP option 66, set:
      </p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        {row('Server URL', phone.provisioningUrl)}
        {row('Username', phone.mac)}
        {row('Password', phone.provisioningPassword)}
      </dl>
      <p className="mt-2 text-zinc-500">
        Then reboot the phone.{' '}
        {phone.lastProvisionedAt
          ? 'It last fetched its settings ' +
            new Date(phone.lastProvisionedAt).toLocaleString() +
            '.'
          : 'It hasn’t fetched its settings yet.'}
      </p>
      <div className="mt-2">
        <Button onClick={() => (preview ? setPreview(null) : load.mutate())}>
          {preview ? 'Hide config' : 'Preview config'}
        </Button>
      </div>
      {load.error && <Alert>{load.error.message}</Alert>}
      {preview && (
        <pre
          aria-label="Config preview"
          className="mt-2 max-h-80 overflow-auto rounded bg-white p-2 text-xs dark:bg-zinc-950"
        >
          {preview}
        </pre>
      )}
    </section>
  );
}
