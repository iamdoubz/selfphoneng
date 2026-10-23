// SPDX-License-Identifier: AGPL-3.0-or-later
// Contacts (spec 11): my book, the company book, imports and shares.
import { z } from 'zod';

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((s) => s || null);

export const ContactInputSchema = z.object({
  name: z.string().trim().min(1, 'Enter a name').max(200),
  company: optionalText(200),
  email: optionalText(200).refine((s) => !s || z.email().safeParse(s).success, 'Not an email'),
  /** Any way of writing a number; stored normalized (00 §8). */
  numbers: z
    .array(
      z.object({
        label: z.string().trim().max(30).default(''),
        number: z.string().trim().min(1).max(40),
      }),
    )
    .max(20)
    .default([]),
  notes: optionalText(5000),
});
export type ContactInput = z.input<typeof ContactInputSchema>;

export type ContactNumber = { label: string; number: string };

/** A contact as stored, and as a share offer carries it. */
export type ContactData = {
  name: string;
  company: string | null;
  email: string | null;
  numbers: ContactNumber[];
  notes: string | null;
};

export type ContactDto = ContactData & {
  /** A uuid, or a Contrack contact id such as jane-smith-f60e8536. */
  id: string;
  /** mine: I edit it; company: read-only for users (admins edit it in Admin → Contacts). */
  book: 'mine' | 'company';
  /** Contrack: the contact's page there (editing happens in Contrack). */
  url: string | null;
};

/** GET /api/me/contacts and /api/contacts: the book(s), and where they live. */
export type ContactBookDto = {
  items: ContactDto[];
  provider: 'builtin' | 'contrack';
  /** Contrack mode: the address people open, and whether this book's token works. */
  contrack: {
    publicUrl: string | null;
    connected: boolean;
    error: string | null;
    /** Contacts still only in the builtin book (from before Contrack): "Copy them" (11 §5). */
    toCopy: number;
  } | null;
};

/** POST …/contacts/copy-to-contrack (11 §5, C6). */
export type ContactCopyResult = { added: number; duplicates: number; failed: number };

/** POST …/contacts/import: the files' text, read in the browser. */
export const ContactImportSchema = z.object({
  files: z
    .array(z.object({ name: z.string().max(200), text: z.string() }))
    .min(1)
    .max(20),
});

export type ContactImportResult = {
  committed: boolean;
  added: number;
  /** Same name and number already in the book (or earlier in the files): skipped. */
  duplicates: number;
  /** Added without a phone number. */
  noNumber: number;
  /** The first problems: a card or row that was skipped, or a number that was dropped. */
  errors: string[];
};

export const ContactShareSchema = z
  .object({
    contactIds: z.array(z.string().min(1).max(100)).min(1).max(500),
    /** Colleagues by extension number. */
    extensions: z.array(z.string().max(20)).max(500).default([]),
    everyone: z.boolean().default(false),
  })
  .refine((s) => s.everyone || s.extensions.length, 'Pick who to share with');
export type ContactShare = z.input<typeof ContactShareSchema>;

export const ContactShareDecisionSchema = z.object({ ids: z.array(z.uuid()).min(1).max(1000) });

/** A contact someone shared with me, waiting for Accept or Deny (11 §2.1). */
export type ContactShareDto = {
  id: string;
  from: { userId: string; name: string } | null;
  contact: ContactData;
  createdAt: string;
};
