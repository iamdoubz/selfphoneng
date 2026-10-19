// SPDX-License-Identifier: AGPL-3.0-or-later
// User + extension editor (05 §2). Tabs so far: General, Phone, Calling, Emergency, Credentials.
// Emergency too. Voicemail (M4) and Forwarding (M6) arrive with their features.
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import {
  ExtensionUpdateSchema,
  OUTBOUND_CLASSES,
  formatNumber,
  InternalNumber,
  RoleSchema,
  type ExtensionDto,
  type SipCredentials,
  type UserDto,
} from '@selfphoneng/shared';
import { didsApi, extensionsApi, usersApi } from '../../api/client.ts';
import { CLASS_LABEL } from './OutboundPage.tsx';
import { Dialog } from '../../components/Dialog.tsx';
import { MohOptions } from '../../components/MohOptions.tsx';
import { PhoneAppSetup } from '../../components/PhoneAppSetup.tsx';
import { Alert, Button, Field, inputClass } from '../../components/ui.tsx';

type Tab = 'general' | 'phone' | 'calling' | 'emergency' | 'credentials';

const GeneralSchema = z.object({
  displayName: z.string().trim().min(1, 'Required').max(100),
  email: z.email('Enter a valid email'),
  role: RoleSchema,
  isActive: z.boolean(),
  number: z.union([z.literal(''), InternalNumber]),
});
type GeneralValues = z.infer<typeof GeneralSchema>;

export function UserDrawer({
  user,
  isSelf,
  onClose,
  onSaved,
  onResetPassword,
}: {
  user: UserDto | null;
  isSelf: boolean;
  onClose: () => void;
  onSaved: (created?: { email: string; password: string }) => void;
  onResetPassword: (u: UserDto) => void;
}) {
  const [tab, setTab] = useState<Tab>('general');
  const ext = useQuery({
    queryKey: ['extension', user?.extension?.id],
    queryFn: () => extensionsApi.get(user!.extension!.id),
    enabled: Boolean(user?.extension),
  });
  const tabs: { id: Tab; label: string; enabled: boolean }[] = [
    { id: 'general', label: 'General', enabled: true },
    { id: 'phone', label: 'Phone', enabled: Boolean(ext.data) },
    { id: 'calling', label: 'Calling', enabled: Boolean(ext.data) },
    { id: 'emergency', label: 'Emergency', enabled: Boolean(ext.data) },
    { id: 'credentials', label: 'Credentials', enabled: Boolean(ext.data) },
  ];

  return (
    <Dialog
      open
      drawer
      onClose={onClose}
      title={user ? `Edit ${user.displayName}` : 'New user'}
      footer={
        <>
          <Button onClick={onClose}>{tab === 'credentials' ? 'Close' : 'Cancel'}</Button>
          {tab !== 'credentials' && (
            <Button variant="primary" type="submit" form={`user-${tab}-form`}>
              {user ? 'Save' : 'Create user'}
            </Button>
          )}
        </>
      }
    >
      <div
        role="tablist"
        aria-label="User settings"
        className="mb-4 flex gap-1 border-b border-zinc-200 dark:border-zinc-800"
      >
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            disabled={!t.enabled}
            title={t.enabled ? undefined : 'Give the user an extension number first'}
            onClick={() => setTab(t.id)}
            className={`-mb-px border-b-2 px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:text-zinc-400 ${tab === t.id ? 'border-sky-600' : 'border-transparent hover:border-zinc-300'}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'general' && (
        <GeneralTab
          user={user}
          ext={ext.data ?? null}
          isSelf={isSelf}
          onSaved={onSaved}
          onResetPassword={onResetPassword}
        />
      )}
      {tab === 'phone' && ext.data && <PhoneTab ext={ext.data} onSaved={() => onSaved()} />}
      {tab === 'calling' && ext.data && <CallingTab ext={ext.data} onSaved={() => onSaved()} />}
      {tab === 'emergency' && ext.data && <EmergencyTab ext={ext.data} onSaved={() => onSaved()} />}
      {tab === 'credentials' && ext.data && <CredentialsTab ext={ext.data} />}
    </Dialog>
  );
}

function GeneralTab({
  user,
  ext,
  isSelf,
  onSaved,
  onResetPassword,
}: {
  user: UserDto | null;
  ext: ExtensionDto | null;
  isSelf: boolean;
  onSaved: (created?: { email: string; password: string }) => void;
  onResetPassword: (u: UserDto) => void;
}) {
  const [error, setError] = useState<string>();
  const form = useForm<GeneralValues>({
    resolver: zodResolver(GeneralSchema),
    defaultValues: {
      displayName: user?.displayName ?? '',
      email: user?.email ?? '',
      role: user?.role ?? 'user',
      isActive: user?.isActive ?? true,
      number: user?.extension?.number ?? '',
    },
  });
  const { errors } = form.formState;

  async function nextFree() {
    try {
      const n = await extensionsApi.nextNumber('user');
      if (n) form.setValue('number', n, { shouldValidate: true });
      else setError('The users number range is full');
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const onSubmit = form.handleSubmit(async (v) => {
    setError(undefined);
    try {
      let created: { email: string; password: string } | undefined;
      let userId = user?.id;
      if (user) await usersApi.update(user.id, v);
      else {
        const r = await usersApi.create({
          displayName: v.displayName,
          email: v.email,
          role: v.role,
        });
        userId = r.user.id;
        created = { email: r.user.email, password: r.temporaryPassword };
      }
      // The user's extension: create it, or renumber it.
      if (v.number && !ext)
        await extensionsApi.create({ number: v.number, name: v.displayName, userId });
      else if (ext && v.number && v.number !== ext.number)
        await extensionsApi.update(ext.id, { number: v.number });
      onSaved(created);
    } catch (e) {
      setError((e as Error).message);
    }
  });

  return (
    <form id="user-general-form" onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
      {error && <Alert>{error}</Alert>}
      <Field label="Name" error={errors.displayName?.message}>
        {(a) => <input {...a} {...form.register('displayName')} className={inputClass} />}
      </Field>
      <Field label="Email" error={errors.email?.message}>
        {(a) => <input {...a} {...form.register('email')} type="email" className={inputClass} />}
      </Field>
      <Field
        label="Role"
        error={errors.role?.message}
        hint={
          isSelf ? 'You cannot remove your own admin role if you are the last admin.' : undefined
        }
      >
        {(a) => (
          <select {...a} {...form.register('role')} className={inputClass}>
            <option value="user">User</option>
            <option value="admin">Admin</option>
          </select>
        )}
      </Field>
      <Field
        label="Extension number"
        error={errors.number?.message}
        hint={
          ext
            ? 'Changing it renumbers their phones and voicemail box.'
            : 'Leave empty for a user without a phone.'
        }
      >
        {(a) => (
          <div className="flex gap-2">
            <input {...a} {...form.register('number')} inputMode="numeric" className={inputClass} />
            {!ext && (
              <Button onClick={nextFree} className="shrink-0">
                Next free
              </Button>
            )}
          </div>
        )}
      </Field>
      {user && (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            {...form.register('isActive')}
            className="size-4"
            disabled={isSelf}
          />
          Active (inactive users cannot sign in)
        </label>
      )}
      {user && (
        <div className="border-t border-zinc-200 pt-4 dark:border-zinc-800">
          <Button onClick={() => onResetPassword(user)}>Reset password</Button>
          <p className="mt-1 text-xs text-zinc-500">
            Creates a new temporary password and signs them out everywhere.
          </p>
          {user.twoStep && <ResetTwoStep user={user} />}
        </div>
      )}
    </form>
  );
}

const PhoneSchema = ExtensionUpdateSchema.pick({
  name: true,
  ringSeconds: true,
  webrtcEnabled: true,
  maxContacts: true,
  language: true,
  mohClass: true,
})
  .required()
  .extend({
    pickupGroup: z.union([
      z.literal(''),
      z.string().regex(/^[a-z0-9-]{1,32}$/, 'Lowercase letters, digits and dashes'),
    ]),
    blfNumbers: z
      .string()
      .regex(/^(\s*\d{3,6}\s*(,\s*\d{3,6}\s*)*)?$/, 'Internal numbers separated by commas'),
  });
type PhoneValues = z.input<typeof PhoneSchema>;

function PhoneTab({ ext, onSaved }: { ext: ExtensionDto; onSaved: () => void }) {
  const qc = useQueryClient();
  const [error, setError] = useState<string>();
  const form = useForm<PhoneValues, unknown, z.output<typeof PhoneSchema>>({
    resolver: zodResolver(PhoneSchema),
    defaultValues: {
      name: ext.name,
      ringSeconds: ext.ringSeconds,
      webrtcEnabled: ext.webrtcEnabled,
      maxContacts: ext.maxContacts,
      language: ext.language,
      mohClass: ext.mohClass,
      pickupGroup: ext.pickupGroup ?? '',
      blfNumbers: ext.blfNumbers.join(', '),
    },
  });
  const { errors } = form.formState;
  const num = (label: string, field: 'ringSeconds' | 'maxContacts', hint: string) => (
    <Field label={label} error={errors[field]?.message} hint={hint}>
      {(a) => (
        <input
          {...a}
          {...form.register(field, { valueAsNumber: true })}
          type="number"
          className={inputClass}
        />
      )}
    </Field>
  );

  const onSubmit = form.handleSubmit(async (v) => {
    setError(undefined);
    try {
      await extensionsApi.update(ext.id, {
        ...v,
        pickupGroup: v.pickupGroup || null,
        blfNumbers: v.blfNumbers
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      });
      await qc.invalidateQueries({ queryKey: ['extension', ext.id] });
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  });

  return (
    <form id="user-phone-form" onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
      {error && <Alert>{error}</Alert>}
      <Field
        label="Caller ID name"
        error={errors.name?.message}
        hint="Shown on the phones they call."
      >
        {(a) => <input {...a} {...form.register('name')} className={inputClass} />}
      </Field>
      {num(
        'Ring time (seconds)',
        'ringSeconds',
        'How long their phones ring before voicemail (5–120).',
      )}
      {num(
        'Max devices',
        'maxContacts',
        'Desk phones and apps registered at the same time (1–10).',
      )}
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" {...form.register('webrtcEnabled')} className="size-4" />
        Browser softphone
      </label>
      <Field
        label="Pickup group"
        error={errors.pickupGroup?.message}
        hint="Phones in the same group can answer each other with *8."
      >
        {(a) => (
          <input
            {...a}
            {...form.register('pickupGroup')}
            placeholder="sales"
            className={inputClass}
          />
        )}
      </Field>
      <Field
        label="BLF keys"
        error={errors.blfNumbers?.message}
        hint="Extensions whose status shows on their phones, e.g. 101, 102."
      >
        {(a) => <input {...a} {...form.register('blfNumbers')} className={inputClass} />}
      </Field>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Language" error={errors.language?.message}>
          {(a) => <input {...a} {...form.register('language')} className={inputClass} />}
        </Field>
        <Field label="Music on hold" error={errors.mohClass?.message}>
          {(a) => (
            <select {...a} {...form.register('mohClass')} className={inputClass}>
              <MohOptions current={ext.mohClass} />
            </select>
          )}
        </Field>
      </div>
    </form>
  );
}

function CredentialsTab({ ext }: { ext: ExtensionDto }) {
  const [creds, setCreds] = useState<SipCredentials | null>(null);
  const [error, setError] = useState<string>();
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState(false);

  const reveal = async () => {
    setError(undefined);
    try {
      setCreds(await extensionsApi.credentials(ext.id));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const regenerate = async () => {
    setError(undefined);
    try {
      await extensionsApi.regenerateSipPassword(ext.id);
      setConfirming(false);
      setDone(true);
      if (creds) await reveal();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const row = (label: string, value: ReactNode) => (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
      <dt className="w-28 shrink-0 text-zinc-500">{label}</dt>
      <dd className="font-mono break-all">{value}</dd>
    </div>
  );

  return (
    <div className="flex flex-col gap-4 text-sm">
      {error && <Alert>{error}</Alert>}
      <p className="text-zinc-600 dark:text-zinc-400">
        Use these to set up a desk phone or softphone by hand. Viewing the password is recorded in
        the audit log.
      </p>
      <dl className="flex flex-col gap-2">
        {row(
          'Server',
          creds ? `${creds.server}:${creds.port} (${creds.transport.toUpperCase()})` : '••••',
        )}
        {row('Username', ext.number)}
        {row('Password', creds ? creds.password : '••••••••••••••••••••••••')}
        {ext.webrtcEnabled && row('Browser', `${ext.number}-web (used by the built-in softphone)`)}
      </dl>
      {!creds && (
        <Button onClick={reveal} className="self-start">
          Reveal password
        </Button>
      )}
      <div className="border-t border-zinc-200 pt-4 dark:border-zinc-800">
        {!confirming ? (
          <Button onClick={() => setConfirming(true)}>New SIP password</Button>
        ) : (
          <div className="flex flex-col gap-2">
            <p>Every phone using the old password stops working until you update it. Continue?</p>
            <div className="flex gap-2">
              <Button variant="danger" onClick={regenerate}>
                Yes, make a new password
              </Button>
              <Button onClick={() => setConfirming(false)}>Cancel</Button>
            </div>
          </div>
        )}
        {done && <p className="mt-2 text-green-700 dark:text-green-400">New password saved.</p>}
      </div>
      <div className="border-t border-zinc-200 pt-4 dark:border-zinc-800">
        <h3 className="mb-2 font-medium">Phone app</h3>
        <PhoneAppSetup load={() => extensionsApi.softphoneQr(ext.id)} />
      </div>
    </div>
  );
}

function CallingTab({ ext, onSaved }: { ext: ExtensionDto; onSaved: () => void }) {
  const qc = useQueryClient();
  const dids = useQuery({ queryKey: ['dids'], queryFn: didsApi.list });
  const [error, setError] = useState<string>();
  const form = useForm({
    defaultValues: {
      outboundClass: ext.outboundClass,
      outboundCallerIdDidId: ext.outboundCallerIdDidId ?? '',
    },
  });
  const onSubmit = form.handleSubmit(async (v) => {
    setError(undefined);
    try {
      await extensionsApi.update(ext.id, {
        outboundClass: v.outboundClass,
        outboundCallerIdDidId: v.outboundCallerIdDidId || null,
      });
      await qc.invalidateQueries({ queryKey: ['extension', ext.id] });
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  });
  return (
    <form id="user-calling-form" onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
      {error && <Alert>{error}</Alert>}
      <Field
        label="Calling permission"
        hint="Which outside numbers they may dial. 911 always works, whatever this says."
      >
        {(a) => (
          <select {...a} {...form.register('outboundClass')} className={inputClass}>
            {OUTBOUND_CLASSES.map((c) => (
              <option key={c} value={c}>
                {CLASS_LABEL[c]}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field
        label="Outbound caller ID"
        hint="The number people see when they call out. Default: the company's main number."
      >
        {(a) => (
          <select {...a} {...form.register('outboundCallerIdDidId')} className={inputClass}>
            <option value="">Company default</option>
            {dids.data?.map((d) => (
              <option key={d.id} value={d.id}>
                {formatNumber(d.number)}
                {d.label ? ` (${d.label})` : ''}
              </option>
            ))}
          </select>
        )}
      </Field>
    </form>
  );
}

function EmergencyTab({ ext, onSaved }: { ext: ExtensionDto; onSaved: () => void }) {
  const qc = useQueryClient();
  const dids = useQuery({ queryKey: ['dids'], queryFn: didsApi.list });
  const [error, setError] = useState<string>();
  const form = useForm({
    defaultValues: {
      emergencyCallerIdDidId: ext.emergencyCallerIdDidId ?? '',
      emergencyLocation: ext.emergencyLocation ?? '',
    },
  });
  const onSubmit = form.handleSubmit(async (v) => {
    setError(undefined);
    try {
      await extensionsApi.update(ext.id, {
        emergencyCallerIdDidId: v.emergencyCallerIdDidId || null,
        emergencyLocation: v.emergencyLocation.trim() || null,
      });
      await qc.invalidateQueries({ queryKey: ['extension', ext.id] });
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  });
  return (
    <form id="user-emergency-form" onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
      {error && <Alert>{error}</Alert>}
      <Field
        label="Emergency caller ID"
        hint="A number whose E911 address at voip.ms is where this person works. Default: the company emergency caller ID."
      >
        {(a) => (
          <select {...a} {...form.register('emergencyCallerIdDidId')} className={inputClass}>
            <option value="">Company default</option>
            {dids.data?.map((d) => (
              <option key={d.id} value={d.id}>
                {formatNumber(d.number)}
                {d.label ? ` (${d.label})` : ''}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field
        label="Location"
        hint="For example: 2nd floor, room 210. Goes into the alert email; 911 can't receive it."
      >
        {(a) => <input {...a} {...form.register('emergencyLocation')} className={inputClass} />}
      </Field>
    </form>
  );
}

/** For a user who lost their phone and recovery codes (08 §2.4). */
function ResetTwoStep({ user }: { user: UserDto }) {
  const qc = useQueryClient();
  const reset = useMutation({
    mutationFn: () => usersApi.resetTwoStep(user.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
  });
  return (
    <div className="mt-4">
      {reset.isSuccess ? (
        <p className="text-sm text-green-700 dark:text-green-400">Two-step sign-in is off.</p>
      ) : (
        <Button onClick={() => reset.mutate()} disabled={reset.isPending}>
          Turn off two-step sign-in
        </Button>
      )}
      <p className="mt-1 text-xs text-zinc-500">
        For a lost phone: they sign in with their password alone and can turn it on again.
      </p>
      {reset.error && <Alert>{reset.error.message}</Alert>}
    </div>
  );
}
