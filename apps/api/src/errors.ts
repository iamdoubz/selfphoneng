// SPDX-License-Identifier: AGPL-3.0-or-later
// API error shape (04 §7.1): HTTP status + { error: { code, message, details } }.
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  constructor(status: number, code: string, message: string, details: unknown = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new HttpError(400, 'validation_failed', message, details);
export const unauthorized = (message = 'Not signed in') =>
  new HttpError(401, 'unauthorized', message);
export const forbidden = (message = 'Not allowed', code = 'forbidden') =>
  new HttpError(403, code, message);
export const notFound = (message = 'Not found') => new HttpError(404, 'not_found', message);
export const conflict = (message: string, details?: unknown) =>
  new HttpError(409, 'conflict', message, details);
export const rateLimited = (message = 'Too many attempts, try again later') =>
  new HttpError(429, 'rate_limited', message);

export function sendError(reply: FastifyReply, e: HttpError) {
  return reply
    .code(e.status)
    .send({ error: { code: e.code, message: e.message, details: e.details } });
}

export function errorHandler(err: FastifyError, req: FastifyRequest, reply: FastifyReply) {
  if (err instanceof HttpError) return sendError(reply, err);
  if (err instanceof ZodError)
    return sendError(reply, badRequest('Invalid input', { issues: err.issues }));
  const status = err.statusCode ?? 500;
  if (status < 500) return sendError(reply, new HttpError(status, 'bad_request', err.message));
  req.log.error({ err }, 'unhandled error');
  return sendError(reply, new HttpError(500, 'internal', 'Internal error'));
}
