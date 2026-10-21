import { ConflictException, Inject, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import { count } from 'drizzle-orm';
import { and, eq, gt, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { DB, type Db } from '../db/db.module.js';
import { activeStoreSubscription, proAccess } from '../membership/entitlements.js';
import { MembershipService } from '../membership/membership.service.js';
import { complimentaryMembershipGrants, membershipSubscriptions, users } from '../db/schema.js';

export const UpdateUserProfile = z.object({
  name: z.string().trim().min(1).max(80).nullable(),
});
export type UpdateUserProfile = z.infer<typeof UpdateUserProfile>;

export const DeleteAccountRequest = z.object({
  /** The account password, to confirm it's really the owner. */
  password: z.string().min(1).max(200),
});
export type DeleteAccountRequest = z.infer<typeof DeleteAccountRequest>;

function serializeProfile(user: { id: string; email: string; name: string | null; plan: string; role: string; emailVerifiedAt: Date | null; createdAt: Date }) {
  const { emailVerifiedAt, ...data } = user;
  return { ...data, emailVerified: !!emailVerifiedAt };
}

@Injectable()
export class UsersService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly membership: MembershipService,
  ) {}

  /**
   * Deletes the signed-in account and everything in it (trips, plans, shares, feedback is detached).
   * A web (Stripe) subscription is cancelled first. An App Store / Google Play subscription can only be
   * cancelled by the person in their store settings, so the reply says when one is still active.
   */
  async deleteAccount(userId: string, request: DeleteAccountRequest) {
    const account = await this.db.query.users.findFirst({ where: eq(users.id, userId), columns: { id: true, role: true, passwordHash: true } });
    if (!account) throw new NotFoundException('User not found');
    if (!(await bcrypt.compare(request.password, account.passwordHash))) throw new UnauthorizedException({ message: 'That password isn\'t right.', code: 'BAD_PASSWORD' });
    if (account.role === 'admin') {
      const [admins] = await this.db.select({ value: count() }).from(users).where(eq(users.role, 'admin'));
      if (admins.value <= 1) throw new ConflictException('The last admin account cannot be deleted');
    }
    const store = await activeStoreSubscription(this.db, userId);
    await this.membership.cancelStripeForDeletion(userId);
    await this.db.delete(users).where(eq(users.id, userId));
    return { deleted: true, storeSubscriptionStillActive: store ? { store: store.store, productId: store.productId } : null };
  }

  async getProfile(userId: string) {
    const [user, access] = await Promise.all([
      this.db.query.users.findFirst({
        where: eq(users.id, userId),
        columns: { id: true, email: true, name: true, plan: true, role: true, emailVerifiedAt: true, createdAt: true },
      }),
      proAccess(this.db, userId),
    ]);
    if (!user) throw new NotFoundException('User not found');
    return serializeProfile({ ...user, plan: access.pro ? 'pro' : 'free' });
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
