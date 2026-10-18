// SPDX-License-Identifier: AGPL-3.0-or-later
// SIP trunk as the API accepts and returns it (02, 04 §7.3, 06 §2). Patterns match the generator's
// sanitizers (03 §2) so valid input always renders.
import { z } from 'zod';

/** A hostname or IPv4 address (same rule as the generator's `host` sanitizer). */
export const Hostname = z
  .string()
  .trim()
  .regex(
    /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/,
    'A hostname like chicago1.voip.ms',
  );
const SipUser = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_.-]{1,64}$/, 'Letters, digits, _ . and - only');
const Password = z
  .string()
  .min(1, 'Required')
  .max(128)
  // Goes into pjsip.conf verbatim: no line breaks, no ';' (comment) and no leading/trailing space.
  .regex(/^[^\s;](?:[^\r\n;]*[^\s;])?$/, 'No semicolons, line breaks or surrounding spaces');

export const CODECS = ['ulaw', 'alaw', 'g722'] as const;

const TrunkFields = z.object({
  name: z.string().trim().min(1, 'Required').max(40),
  provider: z.enum(['voipms', 'generic']),
  enabled: z.boolean(),
  serverHost: Hostname,
  serverPort: z.number().int().min(1).max(65535),
  transport: z.enum(['udp', 'tcp', 'tls']),
  authMode: z.enum(['registration', 'ip']),
  username: SipUser.nullable(),
  password: Password, // write-only
  fromUser: SipUser.nullable(),
  fromDomain: Hostname.nullable(),
  codecs: z.array(z.enum(CODECS)).min(1, 'Pick at least one codec'),
  srtp: z.boolean(),
  maxChannels: z.number().int().min(1).max(1000).nullable(),
  voipmsApiUsername: z.string().trim().max(254).nullable(),
  voipmsApiPassword: z.string().max(128), // write-only
});

export const TrunkCreateSchema = TrunkFields.partial()
  .required({ name: true, serverHost: true })
  .superRefine((t, ctx) => {
    if ((t.authMode ?? 'registration') === 'registration' && (!t.username || !t.password))
      ctx.addIssue({
        code: 'custom',
        path: [t.username ? 'password' : 'username'],
        message: 'Registration needs a username and password',
      });
    if (t.srtp && (t.transport ?? 'udp') !== 'tls')
      ctx.addIssue({ code: 'custom', path: ['srtp'], message: 'SRTP needs the TLS transport' });
  });
/** The same cross-field rules are checked against the merged row on update (routes/trunks.ts). */
export const TrunkUpdateSchema = TrunkFields.partial();

export type TrunkCreate = z.input<typeof TrunkCreateSchema>;
export type TrunkUpdate = z.input<typeof TrunkUpdateSchema>;

export type TrunkDto = Omit<z.output<typeof TrunkFields>, 'password' | 'voipmsApiPassword'> & {
  id: string;
  hasPassword: boolean;
  hasApiPassword: boolean;
  createdAt: string;
};

/** POST /api/trunks/:id/test */
export type TrunkTestResult = {
  registration: TrunkRegistration;
  /** OPTIONS round trip to the server; null when it didn't answer. */
  rttMs: number | null;
  detail: string;
};

export type TrunkRegistration = 'registered' | 'rejected' | 'unregistered' | 'unknown';

/** voip.ms POP servers offered in the form (06 §2); free text is still allowed. */
export const VOIPMS_SERVERS = [
  'atlanta1.voip.ms',
  'chicago1.voip.ms',
  'dallas1.voip.ms',
  'denver1.voip.ms',
  'houston1.voip.ms',
  'losangeles1.voip.ms',
  'montreal1.voip.ms',
  'newyork1.voip.ms',
  'seattle1.voip.ms',
  'tampa1.voip.ms',
  'toronto1.voip.ms',
  'vancouver1.voip.ms',
] as const;
