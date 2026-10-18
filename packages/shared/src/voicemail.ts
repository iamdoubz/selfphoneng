// SPDX-License-Identifier: AGPL-3.0-or-later
// Voicemail messages (02 voicemail_messages, 04 §5.6).

/** Asterisk's mailbox folders that we index. */
export const VOICEMAIL_FOLDERS = ['INBOX', 'Old', 'Urgent'] as const;
export type VoicemailFolder = (typeof VOICEMAIL_FOLDERS)[number];

export type VoicemailDto = {
  id: string;
  folder: VoicemailFolder;
  callerNumber: string | null;
  callerName: string | null;
  durationS: number;
  receivedAt: string;
};
