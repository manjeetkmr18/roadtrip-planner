import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException, HttpException, HttpStatus, OnApplicationShutdown, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { and, count, desc, eq, gte, gt, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { LatLng, TravelOptionsQuery, TripRequest, type TripRequest as TripRequestType } from '../core/index.js';
import { ExchangeRates } from '../providers/fx.js';
import { TtlCache } from '../providers/infra.js';
import { travelOptions } from '../planning/travel-options.js';
import type { TravelOptions } from '../core/index.js';
import { DB, type Db } from '../db/db.module.js';
import { complimentaryMembershipGrants, generationJobs, generations, membershipSubscriptions, trips, tripStops, users } from '../db/schema.js';
import { ENV, type Env } from '../config/env.js';
import { Providers } from '../providers/providers.module.js';
import { ProviderContext } from '../providers/infra.js';
import { TripPlanner } from '../planning/planner.js';
import type { AuthUser } from '../auth/auth.js';

export const GENERATION_QUEUE = 'trip-generation';
const STALE_JOB_MS = 60_000;
const HEARTBEAT_MS = 15_000;
const RECOVERY_INTERVAL_MS = 60_000;
const PRO_STATUSES = ['active', 'trialing', 'cancel_pending'] as const;

function staleJobCondition(status: 'queued' | 'generating', cutoff: Date) {
  return status === 'queued'
    ? lt(generationJobs.queuedAt, cutoff)
    : or(lt(generationJobs.heartbeatAt, cutoff), and(isNull(generationJobs.heartbeatAt), lt(generationJobs.queuedAt, cutoff)));
}

function tripStructure(request: TripRequestType) {
  return {
    title: request.title,
    origin: request.origin,
    destination: request.destination,
    waypoints: request.waypoints,
    startDate: request.startDate,
    endDate: request.endDate,
    departureTime: request.departureTime,
    roundTrip: request.roundTrip,
    currency: request.currency,
    vehicle: request.vehicle,
    travel: request.travel,
  };
}

/** Where generation jobs go: BullMQ in normal operation, in-process when QUEUE_INLINE=true. */
export abstract class GenerationQueue {
  abstract enqueue(tripId: string, generationId: string): Promise<void>;
}

@Injectable()
export class TripsService implements OnModuleInit, OnApplicationShutdown {
  private readonly log = new Logger(TripsService.name);
  private readonly planner: TripPlanner;
  private recoveryTimer?: NodeJS.Timeout;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ENV) private readonly env: Env,
    private readonly queue: GenerationQueue,
    private readonly providers: Providers,
  ) {
    const fx = new ExchangeRates(env.USD_CAD_RATE);
    this.planner = new TripPlanner(providers, { usdToCad: () => fx.usdToCad(), placesSearchesPerDay: env.PLACES_SEARCHES_PER_DAY });
  }

  onModuleInit() {
    if (this.env.VERCEL) return;
    this.recoveryTimer = setInterval(() => {
      void this.recoverStaleGenerationJobs().catch((error) => this.log.error(`Stale generation recovery failed: ${String(error)}`));
    }, RECOVERY_INTERVAL_MS);
    this.recoveryTimer.unref();
  }

  onApplicationShutdown() {
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
  }

  /** Same search within 10 minutes is answered from memory (route + flight calls cost money). */
  private readonly optionsCache = new TtlCache<TravelOptions>(10 * 60_000);

  private async hasPro(tx: Parameters<Parameters<Db['transaction']>[0]>[0], userId: string) {
    const [account, subscription, grant] = await Promise.all([
      tx.query.users.findFirst({ where: eq(users.id, userId), columns: { role: true } }),
      tx.query.membershipSubscriptions.findFirst({
        where: and(
          eq(membershipSubscriptions.userId, userId),
          inArray(membershipSubscriptions.status, [...PRO_STATUSES]),
          gt(membershipSubscriptions.currentPeriodEnd, new Date()),
        ),
      }),
      tx.query.complimentaryMembershipGrants.findFirst({
        where: and(
          eq(complimentaryMembershipGrants.userId, userId),
          isNull(complimentaryMembershipGrants.revokedAt),
          gt(complimentaryMembershipGrants.expiresAt, new Date()),
        ),
      }),
    ]);
    return account?.role === 'admin' || !!(subscription || grant);
  }

  async travelOptions(query: TravelOptionsQuery) {
    const q = TravelOptionsQuery.parse(query);
    try {
      return await this.optionsCache.get(JSON.stringify(q), () => travelOptions(q, this.providers));
    } catch (e) {
      // A place that can't be found, or a provider refusing the request: say so instead of a bare 500.
      this.log.warn(`travel-options failed: ${(e as Error).message}`);
      throw new HttpException({ statusCode: 502, message: (e as Error).message.slice(0, 300) }, HttpStatus.BAD_GATEWAY);
    }
  }

  private defaultTitle(r: TripRequestType) {
    const short = (a: string) => a.split(',')[0].trim();
    return r.title?.trim() || `${short(r.origin.address)} → ${short(r.destination.address)}`;
  }

  async create(user: AuthUser, request: TripRequest) {
    const validated = TripRequest.parse(request);
    const [t] = await this.db.insert(trips).values({ userId: user.id, title: this.defaultTitle(validated), request: validated }).returning();
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
    const validated = TripRequest.parse(request);
    const [t] = await this.db
      .update(trips)
      .set({ request: validated, title: this.defaultTitle(validated), status: 'draft' })
      .where(and(eq(trips.id, id), eq(trips.userId, user.id)))
      .returning();
    if (!t) throw new NotFoundException('Trip not found');
    return t;
  }

  async remove(user: AuthUser, id: string) {
    const [deleted] = await this.db
      .delete(trips)
      .where(and(eq(trips.id, id), eq(trips.userId, user.id)))
      .returning({ id: trips.id });
    if (!deleted) throw new NotFoundException('Trip not found');
    return { deleted: true };
  }

  async usage(user: AuthUser) {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${user.id}, 0))`);
      const monthStart = new Date();
      monthStart.setUTCDate(1);
      monthStart.setUTCHours(0, 0, 0, 0);
      const [row] = await tx
        .select({ n: count() })
        .from(generations)
        .where(and(eq(generations.userId, user.id), gte(generations.createdAt, monthStart)));
      const [reserved] = await tx
        .select({ n: count() })
        .from(generationJobs)
        .where(
          and(
            eq(generationJobs.userId, user.id),
            gte(generationJobs.createdAt, monthStart),
            inArray(generationJobs.status, ['queued', 'generating']),
          ),
        );
      const account = await tx.query.users.findFirst({ where: eq(users.id, user.id) });
      const plan = (await this.hasPro(tx, user.id)) ? 'pro' : 'free';
      const limit = plan === 'pro' ? null : this.env.FREE_TRIPS_PER_MONTH;
      return { plan: account ? plan : 'free', usedThisMonth: row.n + reserved.n, limit };
    });
  }

  async requestGeneration(user: AuthUser, id: string, proposedRequest?: TripRequest, expectedGeneratedAt?: string) {
    const validatedProposal = proposedRequest ? TripRequest.parse(proposedRequest) : undefined;
    if (validatedProposal && !expectedGeneratedAt) throw new BadRequestException('A base plan version is required to apply assistant changes.');
    const admission = await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${user.id}, 0))`);
      let trip = await tx.query.trips.findFirst({ where: and(eq(trips.id, id), eq(trips.userId, user.id)) });
      if (!trip) throw new NotFoundException('Trip not found');
      if (validatedProposal && (trip.status !== 'ready' || !trip.plan || trip.plan.generatedAt !== expectedGeneratedAt)) {
        throw new ConflictException('The trip changed while you were chatting. Reload the latest plan and try again.');
      }
      if (validatedProposal) {
        const currentRequest = TripRequest.parse(trip.request);
        if (JSON.stringify(tripStructure(validatedProposal)) !== JSON.stringify(tripStructure(currentRequest))) {
          throw new BadRequestException('The trip assistant can update preferences only; route, dates, vehicle, and flight details must stay unchanged.');
        }
      }

      if (trip.status === 'queued' || trip.status === 'generating') {
        const job = await tx.query.generationJobs.findFirst({
          where: and(
            eq(generationJobs.tripId, id),
            inArray(generationJobs.status, ['queued', 'generating']),
          ),
          orderBy: desc(generationJobs.createdAt),
        });
        if (job) {
          if (job.status !== 'queued' && job.status !== 'generating') return { trip, generationId: undefined };
          const lastActivity = job.heartbeatAt ?? job.queuedAt;
          if (Date.now() - lastActivity.getTime() < STALE_JOB_MS) return { trip, generationId: undefined };
          const [requeued] = await tx
            .update(generationJobs)
            .set({ status: 'queued', queuedAt: new Date(), heartbeatAt: null })
            .where(
              and(
                eq(generationJobs.id, job.id),
                eq(generationJobs.status, job.status),
                staleJobCondition(job.status, new Date(Date.now() - STALE_JOB_MS)),
              ),
            )
            .returning({ id: generationJobs.id });
          if (!requeued) return { trip, generationId: undefined };
          const [recoveredTrip] = await tx
            .update(trips)
            .set({ status: 'queued', error: null })
            .where(and(eq(trips.id, id), eq(trips.userId, user.id)))
            .returning();
          return { trip: recoveredTrip ?? trip, generationId: job.id };
        }
        await tx
          .update(trips)
          .set({ status: 'failed', error: 'Generation job record is missing; retry to start a new plan.' })
          .where(and(eq(trips.id, id), eq(trips.userId, user.id)));
        trip = { ...trip, status: 'failed' };
      }

      const monthStart = new Date();
      monthStart.setUTCDate(1);
      monthStart.setUTCHours(0, 0, 0, 0);
      const [completed] = await tx
        .select({ n: count() })
        .from(generations)
        .where(and(eq(generations.userId, user.id), gte(generations.createdAt, monthStart)));
      const [reserved] = await tx
        .select({ n: count() })
        .from(generationJobs)
        .where(
          and(
            eq(generationJobs.userId, user.id),
            gte(generationJobs.createdAt, monthStart),
            inArray(generationJobs.status, ['queued', 'generating']),
          ),
        );
      const account = await tx.query.users.findFirst({ where: eq(users.id, user.id) });
      const plan = account && (await this.hasPro(tx, user.id)) ? 'pro' : 'free';
      const limit = plan === 'pro' ? null : this.env.FREE_TRIPS_PER_MONTH;
      if (limit != null && completed.n + reserved.n >= limit) {
        throw new HttpException(
          {
            statusCode: HttpStatus.PAYMENT_REQUIRED,
            code: 'FREE_PLAN_LIMIT',
            message: `You’ve used your ${limit} free trip plans this month. Your saved trips stay available. Upgrade to Travlio Pro to keep planning now.`,
          },
          HttpStatus.PAYMENT_REQUIRED,
        );
      }

      const [updated] = await tx
        .update(trips)
        .set({
          status: 'queued',
          error: null,
          ...(validatedProposal ? { request: validatedProposal, title: this.defaultTitle(validatedProposal) } : {}),
        })
        .where(and(
          eq(trips.id, id),
          eq(trips.userId, user.id),
          ...(validatedProposal ? [eq(trips.status, 'ready')] : [inArray(trips.status, ['draft', 'ready', 'failed'])]),
          ...(expectedGeneratedAt ? [sql`${trips.plan}->>'generatedAt' = ${expectedGeneratedAt}`] : []),
        ))
        .returning();
      if (!updated) {
        if (validatedProposal) throw new ConflictException('The trip changed while you were chatting. Reload the latest plan and try again.');
        const latest = await tx.query.trips.findFirst({ where: and(eq(trips.id, id), eq(trips.userId, user.id)) });
        if (!latest) throw new NotFoundException('Trip not found');
        return { trip: latest, generationId: undefined };
      }

      const [job] = await tx
        .insert(generationJobs)
        .values({ tripId: id, userId: user.id })
        .returning({ id: generationJobs.id });
      return { trip: updated, generationId: job.id };
    });

    const generationId = admission.generationId;
    if (!generationId) return admission.trip;
    await this.enqueueGenerationJob(id, user.id, generationId);
    return admission.trip;
  }

  private async enqueueGenerationJob(tripId: string, userId: string, generationId: string) {
    try {
      await this.queue.enqueue(tripId, generationId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${userId}, 0))`);
        await tx
          .update(generationJobs)
          .set({ status: 'released', completedAt: new Date(), lastError: message.slice(0, 500) })
          .where(and(eq(generationJobs.id, generationId), eq(generationJobs.status, 'queued')));
        await tx
          .update(trips)
          .set({ status: 'failed', error: 'Could not queue trip generation. Please retry.' })
          .where(and(eq(trips.id, tripId), eq(trips.userId, userId), eq(trips.status, 'queued')));
      });
      this.log.error(`Could not enqueue generation ${generationId}: ${message}`);
      throw new ServiceUnavailableException('Could not queue trip generation. Please retry.');
    }
  }

  async recoverStaleGenerationJobs() {
    const cutoff = new Date(Date.now() - STALE_JOB_MS);
    const staleJobs = await this.db.query.generationJobs.findMany({
      where: or(
        and(eq(generationJobs.status, 'queued'), lt(generationJobs.queuedAt, cutoff)),
        and(
          eq(generationJobs.status, 'generating'),
          or(lt(generationJobs.heartbeatAt, cutoff), and(isNull(generationJobs.heartbeatAt), lt(generationJobs.queuedAt, cutoff))),
        ),
      ),
      limit: 25,
    });
    let recoveredCount = 0;

    for (const staleJob of staleJobs) {
      if (staleJob.status !== 'queued' && staleJob.status !== 'generating') continue;
      const staleStatus = staleJob.status;
      const recovered = await this.db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${staleJob.userId}, 0))`);
        const [job] = await tx
          .update(generationJobs)
          .set({ status: 'queued', queuedAt: new Date(), heartbeatAt: null })
          .where(
            and(
              eq(generationJobs.id, staleJob.id),
              eq(generationJobs.status, staleStatus),
              staleJobCondition(staleStatus, cutoff),
            ),
          )
          .returning();
        if (!job) return undefined;
        const trip = await tx.query.trips.findFirst({
          where: and(eq(trips.id, staleJob.tripId), eq(trips.userId, staleJob.userId)),
        });
        if (!trip || (trip.status !== 'queued' && trip.status !== 'generating')) {
          await tx
            .update(generationJobs)
            .set({ status: 'released', completedAt: new Date() })
            .where(and(eq(generationJobs.id, staleJob.id), eq(generationJobs.status, 'queued')));
          return undefined;
        }
        await tx
          .update(trips)
          .set({ status: 'queued', error: null })
          .where(and(eq(trips.id, staleJob.tripId), eq(trips.userId, staleJob.userId)));
        return job;
      });
      if (!recovered) continue;
      await this.enqueueGenerationJob(staleJob.tripId, staleJob.userId, staleJob.id);
      recoveredCount++;
    }
    return recoveredCount;
  }

  /** Runs one generation. Called by the BullMQ worker (or inline). */
  async runGeneration(tripId: string, generationId: string) {
    const now = new Date();
    const [job] = await this.db
      .update(generationJobs)
      .set({
        status: 'generating',
        attempts: sql`${generationJobs.attempts} + 1`,
        startedAt: sql`coalesce(${generationJobs.startedAt}, ${now})`,
        heartbeatAt: now,
      })
      .where(
        and(
          eq(generationJobs.id, generationId),
          or(
            eq(generationJobs.status, 'queued'),
            and(
              eq(generationJobs.status, 'generating'),
              lt(generationJobs.heartbeatAt, new Date(Date.now() - STALE_JOB_MS)),
            ),
          ),
        ),
      )
      .returning();
    if (!job) return;
    const [t] = await this.db
      .select()
      .from(trips)
      .where(and(eq(trips.id, tripId), eq(trips.userId, job.userId)));
    if (!t) {
      await this.db.update(generationJobs).set({ status: 'released', completedAt: new Date() }).where(eq(generationJobs.id, generationId));
      return;
    }
    await this.db.update(trips).set({ status: 'generating' }).where(and(eq(trips.id, tripId), eq(trips.userId, job.userId)));
    const attempt = job.attempts;
    const heartbeat = setInterval(() => {
      void this.db
        .update(generationJobs)
        .set({ heartbeatAt: new Date() })
        .where(and(eq(generationJobs.id, generationId), eq(generationJobs.status, 'generating'), eq(generationJobs.attempts, attempt)))
        .catch((error) => this.log.error(`Generation heartbeat failed for ${generationId}: ${String(error)}`));
    }, HEARTBEAT_MS);
    heartbeat.unref();
    const ctx = new ProviderContext();
    const started = Date.now();
    try {
      const request = TripRequest.parse(t.request);
      const plan = await this.planner.generate(request, ctx);
      const committed = await this.db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${job.userId}, 0))`);
        const [completedJob] = await tx
          .update(generationJobs)
          .set({ status: 'completed', completedAt: new Date(), heartbeatAt: new Date(), lastError: null })
          .where(and(eq(generationJobs.id, generationId), eq(generationJobs.status, 'generating'), eq(generationJobs.attempts, attempt)))
          .returning({ id: generationJobs.id });
        if (!completedJob) return false;
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
          id: generationId,
          tripId,
          userId: t.userId,
          ok: true,
          apiCostUsd: plan.apiCostUsd,
          usedSampleData: plan.usedSampleData,
          durationMs: Date.now() - started,
          createdAt: job.createdAt,
        });
        return true;
      });
      if (committed) {
        this.log.log(`Trip ${tripId} ready in ${Date.now() - started} ms, API cost ~$${plan.apiCostUsd}, calls ${JSON.stringify(ctx.calls)}`);
      } else {
        this.log.warn(`Ignored stale generation attempt ${attempt} for ${generationId}`);
      }
    } catch (e) {
      const message = (e as Error).message ?? String(e);
      this.log.error(`Trip ${tripId} failed: ${message}`);
      await this.db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${job.userId}, 0))`);
        const [failedJob] = await tx
          .update(generationJobs)
          .set({ status: 'failed', completedAt: new Date(), heartbeatAt: new Date(), lastError: message.slice(0, 500) })
          .where(and(eq(generationJobs.id, generationId), eq(generationJobs.status, 'generating'), eq(generationJobs.attempts, attempt)))
          .returning({ id: generationJobs.id });
        if (!failedJob) return;
        await tx
          .update(trips)
          .set({ status: 'failed', error: message.slice(0, 500) })
          .where(and(eq(trips.id, tripId), eq(trips.userId, job.userId), eq(trips.status, 'generating')));
        await tx.insert(generations).values({
          id: generationId,
          tripId,
          userId: t.userId,
          ok: false,
          apiCostUsd: ctx.costUsd,
          durationMs: Date.now() - started,
          createdAt: job.createdAt,
        });
      });
    } finally {
      clearInterval(heartbeat);
    }
  }

  async share(user: AuthUser, id: string) {
    const token = randomBytes(12).toString('base64url');
    const [trip] = await this.db
      .update(trips)
      .set({ shareToken: sql`coalesce(${trips.shareToken}, ${token})` })
      .where(and(eq(trips.id, id), eq(trips.userId, user.id)))
      .returning({ shareToken: trips.shareToken });
    if (!trip) throw new NotFoundException('Trip not found');
    return { shareToken: trip.shareToken };
  }

  async getShared(token: string) {
    const t = await this.db.query.trips.findFirst({ where: eq(trips.shareToken, token) });
    if (!t || !t.plan) throw new NotFoundException('Shared trip not found');
    return { id: t.id, title: t.title, status: t.status, plan: t.plan, updatedAt: t.updatedAt };
  }

  /** Stops near a point from the user's saved trips (PostGIS), e.g. "places I already planned near here". */
  async nearbySavedStops(user: AuthUser, lat: number, lng: number, radiusKm: number) {
    if (!LatLng.safeParse({ lat, lng }).success) throw new BadRequestException('Invalid coordinates');
    if (!Number.isFinite(radiusKm) || radiusKm <= 0) throw new BadRequestException('Radius must be greater than zero');
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
