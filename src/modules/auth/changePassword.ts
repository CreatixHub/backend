import * as argon2 from 'argon2';
import { and, eq, isNull, ne } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { refreshTokens, users } from '../../db/schema';
import { HttpError } from '../../lib/errors';
import { sha256 } from '../../lib/hash';
import type { AuthUser } from '../../middleware/authenticate';

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1).max(200),
    newPassword: z.string().min(8).max(128),
  })
  .strict();

export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

/**
 * Changes the signed-in user's password.
 * - the current password must be correct
 * - clears the "must change password" flag
 * - signs out every other device, but keeps this one signed in
 */
export async function changePassword(
  user: AuthUser,
  input: ChangePasswordInput,
  currentRefreshToken?: string,
): Promise<void> {
  const [row] = await db
    .select({ passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1);
  if (!row || !row.passwordHash) throw new HttpError(404, 'User not found');

  const matches = await argon2.verify(row.passwordHash, input.currentPassword);
  if (!matches) throw new HttpError(400, 'Current password is incorrect');

  if (input.currentPassword === input.newPassword) {
    throw new HttpError(400, 'New password must be different from the current password');
  }

  const newHash = await argon2.hash(input.newPassword);

  await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({
        passwordHash: newHash,
        mustChangePassword: false,
        passwordChangedAt: new Date(),
        failedLoginCount: 0,
        lockedUntil: null,
      })
      .where(eq(users.id, user.id));

    // Keep the session of the browser that is making this request.
    let keepFamily: (typeof refreshTokens.$inferSelect)['familyId'] | null = null;
    if (currentRefreshToken) {
      const [current] = await tx
        .select({ familyId: refreshTokens.familyId })
        .from(refreshTokens)
        .where(and(eq(refreshTokens.userId, user.id), eq(refreshTokens.tokenHash, sha256(currentRefreshToken))))
        .limit(1);
      keepFamily = current?.familyId ?? null;
    }

    await tx
      .update(refreshTokens)
      .set({ revokedAt: new Date(), revokedReason: 'password_changed' })
      .where(
        and(
          eq(refreshTokens.userId, user.id),
          isNull(refreshTokens.revokedAt),
          keepFamily ? ne(refreshTokens.familyId, keepFamily) : undefined,
        ),
      );
  });
}