// SPDX-License-Identifier: AGPL-3.0-or-later
// Contacts (spec 11): my book with the company's (read-only) at /me/contacts, the company's at
// /admin/contacts. Add, edit, import (.vcf, .csv), share (an offer the colleague accepts or
// denies), click to call. useContactName() gives every page names for numbers.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import {
  formatNumber,
  normalizeNumber,
  type ContactDto,
  type ContactImportResult,
  type ContactInput,
} from '@selfphoneng/shared';
import { contactsApi, type ContactBase } from '../../api/client.ts';
import { Dialog, ConfirmDialog } from '../../components/Dialog.tsx';
import { Alert, Button, Field, inputClass } from '../../components/ui.tsx';
import { useLive } from '../../live/store.ts';
import { useMe } from './MeSettingsPage.tsx';
import { useCallBack } from './MyCallsPage.tsx';

const MINE: ContactBase = '/api/me/contacts';
const COMPANY: ContactBase = '/api/contacts';
const key = (base: ContactBase) => ['contacts', base];
const show = (n: string) => (n.length > 6 ? formatNumber(n) : n);

/** Name for a number from my book, then the company's (11 §1); undefined when there's none. */
export function useContactName() {
  const list = useQuery({ queryKey: key(MINE), queryFn: () => contactsApi.list(MINE) });
  const names = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of list.data?.items ?? [])
      for (const n of c.numbers) if (!m.has(n.number)) m.set(n.number, c.name);
    return m;
  }, [list.data]);
  return (number: string | null | undefined) => {
    if (!number) return undefined;
    try {
      return names.get(normalizeNumber(number)) ?? names.get(number);
    } catch {
      return names.get(number);
    }
  };
}

/** "Add to contacts" from a call or a voicemail: the drawer, filled with the number. */
export function AddToContacts({ number, name }: { number: string; name?: string | null }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="ghost" className="px-2 py-1 text-xs" onClick={() => setOpen(true)}>
        Add to contacts
      </Button>
      {open && (
        <ContactDrawer
          base={MINE}
          contact={{ name: name ?? '', numbers: [{ label: 'mobile', number: show(number) }] }}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

export function ContactsPage() {
  return (
    <div className="flex flex-col gap-8">
      <SharedWithYou />
      <ContactBook base={MINE} title="Contacts" />
    </div>
  );
}

export function CompanyContactsPage() {
  return <ContactBook base={COMPANY} title="Company contacts" />;
}

function ContactBook({ base, title }: { base: ContactBase; title: string }) {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: key(base), queryFn: () => contactsApi.list(base) });
  const { call, note } = useCallBack();
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<(ContactInput & { id?: string }) | null>(null);
  const [deleting, setDeleting] = useState<ContactDto | null>(null);
  const [importing, setImporting] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [sharing, setSharing] = useState(false);
  const remove = useMutation({
    mutationFn: (id: string) => contactsApi.remove(base, id),
    onSuccess: async () => {
      setDeleting(null);
      await qc.invalidateQueries({ queryKey: ['contacts'] });
    },
  });
  const words = q.trim().toLowerCase();
  const digits = q.replace(/\D/g, '');
  // ponytail: the whole book is loaded and filtered here; page it on the server if books get huge.
  const ctk = list.data?.contrack ?? null;
  const shown = (list.data?.items ?? []).filter(
    (c) =>
      !words ||
      `${c.name} ${c.company ?? ''} ${c.email ?? ''}`.toLowerCase().includes(words) ||
      (digits.length >= 3 && c.numbers.some((n) => n.number.includes(digits))),
  );
  const canShare = base === MINE;
  // Contrack mode: contacts are changed in Contrack, so rows link there (11 §4.3).
  const mine = (c: ContactDto) => !c.url && (base === COMPANY || c.book === 'mine');

  return (
    <section aria-labelledby="contacts-h" className="flex flex-col gap-3">
      <h2 id="contacts-h" className="text-lg font-semibold">
        {title}
      </h2>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          aria-label="Search contacts"
          placeholder="Search names, companies, numbers"
          className={`${inputClass} max-w-72`}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <Button
          variant="primary"
          onClick={() => setEditing({ name: '', numbers: [{ label: 'mobile', number: '' }] })}
        >
          Add contact
        </Button>
        {!ctk ? (
          <Button onClick={() => setImporting(true)}>Import</Button>
        ) : (
          ctk.publicUrl && (
            <a
              href={ctk.publicUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center rounded-md border border-zinc-300 px-3 py-2 text-sm font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
            >
              Import in Contrack
            </a>
          )
        )}
        {canShare && (
          <Button disabled={!picked.size} onClick={() => setSharing(true)}>
            Share{picked.size ? ` (${picked.size})` : ''}
          </Button>
        )}
      </div>
      {note && (
        <p role="status" className="text-sm text-zinc-600 dark:text-zinc-400">
          {note}
        </p>
      )}
      {list.error && <Alert>{list.error.message}</Alert>}
      {ctk && !ctk.connected && (
        <Alert>
          {ctk.error ??
            (base === MINE
              ? 'Your contacts are in Contrack: connect your account in Settings → Contacts to see and add them.'
              : 'The company Contrack account has no token yet: Settings → Contacts.')}
        </Alert>
      )}
      {list.data && shown.length === 0 && (
        <p className="text-sm text-zinc-500">
          {q ? 'No contact matches that.' : 'No contacts yet.'}
        </p>
      )}
      <ul className="divide-y divide-zinc-100 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
        {shown.map((c) => (
          <li key={c.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
            {canShare && (
              <input
                type="checkbox"
                aria-label={`Pick ${c.name} to share`}
                disabled={c.book !== 'mine'}
                checked={picked.has(c.id)}
                onChange={(e) => {
                  const next = new Set(picked);
                  if (e.target.checked) next.add(c.id);
                  else next.delete(c.id);
                  setPicked(next);
                }}
              />
            )}
            <span className="min-w-40 flex-1">
              <span className="font-medium">{c.name}</span>
              {c.company && <span className="text-zinc-500"> · {c.company}</span>}
              {base === MINE && c.book === 'company' && (
                <span className="ml-2 rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                  Company
                </span>
              )}
            </span>
            <span className="flex flex-wrap gap-x-3">
              {c.numbers.map((n) => (
                <button
                  key={n.number}
                  type="button"
                  className="text-sky-700 underline dark:text-sky-400"
                  aria-label={`Call ${c.name} ${n.label} ${show(n.number)}`}
                  onClick={() => call(n.number)}
                >
                  {n.label && <span className="text-zinc-500 no-underline">{n.label} </span>}
                  {show(n.number)}
                </button>
              ))}
            </span>
            {c.url && (
              <a
                href={c.url}
                target="_blank"
                rel="noreferrer"
                className="text-sky-700 underline dark:text-sky-400"
              >
                Open in Contrack
              </a>
            )}
            {mine(c) && (
              <span className="flex gap-1">
                <Button variant="ghost" className="px-2 py-1" onClick={() => setEditing(c)}>
                  Edit
                </Button>
                <Button variant="ghost" className="px-2 py-1" onClick={() => setDeleting(c)}>
                  Delete
                </Button>
              </span>
            )}
          </li>
        ))}
      </ul>
      {editing && (
        <ContactDrawer
          base={base}
          contact={{
            ...editing,
            numbers: editing.numbers?.map((n) => ({ ...n, number: show(n.number) })),
          }}
          onClose={() => setEditing(null)}
        />
      )}
      {importing && <ImportDialog base={base} onClose={() => setImporting(false)} />}
      {sharing && (
        <ShareDialog
          ids={[...picked]}
          onClose={(done) => {
            setSharing(false);
            if (done) setPicked(new Set());
          }}
        />
      )}
      <ConfirmDialog
        open={deleting !== null}
        title="Delete contact"
        message={<p>Delete {deleting?.name}? This can't be undone.</p>}
        confirmLabel="Delete"
        busy={remove.isPending}
        error={remove.error?.message}
        onCancel={() => setDeleting(null)}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </section>
  );
}

const LABELS = ['mobile', 'work', 'home', 'main', 'fax', 'other'];

function ContactDrawer(props: {
  base: ContactBase;
  contact: ContactInput & { id?: string };
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { id, ...start } = props.contact;
  const [form, setForm] = useState({
    name: start.name,
    company: start.company ?? '',
    email: start.email ?? '',
    notes: start.notes ?? '',
    numbers: start.numbers?.length
      ? start.numbers.map((n) => ({ label: n.label ?? '', number: n.number }))
      : [{ label: 'mobile', number: '' }],
  });
  const save = useMutation({
    mutationFn: () => {
      const c = { ...form, numbers: form.numbers.filter((n) => n.number.trim()) };
      return id ? contactsApi.update(props.base, id, c) : contactsApi.create(props.base, c);
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['contacts'] });
      props.onClose();
    },
  });
  const setNumber = (i: number, patch: Partial<{ label: string; number: string }>) =>
    setForm({ ...form, numbers: form.numbers.map((n, j) => (j === i ? { ...n, ...patch } : n)) });
  return (
    <Dialog
      open
      drawer
      title={id ? 'Edit contact' : 'Add contact'}
      onClose={props.onClose}
      footer={
        <>
          <Button onClick={props.onClose}>Cancel</Button>
          <Button variant="primary" form="contact-form" type="submit" disabled={save.isPending}>
            Save
          </Button>
        </>
      }
    >
      <form
        id="contact-form"
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        {(['name', 'company', 'email'] as const).map((k) => (
          <Field key={k} label={k[0]!.toUpperCase() + k.slice(1)}>
            {(p) => (
              <input
                {...p}
                className={inputClass}
                required={k === 'name'}
                type={k === 'email' ? 'email' : 'text'}
                value={form[k]}
                onChange={(e) => setForm({ ...form, [k]: e.target.value })}
              />
            )}
          </Field>
        ))}
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">Numbers</legend>
          {form.numbers.map((n, i) => (
            <div key={i} className="flex gap-2">
              <select
                aria-label={`Number ${i + 1} label`}
                className={`${inputClass} w-28`}
                value={n.label || 'other'}
                onChange={(e) => setNumber(i, { label: e.target.value })}
              >
                {[...new Set([...LABELS, n.label].filter(Boolean))].map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
              <input
                aria-label={`Number ${i + 1}`}
                inputMode="tel"
                className={inputClass}
                placeholder="(312) 555-1234"
                value={n.number}
                onChange={(e) => setNumber(i, { number: e.target.value })}
              />
              <Button
                variant="ghost"
                aria-label={`Remove number ${i + 1}`}
                onClick={() =>
                  setForm({ ...form, numbers: form.numbers.filter((_, j) => j !== i) })
                }
              >
                ✕
              </Button>
            </div>
          ))}
          <div>
            <Button
              variant="ghost"
              onClick={() =>
                setForm({ ...form, numbers: [...form.numbers, { label: 'work', number: '' }] })
              }
            >
              Add a number
            </Button>
          </div>
        </fieldset>
        <Field label="Notes">
          {(p) => (
            <textarea
              {...p}
              rows={3}
              className={inputClass}
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
            />
          )}
        </Field>
        {save.error && <Alert>{save.error.message}</Alert>}
      </form>
    </Dialog>
  );
}

function ImportDialog({ base, onClose }: { base: ContactBase; onClose: () => void }) {
  const qc = useQueryClient();
  const [files, setFiles] = useState<{ name: string; text: string }[]>([]);
  const [preview, setPreview] = useState<ContactImportResult | null>(null);
  const run = useMutation({
    mutationFn: (commit: boolean) => contactsApi.import(base, files, commit),
    onSuccess: async (r) => {
      setPreview(r);
      if (r.committed) await qc.invalidateQueries({ queryKey: ['contacts'] });
    },
  });
  const done = preview?.committed;
  return (
    <Dialog
      open
      title={base === COMPANY ? 'Import company contacts' : 'Import contacts'}
      onClose={onClose}
      footer={
        done ? (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!preview || !preview.added || run.isPending}
              onClick={() => run.mutate(true)}
            >
              Import {preview?.added ?? ''}
            </Button>
          </>
        )
      }
    >
      <div className="flex flex-col gap-3 text-sm">
        <p className="text-zinc-600 dark:text-zinc-400">
          vCard files (.vcf) from a phone, Google Contacts, Outlook or Apple Contacts, or a CSV with
          a header row: name, company, email, label1, number1, label2, number2…
        </p>
        <input
          type="file"
          multiple
          accept=".vcf,.csv,text/vcard,text/csv"
          aria-label="Contact files"
          disabled={done}
          onChange={async (e) => {
            const picked = [...(e.target.files ?? [])];
            const read = await Promise.all(
              picked.map(async (f) => ({ name: f.name, text: await f.text() })),
            );
            setFiles(read);
            setPreview(null);
            if (read.length) run.mutate(false);
          }}
        />
        {run.isPending && <p className="text-zinc-500">Reading…</p>}
        {preview && (
          <div role="status" className="flex flex-col gap-1">
            <p>
              {done ? 'Imported' : 'New'}: <strong>{preview.added}</strong>
              {preview.duplicates > 0 && <> · already in the book, skipped: {preview.duplicates}</>}
              {preview.noNumber > 0 && <> · without a phone number: {preview.noNumber}</>}
            </p>
            {preview.errors.length > 0 && (
              <ul className="list-disc pl-5 text-amber-800 dark:text-amber-300">
                {preview.errors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        {run.error && <Alert>{run.error.message}</Alert>}
      </div>
    </Dialog>
  );
}

function ShareDialog({ ids, onClose }: { ids: string[]; onClose: (done: boolean) => void }) {
  const people = Object.values(useLive((s) => s.extensions)).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const myNumber = useMe().data?.extension.number;
  const [everyone, setEveryone] = useState(false);
  const [to, setTo] = useState<Set<string>>(new Set());
  const share = useMutation({
    mutationFn: () => contactsApi.share({ contactIds: ids, everyone, extensions: [...to] }),
  });
  return (
    <Dialog
      open
      title={`Share ${ids.length} contact${ids.length === 1 ? '' : 's'}`}
      onClose={() => onClose(share.isSuccess)}
      footer={
        share.isSuccess ? (
          <Button variant="primary" onClick={() => onClose(true)}>
            Done
          </Button>
        ) : (
          <>
            <Button onClick={() => onClose(false)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={(!everyone && !to.size) || share.isPending}
              onClick={() => share.mutate()}
            >
              Share
            </Button>
          </>
        )
      }
    >
      {share.isSuccess ? (
        <p role="status" className="text-sm">
          Sent to {share.data.people} {share.data.people === 1 ? 'person' : 'people'}. They'll see
          it under "Shared with you" and choose to accept or deny it.
        </p>
      ) : (
        <div className="flex flex-col gap-2 text-sm">
          <p className="text-zinc-600 dark:text-zinc-400">
            Each person gets a copy to accept into their own contacts, or deny.
          </p>
          <label className="flex items-center gap-2 font-medium">
            <input
              type="checkbox"
              checked={everyone}
              onChange={(e) => setEveryone(e.target.checked)}
            />
            Everyone in the company
          </label>
          {!everyone &&
            people
              .filter((p) => p.number !== myNumber)
              .map((p) => (
                <label key={p.number} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={to.has(p.number)}
                    onChange={(e) => {
                      const next = new Set(to);
                      if (e.target.checked) next.add(p.number);
                      else next.delete(p.number);
                      setTo(next);
                    }}
                  />
                  {p.name} <span className="text-zinc-500">({p.number})</span>
                </label>
              ))}
          {share.error && <Alert>{share.error.message}</Alert>}
        </div>
      )}
    </Dialog>
  );
}

/** Pending offers from colleagues: nothing is added until Accept (11 §2.1). */
export function useContactShares() {
  return useQuery({ queryKey: ['contacts', 'shares'], queryFn: contactsApi.shares });
}

function SharedWithYou() {
  const qc = useQueryClient();
  const shares = useContactShares();
  const [result, setResult] = useState<string | null>(null);
  const decide = useMutation({
    mutationFn: ({ decision, ids }: { decision: 'accept' | 'deny'; ids: string[] }) =>
      contactsApi.decide(decision, ids),
    onSuccess: async (r) => {
      setResult(
        r.added !== undefined
          ? `Added ${r.added}${r.duplicates ? `; ${r.duplicates} you already had` : ''}.`
          : `Denied ${r.denied}.`,
      );
      await qc.invalidateQueries({ queryKey: ['contacts'] });
    },
  });
  if (!shares.data?.length && !result) return null;
  const bySender = new Map<string, typeof shares.data>();
  for (const s of shares.data ?? []) {
    const k = s.from?.name ?? 'Someone who left';
    bySender.set(k, [...(bySender.get(k) ?? []), s]);
  }
  return (
    <section
      aria-labelledby="shared-h"
      className="flex flex-col gap-3 rounded-lg border border-sky-200 bg-sky-50 p-3 dark:border-sky-900 dark:bg-sky-950"
    >
      <h2 id="shared-h" className="text-lg font-semibold">
        Shared with you
      </h2>
      {result && (
        <p role="status" className="text-sm">
          {result}
        </p>
      )}
      {[...bySender].map(([from, list]) => (
        <div key={from} className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">From {from}</span>
            {list!.length > 1 && (
              <>
                <Button
                  className="px-2 py-1"
                  disabled={decide.isPending}
                  onClick={() => decide.mutate({ decision: 'accept', ids: list!.map((s) => s.id) })}
                >
                  Accept all {list!.length}
                </Button>
                <Button
                  variant="ghost"
                  className="px-2 py-1"
                  disabled={decide.isPending}
                  onClick={() => decide.mutate({ decision: 'deny', ids: list!.map((s) => s.id) })}
                >
                  Deny all
                </Button>
              </>
            )}
          </div>
          <ul className="flex flex-col gap-1">
            {list!.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="flex-1">
                  {s.contact.name}
                  {s.contact.company && (
                    <span className="text-zinc-500"> · {s.contact.company}</span>
                  )}
                  {s.contact.numbers.map((n) => (
                    <span key={n.number} className="text-zinc-500">
                      {' '}
                      · {show(n.number)}
                    </span>
                  ))}
                </span>
                <Button
                  variant="primary"
                  className="px-2 py-1"
                  disabled={decide.isPending}
                  onClick={() => decide.mutate({ decision: 'accept', ids: [s.id] })}
                >
                  Accept
                </Button>
                <Button
                  className="px-2 py-1"
                  disabled={decide.isPending}
                  onClick={() => decide.mutate({ decision: 'deny', ids: [s.id] })}
                >
                  Deny
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ))}
      {decide.error && <Alert>{decide.error.message}</Alert>}
    </section>
  );
}
