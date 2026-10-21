import { describe, expect, it } from 'vitest';
import { clientIp, RateLimiter } from './rate-limit.js';

describe('RateLimiter', () => {
  it('allows up to the limit per window, then asks to wait', () => {
    const r = new RateLimiter(3, 60_000);
    expect([r.hit('a', 0), r.hit('a', 1), r.hit('a', 2)]).toEqual([0, 0, 0]);
    expect(r.hit('a', 30_000)).toBe(30);
    expect(r.hit('b', 30_000)).toBe(0);
    expect(r.hit('a', 60_000)).toBe(0);
  });

  it('ignores untrusted forwarded addresses', () => {
    expect(clientIp({ headers: { 'x-forwarded-for': '1.2.3.4, 10.0.0.1' }, ip: '5.6.7.8' })).toBe('5.6.7.8');
    expect(clientIp({ headers: {}, ip: '5.6.7.8' })).toBe('5.6.7.8');
  });

  it('uses the Vercel-set client address on Vercel only', () => {
    const req = { headers: { 'x-vercel-forwarded-for': '9.9.9.9, 10.0.0.1', 'x-forwarded-for': '1.2.3.4' }, ip: '5.6.7.8' };
    expect(clientIp(req, true)).toBe('9.9.9.9');
    expect(clientIp(req, false)).toBe('5.6.7.8');
    expect(clientIp({ headers: {}, ip: '5.6.7.8' }, true)).toBe('5.6.7.8');
  });
});
