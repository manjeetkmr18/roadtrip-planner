import { ForbiddenException, Inject, Injectable, Logger, NotFoundException, HttpException, HttpStatus } from '@nestjs/common';
import { and, count, desc, eq, gte, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import type { TripRequest } from '@rtp/core';
import { DB, type Db } from '../db/db.module.js';
import { generations, trips, tripStops, users } from '../db/schema.js';
import { ENV, type Env } from '../config/env.js';
import { Providers } from '../providers/providers.module.js';
import { ProviderContext } from '../providers/infra.js';
import { TripPlanner } from '../planning/planner.js';
import type { AuthUser } from '../auth/auth.js';

export const GENERATION_QUEUE = 'trip-generation';

/** Where generation jobs go: BullMQ in normal operation, in-process when QUEUE_INLINE=true. */
export abstract class GenerationQueue {
  abstract enqueue(tripId: string): Promise<void>;
}

@Injectable()
export class TripsService {
  private readonly log = new Logger(TripsService.name);
  private readonly planner: TripPlanner;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ENV) private readonly env: Env,
    private readonly queue: GenerationQueue,
    providers: Providers,
  ) {
    this.planner = new TripPlanner(providers, { usdToCad: env.USD_CAD_RATE });
  }

  private defaultTitle(r: TripRequest) {
    const short = (a: string) => a.split(',')[0].trim();
    return r.title?.trim() || `${short(r.origin.address)} → ${short(r.destination.address)}`;
  }

  async create(user: AuthUser, request: TripRequest) {
    const [t] = await this.db.insert(trips).values({ userId: user.id, title: this.defaultTitle(request), request }).returning();
    return t;
  }

  list(user: AuthUser) {
    return this.db
      .select({
        id: trips.id,
        title: trips.title,
        status: trips.status,
        createdAt: trips.createdAt,
        updatedAt: trips.updatedAt,
        startDate: sql<string>`${trips.request}->>'startDate'`,
        endDate: sql<string>`${trips.request}->>'endDate'`,
      })
      .from(trips)
      .where(eq(trips.userId, user.id))
      .orderBy(desc(trips.updatedAt));
  }

  async get(user: AuthUser, id: string) {
    const t = await this.db.query.trips.findFirst({ where: and(eq(trips.id, id), eq(trips.userId, user.id)) });
    if (!t) throw new NotFoundException('Trip not found');
    return t;
  }

  async update(user: AuthUser, id: string, request: TripRequest) {
    await this.get(user, id);
    const [t] = await this.db
      .update(trips)
      .set({ request, title: this.defaultTitle(request), status: 'draft' })
      .where(eq(trips.id, id))
      .returning();
    return t;
  }

  async remove(user: AuthUser, id: string) {
    await this.get(user, id);
    await this.db.delete(trips).where(eq(trips.id, id));
    return { deleted: true };
  }

  async usage(user: AuthUser) {
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const [row] = await this.db
      .select({ n: count() })
      .from(generations)
      .where(and(eq(generations.userId, user.id), gte(generations.createdAt, monthStart)));
    const u = await this.db.query.users.findFirst({ where: eq(users.id, user.id) });
    const limit = u?.plan === 'pro' ? null : this.env.FREE_TRIPS_PER_MONTH;
    return { plan: u?.plan ?? 'free', usedThisMonth: row.n, limit };
  }

  async requestGeneration(user: AuthUser, id: string) {
    const t = await this.get(user, id);
    if (t.status === 'queued' || t.status === 'generating') return t;
    const usage = await this.usage(user);
    if (usage.limit != null && usage.usedThisMonth >= usage.limit) {
      throw new HttpException(
        `You've used your ${usage.limit} free trip plans this month. Upgrade for unlimited plans.`,
        HttpStatus.PAYMENT_REQUIRED,
      );
    }
    const [updated] = await this.db.update(trips).set({ status: 'queued', error: null }).where(eq(trips.id, id)).returning();
    await this.queue.enqueue(id);
    return updated;
  }

  /** Runs one generation. Called by the BullMQ worker (or inline). */
  async runGeneration(tripId: string) {
    const t = await this.db.query.trips.findFirst({ where: eq(trips.id, tripId) });
    if (!t) return;
    await this.db.update(trips).set({ status: 'generating' }).where(eq(trips.id, tripId));
    const ctx = new ProviderContext();
    const started = Date.now();
    try {
      const plan = await this.planner.generate(t.request, ctx);
      await this.db.transaction(async (tx) => {
        await tx
          .update(trips)
          .set({
            status: 'ready',
            plan,
            error: null,
            generationCount: sql`${trips.generationCount} + 1`,
            lastGeneratedAt: new Date(),
            apiCostUsd: sql`${trips.apiCostUsd} + ${plan.apiCostUsd}`,
          })
          .where(eq(trips.id, tripId));
        await tx.delete(tripStops).where(eq(tripStops.tripId, tripId));
        const stopRows = plan.days.flatMap((d) =>
          d.stops.map((s, i) => ({
            tripId,
            day: d.day,
            position: i,
            name: s.name,
            kind: s.kind,
            placeId: s.placeId,
            location: { x: s.location.lng, y: s.location.lat },
          })),
        );
        if (stopRows.length) await tx.insert(tripStops).values(stopRows);
        await tx.insert(generations).values({
          tripId,
          userId: t.userId,
          ok: true,
          apiCostUsd: plan.apiCostUsd,
          usedSampleData: plan.usedSampleData,
          durationMs: Date.now() - started,
        });
      });
      this.log.log(`Trip ${tripId} ready in ${Date.now() - started} ms, API cost ~$${plan.apiCostUsd}, calls ${JSON.stringify(ctx.calls)}`);
    } catch (e) {
      const message = (e as Error).message ?? String(e);
      this.log.error(`Trip ${tripId} failed: ${message}`);
      await this.db.update(trips).set({ status: 'failed', error: message.slice(0, 500) }).where(eq(trips.id, tripId));
      await this.db.insert(generations).values({ tripId, userId: t.userId, ok: false, apiCostUsd: ctx.costUsd, durationMs: Date.now() - started });
    }
  }

  async share(user: AuthUser, id: string) {
    const t = await this.get(user, id);
    if (t.shareToken) return { shareToken: t.shareToken };
    const token = randomBytes(12).toString('base64url');
    await this.db.update(trips).set({ shareToken: token }).where(eq(trips.id, id));
    return { shareToken: token };
  }

  async getShared(token: string) {
    const t = await this.db.query.trips.findFirst({ where: eq(trips.shareToken, token) });
    if (!t || !t.plan) throw new NotFoundException('Shared trip not found');
    return { id: t.id, title: t.title, status: t.status, plan: t.plan, updatedAt: t.updatedAt };
  }

  /** Stops near a point from the user's saved trips (PostGIS), e.g. "places I already planned near here". */
  async nearbySavedStops(user: AuthUser, lat: number, lng: number, radiusKm: number) {
    if (radiusKm > 200) throw new ForbiddenException('radius too large');
    const rows = await this.db.execute(sql`
      SELECT s.name, s.kind, s.day, s.trip_id AS "tripId", ST_Y(s.location) AS lat, ST_X(s.location) AS lng,
             ST_Distance(s.location::geography, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography) AS meters
      FROM trip_stops s JOIN trips t ON t.id = s.trip_id
      WHERE t.user_id = ${user.id}
        AND ST_DWithin(s.location::geography, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography, ${radiusKm * 1000})
      ORDER BY meters LIMIT 50`);
    return rows.rows;
  }
}
