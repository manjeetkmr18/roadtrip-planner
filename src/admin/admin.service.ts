import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, count, desc, eq, gt, gte, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { AuthUser } from '../auth/auth.js';
import { DB, type Db } from '../db/db.module.js';
import {
  adminAuditLogs,
  complimentaryMembershipGrants,
  feedback,
  generations,
  membershipSubscriptions,
  trips,
  users,
} from '../db/schema.js';

export const UserListQuery = z.object({
  q: z.string().trim().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

export const CreateGrantRequest = z.object({
  expiresAt: z.iso.datetime().transform((value) => new Date(value)),
  reason: z.string().trim().min(3).max(500),
});

export const RevokeGrantRequest = z.object({
  reason: z.string().trim().min(3).max(500),
});

export const DeleteUserRequest = z.object({
  confirmUserId: z.uuid(),
  reason: z.string().trim().min(3).max(500),
});

const BILLING_STATES = ['incomplete', 'trialing', 'active', 'past_due', 'cancel_pending', 'unpaid', 'paused'] as const;
const effectivePlan = sql<string>`CASE
  WHEN ${users.role} = 'admin' OR EXISTS (
    SELECT 1 FROM membership_subscriptions s
    WHERE s.user_id = ${users.id}
      AND s.status IN ('active', 'trialing', 'cancel_pending')
      AND s.current_period_end > now()
  ) OR EXISTS (
    SELECT 1 FROM complimentary_membership_grants g
    WHERE g.user_id = ${users.id}
      AND g.revoked_at IS NULL
      AND g.expires_at > now()
  ) THEN 'pro'
  ELSE 'free'
END`;

@Injectable()
export class AdminService {
  constructor(@Inject(DB) private readonly db: Db) {}

  private audit(
    tx: Parameters<Parameters<Db['transaction']>[0]>[0],
    actorUserId: string,
    action: string,
    targetUserId: string | null,
    details: Record<string, string | number | boolean | null>,
  ) {
    return tx.insert(adminAuditLogs).values({ actorUserId, action, targetUserId, details });
  }

  async overview() {
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const [[userCount], [adminCount], [tripCount], [generationCount], [failedGenerationCount], [monthlyCost], [feedbackCount], [activeSubscriptions], [activeGrants]] =
      await Promise.all([
        this.db.select({ value: count() }).from(users),
        this.db.select({ value: count() }).from(users).where(eq(users.role, 'admin')),
        this.db.select({ value: count() }).from(trips),
        this.db.select({ value: count() }).from(generations).where(gte(generations.createdAt, monthStart)),
        this.db.select({ value: count() }).from(generations).where(and(gte(generations.createdAt, monthStart), eq(generations.ok, false))),
        this.db
          .select({ value: sql<number>`coalesce(sum(${generations.apiCostUsd}), 0)` })
          .from(generations)
          .where(gte(generations.createdAt, monthStart)),
        this.db.select({ value: count() }).from(feedback),
        this.db
          .select({ value: count() })
          .from(membershipSubscriptions)
          .where(and(inArray(membershipSubscriptions.status, ['active', 'trialing', 'cancel_pending']), gt(membershipSubscriptions.currentPeriodEnd, new Date()))),
        this.db
          .select({ value: count() })
          .from(complimentaryMembershipGrants)
          .where(and(isNull(complimentaryMembershipGrants.revokedAt), gt(complimentaryMembershipGrants.expiresAt, new Date()))),
      ]);
    return {
      users: { total: userCount.value, admins: adminCount.value },
      trips: { total: tripCount.value },
      generations: {
        thisMonth: generationCount.value,
        failedThisMonth: failedGenerationCount.value,
        apiCostUsdThisMonth: Number(monthlyCost.value),
      },
      feedback: { total: feedbackCount.value },
      membership: { activeStripeSubscriptions: activeSubscriptions.value, activeComplimentaryGrants: activeGrants.value },
      periodStartedAt: monthStart,
    };
  }

  async listUsers(query: z.infer<typeof UserListQuery>) {
    const search = query.q
      ? [
          ilike(users.email, `%${query.q.replace(/[\\%_]/g, '\\$&')}%`),
          ilike(users.name, `%${query.q.replace(/[\\%_]/g, '\\$&')}%`),
          ...(z.uuid().safeParse(query.q).success ? [eq(users.id, query.q)] : []),
        ]
      : [];
    const where = search.length ? or(...search) : undefined;
    const [items, [total]] = await Promise.all([
      this.db
        .select({
          id: users.id,
          email: users.email,
          name: users.name,
          plan: effectivePlan,
          role: users.role,
          emailVerifiedAt: users.emailVerifiedAt,
          createdAt: users.createdAt,
        })
        .from(users)
        .where(where)
        .orderBy(desc(users.createdAt))
        .limit(query.limit)
        .offset(query.offset),
      this.db.select({ value: count() }).from(users).where(where),
    ]);
    return { items, total: total.value, limit: query.limit, offset: query.offset };
  }

  async getUser(userId: string) {
    const user = await this.db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: {
        id: true,
        email: true,
        name: true,
        plan: true,
        role: true,
        emailVerifiedAt: true,
        createdAt: true,
        stripeCustomerId: true,
      },
    });
    if (!user) throw new NotFoundException('User not found');
    const [userTrips, subscriptions, grants, [usage]] = await Promise.all([
      this.db
        .select({
          id: trips.id,
          title: trips.title,
          status: trips.status,
          request: trips.request,
          plan: trips.plan,
          generationCount: trips.generationCount,
          apiCostUsd: trips.apiCostUsd,
          createdAt: trips.createdAt,
          updatedAt: trips.updatedAt,
        })
        .from(trips)
        .where(eq(trips.userId, userId))
        .orderBy(desc(trips.updatedAt)),
      this.db
        .select({
          id: membershipSubscriptions.id,
          stripeSubscriptionId: membershipSubscriptions.stripeSubscriptionId,
          stripePriceId: membershipSubscriptions.stripePriceId,
          planCode: membershipSubscriptions.planCode,
          status: membershipSubscriptions.status,
          currentPeriodStart: membershipSubscriptions.currentPeriodStart,
          currentPeriodEnd: membershipSubscriptions.currentPeriodEnd,
          cancelAtPeriodEnd: membershipSubscriptions.cancelAtPeriodEnd,
        })
        .from(membershipSubscriptions)
        .where(eq(membershipSubscriptions.userId, userId))
        .orderBy(desc(membershipSubscriptions.updatedAt)),
      this.db
        .select()
        .from(complimentaryMembershipGrants)
        .where(eq(complimentaryMembershipGrants.userId, userId))
        .orderBy(desc(complimentaryMembershipGrants.createdAt)),
      this.db
        .select({ generations: count(), apiCostUsd: sql<number>`coalesce(sum(${generations.apiCostUsd}), 0)` })
        .from(generations)
        .where(eq(generations.userId, userId)),
    ]);
    return {
      user: {
        ...user,
        plan: subscriptions.some((subscription) =>
          ['active', 'trialing', 'cancel_pending'].includes(subscription.status) &&
          subscription.currentPeriodEnd !== null &&
          subscription.currentPeriodEnd > new Date(),
        ) || grants.some((grant) => !grant.revokedAt && grant.expiresAt > new Date()) || user.role === 'admin' ? 'pro' : 'free',
        emailVerified: !!user.emailVerifiedAt,
      },
      trips: userTrips,
      subscriptions,
      complimentaryGrants: grants,
      usage: { generations: usage.generations, apiCostUsd: Number(usage.apiCostUsd) },
    };
  }

  async billing(query: z.infer<typeof UserListQuery>) {
    const rows = await this.db
      .select({
        userId: users.id,
        email: users.email,
        name: users.name,
        stripeCustomerId: users.stripeCustomerId,
        subscriptionId: membershipSubscriptions.stripeSubscriptionId,
        priceId: membershipSubscriptions.stripePriceId,
        planCode: membershipSubscriptions.planCode,
        status: membershipSubscriptions.status,
        currentPeriodStart: membershipSubscriptions.currentPeriodStart,
        currentPeriodEnd: membershipSubscriptions.currentPeriodEnd,
        cancelAtPeriodEnd: membershipSubscriptions.cancelAtPeriodEnd,
      })
      .from(membershipSubscriptions)
      .innerJoin(users, eq(users.id, membershipSubscriptions.userId))
      .orderBy(desc(membershipSubscriptions.updatedAt))
      .limit(query.limit)
      .offset(query.offset);
    return { items: rows, limit: query.limit, offset: query.offset, activeStatuses: BILLING_STATES };
  }

  async auditLogs(query: z.infer<typeof UserListQuery>) {
    const items = await this.db
      .select()
      .from(adminAuditLogs)
      .orderBy(desc(adminAuditLogs.createdAt))
      .limit(query.limit)
      .offset(query.offset);
    return { items, limit: query.limit, offset: query.offset };
  }

  async listFeedback(query: z.infer<typeof UserListQuery>) {
    const items = await this.db
      .select({
        id: feedback.id,
        userId: feedback.userId,
        tripId: feedback.tripId,
        itemType: feedback.itemType,
        itemId: feedback.itemId,
        message: feedback.message,
        createdAt: feedback.createdAt,
        userEmail: users.email,
      })
      .from(feedback)
      .leftJoin(users, eq(users.id, feedback.userId))
      .orderBy(desc(feedback.createdAt))
      .limit(query.limit)
      .offset(query.offset);
    return { items, limit: query.limit, offset: query.offset };
  }

  async grantPro(actor: AuthUser, userId: string, request: z.infer<typeof CreateGrantRequest>) {
    if (request.expiresAt <= new Date()) throw new BadRequestException('Grant expiry must be in the future');
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`pro-grant:${userId}`}, 0))`);
      const target = await tx.query.users.findFirst({ where: eq(users.id, userId), columns: { id: true } });
      if (!target) throw new NotFoundException('User not found');
      const existing = await tx.query.complimentaryMembershipGrants.findFirst({
        where: and(
          eq(complimentaryMembershipGrants.userId, userId),
          isNull(complimentaryMembershipGrants.revokedAt),
          gt(complimentaryMembershipGrants.expiresAt, new Date()),
        ),
      });
      if (existing) throw new ConflictException('User already has an active complimentary Pro grant');
      const [grant] = await tx
        .insert(complimentaryMembershipGrants)
        .values({
          userId,
          grantedByUserId: actor.id,
          reason: request.reason,
          expiresAt: request.expiresAt,
        })
        .returning();
      await tx.update(users).set({ plan: 'pro' }).where(eq(users.id, userId));
      await this.audit(tx, actor.id, 'pro_grant.created', userId, { grantId: grant.id, expiresAt: grant.expiresAt.toISOString(), reason: request.reason });
      return grant;
    });
  }

  async revokePro(actor: AuthUser, grantId: string, request: z.infer<typeof RevokeGrantRequest>) {
    return this.db.transaction(async (tx) => {
      const grant = await tx.query.complimentaryMembershipGrants.findFirst({
        where: eq(complimentaryMembershipGrants.id, grantId),
      });
      if (!grant) throw new NotFoundException('Complimentary membership grant not found');
      if (grant.revokedAt) throw new ConflictException('Membership grant has already been revoked');
      const now = new Date();
      await tx
        .update(complimentaryMembershipGrants)
        .set({ revokedAt: now, revokedByUserId: actor.id })
        .where(eq(complimentaryMembershipGrants.id, grantId));
      const [subscription, otherGrant] = await Promise.all([
        tx.query.membershipSubscriptions.findFirst({
          where: and(
            eq(membershipSubscriptions.userId, grant.userId),
            inArray(membershipSubscriptions.status, ['active', 'trialing', 'cancel_pending']),
            gt(membershipSubscriptions.currentPeriodEnd, now),
          ),
        }),
        tx.query.complimentaryMembershipGrants.findFirst({
          where: and(
            eq(complimentaryMembershipGrants.userId, grant.userId),
            isNull(complimentaryMembershipGrants.revokedAt),
            gt(complimentaryMembershipGrants.expiresAt, now),
          ),
        }),
      ]);
      await tx.update(users).set({ plan: subscription || otherGrant ? 'pro' : 'free' }).where(eq(users.id, grant.userId));
      await this.audit(tx, actor.id, 'pro_grant.revoked', grant.userId, { grantId, reason: request.reason });
      return { revoked: true, grantId };
    });
  }

  async deleteUser(actor: AuthUser, userId: string, request: z.infer<typeof DeleteUserRequest>) {
    if (request.confirmUserId !== userId) throw new BadRequestException('confirmUserId must match the user ID in the URL');
    if (actor.id === userId) throw new ConflictException('You cannot delete your own admin account');
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('admin-roster', 0))`);
      const target = await tx.query.users.findFirst({
        where: eq(users.id, userId),
        columns: { id: true, email: true, role: true },
      });
      if (!target) throw new NotFoundException('User not found');
      const blockingSubscription = await tx.query.membershipSubscriptions.findFirst({
        where: and(
          eq(membershipSubscriptions.userId, userId),
          inArray(membershipSubscriptions.status, [...BILLING_STATES]),
          or(isNull(membershipSubscriptions.currentPeriodEnd), gt(membershipSubscriptions.currentPeriodEnd, new Date())),
        ),
      });
      if (blockingSubscription) throw new ConflictException('Cancel the active Stripe subscription before deleting this account');
      if (target.role === 'admin') {
        const [admins] = await tx.select({ value: count() }).from(users).where(eq(users.role, 'admin'));
        if (admins.value <= 1) throw new ConflictException('The last admin account cannot be deleted');
      }
      await this.audit(tx, actor.id, 'user.deleted', userId, { email: target.email, reason: request.reason });
      await tx.delete(users).where(eq(users.id, userId));
      return { deleted: true, userId, tripsAndAccountDataDeleted: true };
    });
  }
}
