import { UnauthorizedException } from '@nestjs/common';
import type { JwtService } from '@nestjs/jwt';
import { describe, expect, it, vi } from 'vitest';
import { loadEnv } from '../config/env.js';
import type { Db } from '../db/db.module.js';
import { AuthService, sessionStillValid, wholeSecond } from './auth.js';
import type { Mailer } from './mailer.js';

vi.mock('./auth-schema.js', () => ({ ensureAuthSchema: async () => undefined }));

function service(row: { emailVerifiedAt: Date | null; sessionsValidAfter: Date | null } | undefined, iat: number) {
  const db = { query: { users: { findFirst: vi.fn(async () => row) } } } as unknown as Db;
  const jwt = { verify: vi.fn(() => ({ sub: 'user-1', email: 'a@example.com', plan: 'free', ev: false, iat })) } as unknown as JwtService;
  return new AuthService(db, loadEnv({}), jwt, {} as Mailer);
}

describe('session invalidation', () => {
  it('accepts tokens issued in or after the second sessions were reset', () => {
    const reset = wholeSecond(new Date('2026-10-20T12:00:00.750Z'));
    const resetSeconds = reset.getTime() / 1000;
    expect(sessionStillValid(resetSeconds - 1, reset)).toBe(false);
    expect(sessionStillValid(resetSeconds, reset)).toBe(true);
    expect(sessionStillValid(resetSeconds + 60, reset)).toBe(true);
    expect(sessionStillValid(undefined, reset)).toBe(false);
    expect(sessionStillValid(undefined, null)).toBe(true);
  });

  it('rejects a token issued before the last password reset', async () => {
    const reset = new Date('2026-10-20T12:00:00Z');
    const auth = service({ emailVerifiedAt: new Date(), sessionsValidAfter: reset }, reset.getTime() / 1000 - 3600);
    await expect(auth.authenticate('t')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a token for a deleted account', async () => {
    await expect(service(undefined, 1).authenticate('t')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('reads email verification from the database, not the token', async () => {
    const auth = service({ emailVerifiedAt: new Date(), sessionsValidAfter: null }, 1);
    await expect(auth.authenticate('t')).resolves.toMatchObject({ id: 'user-1', emailVerified: true });
  });
});
