// SPDX-License-Identifier: AGPL-3.0-or-later
// Admin actions on calls in progress (04 §7.3): hang up, transfer. Admin only.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { InternalNumber } from '@selfphoneng/shared';
import { requireAdmin } from '../auth/guards.ts';
import { HttpError, notFound } from '../errors.ts';
import { audit } from '../services/audit.ts';
import { ownerOf } from '../services/numbering.ts';

const Params = z.object({ linkedid: z.string().regex(/^[\d.]+$/, 'Not a call id') });
const TransferBody = z.object({ target: InternalNumber });

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
}
