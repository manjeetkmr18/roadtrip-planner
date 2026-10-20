import { describe, expect, it } from 'vitest';
import { loadEnv } from './env.js';

describe('production environment', () => {
  it('requires email delivery configuration', () => {
    expect(() => loadEnv({ NODE_ENV: 'production', JWT_SECRET: 'x'.repeat(32) })).toThrow(/EMAIL_FROM/);
    expect(() =>
      loadEnv({
        NODE_ENV: 'production',
        JWT_SECRET: 'x'.repeat(32),
        EMAIL_FROM: 'Travlio <no-reply@example.com>',
      }),
    ).toThrow(/SES_REGION or AWS_REGION/);
  });
});

describe('trusted proxy configuration', () => {
  it('parses explicitly configured proxy IPs and CIDRs', () => {
    const env = loadEnv({ TRUSTED_PROXY_CIDRS: '10.0.0.0/8, 192.168.1.1' });
    expect(env.TRUSTED_PROXY_CIDRS).toEqual(['10.0.0.0/8', '192.168.1.1']);
    expect(loadEnv({}).TRUSTED_PROXY_CIDRS).toBeUndefined();
  });

  describe('Stripe configuration', () => {
    const complete = {
      STRIPE_SECRET_KEY: 'sk_test_example',
      STRIPE_WEBHOOK_SECRET: 'whsec_example',
      STRIPE_PRICE_ID_MONTHLY: 'price_monthly',
      STRIPE_PRICE_ID_ANNUAL: 'price_annual',
      WEB_APP_URL: 'http://localhost:3000',
    };

    it('accepts complete local Stripe configuration and rejects partial setup', () => {
      expect(loadEnv(complete).STRIPE_PRICE_ID_MONTHLY).toBe('price_monthly');
      expect(() => loadEnv({ STRIPE_SECRET_KEY: 'sk_test_example' })).toThrow(/both Stripe price IDs/);
    });

    it('requires HTTPS for production checkout redirects', () => {
      expect(() => loadEnv({ ...complete, NODE_ENV: 'production', JWT_SECRET: 'x'.repeat(32), EMAIL_FROM: 'Travlio <no-reply@example.com>', AWS_REGION: 'us-east-1' })).toThrow(/WEB_APP_URL.*HTTPS/);
    });
  });

  it('rejects invalid proxy ranges rather than trusting a broad fallback', () => {
    expect(() => loadEnv({ TRUSTED_PROXY_CIDRS: '*' })).toThrow(/valid IP address or CIDR/);
    expect(() => loadEnv({ TRUSTED_PROXY_CIDRS: '10.0.0.1/33' })).toThrow(/valid IP address or CIDR/);
  });
});
