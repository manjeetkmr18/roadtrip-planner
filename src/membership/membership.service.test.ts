import { describe, expect, it, vi } from 'vitest';
import { loadEnv } from '../config/env.js';
import type { Db } from '../db/db.module.js';
import type { AuthUser } from '../auth/auth.js';
import { generationJobs, generations, membershipSubscriptions, membershipWebhookEvents, users } from '../db/schema.js';
import { CheckoutRequest, MembershipService } from './membership.service.js';
import type Stripe from 'stripe';

const user: AuthUser = { id: 'user-1', email: 'person@example.com', plan: 'free' };

describe('MembershipService', () => {
  it('requires an allow-listed plan and idempotency key for checkout', () => {
    expect(CheckoutRequest.safeParse({ plan: 'monthly', idempotencyKey: '35bf4fd2-65ef-4fc7-91a5-cb9cb0c72ef6' }).success).toBe(true);
    expect(CheckoutRequest.safeParse({ plan: 'custom', idempotencyKey: 'not-a-uuid' }).success).toBe(false);
  });

  it('reports effective membership from persisted subscription state, not client claims', async () => {
    const subscription = {
      userId: user.id,
      planCode: 'monthly',
      status: 'cancel_pending',
      currentPeriodStart: new Date('2026-10-01T00:00:00Z'),
      currentPeriodEnd: new Date('2026-11-01T00:00:00Z'),
      cancelAtPeriodEnd: true,
    };
    const findFirst = vi.fn(async () => subscription);
    const service = new MembershipService(
      {
        query: {
          users: { findFirst: vi.fn(async () => ({ role: 'user' })) },
          membershipSubscriptions: { findFirst },
          complimentaryMembershipGrants: { findFirst: vi.fn(async () => undefined) },
        },
      } as unknown as Db,
      loadEnv({}),
    );

    await expect(service.me(user)).resolves.toMatchObject({
      plan: 'pro',
      subscription: { plan: 'monthly', status: 'cancel_pending', cancelAtPeriodEnd: true },
    });

    const latestCanceled = { ...subscription, status: 'canceled' };
    const canceledFindFirst = vi.fn(async () => latestCanceled as typeof subscription | undefined);
    canceledFindFirst.mockResolvedValueOnce(undefined);
    const canceledService = new MembershipService(
      {
        query: {
          users: { findFirst: vi.fn(async () => ({ role: 'user' })) },
          membershipSubscriptions: { findFirst: canceledFindFirst },
          complimentaryMembershipGrants: { findFirst: vi.fn(async () => undefined) },
        },
      } as unknown as Db,
      loadEnv({}),
    );
    await expect(canceledService.me(user)).resolves.toMatchObject({ plan: 'free', subscription: { status: 'canceled' } });
  });

  it('allows arrival adjustments only with a current entitled subscription', async () => {
    const findFirst = vi.fn(async () => ({ id: 'subscription-1' }));
    const service = new MembershipService(
      {
        query: {
          users: { findFirst: vi.fn(async () => ({ role: 'user' })) },
          membershipSubscriptions: { findFirst },
          complimentaryMembershipGrants: { findFirst: vi.fn(async () => undefined) },
        },
      } as unknown as Db,
      loadEnv({}),
    );

    await expect(service.assertPro(user)).resolves.toBeUndefined();

    findFirst.mockResolvedValueOnce(undefined);
    await expect(service.assertPro(user)).rejects.toMatchObject({
      status: 403,
      message: 'Trip arrival adjustments require an active Travlio Pro membership.',
      response: { code: 'PRO_REQUIRED' },
    });
    expect(findFirst).toHaveBeenLastCalledWith(expect.objectContaining({
      where: expect.anything(),
      orderBy: expect.anything(),
    }));
  });

  it('recognizes a current complimentary grant as Pro', async () => {
    const service = new MembershipService({
      query: {
        users: { findFirst: vi.fn(async () => ({ role: 'user' })) },
        membershipSubscriptions: { findFirst: vi.fn(async () => undefined) },
        complimentaryMembershipGrants: { findFirst: vi.fn(async () => ({ id: 'grant-1' })) },
      },
    } as unknown as Db, loadEnv({}));

    await expect(service.assertPro(user)).resolves.toBeUndefined();
    await expect(service.me(user)).resolves.toMatchObject({
      plan: 'pro',
      subscription: { plan: 'complimentary', status: 'active' },
    });
  });

  it('reports completed and reserved monthly usage from server-side records', async () => {
    const db = {
      select: vi.fn(() => ({
        from: (table: unknown) => ({
          where: async () => [{ n: table === generations ? 2 : table === generationJobs ? 1 : 0 }],
        }),
      })),
      query: {
        users: { findFirst: vi.fn(async () => ({ role: 'user' })) },
        membershipSubscriptions: { findFirst: vi.fn(async () => undefined) },
        complimentaryMembershipGrants: { findFirst: vi.fn(async () => undefined) },
      },
    } as unknown as Db;
    const service = new MembershipService(db, loadEnv({ FREE_TRIPS_PER_MONTH: '3' }));

    await expect(service.usage(user)).resolves.toMatchObject({ plan: 'free', usedThisMonth: 3, limit: 3 });
  });

  it('grants administrators Pro access based on their persisted role', async () => {
    const service = new MembershipService({
      query: {
        users: { findFirst: vi.fn(async () => ({ role: 'admin' })) },
        membershipSubscriptions: { findFirst: vi.fn(async () => undefined) },
        complimentaryMembershipGrants: { findFirst: vi.fn(async () => undefined) },
      },
    } as unknown as Db, loadEnv({}));

    await expect(service.assertPro(user)).resolves.toBeUndefined();
    await expect(service.me(user)).resolves.toMatchObject({ plan: 'pro', access: 'admin' });
  });

  it('rejects payment operations while Stripe is unconfigured', async () => {
    const service = new MembershipService({} as Db, loadEnv({}));

    await expect(service.plans()).rejects.toMatchObject({ status: 503 });
  });

  it('deduplicates signed subscription webhook events and persists server-owned Pro state', async () => {
    let eventRecorded = false;
    let subscriptionWrites = 0;
    const subscription = {
      id: 'sub_1',
      customer: 'cus_1',
      metadata: { userId: user.id, planCode: 'monthly' },
      status: 'active',
      cancel_at_period_end: false,
      canceled_at: null,
      items: { data: [{ price: { id: 'price_monthly' }, current_period_start: 1_800_000_000, current_period_end: 1_802_592_000 }] },
    } as unknown as Stripe.Subscription;
    const tx = {
      execute: vi.fn(async () => undefined),
      insert: (table: unknown) => ({
        values: () => ({
          onConflictDoNothing: () => ({
            returning: async () => {
              if (table !== membershipWebhookEvents || eventRecorded) return [];
              eventRecorded = true;
              return [{ id: 'event-row' }];
            },
          }),
          onConflictDoUpdate: async () => {
            if (table === membershipSubscriptions) subscriptionWrites++;
          },
        }),
      }),
      query: {
        users: { findFirst: vi.fn(async () => ({ id: user.id })) },
        membershipSubscriptions: { findFirst: vi.fn(async () => ({ status: 'active' })) },
        complimentaryMembershipGrants: { findFirst: vi.fn(async () => undefined) },
      },
      update: (table: unknown) => ({
        set: vi.fn((values: { plan: string }) => ({
          where: async () => {
            if (table === users) expect(values.plan).toBe('pro');
          },
        })),
      }),
    };
    const db = {
      transaction: async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
    } as unknown as Db;
    const service = new MembershipService(db, loadEnv({
      STRIPE_SECRET_KEY: 'sk_test_example',
      STRIPE_WEBHOOK_SECRET: 'whsec_example',
      STRIPE_PRICE_ID_MONTHLY: 'price_monthly',
      STRIPE_PRICE_ID_ANNUAL: 'price_annual',
      WEB_APP_URL: 'http://localhost:3000',
    }));
    Object.defineProperty(service, 'stripeClient', {
      value: {
        webhooks: { constructEvent: () => ({ id: 'evt_1', type: 'customer.subscription.updated', data: { object: subscription } }) },
        subscriptions: { retrieve: vi.fn(async () => subscription) },
      },
    });

    await expect(service.handleWebhook(Buffer.from('{}'), 't=1,v1=signature')).resolves.toEqual({ received: true, duplicate: false });
    await expect(service.handleWebhook(Buffer.from('{}'), 't=1,v1=signature')).resolves.toEqual({ received: true, duplicate: true });
    expect(subscriptionWrites).toBe(1);
  });
});
