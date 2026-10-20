import { BadRequestException } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { loadEnv } from '../config/env.js';
import type { Db } from '../db/db.module.js';
import type { JwtService } from '@nestjs/jwt';
import { AuthService } from './auth.js';
import type { Mailer } from './mailer.js';

const user = { id: 'user-1' };

function serviceWithCodeDb(options: { attempts?: number; code?: string } = {}) {
  const env = loadEnv({});
  let attempts = options.attempts ?? 0;
  let codeExists = true;
  let updateTail = Promise.resolve();
  let deleteTail = Promise.resolve();
  const expiresAt = new Date(Date.now() + 60_000);
  const row = {
    id: 'code-1',
    userId: 'user-1',
    purpose: 'verify_email',
    codeHash: createHmac('sha256', env.JWT_SECRET)
      .update(`verify_email:user-1:${options.code ?? '654321'}`)
      .digest('hex'),
    attempts,
    expiresAt,
    createdAt: new Date(),
  };
  const db = {
    query: { authCodes: { findFirst: vi.fn(async () => (codeExists ? { ...row, attempts } : undefined)) } },
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: async () => {
            const result = updateTail.then(() => {
              if (!codeExists || attempts >= 5 || expiresAt <= new Date()) return [];
              attempts += 1;
              return [{ attempts }];
            });
            updateTail = result.then(() => undefined);
            return result;
          },
        })),
      })),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(() => ({
        returning: async () => {
          const result = deleteTail.then(() => {
            if (!codeExists || attempts >= 5 || expiresAt <= new Date()) return [];
            codeExists = false;
            return [{ id: 'code-1' }];
          });
          deleteTail = result.then(() => undefined);
          return result;
        },
      })),
    })),
  } as unknown as Db;
  const service = new AuthService(db, env, {} as JwtService, {} as Mailer);
  const useCode = (service as unknown as {
    useCode: (u: { id: string }, purpose: 'verify_email' | 'reset_password', code: string) => Promise<void>;
  }).useCode.bind(service);
  return { useCode, db, getAttempts: () => attempts };
}

describe('AuthService email codes', () => {
  it('atomically counts concurrent wrong attempts and stops at the limit', async () => {
    const { useCode, getAttempts } = serviceWithCodeDb();
    const attempts = Array.from({ length: 8 }, () => useCode(user, 'verify_email', '000000'));

    const results = await Promise.allSettled(attempts);

    expect(results.every((result) => result.status === 'rejected' && result.reason instanceof BadRequestException)).toBe(true);
    expect(getAttempts()).toBe(5);
  });

  it('allows a valid code to be consumed only once under concurrent requests', async () => {
    const { useCode } = serviceWithCodeDb({ code: '123456' });

    const results = await Promise.allSettled([
      useCode(user, 'verify_email', '123456'),
      useCode(user, 'verify_email', '123456'),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  });

  it('serializes code issuance so concurrent resends respect the cooldown', async () => {
    const codes: Array<{ userId: string; purpose: string; codeHash: string; expiresAt: Date; createdAt: Date }> = [];
    const tx = {
      execute: vi.fn(async () => undefined),
      query: {
        authCodes: {
          findFirst: vi.fn(async () => codes.find((item) => Date.now() - item.createdAt.getTime() < 60_000)),
        },
      },
      delete: vi.fn(() => ({
        where: vi.fn(async () => {
          codes.splice(0, codes.length);
        }),
      })),
      insert: vi.fn(() => ({
        values: vi.fn(async (value: Omit<(typeof codes)[number], 'createdAt'>) => {
          codes.push({ ...value, createdAt: new Date() });
        }),
      })),
    };
    let transactionTail = Promise.resolve();
    const db = {
      transaction: <T>(callback: (transaction: typeof tx) => Promise<T>) => {
        const result = transactionTail.then(() => callback(tx));
        transactionTail = result.then(() => undefined, () => undefined);
        return result;
      },
    } as unknown as Db;
    const mailer = { configured: true, send: vi.fn(async () => undefined) } as unknown as Mailer;
    const service = new AuthService(db, loadEnv({}), {} as JwtService, mailer);
    const sendCode = (service as unknown as {
      sendCode: (u: { id: string; email: string }, purpose: 'verify_email' | 'reset_password') => Promise<boolean>;
    }).sendCode.bind(service);

    const results = await Promise.all([
      sendCode({ id: 'user-1', email: 'user@example.com' }, 'verify_email'),
      sendCode({ id: 'user-1', email: 'user@example.com' }, 'verify_email'),
    ]);

    expect(results).toEqual([true, false]);
    expect(codes).toHaveLength(1);
    expect(mailer.send).toHaveBeenCalledOnce();
    expect(tx.execute).toHaveBeenCalledTimes(2);
  });
});
