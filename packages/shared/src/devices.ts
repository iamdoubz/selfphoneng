// SPDX-License-Identifier: AGPL-3.0-or-later
// Desk phones the PBX provisions (02 devices, 07). Admin only.
import { z } from 'zod';

export const PHONE_VENDORS = ['yealink', 'grandstream', 'generic'] as const;
export type PhoneVendor = (typeof PHONE_VENDORS)[number];

/** Any way of writing a MAC (00:15:65:AB:CD:EF, 0015.65ab.cdef, …) → 12 lowercase hex. */
export const Mac = z
  .string()
  .trim()
  .transform((v, ctx) => {
    const hex = v.toLowerCase().replace(/[^0-9a-f]/g, '');
    if (hex.length === 12 && /^[0-9a-f:.\-\s]+$/i.test(v)) return hex;
    ctx.addIssue({ code: 'custom', message: 'A MAC address like 00:15:65:ab:cd:ef' });
    return z.NEVER;
  });

const DeviceFields = z.object({
  mac: Mac,
  vendor: z.enum(PHONE_VENDORS),
  model: z.string().trim().max(40).nullable(),
  label: z.string().trim().max(60).nullable(),
  extensionId: z.uuid('Pick a user'),
});

export const DeviceCreateSchema = DeviceFields.partial().required({
  mac: true,
  vendor: true,
  extensionId: true,
});
export const DeviceUpdateSchema = DeviceFields.partial();
export type DeviceCreate = z.input<typeof DeviceCreateSchema>;
export type DeviceUpdate = z.input<typeof DeviceUpdateSchema>;

export type DeviceDto = z.output<typeof DeviceFields> & {
  id: string;
  extensionNumber: string;
  extensionName: string;
  /** What to type into the phone (or hand out with DHCP option 66). */
  provisioningUrl: string;
  /** Basic auth for the phone: the MAC and this password. Admins see it to type it in. */
  provisioningPassword: string;
  lastProvisionedAt: string | null;
  lastProvisionedIp: string | null;
  createdAt: string;
};
