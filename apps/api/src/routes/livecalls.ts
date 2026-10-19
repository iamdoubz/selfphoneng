// SPDX-License-Identifier: AGPL-3.0-or-later
// Admin actions on calls in progress (04 §7.3): hang up, transfer, listen/whisper/barge. Admin only.
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { InternalNumber } from '@selfphoneng/shared';
import { requireAdmin } from '../auth/guards.ts';
import { extensions } from '../db/schema.ts';
import { badRequest, conflict, HttpError, notFound } from '../errors.ts';
import { audit } from '../services/audit.ts';
import { ownerOf } from '../services/numbering.ts';

const Params = z.object({ linkedid: z.string().regex(/^[\d.]+$/, 'Not a call id') });
const TransferBody = z.object({ target: InternalNumber });
const SpyBody = z.object({ mode: z.enum(['listen', 'whisper', 'barge']) });
/** ChanSpy options: q no beep or name, E leave when the spied call ends; w whisper, B barge. */
const SPY_OPTIONS = { listen: 'qE', whisper: 'qEw', barge: 'qEB' } as const;
const SPY_VERB = {
  listen: 'Listened to',
  whisper: 'Whispered into',
  barge: 'Barged into',
} as const;
/** A user's phone leg (desk or browser), not a trunk or Local channel. */
const USER_CHANNEL = /^PJSIP\/(\d+)(?:-web)?-[0-9a-f]+$/;

export async function liveCallRoutes(app: FastifyInstance) {
  const { db } = app;
  app.addHook('preHandler', requireAdmin);

  const callOf = (linkedid: string) => {
    if (!app.ami.isConnected())
      throw new HttpError(503, 'unavailable', 'Asterisk is not connected');
    const call = app.live.calls.list().find((c) => c.linkedid === linkedid);
    if (!call) throw notFound('That call has ended');
    return call;
  };

  app.post('/api/live/calls/:linkedid/hangup', async (req) => {
    const { linkedid } = Params.parse(req.params);
    const call = callOf(linkedid);
    for (const channel of call.channels)
      await app.ami.action({ Action: 'Hangup', Channel: channel }).catch(() => undefined); // gone already
    await audit(db, {
      actorUserId: req.user!.id,
      actorIp: req.ip,
      action: 'call_hangup',
      summary: `Hung up a call ${call.from.number} → ${call.to.number}`,
    });
    return { ok: true };
  });

  /** Sends the calling party (the call's first channel) to an internal number. */
  app.post('/api/live/calls/:linkedid/transfer', async (req) => {
    const { linkedid } = Params.parse(req.params);
    const { target } = TransferBody.parse(req.body);
    const call = callOf(linkedid);
    if (!(await ownerOf(db, target))) throw notFound(`${target} isn't an extension or group here`);
    await app.ami.action({
      Action: 'Redirect',
      Channel: call.channels[0]!,
      Context: 'sp-local-numbers',
      Exten: target,
      Priority: '1',
    });
    await audit(db, {
      actorUserId: req.user!.id,
      actorIp: req.ip,
      action: 'call_transfer',
      summary: `Transferred ${call.from.number} (call to ${call.to.number}) to ${target}`,
    });
    return { ok: true };
  });

  /**
   * Rings the admin's desk phone; when they answer, ChanSpy on the call's first user leg (the
   * agent): listen, whisper to that user only, or barge (both sides hear).
   */
  app.post('/api/live/calls/:linkedid/spy', async (req) => {
    const { linkedid } = Params.parse(req.params);
    const { mode } = SpyBody.parse(req.body);
    const call = callOf(linkedid);
    const [me] = await db.select().from(extensions).where(eq(extensions.userId, req.user!.id));
    if (!me) throw badRequest('You need an extension of your own to listen in');
    if (!app.live.deskOnline(me.number))
      throw conflict("Your desk phone isn't connected, so it can't ring");
    const target = call.channels.find((c) => {
      const n = USER_CHANNEL.exec(c)?.[1];
      return n !== undefined && n !== me.number;
    });
    if (!target) throw badRequest('There is no phone of a user on this call to listen to');
    const user = USER_CHANNEL.exec(target)![1]!;
    await app.ami.action({
      Action: 'Originate',
      Channel: `PJSIP/${me.number}`,
      Application: 'ChanSpy',
      Data: `${target},${SPY_OPTIONS[mode]}`,
      CallerID: `"${mode[0]!.toUpperCase()}${mode.slice(1)} ${user}" <${user}>`,
      Async: 'true',
    });
    await audit(db, {
      actorUserId: req.user!.id,
      actorIp: req.ip,
      action: 'call_spy',
      summary: `${SPY_VERB[mode]} a call ${call.from.number} → ${call.to.number} (on ${user}'s phone)`,
    });
    return { ok: true };
  });
}
