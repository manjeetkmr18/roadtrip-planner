import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { and, count, desc, eq, gte, gt, inArray, isNull, sql } from 'drizzle-orm';
import Stripe from 'stripe';
import { z } from 'zod';
import { ENV, type Env } from '../config/env.js';
import { DB, type Db } from '../db/db.module.js';
import { complimentaryMembershipGrants, generationJobs, generations, membershipSubscriptions, membershipWebhookEvents, users } from '../db/schema.js';
import type { AuthUser } from '../auth/auth.js';
import { activeGrant, activeStoreSubscription, activeStripeSubscription, proAccess } from './entitlements.js';

export const CheckoutRequest = z.object({
  plan: z.enum(['monthly', 'annual']),
  idempotencyKey: z.uuid(),
});

export type CheckoutInput = z.infer<typeof CheckoutRequest>;
type PlanCode = 'monthly' | 'annual';
type StripePriceSetting = 'STRIPE_PRICE_ID_MONTHLY' | 'STRIPE_PRICE_ID_ANNUAL';

const PRICE_SETTINGS: Record<PlanCode, StripePriceSetting> = {
  monthly: 'STRIPE_PRICE_ID_MONTHLY',
  annual: 'STRIPE_PRICE_ID_ANNUAL',
};

/** 'monthly' / 'annual' from a store product ID such as travlio_pro_annual or pro.monthly. */
export function storePlanCode(productId: string): 'monthly' | 'annual' | string {
  if (/annual|year|yearly|12m|p1y/i.test(productId)) return 'annual';
  if (/month|monthly|1m|p1m/i.test(productId)) return 'monthly';
  return productId;
}

function customerId(customer: string | Stripe.Customer | Stripe.DeletedCustomer): string {
  return typeof customer === 'string' ? customer : customer.id;
}

@Injectable()
export class MembershipService {
  private readonly log = new Logger(MembershipService.name);
  private stripeClient?: Stripe;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private stripe(requireWebhook = false) {
    if (!this.env.STRIPE_SECRET_KEY || !this.env.STRIPE_PRICE_ID_MONTHLY || !this.env.STRIPE_PRICE_ID_ANNUAL || !this.env.WEB_APP_URL) {
      throw new ServiceUnavailableException('Subscription payments are not configured');
    }
    if (requireWebhook && !this.env.STRIPE_WEBHOOK_SECRET) {
      throw new ServiceUnavailableException('Subscription webhooks are not configured');
    }
    this.stripeClient ??= new Stripe(this.env.STRIPE_SECRET_KEY);
    return this.stripeClient;
  }

  private priceId(plan: PlanCode) {
    const id = this.env[PRICE_SETTINGS[plan]];
    if (!id) throw new ServiceUnavailableException('Subscription payments are not configured');
    return id;
  }

  private async planPrice(stripe: Stripe, plan: PlanCode) {
    const price = await stripe.prices.retrieve(this.priceId(plan));
    const expectedInterval = plan === 'monthly' ? 'month' : 'year';
    if (!price.active || price.type !== 'recurring' || !price.recurring ||
        price.recurring.interval !== expectedInterval || price.recurring.interval_count !== 1) {
      throw new ServiceUnavailableException(`Configured ${plan} subscription price must be active and recur every ${expectedInterval}`);
    }
    return {
      code: plan,
      priceId: price.id,
      amount: price.unit_amount,
      currency: price.currency.toUpperCase(),
      interval: price.recurring.interval,
      intervalCount: price.recurring.interval_count,
    };
  }

  async hasPro(userId: string) {
    return (await proAccess(this.db, userId)).pro;
  }

  async plans() {
    const stripe = this.stripe();
    const entries = await Promise.all(
      (['monthly', 'annual'] as const).map((plan) => this.planPrice(stripe, plan)),
    );
    return entries;
  }

  async me(user: AuthUser) {
    const [{ source }, active, store, grant, account] = await Promise.all([
      proAccess(this.db, user.id),
      activeStripeSubscription(this.db, user.id),
      activeStoreSubscription(this.db, user.id),
      activeGrant(this.db, user.id),
      this.db.query.users.findFirst({ where: eq(users.id, user.id), columns: { role: true } }),
    ]);
    const subscription = active ?? (await this.db.query.membershipSubscriptions.findFirst({
      where: eq(membershipSubscriptions.userId, user.id),
      orderBy: desc(membershipSubscriptions.updatedAt),
    }));
    const storePlan = store ? storePlanCode(store.productId) : null;
    return {
      plan: source ? 'pro' : 'free',
      access: account?.role === 'admin' ? 'admin' : source ?? 'free',
      /** Who bills the subscription: manage it there (Stripe portal on the web, or the store). */
      billing: source === 'subscription' ? 'stripe' : source === 'store' && store ? store.store : null,
      store: store
        ? { store: store.store, productId: store.productId, status: store.status, expiresAt: store.expiresAt, willRenew: store.willRenew, sandbox: store.sandbox }
        : null,
      subscription: source === 'store' && store
        ? {
            plan: storePlan,
            status: store.status === 'billing_issue' ? 'past_due' : store.status,
            currentPeriodStart: null,
            currentPeriodEnd: store.expiresAt,
            cancelAtPeriodEnd: !store.willRenew,
          }
        : active
        ? {
            plan: active.planCode,
            status: active.status,
            currentPeriodStart: active.currentPeriodStart,
            currentPeriodEnd: active.currentPeriodEnd,
            cancelAtPeriodEnd: active.cancelAtPeriodEnd,
          }
        : grant
          ? { plan: 'complimentary', status: 'active', currentPeriodStart: grant.createdAt, currentPeriodEnd: grant.expiresAt, cancelAtPeriodEnd: false }
          : subscription
            ? {
                plan: subscription.planCode,
                status: subscription.status,
                currentPeriodStart: subscription.currentPeriodStart,
                currentPeriodEnd: subscription.currentPeriodEnd,
                cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
              }
            : null,
    };
  }

  /** Throws 403 with code PRO_REQUIRED (so clients can offer the upgrade) unless the user has Pro. */
  async assertPro(user: AuthUser, message = 'Trip arrival adjustments require an active Travlio Pro membership.'): Promise<void> {
    if (!(await this.hasPro(user.id))) throw new ForbiddenException({ message, code: 'PRO_REQUIRED' });
  }

  async usage(user: AuthUser) {
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const [[completed], [reserved]] = await Promise.all([
      this.db
        .select({ n: count() })
        .from(generations)
        .where(and(eq(generations.userId, user.id), gte(generations.createdAt, monthStart))),
      this.db
        .select({ n: count() })
        .from(generationJobs)
        .where(
          and(
            eq(generationJobs.userId, user.id),
            gte(generationJobs.createdAt, monthStart),
            inArray(generationJobs.status, ['queued', 'generating']),
          ),
        ),
    ]);
    const plan = (await this.hasPro(user.id)) ? 'pro' : 'free';
    return {
      plan,
      usedThisMonth: completed.n + reserved.n,
      limit: plan === 'pro' ? null : this.env.FREE_TRIPS_PER_MONTH,
      resetsAt: new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 1)),
    };
  }

  async checkout(user: AuthUser, request: CheckoutInput) {
    const stripe = this.stripe();
    await this.planPrice(stripe, request.plan);
    let account = await this.db.query.users.findFirst({ where: eq(users.id, user.id) });
    if (!account) throw new ConflictException('User account is no longer available');
    if (!account.stripeCustomerId) {
      const customer = await stripe.customers.create(
        { email: account.email, name: account.name ?? undefined, metadata: { userId: account.id } },
        { idempotencyKey: `customer:${account.id}` },
      );
      const [stored] = await this.db
        .update(users)
        .set({ stripeCustomerId: customer.id })
        .where(and(eq(users.id, account.id), isNull(users.stripeCustomerId)))
        .returning({ stripeCustomerId: users.stripeCustomerId });
      if (stored) {
        account = { ...account, stripeCustomerId: stored.stripeCustomerId };
      } else {
        const latest = await this.db.query.users.findFirst({ where: eq(users.id, user.id) });
        if (!latest?.stripeCustomerId) throw new ConflictException('Could not associate billing customer with this account');
        account = latest;
      }
    }

    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${account.id}, 1))`);
      const subscriptions = await stripe.subscriptions.list({ customer: account.stripeCustomerId!, status: 'all', limit: 100 });
      const hasExistingSubscription = subscriptions.data.some((subscription) =>
        ['incomplete', 'trialing', 'active', 'past_due', 'unpaid', 'paused'].includes(subscription.status),
      );
      if (hasExistingSubscription) {
        throw new ConflictException('A subscription already exists. Manage it from the subscription portal.');
      }

      const openSessions = await stripe.checkout.sessions.list({ customer: account.stripeCustomerId!, status: 'open', limit: 100 });
      const openSession = openSessions.data.find((session) => session.mode === 'subscription');
      if (openSession) {
        if (openSession.metadata?.planCode !== request.plan || !openSession.url) {
          throw new ConflictException('A checkout session is already open. Complete or close it before starting another.');
        }
        return { url: openSession.url };
      }

      const session = await stripe.checkout.sessions.create(
        {
          mode: 'subscription',
          customer: account.stripeCustomerId!,
          client_reference_id: account.id,
          line_items: [{ price: this.priceId(request.plan), quantity: 1 }],
          success_url: `${this.env.WEB_APP_URL}/membership/success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${this.env.WEB_APP_URL}/membership`,
          metadata: { userId: account.id, planCode: request.plan },
          subscription_data: { metadata: { userId: account.id, planCode: request.plan } },
        },
        { idempotencyKey: `checkout:${account.id}:${request.idempotencyKey}` },
      );
      if (!session.url) throw new ServiceUnavailableException('Stripe did not return a checkout URL');
      return { url: session.url };
    });
  }

  async portal(user: AuthUser) {
    const stripe = this.stripe();
    const account = await this.db.query.users.findFirst({
      where: eq(users.id, user.id),
      columns: { stripeCustomerId: true },
    });
    if (!account?.stripeCustomerId) throw new ConflictException('No subscription billing account exists yet');
    const session = await stripe.billingPortal.sessions.create({
      customer: account.stripeCustomerId,
      return_url: `${this.env.WEB_APP_URL}/membership`,
    });
    return { url: session.url };
  }

  /**
   * Before an account is deleted: cancel any Stripe subscription that could still bill, right away.
   * Throws if one can't be cancelled, so a deleted account is never left being charged.
   */
  async cancelStripeForDeletion(userId: string) {
    const billing = await this.db.query.membershipSubscriptions.findMany({
      where: and(
        eq(membershipSubscriptions.userId, userId),
        inArray(membershipSubscriptions.status, ['incomplete', 'trialing', 'active', 'past_due', 'cancel_pending', 'unpaid', 'paused']),
      ),
      columns: { stripeSubscriptionId: true },
    });
    if (!billing.length) return { cancelled: 0 };
    const stripe = this.stripe();
    for (const { stripeSubscriptionId } of billing) {
      try {
        await stripe.subscriptions.cancel(stripeSubscriptionId);
      } catch (e) {
        if (e instanceof Stripe.errors.StripeInvalidRequestError && /No such subscription|canceled/i.test(e.message)) continue;
        this.log.error(`could not cancel ${stripeSubscriptionId} before account deletion: ${(e as Error).message}`);
        throw new ServiceUnavailableException('Could not cancel your subscription, so the account was not deleted. Please try again.');
      }
    }
    return { cancelled: billing.length };
  }

  async handleWebhook(rawBody: Buffer, signature: string | undefined) {
    if (!signature) throw new ServiceUnavailableException('Stripe signature header is missing');
    const stripe = this.stripe(true);
    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(rawBody, signature, this.env.STRIPE_WEBHOOK_SECRET!);
    } catch (error) {
      if (error instanceof Stripe.errors.StripeSignatureVerificationError) {
        throw new BadRequestException('Invalid Stripe webhook signature');
      }
      throw error;
    }

    const subscription = await this.subscriptionFromEvent(stripe, event);
    const applied = await this.db.transaction(async (tx) => {
      const [recorded] = await tx
        .insert(membershipWebhookEvents)
        .values({ stripeEventId: event.id, eventType: event.type })
        .onConflictDoNothing({ target: membershipWebhookEvents.stripeEventId })
        .returning({ id: membershipWebhookEvents.id });
      if (!recorded) return false;

      if (subscription) await this.syncSubscription(tx, subscription);
      return true;
    });
    return { received: true, duplicate: !applied };
  }

  private async subscriptionFromEvent(stripe: Stripe, event: Stripe.Event) {
    let subscriptionId: string | undefined;
    if (event.type.startsWith('customer.subscription.')) {
      subscriptionId = (event.data.object as Stripe.Subscription).id;
    } else if (event.type === 'checkout.session.completed') {
      const value = (event.data.object as Stripe.Checkout.Session).subscription;
      subscriptionId = typeof value === 'string' ? value : value?.id;
    }
    if (!subscriptionId) return undefined;
    return stripe.subscriptions.retrieve(subscriptionId);
  }

  private async syncSubscription(tx: Parameters<Parameters<Db['transaction']>[0]>[0], subscription: Stripe.Subscription) {
    const priceId = subscription.items.data[0]?.price.id;
    if (!priceId) throw new Error(`Stripe subscription ${subscription.id} has no price`);
    const planCode = (['monthly', 'annual'] as const).find((plan) => this.env[PRICE_SETTINGS[plan]] === priceId);
    if (!planCode) throw new Error(`Stripe subscription ${subscription.id} uses an unconfigured price`);

    const stripeCustomer = customerId(subscription.customer);
    const hintedUserId = subscription.metadata.userId;
    const account =
      (hintedUserId ? await tx.query.users.findFirst({ where: eq(users.id, hintedUserId) }) : undefined) ??
      (await tx.query.users.findFirst({ where: eq(users.stripeCustomerId, stripeCustomer) }));
    if (!account) throw new Error(`No local user found for Stripe subscription ${subscription.id}`);

    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${account.id}, 1))`);
    const status = this.subscriptionStatus(subscription);
    await tx
      .insert(membershipSubscriptions)
      .values({
        userId: account.id,
        stripeSubscriptionId: subscription.id,
        stripePriceId: priceId,
        planCode,
        status,
        currentPeriodStart: subscription.items.data[0]?.current_period_start
          ? new Date(subscription.items.data[0].current_period_start * 1000)
          : null,
        currentPeriodEnd: subscription.items.data[0]?.current_period_end
          ? new Date(subscription.items.data[0].current_period_end * 1000)
          : null,
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
        canceledAt: subscription.canceled_at ? new Date(subscription.canceled_at * 1000) : null,
      })
      .onConflictDoUpdate({
        target: membershipSubscriptions.stripeSubscriptionId,
        set: {
          stripePriceId: priceId,
          planCode,
          status,
          currentPeriodStart: subscription.items.data[0]?.current_period_start
            ? new Date(subscription.items.data[0].current_period_start * 1000)
            : null,
          currentPeriodEnd: subscription.items.data[0]?.current_period_end
            ? new Date(subscription.items.data[0].current_period_end * 1000)
            : null,
          cancelAtPeriodEnd: subscription.cancel_at_period_end,
          canceledAt: subscription.canceled_at ? new Date(subscription.canceled_at * 1000) : null,
        },
      });

    const access = await proAccess(tx, account.id);
    await tx.update(users).set({ plan: access.pro ? 'pro' : 'free' }).where(eq(users.id, account.id));
  }

  private subscriptionStatus(subscription: Stripe.Subscription) {
    if (subscription.cancel_at_period_end && subscription.status === 'active') return 'cancel_pending' as const;
    switch (subscription.status) {
      case 'incomplete':
        return 'incomplete' as const;
      case 'trialing':
        return 'trialing' as const;
      case 'active':
        return 'active' as const;
      case 'past_due':
        return 'past_due' as const;
      case 'canceled':
        return 'canceled' as const;
      case 'unpaid':
        return 'unpaid' as const;
      case 'paused':
        return 'paused' as const;
      default:
        this.log.warn(`Unmapped Stripe subscription state "${subscription.status}" treated as expired`);
        return 'expired' as const;
    }
  }
}
