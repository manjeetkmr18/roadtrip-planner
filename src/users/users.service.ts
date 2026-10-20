import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, gt, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { DB, type Db } from '../db/db.module.js';
import { complimentaryMembershipGrants, membershipSubscriptions, users } from '../db/schema.js';

export const UpdateUserProfile = z.object({
  name: z.string().trim().min(1).max(80).nullable(),
});
export type UpdateUserProfile = z.infer<typeof UpdateUserProfile>;

function serializeProfile(user: { id: string; email: string; name: string | null; plan: string; role: string; emailVerifiedAt: Date | null; createdAt: Date }) {
  const { emailVerifiedAt, ...data } = user;
  return { ...data, emailVerified: !!emailVerifiedAt };
}

@Injectable()
export class UsersService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async getProfile(userId: string) {
    const [user, subscription, grant] = await Promise.all([
      this.db.query.users.findFirst({
        where: eq(users.id, userId),
        columns: { id: true, email: true, name: true, plan: true, role: true, emailVerifiedAt: true, createdAt: true },
      }),
      this.db.query.membershipSubscriptions.findFirst({
        where: and(
          eq(membershipSubscriptions.userId, userId),
          inArray(membershipSubscriptions.status, ['active', 'trialing', 'cancel_pending']),
          gt(membershipSubscriptions.currentPeriodEnd, new Date()),
        ),
      }),
      this.db.query.complimentaryMembershipGrants.findFirst({
        where: and(
          eq(complimentaryMembershipGrants.userId, userId),
          isNull(complimentaryMembershipGrants.revokedAt),
          gt(complimentaryMembershipGrants.expiresAt, new Date()),
        ),
      }),
    ]);
    if (!user) throw new NotFoundException('User not found');
    return serializeProfile({ ...user, plan: subscription || grant ? 'pro' : 'free' });
  }

  async updateProfile(userId: string, profile: UpdateUserProfile) {
    const [user] = await this.db
      .update(users)
      .set({ name: profile.name })
      .where(eq(users.id, userId))
      .returning({
        id: users.id,
        email: users.email,
        name: users.name,
        plan: users.plan,
        role: users.role,
        emailVerifiedAt: users.emailVerifiedAt,
        createdAt: users.createdAt,
      });
    if (!user) throw new NotFoundException('User not found');
    return this.getProfile(userId);
  }
}
