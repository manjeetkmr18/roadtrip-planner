import { ConflictException, ForbiddenException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { AuthUser, JwtGuard } from '../auth/auth.js';
import type { Db } from '../db/db.module.js';
import { adminAuditLogs, complimentaryMembershipGrants, membershipSubscriptions, users } from '../db/schema.js';
import { AdminGuard } from './admin.guard.js';
import { AdminService, CreateGrantRequest, DeleteUserRequest } from './admin.service.js';

const admin: AuthUser = { id: 'admin-1', email: 'admin@example.com', plan: 'free' };
const targetId = 'd7f8d5eb-28a7-4c42-a400-01cc46414d7e';

describe('AdminGuard', () => {
  it('uses the current database role instead of a client-supplied role', async () => {
    const request = { user: { ...admin, role: 'admin' } };
    const context = { switchToHttp: () => ({ getRequest: () => request }) };
    const db = { query: { users: { findFirst: vi.fn(async () => ({ role: 'user' })) } } } as unknown as Db;
    const guard = new AdminGuard({ canActivate: vi.fn() } as unknown as JwtGuard, db);

    await expect(guard.canActivate(context as never)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows an account whose persisted role is admin', async () => {
    const context = { switchToHttp: () => ({ getRequest: () => ({ user: admin }) }) };
    const db = { query: { users: { findFirst: vi.fn(async () => ({ role: 'admin' })) } } } as unknown as Db;
    const guard = new AdminGuard({ canActivate: vi.fn() } as unknown as JwtGuard, db);

    await expect(guard.canActivate(context as never)).resolves.toBe(true);
  });
});

describe('Admin membership and account actions', () => {
  it('validates grant expiry and requires exact user ID confirmation before deletion', () => {
    expect(CreateGrantRequest.safeParse({
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      reason: 'Customer support courtesy',
    }).success).toBe(true);
    expect(CreateGrantRequest.safeParse({ expiresAt: 'yesterday', reason: 'ok' }).success).toBe(false);
    expect(DeleteUserRequest.safeParse({ confirmUserId: targetId, reason: 'User requested deletion' }).success).toBe(true);
    expect(DeleteUserRequest.safeParse({ confirmUserId: 'wrong', reason: 'User requested deletion' }).success).toBe(false);
  });

  it('creates a complimentary grant and records the admin action', async () => {
    const expiry = new Date(Date.now() + 86_400_000);
    const grant = { id: 'grant-1', userId: targetId, grantedByUserId: admin.id, reason: 'Support courtesy', expiresAt: expiry };
    const insert = vi.fn((table: unknown) => ({
      values: vi.fn((value: unknown) => ({
        returning: async () => {
          if (table === complimentaryMembershipGrants) return [grant];
          if (table === adminAuditLogs) expect(value).toMatchObject({ action: 'pro_grant.created', targetUserId: targetId });
          return [];
        },
      })),
    }));
    const tx = {
      execute: vi.fn(async () => undefined),
      query: {
        users: { findFirst: vi.fn(async () => ({ id: targetId })) },
        complimentaryMembershipGrants: { findFirst: vi.fn(async () => undefined) },
      },
      insert,
      update: vi.fn((table: unknown) => ({
        set: vi.fn(() => ({
          where: async () => {
            if (table === users) return undefined;
          },
        })),
      })),
    };
    const db = { transaction: (callback: (value: typeof tx) => Promise<unknown>) => callback(tx) } as unknown as Db;
    const service = new AdminService(db);

    await expect(service.grantPro(admin, targetId, { expiresAt: expiry, reason: 'Support courtesy' })).resolves.toEqual(grant);
    expect(insert).toHaveBeenCalledWith(complimentaryMembershipGrants);
    expect(insert).toHaveBeenCalledWith(adminAuditLogs);
  });

  it('refuses account deletion while its Stripe subscription can still be active', async () => {
    const tx = {
      execute: vi.fn(async () => undefined),
      query: {
        users: { findFirst: vi.fn(async () => ({ id: targetId, email: 'target@example.com', role: 'user' })) },
        membershipSubscriptions: { findFirst: vi.fn(async () => ({ status: 'active' })) },
      },
      delete: vi.fn(),
      insert: vi.fn(),
    };
    const db = { transaction: (callback: (value: typeof tx) => Promise<unknown>) => callback(tx) } as unknown as Db;
    const service = new AdminService(db);

    await expect(service.deleteUser(admin, targetId, {
      confirmUserId: targetId,
      reason: 'User requested deletion',
    })).rejects.toBeInstanceOf(ConflictException);
    expect(tx.delete).not.toHaveBeenCalled();
    expect(tx.insert).not.toHaveBeenCalled();
    expect(membershipSubscriptions).toBeDefined();
  });
});
