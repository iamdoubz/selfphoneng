// SPDX-License-Identifier: AGPL-3.0-or-later
// /api/settings (04 §7.3) and the dashboard warnings. Admin only.
import { eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  AiEndpointSchema,
  AiTtsEndpointSchema,
  ContrackInputSchema,
  LdapInputSchema,
  OidcInputSchema,
  SettingsSchemas,
  SmtpInputSchema,
  type AiTestResult,
  type AuthMode,
  type Destination,
  type LdapTestResult,
  type OidcInput,
  type OidcTestResult,
  type SettingKey,
  type SettingsDto,
  type Warning,
} from '@selfphoneng/shared';
import type { Db } from '../db/client.ts';
import { dids, extensions, trunks } from '../db/schema.ts';
import { HttpError, badRequest } from '../errors.ts';
import { requireAdmin } from '../auth/guards.ts';
import { encrypt } from '../crypto/secrets.ts';
import { audit } from '../services/audit.ts';
import { assertDestinationExists } from '../services/destinations.ts';
import { getAllSettings, getSetting, setSetting } from '../services/settings.ts';
import { notifyEmergency } from '../services/emergency.ts';
import { readTlsCert } from '../services/tls.ts';
import { backupMissed } from '../services/backup.ts';
import { detectPublicIp } from '../jobs.ts';
import type { SendMail } from '../services/mail.ts';
import { AiError, assertLocalUrl, testEndpoint } from '../ai/client.ts';
import { forgetBook } from '../contacts/contrack.ts';
import { assertLdap, testLdap, type LdapSettings } from '../sso/ldap.ts';
import { directoryUserFor } from '../sso/directory.ts';
import { assertIssuer, oidcConfig, oidcError, testOidc, type OidcSettings } from '../sso/oidc.ts';

declare module 'fastify' {
  interface FastifyInstance {
    /** Decorated by the caller (index.ts: SMTP; tests: a fake). */
    sendMail: SendMail;
  }
}

/** Set by the system itself, never through PATCH. */
const READ_ONLY = new Set<string>([
  'system.restartRequired',
  'system.transportHash',
  'system.directoryWarning',
  'sms.webhookToken',
  'setup.completed',
]);

async function toDto(db: Db): Promise<SettingsDto> {
  const {
    smtp,
    'contacts.contrack': ctk,
    'auth.oidc': oidc,
    'auth.ldap': ldap,
    ...rest
  } = await getAllSettings(db);
  return {
    ...rest,
    'auth.ldap': ldap && {
      enabled: ldap.enabled,
      preset: ldap.preset,
      url: ldap.url,
      startTls: ldap.startTls,
      bindDn: ldap.bindDn,
      baseDn: ldap.baseDn,
      userFilter: ldap.userFilter,
      idAttribute: ldap.idAttribute,
      emailAttribute: ldap.emailAttribute,
      nameAttribute: ldap.nameAttribute,
      adminFilter: ldap.adminFilter,
      hasBindPassword: ldap.bindPasswordEnc !== null,
    },
    'auth.oidc': oidc && {
      label: oidc.label,
      issuer: oidc.issuer,
      clientId: oidc.clientId,
      scopes: oidc.scopes,
      groupsClaim: oidc.groupsClaim,
      adminGroups: oidc.adminGroups,
      allowedGroups: oidc.allowedGroups,
      trustEmail: oidc.trustEmail,
      hasClientSecret: oidc.clientSecretEnc !== null,
    },
    'contacts.contrack': ctk && {
      url: ctk.url,
      publicUrl: ctk.publicUrl,
      hasCompanyToken: ctk.companyTokenEnc !== '',
    },
    smtp: smtp && {
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      username: smtp.username,
      from: smtp.from,
      hasPassword: smtp.passwordEnc !== '',
    },
  };
}

/** References inside settings must point at rows that exist; transports in use stay on. */
async function checkRefs(db: Db, v: Record<string, unknown>) {
  for (const key of ['routing.defaultCallerIdDidId', 'emergency.defaultCallerIdDidId'] as const) {
    const id = v[key] as string | null | undefined;
    if (!id) continue;
    const [d] = await db.select({ id: dids.id }).from(dids).where(eq(dids.id, id));
    if (!d) throw badRequest(`${key}: that phone number does not exist`);
  }
  const ids = v['emergency.notifyExtensionIds'] as string[] | undefined;
  if (ids?.length) {
    const found = await db
      .select({ id: extensions.id })
      .from(extensions)
      .where(inArray(extensions.id, ids));
    if (found.length !== new Set(ids).size)
      throw badRequest('emergency.notifyExtensionIds: one of those extensions does not exist');
  }
  if (v['routing.unmatchedDidDestination'])
    await assertDestinationExists(db, v['routing.unmatchedDidDestination'] as Destination);
  for (const [key, transport] of [
    ['sip.tcpEnabled', 'tcp'],
    ['sip.tlsEnabled', 'tls'],
  ] as const)
    if (v[key] === false) {
      const [t] = await db
        .select({ name: trunks.name })
        .from(trunks)
        .where(eq(trunks.transport, transport));
      if (t) throw badRequest(`Trunk ${t.name} uses ${transport.toUpperCase()}: change it first`);
    }
}

export async function settingsRoutes(app: FastifyInstance) {
  const { db } = app;

  /** The stored form of `auth.ldap`: the bind password is write-only (empty keeps it). */
  async function ldapFromInput(raw: unknown): Promise<LdapSettings | null> {
    if (raw === null) return null;
    const v = LdapInputSchema.parse(raw);
    try {
      assertLdap(v);
    } catch (err) {
      throw badRequest((err as Error).message);
    }
    const old = await getSetting(db, 'auth.ldap');
    return {
      enabled: v.enabled,
      preset: v.preset,
      url: v.url.replace(/\/$/, ''),
      startTls: v.startTls,
      bindDn: v.bindDn,
      bindPasswordEnc: v.bindPassword
        ? encrypt(v.bindPassword)
        : v.clearBindPassword
          ? null
          : (old?.bindPasswordEnc ?? null),
      baseDn: v.baseDn,
      userFilter: v.userFilter,
      idAttribute: v.idAttribute,
      emailAttribute: v.emailAttribute,
      nameAttribute: v.nameAttribute,
      adminFilter: v.adminFilter,
    };
  }

  /** The stored form of `auth.oidc`: the secret is write-only (empty keeps the stored one). */
  async function oidcFromInput(input: OidcInput | null): Promise<OidcSettings | null> {
    if (!input) return null;
    try {
      assertIssuer(input.issuer);
    } catch (err) {
      throw badRequest((err as Error).message);
    }
    const old = await getSetting(db, 'auth.oidc');
    return {
      label: input.label,
      issuer: input.issuer,
      clientId: input.clientId,
      clientSecretEnc: input.clientSecret
        ? encrypt(input.clientSecret)
        : input.clearClientSecret
          ? null
          : (old?.clientSecretEnc ?? null),
      scopes: input.scopes,
      groupsClaim: input.groupsClaim,
      adminGroups: input.adminGroups,
      allowedGroups: input.allowedGroups,
      trustEmail: input.trustEmail,
    };
  }
  app.addHook('preHandler', requireAdmin);

  app.get('/api/settings', () => toDto(db));

  app.patch('/api/settings', async (req) => {
    const body = z.record(z.string(), z.unknown()).parse(req.body);
    const values: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(body)) {
      if (!(key in SettingsSchemas) || READ_ONLY.has(key))
        throw badRequest(`${key} can't be changed here`);
      if (key === 'smtp') {
        // The password is write-only: empty keeps the stored one.
        const input = SmtpInputSchema.nullable().parse(raw);
        const old = await getSetting(db, 'smtp');
        values.smtp = input && {
          host: input.host,
          port: input.port,
          secure: input.secure,
          username: input.username,
          from: input.from,
          passwordEnc: input.password ? encrypt(input.password) : (old?.passwordEnc ?? ''),
        };
      } else if (key === 'contacts.contrack') {
        // The company token is write-only too (11 §4.3).
        const input = ContrackInputSchema.nullable().parse(raw);
        const old = await getSetting(db, 'contacts.contrack');
        if (input)
          try {
            assertLocalUrl(input.url);
          } catch (err) {
            throw badRequest(`Contrack address: ${(err as Error).message}`);
          }
        values[key] = input && {
          url: input.url.replace(/\/+$/, ''),
          publicUrl: input.publicUrl,
          companyTokenEnc: input.companyToken
            ? encrypt(input.companyToken)
            : input.clearCompanyToken
              ? ''
              : (old?.companyTokenEnc ?? ''),
        };
        forgetBook(null);
      } else if (key === 'auth.ldap') {
        values[key] = await ldapFromInput(raw);
      } else if (key === 'auth.oidc') {
        values[key] = await oidcFromInput(raw === null ? null : OidcInputSchema.parse(raw));
      } else values[key] = SettingsSchemas[key as SettingKey].parse(raw);
    }
    await checkRefs(db, values);
    for (const key of ['ai.llm', 'ai.stt', 'ai.tts'] as const) {
      const ep = values[key] as { url: string } | null | undefined;
      try {
        if (ep) assertLocalUrl(ep.url);
      } catch (err) {
        if (err instanceof AiError) throw badRequest(`${key}: ${err.message}`);
        throw err;
      }
    }
    const before = await getAllSettings(db);
    // 12 §1.1: mixed and oidc need a working OpenID Connect setup.
    if ('auth.mode' in values || 'auth.oidc' in values) {
      const mode = (values['auth.mode'] ?? before['auth.mode']) as AuthMode;
      const oidc = (
        'auth.oidc' in values ? values['auth.oidc'] : before['auth.oidc']
      ) as OidcSettings | null;
      if (mode !== 'password') {
        if (!oidc) throw badRequest('Set up OpenID Connect first');
        try {
          await oidcConfig(oidc);
        } catch (err) {
          throw badRequest(`OpenID Connect doesn't work: ${oidcError(err)}`);
        }
      }
    }
    // SIP ports may not land on another listener (Asterisk would fail to start the transport).
    const c = app.config;
    const [sip, tls] = [
      (values['sip.udpPort'] ?? before['sip.udpPort']) as number,
      (values['sip.tlsPort'] ?? before['sip.tlsPort']) as number,
    ];
    for (const port of [sip, tls])
      if ([80, 443, 8088, c.AMI_PORT, c.API_PORT].includes(port))
        throw badRequest(`Port ${port} is already used by SelfPhoneNG`);
      else if (port >= c.RTP_PORT_START && port <= c.RTP_PORT_END)
        throw badRequest(
          `Port ${port} is in the call audio range (${c.RTP_PORT_START}–${c.RTP_PORT_END})`,
        );
    if (sip === tls) throw badRequest('The SIP port and the TLS port must differ');
    if (values['sip.tlsEnabled'] === true && !before['sip.tlsEnabled']) {
      const cert = await readTlsCert(app.config.TLS_DIR);
      if (!cert.ok) throw badRequest(`Can't turn on TLS. ${cert.error}`);
    }
    for (const [key, value] of Object.entries(values))
      await setSetting(db, key as SettingKey, value as never);
    const changed = Object.keys(values).filter(
      (k) => JSON.stringify(before[k as keyof typeof before]) !== JSON.stringify(values[k]),
    );
    if (changed.length) {
      await audit(db, {
        actorUserId: req.user!.id,
        actorIp: req.ip,
        action: 'update',
        entityType: 'settings',
        summary: `Changed settings: ${changed.join(', ')}`,
        diff: {
          before: Object.fromEntries(changed.map((k) => [k, before[k as keyof typeof before]])),
          after: Object.fromEntries(changed.map((k) => [k, values[k]])),
        },
      });
      app.generator.requestApply('api-change');
    }
    return toDto(db);
  });

  app.post('/api/settings/smtp/test', async (req) => {
    const { to } = z.object({ to: z.email() }).parse(req.body);
    try {
      await app.sendMail({
        to: [to],
        subject: 'SelfPhoneNG test email',
        text: 'Email from your phone system works.',
      });
    } catch (e) {
      throw badRequest(`Sending failed: ${(e as Error).message}`);
    }
    return { ok: true };
  });

  /** Settings → Emergency → Test notifications (06 §6.5): email + ring-out, never dials 911. */
  app.post('/api/settings/emergency/test', async (req) => {
    const [ext] = await db.select().from(extensions).where(eq(extensions.userId, req.user!.id));
    const notified = await notifyEmergency(
      { db, ami: app.ami, live: app.live, send: app.sendMail, log: req.log },
      {
        ext: ext?.number ?? '',
        name: req.user!.displayName,
        callerId: 'TEST',
        dialed: '911',
        test: true,
      },
    );
    await audit(db, {
      actorUserId: req.user!.id,
      actorIp: req.ip,
      action: 'emergency_test',
      summary: 'Tested the emergency notifications (nothing was dialed)',
      diff: { after: notified },
    });
    return { notified };
  });

  /**
   * Settings → Sign-in → Directory → Test, from the unsaved form (12 §4.1). The test password
   * is used once and never stored or logged.
   */
  app.post('/api/settings/auth/ldap/test', async (req): Promise<LdapTestResult> => {
    const { testLogin, testPassword, ...form } = LdapInputSchema.extend({
      testLogin: z.string().trim().max(254).optional(),
      testPassword: z.string().max(200).optional(),
    }).parse(req.body);
    const s = (await ldapFromInput(form))!;
    try {
      const r = await testLdap(s, testLogin || undefined, testPassword);
      if (!r.user) return { ok: true, matching: r.matching };
      const matches = await directoryUserFor(db, r.user);
      return {
        ok: true,
        matching: r.matching,
        user: { ...r.user, matches: matches?.email ?? null },
      };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  /** Settings → Sign-in → Test, from the unsaved form (12 §3.1). */
  app.post('/api/settings/auth/oidc/test', async (req): Promise<OidcTestResult> => {
    const s = await oidcFromInput(OidcInputSchema.parse(req.body));
    return testOidc(s!, app.config.PUBLIC_HOSTNAME);
  });

  /** The server's public IPv4, as an outside service sees it (only sent when asked). */
  app.post('/api/settings/network/detect-public-ip', async () => {
    const ip = await detectPublicIp();
    if (ip) return { ip };
    throw new HttpError(502, 'unavailable', "Couldn't detect the public IP. Enter it by hand.");
  });

  // First-run wizard (05 §2.1).
  app.get('/api/setup/status', async () => ({
    completed: await getSetting(db, 'setup.completed'),
  }));
  app.post('/api/setup/complete', async (req) => {
    await setSetting(db, 'setup.completed', true);
    await audit(db, {
      actorUserId: req.user!.id,
      actorIp: req.ip,
      action: 'setup_complete',
      summary: 'Finished the setup wizard',
    });
    return { ok: true };
  });

  /** Settings → AI → Test (spec 10): the values in the form, saved or not. */
  app.post('/api/ai/test', async (req): Promise<AiTestResult> => {
    const { kind } = z.object({ kind: z.enum(['llm', 'stt', 'tts']) }).parse(req.body);
    const ep = (kind === 'tts' ? AiTtsEndpointSchema : AiEndpointSchema).parse(
      (req.body as { endpoint?: unknown }).endpoint,
    );
    return testEndpoint(kind, ep);
  });

  /** The SIP TLS certificate, for Settings → Security (M11-T2). */
  app.get('/api/system/tls', () => readTlsCert(app.config.TLS_DIR));

  /** Things an admin should fix, for the dashboard banner (05 §2). */
  app.get('/api/system/warnings', async (): Promise<{ items: Warning[] }> => {
    const items: Warning[] = [];
    const s = await getAllSettings(db);
    if (s['system.restartRequired'])
      items.push({
        code: 'restart_required',
        message: 'SIP port or transport changes need a telephony restart.',
        link: '/admin/system',
      });
    const [anyTrunk] = await db.select({ id: trunks.id }).from(trunks).limit(1);
    const e911 = s['emergency.defaultCallerIdDidId'];
    if (anyTrunk && !e911)
      items.push({
        code: 'e911_cid_missing',
        message: 'No emergency (E911) caller ID is set. 911 calls may not carry your address.',
        link: '/admin/settings/emergency',
      });
    if (e911) {
      const [d] = await db.select().from(dids).where(eq(dids.id, e911));
      if (d && !d.e911Address)
        items.push({
          code: 'e911_address_unconfirmed',
          message: 'Confirm the emergency caller ID number has an E911 address at voip.ms.',
          link: '/admin/numbers',
        });
    }
    if (s['sip.tlsEnabled']) {
      const cert = await readTlsCert(app.config.TLS_DIR);
      const days = cert.ok ? (Date.parse(cert.notAfter) - Date.now()) / 86_400_000 : 0;
      if (days < 14)
        items.push({
          code: 'tls_cert',
          message: cert.ok
            ? `The SIP TLS certificate ${days < 0 ? 'has expired' : `expires in ${Math.ceil(days)} days`}. Run scripts/tls-cert.sh after renewing it.`
            : `SIP over TLS is on, but: ${cert.error}.`,
          link: '/admin/settings/security',
        });
    }
    if (await backupMissed(app.config, db))
      items.push({
        code: 'backup_old',
        message: "Today's backup hasn't been made. Check the api log, or press Back up now.",
        link: '/admin/settings/backups',
      });
    if (s['system.directoryWarning'])
      items.push({
        code: 'directory_check',
        message: s['system.directoryWarning'],
        link: '/admin/settings/sign-in',
      });
    if (!s.smtp)
      items.push({
        code: 'smtp_missing',
        message: 'Email is not set up, so emergency and voicemail emails can’t be sent.',
        link: '/admin/settings/email',
      });
    return { items };
  });
}
