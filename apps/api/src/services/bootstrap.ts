// SPDX-License-Identifier: AGPL-3.0-or-later
// Startup step 4 (04 §1): create the first admin from env if no admin exists.
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { users } from '../db/schema.ts';
import { hashPassword } from '../auth/passwords.ts';
import { audit } from './audit.ts';

export async function ensureInitialAdmin(
  db: Db,
  email: string,
  password: string,
): Promise<'created' | 'exists'> {
  const [admin] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.role, 'admin'))
    .limit(1);
  if (admin) return 'exists';
  // The password comes from .env and must be changed at first login, so the policy is not applied here.
  const [created] = await db
    .insert(users)
    .values({
      email,
      displayName: 'Administrator',
      passwordHash: await hashPassword(password),
      role: 'admin',
      mustChangePassword: true,
    })
    .returning({ id: users.id });
  await audit(db, {
    action: 'create',
    entityType: 'user',
    entityId: created!.id,
    summary: `Initial admin ${email} created from INITIAL_ADMIN_EMAIL`,
  });
  return 'created';
}
