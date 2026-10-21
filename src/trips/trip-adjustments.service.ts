import { BadRequestException, ConflictException, HttpException, HttpStatus, Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { decodePolyline, encodePolyline, formatHHMM, haversineMeters, parseHHMM, scheduleDay, summarizeCosts, TripAdjustmentRequest, TripAssistantRequest, TripRequest, validatePlan, type DayPlan, type TripPlan } from '../core/index.js';
import { DB, type Db } from '../db/db.module.js';
import { tripAdjustments, tripStops, trips } from '../db/schema.js';
import { ENV, type Env } from '../config/env.js';
import type { AuthUser } from '../auth/auth.js';
import { ExchangeRates } from '../providers/fx.js';
import { ProviderContext, nowIso } from '../providers/infra.js';
import { Providers } from '../providers/providers.module.js';
import type { RawRoute, ResolvedPlace } from '../providers/google.js';
import { legCostLines } from '../planning/route-costs.js';
import { localIso } from '../planning/planner.js';
import { timeZoneAt } from '../core/timezone.js';
import { MembershipService } from '../membership/membership.service.js';
import { RateLimiter } from '../common/rate-limit.js';
import { ASSISTANT_MAX_TOKENS, ASSISTANT_PRO_MESSAGE, ASSISTANT_SCHEMA, ASSISTANT_SYSTEM, planDigest, readAssistantOutput } from './assistant.js';

const HOTEL_RADIUS_METERS = 100_000;

function appendPolyline(route: string | undefined, extension: string): string {
  const original = route ? decodePolyline(route) : [];
  const extra = decodePolyline(extension);
  if (!original.length) return extension;
  const joins = extra.length && haversineMeters(original.at(-1)!, extra[0]) < 100 ? extra.slice(1) : extra;
  return encodePolyline([...original, ...joins]);
}

export function extendPlan(
  plan: TripPlan,
  destination: ResolvedPlace,
  accommodation: ResolvedPlace,
  route: RawRoute,
  arrivalDay: number,
  arrivalTime: string,
  resumeTime: string,
  extraCosts: Map<string, Awaited<ReturnType<typeof legCostLines>>>,
  roadEvents: TripPlan['roadEvents'],
): TripPlan {
  if (plan.request.roundTrip || plan.request.travel.mode !== 'drive') {
    throw new BadRequestException('Hotel adjustments currently support one-way drive trips only.');
  }

  const targetIndex = plan.days.findIndex(
    (day) => day.day === arrivalDay && day.drivingSeconds > 0 && !!day.endLocation && haversineMeters(day.endLocation, destination.location) < 15_000,
  );
  if (targetIndex < 0) {
    throw new BadRequestException('Choose the day your trip reaches its destination.');
  }
  if (plan.days.slice(targetIndex + 1).some((day) => day.drivingSeconds > 0)) {
    throw new BadRequestException('Hotel adjustments are available for the final destination arrival day.');
  }
  if (haversineMeters(destination.location, accommodation.location) > HOTEL_RADIUS_METERS) {
    throw new BadRequestException('Choose lodging within 100 km of your planned destination.');
  }

  const oldDay = plan.days[targetIndex];
  const newDistance = oldDay.distanceMeters + route.distanceMeters;
  if (newDistance <= 0) throw new BadRequestException('Could not calculate a route to the lodging location.');
  const hotelArrivalMinutes = parseHHMM(arrivalTime) + Math.ceil(route.durationSeconds / 60);
  const arrivalAtHotel = formatHHMM(hotelArrivalMinutes);
  const retainedStops = oldDay.stops
    .filter((stop) => stop.kind === 'fuel' || stop.kind === 'waypoint')
    .map((stop) => ({
      ...stop,
      routeFraction: Math.min(0.99, ((stop.routeFraction ?? 0) * oldDay.distanceMeters) / newDistance),
    }));
  const scheduledRetained = scheduleDay({ departureTime: oldDay.departureTime, drivingSeconds: oldDay.drivingSeconds + route.durationSeconds, stops: retainedStops }).stops;
  if (scheduledRetained.some((stop) => stop.arrivalTime && parseHHMM(stop.arrivalTime) > parseHHMM(arrivalTime))) {
    throw new BadRequestException('The selected arrival time is earlier than a retained fuel or custom stop. Choose a later arrival or edit those stops first.');
  }
  const destinationFraction = oldDay.distanceMeters / newDistance;
  const cityArrival = {
    id: `arrival-${randomUUID()}`,
    name: destination.label,
    kind: 'waypoint' as const,
    location: destination.location,
    visitMinutes: 0,
    routeFraction: destinationFraction,
    arrivalTime,
    description: 'Your stated arrival time before continuing to lodging.',
  };
  const overnight = {
    id: `lodging-${randomUUID()}`,
    name: accommodation.label,
    kind: 'overnight' as const,
    location: accommodation.location,
    placeId: accommodation.placeId,
    visitMinutes: 0,
    routeFraction: 1,
    arrivalTime: arrivalAtHotel,
    arrivalDayOffset: Math.floor(hotelArrivalMinutes / 1440),
    mapsUrl: `https://www.google.com/maps/dir/?api=1&destination=${accommodation.location.lat},${accommodation.location.lng}`,
    description: 'Lodging selected by you; not a booking.',
  };
  const adjustedTarget: DayPlan = {
    ...oldDay,
    endPlace: accommodation.label,
    endLocation: accommodation.location,
    distanceMeters: newDistance,
    drivingSeconds: oldDay.drivingSeconds + route.durationSeconds,
    stops: [...scheduledRetained, cityArrival, overnight].sort((a, b) => (a.routeFraction ?? 0) - (b.routeFraction ?? 0)),
  };
  adjustedTarget.stops = adjustedTarget.stops.map((stop) =>
    stop.id === cityArrival.id ? cityArrival : stop.id === overnight.id ? overnight : stop,
  );

  const days = plan.days.map((day, index) => {
    if (index === targetIndex) return adjustedTarget;
    if (index <= targetIndex) return day;
    const updated: DayPlan = {
      ...day,
      startPlace: accommodation.label,
      endPlace: accommodation.label,
      endLocation: accommodation.location,
      departureTime: index === targetIndex + 1 ? resumeTime : day.departureTime,
    };
    return { ...updated, stops: scheduleDay(updated).stops };
  });
  const newIssues = validatePlan({
    days,
    preferences: plan.request.preferences,
    totalTripDays: days.length,
    drivingDaysNeeded: days.filter((day) => day.drivingSeconds > 0).length,
  });
  const validatedCodes = new Set([
    'TRIP_TOO_SHORT',
    'DRIVE_LIMIT_EXCEEDED',
    'DAY_TOO_LONG',
    'LATE_ARRIVAL',
    'STOP_ORDER',
    'CLOSED_ON_ARRIVAL',
    'HOURS_UNKNOWN',
    'LONG_DETOUR',
    'PAST_END_DATE',
  ]);
  const retainedIssues = plan.issues.filter((issue) => !validatedCodes.has(issue.code));
  const routes = plan.routes.map((routeOption) => {
    const costs = [...routeOption.costs, ...(extraCosts.get(routeOption.id) ?? [])];
    return {
      ...routeOption,
      distanceMeters: routeOption.distanceMeters + route.distanceMeters,
      durationSeconds: routeOption.durationSeconds + route.durationSeconds,
      polyline: appendPolyline(routeOption.polyline, route.polyline),
      costs,
      summary: summarizeCosts(costs, plan.request.currency),
    };
  });
  const providerNotes = [...plan.providerNotes, 'The destination-to-lodging drive was added. Existing route advisories and destination-area forecasts are unchanged.'];
  return {
    ...plan,
    generatedAt: nowIso(),
    routes,
    days,
    issues: [...retainedIssues, ...newIssues],
    roadEvents: [...plan.roadEvents, ...roadEvents.filter((event) => !plan.roadEvents.some((old) => old.id === event.id))],
    providerNotes,
    usedSampleData: plan.usedSampleData || route.sample,
  };
}

@Injectable()
export class TripAdjustmentsService {
  private readonly fx: ExchangeRates;
  private readonly log = new Logger(TripAdjustmentsService.name);
  private readonly assistantLimit = new RateLimiter(12, 60_000);

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ENV) private readonly env: Env,
    private readonly providers: Providers,
    private readonly membership: MembershipService,
  ) {
    this.fx = new ExchangeRates(env.USD_CAD_RATE);
  }

  async chat(user: AuthUser, tripId: string, input: TripAssistantRequest) {
    await this.membership.assertPro(user, ASSISTANT_PRO_MESSAGE);
    if (this.assistantLimit.hit(user.id)) {
      throw new HttpException({ statusCode: 429, message: 'Too many assistant messages. Try again in a minute.' }, HttpStatus.TOO_MANY_REQUESTS);
    }
    const request = TripAssistantRequest.parse(input);
    const trip = await this.db.query.trips.findFirst({ where: and(eq(trips.id, tripId), eq(trips.userId, user.id)) });
    if (!trip) throw new NotFoundException('Trip not found');
    if (trip.status !== 'ready' || !trip.plan) throw new ConflictException('Plan the trip before using the trip assistant.');
    if (!this.providers.llm.enabled || !this.providers.llm.completeJson) {
      throw new ServiceUnavailableException('The trip assistant is unavailable because its AI provider is not configured.');
    }

    const draft = TripRequest.parse(request.draft ?? trip.request);
    const context = new ProviderContext();
    let raw: unknown;
    try {
      raw = await this.providers.llm.completeJson({
        system: ASSISTANT_SYSTEM,
        prompt: JSON.stringify({
          plan: planDigest(trip.plan, draft),
          // Only the latest turns; the newest message is the traveller's.
          conversation: request.messages,
        }),
        maxTokens: ASSISTANT_MAX_TOKENS,
        fast: true,
        name: 'reply_to_traveller',
        schema: ASSISTANT_SCHEMA,
      }, context);
    } catch (e) {
      this.log.warn(`trip assistant call failed: ${(e as Error).message}`);
      throw new ServiceUnavailableException('The trip assistant is busy right now. Please try again in a moment.');
    } finally {
      if (context.costUsd > 0) {
        await this.db
          .update(trips)
          .set({ apiCostUsd: sql`${trips.apiCostUsd} + ${context.costUsd}` })
          .where(and(eq(trips.id, tripId), eq(trips.userId, user.id)));
      }
    }
    const result = readAssistantOutput(raw, draft.preferences);
    if (!result) throw new ServiceUnavailableException('The trip assistant returned an invalid response. Please try again.');
    const proposal = result.preferences ? TripRequest.parse({ ...draft, preferences: result.preferences }) : null;
    return { reply: result.reply, needsClarification: result.needsClarification, proposal };
  }

  async preview(user: AuthUser, tripId: string, input: TripAdjustmentRequest) {
    await this.membership.assertPro(user);
    const request = TripAdjustmentRequest.parse(input);
    const trip = await this.db.query.trips.findFirst({ where: and(eq(trips.id, tripId), eq(trips.userId, user.id)) });
    if (!trip) throw new NotFoundException('Trip not found');
    if (trip.status !== 'ready' || !trip.plan) throw new ConflictException('Plan the trip before adjusting it.');
    if (trip.plan.request.roundTrip || trip.plan.request.travel.mode !== 'drive') {
      throw new BadRequestException('Hotel adjustments currently support one-way drive trips only.');
    }

    const context = new ProviderContext();
    const day = trip.plan.days.find((candidate) => candidate.day === request.arrivalDay);
    if (!day) throw new BadRequestException('The selected arrival day is not part of this itinerary.');
    if (day.drivingSeconds <= 0 || !day.endLocation) throw new BadRequestException('Choose a driving day that reaches the destination.');
    if (trip.plan.days.some((candidate) => candidate.day > day.day && candidate.drivingSeconds > 0)) {
      throw new BadRequestException('Hotel adjustments are available for the final destination arrival day.');
    }
    const [destinationGeocode, accommodationGeocode] = await Promise.all([
      this.providers.geocoding.resolve(
        { address: trip.plan.request.destination.address, placeId: trip.plan.request.destination.placeId },
        context,
      ),
      this.providers.geocoding.resolve({ address: request.accommodation.address, placeId: request.accommodation.placeId }, context),
    ]);
    const destinationGeocodeLocation = context.usedSampleData && trip.plan.request.destination.location
      ? trip.plan.request.destination.location
      : destinationGeocode.location;
    const accommodation: ResolvedPlace = {
      ...accommodationGeocode,
      label: request.accommodation.address,
      ...(context.usedSampleData && request.accommodation.location ? { location: request.accommodation.location } : {}),
    };
    if (haversineMeters(day.endLocation, destinationGeocodeLocation) > 15_000) {
      throw new BadRequestException('Choose the driving day that reaches your planned destination.');
    }
    const destination: ResolvedPlace = { ...destinationGeocode, location: day.endLocation, label: day.endPlace };
    if (haversineMeters(destination.location, accommodation.location) > HOTEL_RADIUS_METERS) {
      throw new BadRequestException('Choose lodging within 100 km of your planned destination.');
    }
    const [route] = await this.providers.routes.compute(
      {
        origin: destination.location,
        destination: accommodation.location,
        waypoints: [],
        departureIso: localIso(day.date, request.arrivalTime, timeZoneAt(destination)),
        alternatives: false,
        avoidFerries: trip.plan.request.preferences.avoidFerries,
      },
      context,
    );
    if (!route) throw new BadRequestException('No route could be calculated to the lodging location.');

    const extraCosts = new Map<string, Awaited<ReturnType<typeof legCostLines>>>();
    const usdToCad = await this.fx.usdToCad();
    for (const routeOption of trip.plan.routes) {
      extraCosts.set(
        routeOption.id,
        await legCostLines(
          {
            idPrefix: `${routeOption.id}-lodging`,
            labelPrefix: 'Destination to lodging · ',
            raw: route,
            date: day.date,
            from: destination,
            to: accommodation,
          },
          trip.plan.request,
          this.providers,
          context,
          usdToCad,
        ),
      );
    }
    const roadEvents = route.polyline ? await this.providers.roads.eventsNearRoute(route.polyline, context) : [];
    const plan = extendPlan(trip.plan, destination, accommodation, route, request.arrivalDay, request.arrivalTime, request.resumeTime, extraCosts, roadEvents);
    plan.usedSampleData ||= context.usedSampleData;
    plan.apiCostUsd += context.costUsd;
    if (roadEvents.some((event) => event.fullClosure)) {
      plan.issues.push(
        ...roadEvents
          .filter((event) => event.fullClosure)
          .map((event) => ({
            severity: 'warning' as const,
            code: 'ROAD_CLOSURE',
            message: `${event.road}: ${event.description}`,
          })),
      );
    }
    const [adjustment] = await this.db
      .insert(tripAdjustments)
      .values({
        tripId,
        userId: user.id,
        baseGeneratedAt: trip.plan.generatedAt,
        previousPlan: trip.plan,
        proposedPlan: plan,
        apiCostUsd: context.costUsd,
      })
      .returning({ id: tripAdjustments.id });
    return {
      id: adjustment.id,
      plan,
      summary: {
        removedStops: trip.plan.days.find((candidate) => candidate.day === request.arrivalDay)?.stops.filter((stop) => ['attraction', 'meal', 'rest'].includes(stop.kind)).map((stop) => stop.name) ?? [],
        lodging: accommodation.label,
        arrivalTime: request.arrivalTime,
        lodgingArrivalTime: plan.days.find((candidate) => candidate.day === request.arrivalDay)?.stops.find((stop) => stop.kind === 'overnight')?.arrivalTime,
        lodgingArrivalNextDay: plan.days.find((candidate) => candidate.day === request.arrivalDay)?.stops.find((stop) => stop.kind === 'overnight')?.arrivalDayOffset === 1,
        resumedDay: plan.days.find((candidate) => candidate.day === request.arrivalDay + 1)?.day ?? null,
        resumeTime: request.resumeTime,
        extraDistanceMeters: route.distanceMeters,
        extraDrivingSeconds: route.durationSeconds,
        usedSampleData: context.usedSampleData,
      },
    };
  }

  async apply(user: AuthUser, tripId: string, adjustmentId: string) {
    const adjustment = await this.findAdjustment(user, tripId, adjustmentId);
    if (adjustment.status !== 'proposed') throw new ConflictException('This itinerary proposal is no longer available.');
    return this.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(trips)
          .set({ plan: adjustment.proposedPlan, apiCostUsd: sql`${trips.apiCostUsd} + ${adjustment.apiCostUsd}` })
        .where(
          and(
            eq(trips.id, tripId),
            eq(trips.userId, user.id),
            eq(trips.status, 'ready'),
            sql`${trips.plan}->>'generatedAt' = ${adjustment.baseGeneratedAt}`,
          ),
        )
        .returning({ id: trips.id });
      if (!updated) throw new ConflictException('The trip changed after this preview. Load the latest plan and try again.');
      await this.syncStops(tx, tripId, adjustment.proposedPlan);
      const [applied] = await tx
        .update(tripAdjustments)
        .set({ status: 'applied', appliedAt: new Date() })
        .where(and(eq(tripAdjustments.id, adjustmentId), eq(tripAdjustments.userId, user.id), eq(tripAdjustments.status, 'proposed')))
        .returning({ id: tripAdjustments.id });
      if (!applied) throw new ConflictException('This itinerary proposal has already been used.');
      return { applied: true, plan: adjustment.proposedPlan };
    });
  }

  async undo(user: AuthUser, tripId: string, adjustmentId: string) {
    const adjustment = await this.findAdjustment(user, tripId, adjustmentId);
    if (adjustment.status !== 'applied') throw new ConflictException('This itinerary change can no longer be undone.');
    return this.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(trips)
        .set({ plan: adjustment.previousPlan })
        .where(
          and(
            eq(trips.id, tripId),
            eq(trips.userId, user.id),
            eq(trips.status, 'ready'),
            sql`${trips.plan}->>'generatedAt' = ${adjustment.proposedPlan.generatedAt}`,
          ),
        )
        .returning({ id: trips.id });
      if (!updated) throw new ConflictException('The trip changed after this adjustment, so it cannot be undone safely.');
      await this.syncStops(tx, tripId, adjustment.previousPlan);
      const [undone] = await tx
        .update(tripAdjustments)
        .set({ status: 'undone', undoneAt: new Date() })
        .where(and(eq(tripAdjustments.id, adjustmentId), eq(tripAdjustments.userId, user.id), eq(tripAdjustments.status, 'applied')))
        .returning({ id: tripAdjustments.id });
      if (!undone) throw new ConflictException('This itinerary change has already been undone.');
      return { undone: true, plan: adjustment.previousPlan };
    });
  }

  private findAdjustment(user: AuthUser, tripId: string, adjustmentId: string) {
    return this.db.query.tripAdjustments.findFirst({
      where: and(eq(tripAdjustments.id, adjustmentId), eq(tripAdjustments.tripId, tripId), eq(tripAdjustments.userId, user.id)),
    }).then((adjustment) => {
      if (!adjustment) throw new NotFoundException('Itinerary adjustment not found');
      return adjustment;
    });
  }

  private async syncStops(tx: Parameters<Parameters<Db['transaction']>[0]>[0], tripId: string, plan: TripPlan) {
    await tx.delete(tripStops).where(eq(tripStops.tripId, tripId));
    const rows = plan.days.flatMap((day) =>
      day.stops.map((stop, position) => ({
        tripId,
        day: day.day,
        position,
        name: stop.name,
        kind: stop.kind,
        placeId: stop.placeId,
        location: { x: stop.location.lng, y: stop.location.lat },
      })),
    );
    if (rows.length) await tx.insert(tripStops).values(rows);
  }
}
