import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { loadEnv } from '../config/env.js';
import type { Db } from '../db/db.module.js';
import { generationJobs, generations, trips } from '../db/schema.js';
import type { Providers } from '../providers/providers.module.js';
import { GenerationQueue, TripsService } from './trips.service.js';

type TestTrip = { id: string; userId: string; status: 'draft' | 'queued' | 'generating' | 'ready' | 'failed'; title: string; error: null; request: object };
type TestJob = { id: string; tripId: string; userId: string; status: 'queued' | 'generating' | 'completed' | 'failed' | 'released'; attempts: number; queuedAt: Date; heartbeatAt: Date | null; createdAt: Date };

function harness(queue: GenerationQueue, pro = false, completedGenerations = 0, role = 'user') {
  const user = { id: 'user-1', plan: 'free', role };
  const tripsInDb: TestTrip[] = [
    { id: 'trip-1', userId: user.id, status: 'draft', title: 'Trip 1', error: null, request: {} },
    { id: 'trip-2', userId: user.id, status: 'draft', title: 'Trip 2', error: null, request: {} },
  ];
  const jobs: TestJob[] = [];
  let tripLookup = 0;
  let jobSequence = 0;

  const tx = {
    execute: vi.fn(async () => undefined),
    query: {
      trips: {
        findFirst: vi.fn(async () => tripsInDb[tripLookup++]),
      },
      generationJobs: {
        findFirst: vi.fn(async () => jobs.findLast((job) => job.status === 'queued' || job.status === 'generating')),
      },
      users: {
        findFirst: vi.fn(async () => user),
      },
      membershipSubscriptions: {
        findFirst: vi.fn(async () => undefined),
      },
      complimentaryMembershipGrants: {
        findFirst: vi.fn(async () => pro ? { id: 'grant-1', expiresAt: new Date(Date.now() + 60_000) } : undefined),
      },
    },
    select: vi.fn(() => ({
      from: (table: unknown) => ({
        where: async () => [{ n: table === generations ? completedGenerations : jobs.filter((job) => job.status === 'queued' || job.status === 'generating').length }],
      }),
    })),
    update: vi.fn((table: unknown) => ({
      set: (values: Partial<TestTrip & TestJob>) => ({
        where: () => {
          let rows: unknown[] = [];
          if (table === trips && values.status === 'queued') {
            const trip = tripsInDb[tripLookup - 1];
            if (trip.status === 'draft' || trip.status === 'ready' || trip.status === 'failed') {
              Object.assign(trip, values);
              rows = [trip];
            }
          }
          if (table === trips && values.status === 'failed') {
            const trip = tripsInDb.find((item) => item.status === 'queued');
            if (trip) Object.assign(trip, values);
          }
          if (table === generationJobs && values.status === 'released') {
            const job = jobs.find((item) => item.status === 'queued');
            if (job) Object.assign(job, values);
          }
          return Object.assign(Promise.resolve(rows), { returning: async () => rows });
        },
      }),
    })),
    insert: vi.fn((table: unknown) => ({
      values: (values: { tripId: string; userId: string }) => ({
        returning: async () => {
          if (table !== generationJobs) return [];
          const job: TestJob = {
            id: `generation-${++jobSequence}`,
            tripId: values.tripId,
            userId: values.userId,
            status: 'queued',
            attempts: 0,
            queuedAt: new Date(),
            heartbeatAt: null,
            createdAt: new Date(),
          };
          jobs.push(job);
          return [{ id: job.id }];
        },
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
  const service = new TripsService(db, loadEnv({ QUEUE_INLINE: 'true', FREE_TRIPS_PER_MONTH: '1' }), queue, {} as Providers);
  return { service, user, tripsInDb, jobs };
}

describe('TripsService generation admission', () => {
  it('serializes quota checks and reserves the only free generation before enqueue', async () => {
    const enqueue = vi.fn(async () => undefined);
    const { service, jobs } = harness({ enqueue } as GenerationQueue);
    const user = { id: 'user-1', email: 'user@example.com', plan: 'free' };

    const results = await Promise.allSettled([
      service.requestGeneration(user, 'trip-1'),
      service.requestGeneration(user, 'trip-2'),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(enqueue).toHaveBeenCalledOnce();
    expect(jobs.filter((job) => job.status === 'queued')).toHaveLength(1);
  });

  it('releases the reservation and marks the trip failed when queue admission fails', async () => {
    const enqueue = vi.fn(async () => {
      throw new Error('Redis unavailable');
    });
    const { service, tripsInDb, jobs } = harness({ enqueue } as GenerationQueue);
    const user = { id: 'user-1', email: 'user@example.com', plan: 'free' };

    await expect(service.requestGeneration(user, 'trip-1')).rejects.toMatchObject({ status: 503 });
    expect(jobs[0].status).toBe('released');
    expect(tripsInDb[0].status).toBe('failed');
  });

  it('uses an active complimentary grant when enforcing the generation quota', async () => {
    const queue = { enqueue: vi.fn(async () => undefined) } as GenerationQueue;
    const { service, user } = harness(queue, true, 1);

    await expect(service.requestGeneration(user, 'trip-1')).resolves.toMatchObject({ status: 'queued' });
    expect(queue.enqueue).toHaveBeenCalledOnce();
  });

  it('allows administrators to generate beyond the free-plan quota', async () => {
    const queue = { enqueue: vi.fn(async () => undefined) } as GenerationQueue;
    const { service, user } = harness(queue, false, 1, 'admin');

    await expect(service.requestGeneration(user, 'trip-1')).resolves.toMatchObject({ status: 'queued' });
    expect(queue.enqueue).toHaveBeenCalledOnce();
  });

  it('returns an actionable upgrade error when the free quota is exhausted', async () => {
    const { service, user } = harness({ enqueue: vi.fn(async () => undefined) } as GenerationQueue, false, 1);

    await expect(service.requestGeneration(user, 'trip-1')).rejects.toMatchObject({
      status: 402,
      response: {
        code: 'FREE_PLAN_LIMIT',
        message: expect.stringContaining('Upgrade to Travlio Pro'),
      },
    });
  });
});

describe('TripsService stale generation recovery', () => {
  it('requeues a stale job only while its trip is still active', async () => {
    const staleAt = new Date(Date.now() - 120_000);
    const trip = { id: 'trip-1', userId: 'user-1', status: 'generating', title: 'Trip 1', error: null, request: {} };
    const job = {
      id: 'generation-1',
      tripId: trip.id,
      userId: trip.userId,
      status: 'generating',
      attempts: 1,
      queuedAt: staleAt,
      heartbeatAt: staleAt,
      createdAt: staleAt,
    };
    const enqueue = vi.fn(async () => undefined);
    const update = vi.fn((table: unknown) => ({
      set: (values: { status: string }) => ({
        where: () => {
          if (table === generationJobs && values.status === 'queued') {
            Object.assign(job, values);
            return Object.assign(Promise.resolve([job]), { returning: async () => [job] });
          }
          if (table === trips && values.status === 'queued') Object.assign(trip, values);
          return Object.assign(Promise.resolve([]), { returning: async () => [] });
        },
      }),
    }));
    const db = {
      query: { generationJobs: { findMany: vi.fn(async () => [job]) } },
      transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({
          execute: vi.fn(async () => undefined),
          update,
          query: { trips: { findFirst: vi.fn(async () => trip) } },
        }),
    } as unknown as Db;
    const service = new TripsService(db, loadEnv({ QUEUE_INLINE: 'true' }), { enqueue } as GenerationQueue, {} as Providers);

    await expect(service.recoverStaleGenerationJobs()).resolves.toBe(1);
    expect(job.status).toBe('queued');
    expect(trip.status).toBe('queued');
    expect(enqueue).toHaveBeenCalledWith(trip.id, job.id);
  });
});

describe('TripsService ownership', () => {
  const user = { id: 'user-1', email: 'user@example.com', plan: 'free' };

  it('returns not found when a user tries to delete a trip they do not own', async () => {
    const returning = vi.fn(async () => []);
    const where = vi.fn(() => ({ returning }));
    const deleteTrip = vi.fn(() => ({ where }));
    const db = { delete: deleteTrip } as unknown as Db;
    const service = new TripsService(db, loadEnv({ QUEUE_INLINE: 'true' }), { enqueue: vi.fn() } as GenerationQueue, {} as Providers);

    await expect(service.remove(user, 'trip-2')).rejects.toMatchObject({ status: 404 });
    expect(where).toHaveBeenCalledOnce();
  });

  it('returns the persisted share token and hides trips that are not owned', async () => {
    const returning = vi.fn(async () => [{ shareToken: 'existing-share-token' }]);
    const where = vi.fn(() => ({ returning }));
    const set = vi.fn(() => ({ where }));
    const update = vi.fn(() => ({ set }));
    const db = { update } as unknown as Db;
    const service = new TripsService(db, loadEnv({ QUEUE_INLINE: 'true' }), { enqueue: vi.fn() } as GenerationQueue, {} as Providers);

    await expect(service.share(user, 'trip-2')).resolves.toEqual({ shareToken: 'existing-share-token' });
    expect(where).toHaveBeenCalledOnce();

    returning.mockResolvedValueOnce([]);
    await expect(service.share(user, 'trip-3')).rejects.toMatchObject({ status: 404 });
  });
});

describe('TripsService nearby saved stops validation', () => {
  it('rejects invalid coordinates and radii before querying saved trips', async () => {
    const execute = vi.fn();
    const db = { execute } as unknown as Db;
    const service = new TripsService(db, loadEnv({ QUEUE_INLINE: 'true' }), { enqueue: vi.fn() } as GenerationQueue, {} as Providers);
    const user = { id: 'user-1', email: 'user@example.com', plan: 'free' };

    await expect(service.nearbySavedStops(user, 91, -79, 25)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.nearbySavedStops(user, 43, -79, 0)).rejects.toBeInstanceOf(BadRequestException);
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('TripsService generation execution', () => {
  it('does not rerun work when the generation reservation cannot be claimed', async () => {
    const generate = vi.fn();
    const db = {
      update: vi.fn(() => ({
        set: () => ({
          where: () => ({ returning: async () => [] }),
        }),
      })),
    } as unknown as Db;
    const service = new TripsService(db, loadEnv({ QUEUE_INLINE: 'true' }), { enqueue: vi.fn() } as GenerationQueue, {} as Providers);
    Object.defineProperty(service, 'planner', { value: { generate } });

    await expect(service.runGeneration('trip-1', 'generation-1')).resolves.toBeUndefined();
    expect(db.update).toHaveBeenCalledOnce();
    expect(generate).not.toHaveBeenCalled();
  });
});
