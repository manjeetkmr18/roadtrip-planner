import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { loadEnv } from '../config/env.js';
import type { Db } from '../db/db.module.js';
import { storePlanCode } from './membership.service.js';
import { readEntitlement, StoreBillingService, webhookAuthorized, type RcSubscriber } from './store-billing.js';

vi.mock('./store-schema.js', () => ({ ensureStoreSchema: async () => undefined, isMissingTable: () => false }));

const now = new Date('2026-10-20T12:00:00Z');
const later = '2026-11-20T12:00:00Z';
const earlier = '2026-10-01T12:00:00Z';

function customer(entitlement?: Partial<RcSubscriber['subscriber']['entitlements'][string]>, sub?: Record<string, unknown>): RcSubscriber {
  return {
    subscriber: {
      entitlements: entitlement ? { pro: { product_identifier: 'travlio_pro_monthly', expires_date: later, ...entitlement } } : {},
      subscriptions: { travlio_pro_monthly: { store: 'app_store', is_sandbox: false, expires_date: later, ...sub } },
    },
  } as RcSubscriber;
}

describe('readEntitlement', () => {
  it('reads an active, renewing subscription', () => {
    expect(readEntitlement(customer({}), 'pro', now)).toEqual({
      store: 'app_store', productId: 'travlio_pro_monthly', status: 'active', expiresAt: new Date(later), willRenew: true, sandbox: false,
    });
  });
  it('returns null when the customer never had the entitlement', () => {
    expect(readEntitlement(customer(), 'pro', now)).toBeNull();
  });
  it('marks cancelled-but-paid-up, expired, refunded, billing issue and sandbox', () => {
    expect(readEntitlement(customer({}, { unsubscribe_detected_at: earlier }), 'pro', now)).toMatchObject({ status: 'cancel_pending', willRenew: false });
    expect(readEntitlement(customer({ expires_date: earlier }), 'pro', now)).toMatchObject({ status: 'expired' });
    expect(readEntitlement(customer({}, { refunded_at: earlier }), 'pro', now)).toMatchObject({ status: 'refunded' });
    expect(readEntitlement(customer({}, { billing_issues_detected_at: earlier }), 'pro', now)).toMatchObject({ status: 'billing_issue', willRenew: true });
    expect(readEntitlement(customer({}, { is_sandbox: true, store: 'play_store' }), 'pro', now)).toMatchObject({ sandbox: true, store: 'play_store' });
  });
  it('keeps access through a store grace period', () => {
    const result = readEntitlement(customer({ expires_date: earlier, grace_period_expires_date: later }, { billing_issues_detected_at: earlier }), 'pro', now);
    expect(result).toMatchObject({ status: 'billing_issue', expiresAt: new Date(later) });
  });
  it('treats an entitlement without an expiry (lifetime / promotional) as active and not renewing', () => {
    expect(readEntitlement(customer({ expires_date: null }), 'pro', now)).toMatchObject({ status: 'active', expiresAt: null, willRenew: false });
  });
});

describe('webhookAuthorized', () => {
  it('compares the Authorization header with the configured value', () => {
    expect(webhookAuthorized('s3cret-value-123456', 's3cret-value-123456')).toBe(true);
    expect(webhookAuthorized('Bearer s3cret-value-123456', 's3cret-value-123456')).toBe(true);
    expect(webhookAuthorized('wrong', 's3cret-value-123456')).toBe(false);
    expect(webhookAuthorized(undefined, 's3cret-value-123456')).toBe(false);
    expect(webhookAuthorized('x', undefined)).toBe(false);
  });
});

describe('storePlanCode', () => {
  it('names monthly and annual products', () => {
    expect(storePlanCode('travlio_pro_annual')).toBe('annual');
    expect(storePlanCode('pro.yearly')).toBe('annual');
    expect(storePlanCode('travlio_pro_monthly')).toBe('monthly');
    expect(storePlanCode('weird')).toBe('weird');
  });
});

describe('StoreBillingService', () => {
  const env = loadEnv({ REVENUECAT_SECRET_KEY: 'sk_test', REVENUECAT_WEBHOOK_AUTH: 'webhook-auth-value-123' });
  const userId = '3f2c1a9e-5b7d-4c1e-9a2b-1234567890ab';

  function service(found: { id: string }[] = [{ id: userId }]) {
    const db = { select: () => ({ from: () => ({ where: async () => found }) }) } as unknown as Db;
    const s = new StoreBillingService(db, env);
    const sync = vi.spyOn(s, 'syncUser').mockResolvedValue({ pro: true, store: null });
    return { s, sync };
  }

  it('rejects webhooks without the right Authorization header', async () => {
    const { s, sync } = service();
    await expect(s.handleWebhook('nope', { event: { type: 'INITIAL_PURCHASE', app_user_id: userId } })).rejects.toBeInstanceOf(UnauthorizedException);
    expect(sync).not.toHaveBeenCalled();
  });

  it('re-reads every Travlio account named in the event, ignoring anonymous IDs', async () => {
    const { s, sync } = service();
    const result = await s.handleWebhook('webhook-auth-value-123', {
      event: { id: 'evt', type: 'TRANSFER', app_user_id: '$RCAnonymousID:abc', transferred_to: [userId.toUpperCase()], transferred_from: ['$RCAnonymousID:abc'] },
    });
    expect(result).toEqual({ received: true, synced: 1 });
    expect(sync).toHaveBeenCalledWith(userId);
  });

  it('answers 200 to test events that name no Travlio account', async () => {
    const { s, sync } = service([]);
    await expect(s.handleWebhook('webhook-auth-value-123', { event: { type: 'TEST', app_user_id: 'test-user' } })).resolves.toMatchObject({ synced: 0 });
    expect(sync).not.toHaveBeenCalled();
  });

  it('is unavailable until RevenueCat is configured', async () => {
    const s = new StoreBillingService({} as Db, loadEnv({}));
    await expect(s.handleWebhook('x', {})).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(s.fetchSubscriber(userId)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('reports RevenueCat outages as 503 without leaking details', async () => {
    const s = new StoreBillingService({} as Db, env);
    s.fetcher = vi.fn(async () => new Response('nope', { status: 500 }));
    await expect(s.fetchSubscriber(userId)).rejects.toBeInstanceOf(ServiceUnavailableException);
    s.fetcher = vi.fn(async () => { throw new Error('ECONNRESET'); });
    await expect(s.fetchSubscriber(userId)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
