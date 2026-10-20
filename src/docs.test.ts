import { describe, expect, it } from 'vitest';
import { buildOpenApi, docsAuth } from './docs.js';
import { loadEnv } from './config/env.js';

function call(header?: string) {
  const res = { code: 0, headers: {} as Record<string, string>, setHeader(k: string, v: string) { this.headers[k] = v; }, status(c: number) { this.code = c; return this; }, send() { return this; } };
  let passed = false;
  docsAuth('travlio', 'correct-horse-battery')({ headers: header ? { authorization: header } : {} } as never, res as never, () => (passed = true));
  return { passed, res };
}
const basic = (u: string, p: string) => `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`;

describe('API docs', () => {
  it('asks for a password without credentials or with wrong ones', () => {
    for (const h of [undefined, basic('travlio', 'wrong'), basic('admin', 'correct-horse-battery'), 'Bearer abc']) {
      const r = call(h);
      expect(r.passed).toBe(false);
      expect(r.res.code).toBe(401);
      expect(r.res.headers['WWW-Authenticate']).toContain('Basic');
    }
  });

  it('lets the right username and password through', () => {
    expect(call(basic('travlio', 'correct-horse-battery')).passed).toBe(true);
  });

  it('describes every endpoint, with schemas from the real validators', () => {
    const doc = buildOpenApi() as unknown as { paths: Record<string, object>; components: { schemas: Record<string, { properties?: Record<string, unknown> }> } };
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining([
        '/api/auth/register',
        '/api/auth/login',
        '/api/auth/me',
        '/api/auth/verify-email',
        '/api/auth/resend-verification',
        '/api/auth/forgot-password',
        '/api/auth/reset-password',
        '/api/users/me',
        '/api/membership/plans',
        '/api/membership/me',
        '/api/membership/usage',
        '/api/membership/checkout',
        '/api/membership/portal',
        '/api/membership/webhook',
        '/api/trips/travel-options',
        '/api/trips',
        '/api/trips/usage',
        '/api/trips/saved-stops/nearby',
        '/api/trips/{id}',
        '/api/trips/{id}/generate',
        '/api/trips/{id}/adjustments/preview',
        '/api/trips/{id}/adjustments/{adjustmentId}/apply',
        '/api/trips/{id}/adjustments/{adjustmentId}/undo',
        '/api/trips/{id}/share',
        '/api/share/{token}',
        '/api/places/autocomplete',
        '/api/places/details',
        '/api/places/photo',
        '/api/feedback',
        '/api/health',
        '/api/health/integrations',
        '/api/health/test-account',
      ]),
    );
    const expectedMethods: Record<string, string[]> = {
      '/api/auth/register': ['post'],
      '/api/auth/login': ['post'],
      '/api/auth/me': ['get'],
      '/api/auth/verify-email': ['post'],
      '/api/auth/resend-verification': ['post'],
      '/api/auth/forgot-password': ['post'],
      '/api/auth/reset-password': ['post'],
      '/api/users/me': ['get', 'patch'],
      '/api/membership/plans': ['get'],
      '/api/membership/me': ['get'],
      '/api/membership/usage': ['get'],
      '/api/membership/checkout': ['post'],
      '/api/membership/portal': ['post'],
      '/api/membership/webhook': ['post'],
      '/api/trips/travel-options': ['post'],
      '/api/trips': ['get', 'post'],
      '/api/trips/usage': ['get'],
      '/api/trips/saved-stops/nearby': ['get'],
      '/api/trips/{id}': ['get', 'put', 'delete'],
      '/api/trips/{id}/generate': ['post'],
      '/api/trips/{id}/adjustments/preview': ['post'],
      '/api/trips/{id}/adjustments/{adjustmentId}/apply': ['post'],
      '/api/trips/{id}/adjustments/{adjustmentId}/undo': ['post'],
      '/api/trips/{id}/share': ['post'],
      '/api/share/{token}': ['get'],
      '/api/places/autocomplete': ['get'],
      '/api/places/details': ['get'],
      '/api/places/photo': ['get'],
      '/api/feedback': ['post'],
      '/api/health': ['get'],
      '/api/health/integrations': ['get'],
      '/api/health/test-account': ['post'],
    };
    for (const [path, methods] of Object.entries(expectedMethods)) {
      expect(Object.keys(doc.paths[path] as object)).toEqual(expect.arrayContaining(methods));
    }
    expect(Object.keys(doc.paths['/api/health'] as object)).toContain('get');
    expect(Object.keys(doc.paths['/api/health/integrations'] as object)).toContain('get');
    expect(Object.keys(doc.paths['/api/health/test-account'] as object)).toContain('post');
    expect(Object.keys(doc.components.schemas.TripRequest.properties ?? {})).toEqual(expect.arrayContaining(['origin', 'destination', 'startDate', 'preferences']));
    expect(JSON.stringify(doc)).toContain('"bearer"');
  });

  it('refuses a short docs password', () => {
    expect(() => loadEnv({ DOCS_USERNAME: 'a', DOCS_PASSWORD: 'short' })).toThrow(/DOCS_PASSWORD/);
  });
});

describe('Vercel environment', () => {
  const emailConfig = { EMAIL_FROM: 'Travlio <no-reply@example.com>', AWS_REGION: 'us-east-1' };
  const base = { VERCEL: '1', JWT_SECRET: 'x'.repeat(32), DATABASE_URL: 'postgres://u:p@ep-x.neon.tech/db?sslmode=require' };
  it('plans in-process and keeps the pool small on Vercel', () => {
    const env = loadEnv({ ...base, ...emailConfig });
    expect(env.QUEUE_INLINE).toBe(true);
    expect(env.DB_POOL_MAX).toBe(3);
  });
  it('ignores a copied local Redis setting on Vercel', () => {
    expect(loadEnv({ ...base, QUEUE_INLINE: 'false', REDIS_URL: 'redis://localhost:6379' }).QUEUE_INLINE).toBe(true);
    expect(loadEnv({ ...base, QUEUE_INLINE: 'false', REDIS_URL: 'rediss://default:x@eu1.upstash.io:6379' }).QUEUE_INLINE).toBe(false);
  });
  it('fails clearly without a JWT secret or a real database', () => {
    expect(() => loadEnv({ ...base, ...emailConfig, JWT_SECRET: undefined })).toThrow(/JWT_SECRET/);
    expect(() => loadEnv({ ...base, ...emailConfig, DATABASE_URL: undefined })).toThrow(/DATABASE_URL/);
  });
});
