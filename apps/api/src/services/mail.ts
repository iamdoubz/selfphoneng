// SPDX-License-Identifier: AGPL-3.0-or-later
// Outgoing email (04 §10) through the SMTP server in settings.smtp.
import nodemailer from 'nodemailer';
import type { Db } from '../db/client.ts';
import { decrypt } from '../crypto/secrets.ts';
import { getSetting } from './settings.ts';

export type Mail = {
  to: string[];
  subject: string;
  text: string;
  attachments?: { filename: string; path: string }[];
};
export type SendMail = (m: Mail) => Promise<void>;

export class MailNotConfigured extends Error {
  constructor() {
    super('Email is not set up (Settings → Email)');
  }
}

/** Reads the SMTP settings on every send, so changes apply without a restart. */
export function smtpMailer(db: Db): SendMail {
  return async ({ to, subject, text, attachments }) => {
    const smtp = await getSetting(db, 'smtp');
    if (!smtp) throw new MailNotConfigured();
    const transport = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      auth: smtp.username ? { user: smtp.username, pass: decrypt(smtp.passwordEnc) } : undefined,
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
    });
    await transport.sendMail({ from: smtp.from, to, subject, text, attachments });
  };
}
