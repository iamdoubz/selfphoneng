// SPDX-License-Identifier: AGPL-3.0-or-later
// Voicemail messages (02 voicemail_messages, 04 §5.6).

/** Asterisk's mailbox folders that we index. */
export const VOICEMAIL_FOLDERS = ['INBOX', 'Old', 'Urgent'] as const;
export type VoicemailFolder = (typeof VOICEMAIL_FOLDERS)[number];

/** unavail/busy: played before the beep; greet: your name; temp: overrides both while set. */
export const GREETINGS = ['unavail', 'busy', 'greet', 'temp'] as const;
export type GreetingKind = (typeof GREETINGS)[number];

export type VoicemailDto = {
  id: string;
  folder: VoicemailFolder;
  callerNumber: string | null;
  callerName: string | null;
  durationS: number;
  receivedAt: string;
  /** Speech to text (Settings → AI); null when off, failed, or not done yet. */
  transcript: string | null;
};
