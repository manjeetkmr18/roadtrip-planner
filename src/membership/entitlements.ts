import { and, desc, eq, gt, inArray, isNull, or } from 'drizzle-orm';
import type { Db } from '../db/db.module.js';
import { isMissingTable } from './store-schema.js';
import { complimentaryMembershipGrants, membershipSubscriptions, storeSubscriptions, users } from '../db/schema.js';

/** A database handle or an open transaction. */
type Reader = Pick<Db, 'query'>;

export const STRIPE_PRO_STATUSES = ['active', 'trialing', 'cancel_pending'] as const;
/** Store statuses that still give access until the paid period ends (billing_issue = store grace period). */
export const STORE_PRO_STATUSES = ['active', 'cancel_pending', 'billing_issue'] as const;

export type ProSource = 'admin' | 'subscription' | 'store' | 'complimentary';

export function activeStripeSubscription(db: Reader, userId: string) {
  return db.query.membershipSubscriptions.findFirst({
    where: and(
      eq(membershipSubscriptions.userId, userId),
      inArray(membershipSubscriptions.status, [...STRIPE_PRO_STATUSES]),
      gt(membershipSubscriptions.currentPeriodEnd, new Date()),
    ),
    orderBy: desc(membershipSubscriptions.currentPeriodEnd),
  });
}

export async function activeStoreSubscription(db: Reader, userId: string) {
  try {
    return await findActiveStore(db, userId);
  } catch (e) {
    // Before the table exists (fresh deploy, migration not run yet) nobody has a store subscription.
    if (isMissingTable(e)) return undefined;
    throw e;
  }
}

function findActiveStore(db: Reader, userId: string) {
  return db.query.storeSubscriptions.findFirst({
    where: and(
      eq(storeSubscriptions.userId, userId),
      inArray(storeSubscriptions.status, [...STORE_PRO_STATUSES]),
      or(isNull(storeSubscriptions.expiresAt), gt(storeSubscriptions.expiresAt, new Date())),
    ),
    orderBy: desc(storeSubscriptions.expiresAt),
  });
}

export function activeGrant(db: Reader, userId: string) {
  return db.query.complimentaryMembershipGrants.findFirst({
    where: and(
      eq(complimentaryMembershipGrants.userId, userId),
      isNull(complimentaryMembershipGrants.revokedAt),
      gt(complimentaryMembershipGrants.expiresAt, new Date()),
    ),
    orderBy: desc(complimentaryMembershipGrants.expiresAt),
  });
}

/**
 * The one place that decides whether an account has Travlio Pro: an admin, a Stripe (web)
 * subscription, an App Store / Google Play subscription, or a complimentary grant.
 */
export async function proAccess(db: Reader, userId: string): Promise<{ pro: boolean; source: ProSource | null }> {
  const [account, subscription, store, grant] = await Promise.all([
    db.query.users.findFirst({ where: eq(users.id, userId), columns: { role: true } }),
    activeStripeSubscription(db, userId),
    activeStoreSubscription(db, userId),
    activeGrant(db, userId),
  ]);
  const source: ProSource | null =
    account?.role === 'admin' ? 'admin' : subscription ? 'subscription' : store ? 'store' : grant ? 'complimentary' : null;
  return { pro: !!source, source };
}
