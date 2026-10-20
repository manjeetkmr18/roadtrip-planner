import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { encodePolyline, TripAdjustmentRequest, TripPlan } from '../core/index.js';
import type { AuthUser } from '../auth/auth.js';
import { loadEnv } from '../config/env.js';
import type { Db } from '../db/db.module.js';
import type { Providers } from '../providers/providers.module.js';
import type { RawRoute, ResolvedPlace } from '../providers/google.js';
import { MembershipService } from '../membership/membership.service.js';
import { extendPlan, TripAdjustmentsService } from './trip-adjustments.service.js';

const toronto = { lat: 43.6532, lng: -79.3832 };
const calgary = { lat: 51.0447, lng: -114.0719 };
const hotel = { lat: 51.046, lng: -114.07 };

const basePlan = TripPlan.parse({
  generatedAt: '2026-10-19T12:00:00.000Z',
  request: {
    origin: { address: 'Toronto, ON', location: toronto },
    destination: { address: 'Calgary, AB', location: calgary },
    startDate: '2026-10-19',
    endDate: '2026-10-20',
  },
  selectedRouteId: 'fastest',
  routes: [
    {
      id: 'fastest',
      kind: 'fastest',
      label: 'Fastest',
      distanceMeters: 100_000,
      durationSeconds: 3600,
      polyline: encodePolyline([toronto, calgary]),
      costs: [],
      summary: { low: 0, typical: 0, high: 0, currency: 'CAD', unknownCount: 0, unknownLabels: [], spreadDrivers: [] },
      source: { name: 'Test route', retrievedAt: '2026-10-19T12:00:00.000Z' },
    },
  ],
  days: [
    {
      day: 1,
      date: '2026-10-19',
      startPlace: 'Toronto, ON',
      endPlace: 'Calgary, AB',
      endLocation: calgary,
      distanceMeters: 100_000,
      drivingSeconds: 3600,
      departureTime: '08:00',
      stops: [
        {
          id: 'attraction-1',
          name: 'Scenic stop',
          kind: 'attraction',
          location: { lat: 46, lng: -90 },
          visitMinutes: 60,
          routeFraction: 0.5,
          arrivalTime: '09:00',
        },
        {
          id: 'overnight-1',
          name: 'Overnight in Calgary',
          kind: 'overnight',
          location: calgary,
          visitMinutes: 0,
          routeFraction: 1,
          arrivalTime: '10:00',
        },
      ],
    },
    {
      day: 2,
      date: '2026-10-20',
      startPlace: 'Calgary, AB',
      endPlace: 'Calgary, AB',
      endLocation: calgary,
      distanceMeters: 0,
      drivingSeconds: 0,
      departureTime: '09:30',
      stops: [
        {
          id: 'museum',
          name: 'Museum',
          kind: 'attraction',
          location: calgary,
          visitMinutes: 60,
          routeFraction: 0.5,
          arrivalTime: '10:00',
        },
      ],
    },
  ],
  issues: [],
  roadEvents: [],
  advisories: [],
  usedSampleData: false,
  providerNotes: [],
  apiCostUsd: 0,
});

const destination: ResolvedPlace = { label: 'Calgary, AB', location: calgary, country: 'CA', region: 'AB' };
const accommodation: ResolvedPlace = { label: 'Hotel in Calgary, AB', location: hotel, country: 'CA', region: 'AB', placeId: 'hotel-id' };
const route: RawRoute = {
  distanceMeters: 5000,
  durationSeconds: 900,
  polyline: encodePolyline([calgary, hotel]),
  steps: [],
  sample: false,
};

describe('TripAdjustmentsService.preview', () => {
  it('rejects non-Pro previews before loading trips or calling paid providers', async () => {
    const assertPro = vi.fn().mockRejectedValue(
      new ForbiddenException('Trip arrival adjustments require an active Travlio Pro membership.'),
    );
    const findTrip = vi.fn();
    const resolvePlace = vi.fn();
    const computeRoute = vi.fn();
    const providers = {
      geocoding: { resolve: resolvePlace },
      routes: { compute: computeRoute },
    } as unknown as Providers;
    const service = new TripAdjustmentsService(
      { query: { trips: { findFirst: findTrip } } } as unknown as Db,
      loadEnv({}),
      providers,
      { assertPro } as MembershipService,
    );
    const user: AuthUser = { id: 'free-user', email: 'person@example.com', plan: 'free' };
    const request = TripAdjustmentRequest.parse({
      arrivalDay: 1,
      arrivalTime: '21:00',
      resumeTime: '10:00',
      accommodation: { address: 'Example lodging' },
    });

    await expect(service.preview(user, 'trip-1', request)).rejects.toMatchObject({ status: 403 });
    expect(assertPro).toHaveBeenCalledWith(user);
    expect(findTrip).not.toHaveBeenCalled();
    expect(resolvePlace).not.toHaveBeenCalled();
    expect(computeRoute).not.toHaveBeenCalled();
  });
});

describe('extendPlan', () => {
  it('routes the arrival day to lodging, skips sightseeing, and shifts destination days later', () => {
    const adjusted = extendPlan(basePlan, destination, accommodation, route, 1, '21:00', '10:00', new Map(), []);
    const arrivalDay = adjusted.days[0];
    const freeDay = adjusted.days[1];

    expect(arrivalDay.endPlace).toBe(accommodation.label);
    expect(arrivalDay.distanceMeters).toBe(105_000);
    expect(arrivalDay.drivingSeconds).toBe(4500);
    expect(arrivalDay.stops.map((stop) => stop.kind)).toEqual(['waypoint', 'overnight']);
    expect(arrivalDay.stops.map((stop) => stop.arrivalTime)).toEqual(['21:00', '21:15']);
    expect(freeDay.departureTime).toBe('10:00');
    expect(freeDay.startPlace).toBe(accommodation.label);
    expect(freeDay.endLocation).toEqual(accommodation.location);
    expect(adjusted.routes[0].distanceMeters).toBe(105_000);
    expect(adjusted.routes[0].durationSeconds).toBe(4500);
    expect(adjusted.generatedAt).not.toBe(basePlan.generatedAt);
  });

  it('rejects round trips and lodging too far from the destination', () => {
    const roundTrip = TripPlan.parse({ ...basePlan, request: { ...basePlan.request, roundTrip: true } });
    expect(() => extendPlan(roundTrip, destination, accommodation, route, 1, '21:00', '10:00', new Map(), [])).toThrow(
      'Hotel adjustments currently support one-way drive trips only.',
    );

    const farHotel: ResolvedPlace = { ...accommodation, location: { lat: 49, lng: -114 } };
    expect(() => extendPlan(basePlan, destination, farHotel, route, 1, '21:00', '10:00', new Map(), [])).toThrow(
      'Choose lodging within 100 km of your planned destination.',
    );
  });

  it('marks lodging arrival after midnight as the next calendar day', () => {
    const afterMidnightRoute = { ...route, durationSeconds: 1800 };
    const adjusted = extendPlan(basePlan, destination, accommodation, afterMidnightRoute, 1, '23:50', '10:00', new Map(), []);
    const overnight = adjusted.days[0].stops.find((stop) => stop.kind === 'overnight');
    expect(overnight?.arrivalTime).toBe('00:20');
    expect(overnight?.arrivalDayOffset).toBe(1);
  });
});
