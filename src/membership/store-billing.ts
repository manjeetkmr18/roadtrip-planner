import { Inject, Injectable, Logger, OnModuleInit, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { ENV, type Env } from '../config/env.js';
import { DB, type Db } from '../db/db.module.js';
import { storeSubscriptions, users } from '../db/schema.js';
import { proAccess } from './entitlements.js';
import { ensureStoreSchema } from './store-schema.js';

/**
 * App Store / Google Play subscriptions through RevenueCat.
 *
 * The app identifies purchasers by their Travlio user ID (Purchases.logIn(user.id)). Whenever
 * RevenueCat sends a webhook, or the app asks for a sync after a purchase or restore, the customer
 * is re-read from RevenueCat's REST API and stored. Webhook payloads are only used to know whom to
 * re-read, as RevenueCat recommends, so a forged or replayed event can't grant anything.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const RcDate = z.string().nullish();
const RcSubscriber = z.object({
  subscriber: z.object({
    entitlements: z
      .record(
        z.string(),
        z.object({
          expires_date: RcDate,
          grace_period_expires_date: RcDate,
          product_identifier: z.string(),
          purchase_date: RcDate,
        }),
      )
      .default({}),
    subscriptions: z
      .record(
        z.string(),
        z.object({
          expires_date: RcDate,
          store: z.string().nullish(),
          is_sandbox: z.boolean().nullish(),
          unsubscribe_detected_at: RcDate,
          billing_issues_detected_at: RcDate,
          refunded_at: RcDate,
          grace_period_expires_date: RcDate,
        }),
      )
      .default({}),
  }),
});
export type RcSubscriber = z.infer<typeof RcSubscriber>;

const RcWebhook = z.object({
  event: z.object({
    id: z.string().optional(),
    type: z.string(),
    app_user_id: z.string().nullish(),
    original_app_user_id: z.string().nullish(),
    aliases: z.array(z.string()).nullish(),
    transferred_from: z.array(z.string()).nullish(),
    transferred_to: z.array(z.string()).nullish(),
  }),
});

export type StoreEntitlement = {
  store: string;
  productId: string;
  status: 'active' | 'cancel_pending' | 'billing_issue' | 'expired' | 'refunded';
  expiresAt: Date | null;
  willRenew: boolean;
  sandbox: boolean;
};

const date = (value: string | null | undefined) => (value ? new Date(value) : null);

/** Turns RevenueCat's customer record into this entitlement's current state (null = never had it). */
export function readEntitlement(body: RcSubscriber, entitlementId: string, now = new Date()): StoreEntitlement | null {
  const entitlement = body.subscriber.entitlements[entitlementId];
  if (!entitlement) return null;
  const sub = body.subscriber.subscriptions[entitlement.product_identifier];
  const expires = date(entitlement.expires_date);
  const grace = date(entitlement.grace_period_expires_date) ?? date(sub?.grace_period_expires_date);
  // In a billing grace period the store keeps access open past the expiry date.
  const until = expires && grace && grace > expires ? grace : expires;
  const base = { store: sub?.store ?? 'unknown', productId: entitlement.product_identifier, expiresAt: until, sandbox: !!sub?.is_sandbox };
  if (sub?.refunded_at) return { ...base, status: 'refunded', willRenew: false };
  if (until && until <= now) return { ...base, status: 'expired', willRenew: false };
  if (sub?.billing_issues_detected_at && !sub.unsubscribe_detected_at) return { ...base, status: 'billing_issue', willRenew: true };
  if (sub?.unsubscribe_detected_at) return { ...base, status: 'cancel_pending', willRenew: false };
  // Lifetime / promotional entitlements without an expiry don't renew.
  return { ...base, status: 'active', willRenew: !!until };
}

/** Constant-time comparison of the webhook's Authorization header with the configured value. */
export function webhookAuthorized(header: string | undefined, expected: string | undefined) {
  if (!header || !expected) return false;
  const digest = (v: string) => createHash('sha256').update(v).digest();
  const value = header.startsWith('Bearer ') && !expected.startsWith('Bearer ') ? header.slice(7) : header;
  return timingSafeEqual(digest(value), digest(expected));
}

@Injectable()
export class StoreBillingService implements OnModuleInit {
  private readonly log = new Logger(StoreBillingService.name);

  /** Swappable in tests. */
  fetcher: typeof fetch = (input, init) => fetch(input, init);

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Create the table at startup, so Pro checks inside transactions never meet a missing table. */
  async onModuleInit() {
    try {
      await ensureStoreSchema(this.db);
    } catch (e) {
      this.log.warn(`store_subscriptions table not ready yet: ${(e as Error).message}`);
    }
  }

  get configured() {
    return !!this.env.REVENUECAT_SECRET_KEY;
  }

  private get entitlementId() {
    return this.env.REVENUECAT_ENTITLEMENT_ID;
  }

  async fetchSubscriber(appUserId: string): Promise<RcSubscriber> {
    if (!this.env.REVENUECAT_SECRET_KEY) throw new ServiceUnavailableException('In-app purchases are not configured');
    let res: Response;
    try {
      res = await this.fetcher(`${this.env.REVENUECAT_API_URL.replace(/\/$/, '')}/subscribers/${encodeURIComponent(appUserId)}`, {
        headers: { Authorization: `Bearer ${this.env.REVENUECAT_SECRET_KEY}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      this.log.warn(`RevenueCat unreachable: ${(e as Error).message}`);
      throw new ServiceUnavailableException('Could not reach the purchase service. Please try again.');
    }
    if (!res.ok) {
      this.log.warn(`RevenueCat GET subscriber failed: HTTP ${res.status}`);
      throw new ServiceUnavailableException('Could not check your purchases right now. Please try again.');
    }
    const parsed = RcSubscriber.safeParse(await res.json());
    if (!parsed.success) throw new ServiceUnavailableException('The purchase service sent an unexpected response.');
    return parsed.data;
  }

  /** Re-reads one user's purchases from RevenueCat and stores the result. Returns whether they now have Pro. */
  async syncUser(userId: string) {
    await ensureStoreSchema(this.db);
    const state = readEntitlement(await this.fetchSubscriber(userId), this.entitlementId);
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${userId}, 1))`);
      const account = await tx.query.users.findFirst({ where: eq(users.id, userId), columns: { id: true } });
      if (!account) return { pro: false, store: null };
      if (state) {
        const values = {
          store: state.store,
          productId: state.productId,
          status: state.status,
          expiresAt: state.expiresAt,
          willRenew: state.willRenew,
          sandbox: state.sandbox,
        };
        await tx
          .insert(storeSubscriptions)
          .values({ userId, entitlement: this.entitlementId, ...values })
          .onConflictDoUpdate({ target: [storeSubscriptions.userId, storeSubscriptions.entitlement], set: values });
      } else {
        // RevenueCat no longer has the entitlement for this user (e.g. transferred to another account).
        await tx
          .update(storeSubscriptions)
          .set({ status: 'expired', willRenew: false })
          .where(eq(storeSubscriptions.userId, userId));
      }
      const access = await proAccess(tx, userId);
      await tx.update(users).set({ plan: access.pro ? 'pro' : 'free' }).where(eq(users.id, userId));
      return { pro: access.pro, store: state };
    });
  }

  async handleWebhook(authorization: string | undefined, body: unknown) {
    if (!this.env.REVENUECAT_WEBHOOK_AUTH || !this.configured) {
      throw new ServiceUnavailableException('In-app purchase webhooks are not configured');
    }
    if (!webhookAuthorized(authorization, this.env.REVENUECAT_WEBHOOK_AUTH)) throw new UnauthorizedException('Invalid webhook authorization');
    const parsed = RcWebhook.safeParse(body);
    if (!parsed.success) return { received: true, synced: 0, ignored: 'unrecognised payload' };
    const e = parsed.data.event;
    const ids = [
      e.app_user_id,
      e.original_app_user_id,
      ...(e.aliases ?? []),
      ...(e.transferred_from ?? []),
      ...(e.transferred_to ?? []),
    ].filter((id): id is string => !!id && UUID.test(id));
    const unique = [...new Set(ids.map((id) => id.toLowerCase()))];
    if (!unique.length) return { received: true, synced: 0 };
    await ensureStoreSchema(this.db);
    const known = await this.db.select({ id: users.id }).from(users).where(inArray(users.id, unique));
    for (const { id } of known) await this.syncUser(id);
    this.log.log(`RevenueCat ${e.type}${e.id ? ` ${e.id}` : ''}: synced ${known.length} account(s)`);
    return { received: true, synced: known.length };
  }
}
