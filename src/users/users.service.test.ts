import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../db/db.module.js';
import { UsersService } from './users.service.js';

describe('UsersService', () => {
  it('returns an authenticated user profile without billing or credential fields', async () => {
    const findFirst = vi.fn(async () => ({
      id: 'user-1',
      email: 'person@example.com',
      name: 'Person',
      plan: 'free',
      emailVerifiedAt: new Date('2026-01-01T00:00:00Z'),
      createdAt: new Date('2026-01-01T00:00:00Z'),
    }));
    const service = new UsersService({ query: { users: { findFirst } } } as unknown as Db);

    await expect(service.getProfile('user-1')).resolves.toEqual({
      id: 'user-1',
      email: 'person@example.com',
      name: 'Person',
      plan: 'free',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      emailVerified: true,
    });
  });

  it('updates only the profile name', async () => {
    const returning = vi.fn(async () => [{
      id: 'user-1',
      email: 'person@example.com',
      name: null,
      plan: 'free',
      emailVerifiedAt: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    }]);
    const where = vi.fn(() => ({ returning }));
    const set = vi.fn(() => ({ where }));
    const service = new UsersService({ update: vi.fn(() => ({ set })) } as unknown as Db);

    await expect(service.updateProfile('user-1', { name: null })).resolves.toMatchObject({
      id: 'user-1',
      name: null,
      emailVerified: false,
    });
    expect(set).toHaveBeenCalledWith({ name: null });
  });
});
