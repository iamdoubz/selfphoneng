// SPDX-License-Identifier: AGPL-3.0-or-later
// LDAP / LDAPS password check (12 §4) on ldapts: search the person with the service account,
// bind as them with their password, read whether the admin filter matches them.
import {
  AndFilter,
  Client,
  EqualityFilter,
  FilterParser,
  InvalidCredentialsError,
  NoSuchObjectError,
  SizeLimitExceededError,
  escapeFilter,
  type Entry,
} from 'ldapts';
import type { SettingValue } from '@selfphoneng/shared';
import { decrypt } from '../crypto/secrets.ts';

export type LdapSettings = NonNullable<SettingValue<'auth.ldap'>>;

/** The directory can't be asked (down, TLS, a refused service account): not a wrong password. */
export class DirectoryUnavailable extends Error {}

const LOCAL = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);

/** 12 §4.1: no password in clear text over the network, and filters that parse. */
export function assertLdap(s: {
  url: string;
  startTls: boolean;
  userFilter: string;
  adminFilter: string | null;
}): void {
  const u = new URL(s.url);
  if (u.protocol === 'ldaps:' && s.startTls) throw new Error('StartTLS is for ldap:// addresses');
  if (u.protocol === 'ldap:' && !s.startTls && !LOCAL.has(u.hostname))
    throw new Error('ldap:// sends passwords in clear text: use ldaps://, or turn on StartTLS');
  for (const [name, f] of [
    ['User filter', s.userFilter],
    ['Admin filter', s.adminFilter],
  ] as const)
    try {
      if (f) FilterParser.parseString(f.replaceAll('{login}', 'x'));
    } catch (err) {
      throw new Error(`${name}: ${(err as Error).message}`, { cause: err });
    }
}

/** Every {login} replaced by the RFC 4515-escaped value (ldapts escapeFilter). */
export function withLogin(filter: string, login: string): string {
  const parts = filter.split('{login}');
  const strings = Object.assign([...parts], { raw: parts }) as unknown as TemplateStringsArray;
  return escapeFilter(strings, ...parts.slice(1).map(() => login));
}

/** {login} → * : the filter's other conditions (group, disabled bit) without the login (§4.5). */
export const anyLogin = (filter: string) => filter.replaceAll('{login}', '*');

const first = (v: Entry[string] | undefined) => (Array.isArray(v) ? v[0] : v);
/** One attribute as text: binary ids (AD's objectGUID) as lowercase hex (12 §4.4). */
const attr = (e: Entry, name: string): string | null => {
  const v = first(e[name]);
  if (v === undefined) return null;
  return (Buffer.isBuffer(v) ? v.toString('hex') : String(v)) || null;
};

const newClient = (s: LdapSettings) =>
  new Client({ url: s.url, timeout: 5000, connectTimeout: 5000 });

async function startTls(c: Client, s: LdapSettings) {
  if (s.startTls) await c.startTLS({ servername: new URL(s.url).hostname });
}

/** A connection bound as the service account (or anonymous). */
async function connect(s: LdapSettings): Promise<Client> {
  const c = newClient(s);
  try {
    await startTls(c, s);
    if (s.bindDn) {
      // A DN with an empty password is an anonymous "unauthenticated bind" (RFC 4513 §5.1.2).
      if (!s.bindPasswordEnc) throw new Error('The service account has no password');
      await c.bind(s.bindDn, decrypt(s.bindPasswordEnc));
    }
    return c;
  } catch (err) {
    await c.unbind().catch(() => {});
    throw new DirectoryUnavailable(
      err instanceof InvalidCredentialsError
        ? 'The directory refused the service account'
        : (err as Error).message,
    );
  }
}

const attributes = (s: LdapSettings) => [s.idAttribute, s.emailAttribute, s.nameAttribute, 'cn'];
const buffers = (s: LdapSettings) => (s.idAttribute === 'objectGUID' ? ['objectGUID'] : []);

/** The entries `login` matches (at most 2: more than one is as bad as none). */
async function findByLogin(c: Client, s: LdapSettings, login: string): Promise<Entry[]> {
  try {
    const r = await c.search(s.baseDn, {
      scope: 'sub',
      filter: withLogin(s.userFilter, login),
      attributes: attributes(s),
      explicitBufferAttributes: buffers(s),
      sizeLimit: 2,
    });
    return r.searchEntries;
  } catch (err) {
    if (err instanceof SizeLimitExceededError) return [{ dn: '' }, { dn: '' }];
    throw err;
  }
}

export type DirectoryEntry = {
  dn: string;
  /** The stable id attribute's value (12 §4.4). */
  id: string;
  email: string | null;
  name: string | null;
  /** adminFilter's answer; null when there is none (the role is managed here). */
  admin: boolean | null;
};

async function toEntry(c: Client, s: LdapSettings, e: Entry): Promise<DirectoryEntry> {
  const id = attr(e, s.idAttribute);
  if (!id) throw new DirectoryUnavailable(`${e.dn} has no ${s.idAttribute}`);
  let admin: boolean | null = null;
  if (s.adminFilter)
    try {
      const r = await c.search(e.dn, { scope: 'base', filter: s.adminFilter, attributes: ['1.1'] });
      admin = r.searchEntries.length > 0;
    } catch (err) {
      // lldap answers "no such object" when the entry doesn't match a base search's filter.
      if (!(err instanceof NoSuchObjectError)) throw err;
      admin = false;
    }
  return {
    dn: e.dn,
    id,
    email: attr(e, s.emailAttribute),
    name: attr(e, s.nameAttribute) ?? attr(e, 'cn'),
    admin,
  };
}

/** Is this the password of that entry? Its own connection, so the service one stays bound. */
async function passwordWorks(s: LdapSettings, dn: string, password: string): Promise<boolean> {
  const u = newClient(s);
  try {
    await startTls(u, s);
    await u.bind(dn, password);
    return true;
  } catch (err) {
    if (err instanceof InvalidCredentialsError) return false;
    throw new DirectoryUnavailable((err as Error).message);
  } finally {
    await u.unbind().catch(() => {});
  }
}

const unavailable = (err: unknown) =>
  err instanceof DirectoryUnavailable ? err : new DirectoryUnavailable((err as Error).message);

/**
 * 12 §4.2 step 3: the directory entry for this login and password, or null when they don't
 * match exactly one entry with that password. Throws DirectoryUnavailable otherwise.
 */
export async function ldapAuthenticate(
  s: LdapSettings,
  login: string,
  password: string,
): Promise<DirectoryEntry | null> {
  // Never bind with an empty password: many servers take it as anonymous success.
  if (!password) return null;
  const c = await connect(s);
  try {
    const found = await findByLogin(c, s, login);
    if (found.length !== 1) return null;
    if (!(await passwordWorks(s, found[0]!.dn, password))) return null;
    return await toEntry(c, s, found[0]!);
  } catch (err) {
    throw unavailable(err);
  } finally {
    await c.unbind().catch(() => {});
  }
}

/** `(&(<id attribute>=<id>)<userFilter with {login} → *>)`: still there, and still let in (§4.5). */
export function byIdFilter(s: Pick<LdapSettings, 'idAttribute' | 'userFilter'>, id: string) {
  // An object, not a string: ldapts parses "\ff" in a string filter to U+00FF and sends it as
  // UTF-8 (two bytes), so a binary objectGUID would never match. A Buffer goes out as is.
  const value = s.idAttribute === 'objectGUID' ? Buffer.from(id, 'hex') : id;
  return new AndFilter({
    filters: [
      new EqualityFilter({ attribute: s.idAttribute, value }),
      FilterParser.parseString(anyLogin(s.userFilter)),
    ],
  });
}

/**
 * The leaver check (12 §4.5): each id → its entry, when the directory still has it and the user
 * filter still lets it in. One connection for all. Throws DirectoryUnavailable on any failure,
 * so a half-done run never reads as "gone".
 */
export async function lookupIds(
  s: LdapSettings,
  ids: string[],
): Promise<Map<string, DirectoryEntry>> {
  const c = await connect(s);
  try {
    const found = new Map<string, DirectoryEntry>();
    for (const id of ids) {
      const r = await c.search(s.baseDn, {
        scope: 'sub',
        filter: byIdFilter(s, id),
        attributes: attributes(s),
        explicitBufferAttributes: buffers(s),
        sizeLimit: 2,
      });
      if (r.searchEntries.length === 1) found.set(id, await toEntry(c, s, r.searchEntries[0]!));
    }
    return found;
  } catch (err) {
    throw unavailable(err);
  } finally {
    await c.unbind().catch(() => {});
  }
}

/** Settings → Sign-in → Directory → Test (12 §4.1), step by step so it can say which failed. */
export async function testLdap(
  s: LdapSettings,
  login?: string,
  password?: string,
): Promise<{ matching: number; user?: DirectoryEntry }> {
  const c = await connect(s);
  try {
    let matching: number;
    try {
      const r = await c.search(s.baseDn, {
        scope: 'sub',
        filter: anyLogin(s.userFilter),
        attributes: ['1.1'],
        sizeLimit: 1000,
      });
      matching = r.searchEntries.length;
    } catch (err) {
      if (!(err instanceof SizeLimitExceededError)) throw err;
      matching = 1000;
    }
    if (!login) return { matching };
    const found = await findByLogin(c, s, login);
    if (found.length === 0) throw new Error(`No entry under ${s.baseDn} matches "${login}"`);
    if (found.length > 1) throw new Error(`More than one entry matches "${login}"`);
    if (!password || !(await passwordWorks(s, found[0]!.dn, password)))
      throw new Error(`The directory refused the password for ${found[0]!.dn}`);
    return { matching, user: await toEntry(c, s, found[0]!) };
  } finally {
    await c.unbind().catch(() => {});
  }
}
