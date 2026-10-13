import { describe, expect, it } from 'vitest';
import {
  addDays,
  dayOfWeek,
  isOntarioWeekendOrHoliday,
  ontarioStatutoryHolidays,
  estimate407,
  candidateRates,
  is407EtrSection,
  energyCostLine,
  summarizeCosts,
  unknownTollLine,
  convertLine,
  parkingCostLine,
  reviewDay,
  parseForecastText,
  splitIntoDrivingDays,
  drivingDaysNeeded,
  scheduleDay,
  validatePlan,
  isOpenAt,
  decodePolyline,
  encodePolyline,
  pointAlong,
  TripRequest,
  type RouteStep,
  type DayPlan,
} from './index.js';

describe('time', () => {
  it('computes weekdays and adds days', () => {
    expect(dayOfWeek('2026-10-12')).toBe(1); // Monday
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
  it('knows Ontario statutory holidays for 2026', () => {
    const h = ontarioStatutoryHolidays(2026);
    expect(h).toContain('2026-02-16'); // Family Day
    expect(h).toContain('2026-04-03'); // Good Friday
    expect(h).toContain('2026-05-18'); // Victoria Day
    expect(h).toContain('2026-09-07'); // Labour Day
    expect(h).toContain('2026-10-12'); // Thanksgiving
    expect(isOntarioWeekendOrHoliday('2026-10-12')).toBe(true);
    expect(isOntarioWeekendOrHoliday('2026-10-13')).toBe(false);
  });
});

describe('407 ETR', () => {
  it('uses the weekday 7 a.m. peak rates', () => {
    const rates = candidateRates('2026-10-14', 7 * 60 + 15, [7]);
    expect(rates).toEqual([108.79]);
  });
  it('wraps early morning to the overnight rate', () => {
    expect(candidateRates('2026-10-14', 3 * 60, [1])).toEqual([50.66]);
  });
  it('produces an ordered low / typical / high range with fees', () => {
    const e = estimate407({ km: 20, date: '2026-10-14', entryMinutes: 7 * 60, hasTransponder: false });
    expect(e.low).toBeLessThan(e.typical);
    expect(e.typical).toBeLessThanOrEqual(e.high);
    // low: cheapest zone at 7am = 62.30 c/km → 12.46 + $1 + $5.30
    expect(e.low).toBeCloseTo(18.76, 2);
  });
  it('matches a published example within zone 7 with transponder', () => {
    // 20 km in zone 7 entering 7am weekday: 20 * 1.0879 = 21.76 + $1 trip charge
    const e = estimate407({ km: 20, date: '2026-10-14', entryMinutes: 7 * 60, hasTransponder: true, zones: [7] });
    expect(e.low).toBeCloseTo(22.76, 2);
  });
  it('splits the private 407 ETR from the provincial section by longitude', () => {
    expect(is407EtrSection(-79.5)).toBe(true);
    expect(is407EtrSection(-78.9)).toBe(false);
  });
});

describe('costs', () => {
  const at = '2026-10-12T00:00:00Z';
  it('computes fuel with consumption and price ranges', () => {
    const line = energyCostLine({
      id: 'fuel',
      distanceKm: 1000,
      fuelType: 'gasoline',
      consumptionPer100km: 8,
      date: '2026-07-01',
      price: { low: 1.4, typical: 1.5, high: 1.6, currency: 'CAD', unit: 'L', confidence: 'approximate' },
    });
    expect(line.low).toBe(112); // 80 L * 1.0 * 1.40
    expect(line.typical).toBe(126); // 80 * 1.05 * 1.5
    expect(line.high).toBeCloseTo(147.2, 2); // 80 * 1.15 * 1.6
  });
  it('never counts unknown tolls as zero', () => {
    const lines = [
      { id: 'a', category: 'toll' as const, label: 'Bridge', low: 5, typical: 6, high: 8, currency: 'CAD' as const, confidence: 'provider_estimate' as const, mandatory: true, assumptions: [] },
      unknownTollLine('b', 'Unpriced toll', 'CAD'),
      parkingCostLine({ id: 'p', urbanStops: 2, otherStops: 1, overnights: 1, currency: 'CAD', retrievedAt: at }),
    ];
    const s = summarizeCosts(lines, 'CAD');
    expect(s.unknownCount).toBe(1);
    expect(s.unknownLabels).toEqual(['Unpriced toll']);
    expect(s.low).toBe(5);
    expect(s.typical).toBe(30);
    expect(s.high).toBe(8 + 50 + 8 + 30);
    expect(s.spreadDrivers[0].label).toBe('Parking');
  });
  it('converts USD lines to CAD and refuses mixed currencies', () => {
    const usd = { id: 'u', category: 'toll' as const, label: 'NY Thruway', low: 10, typical: 10, high: 10, currency: 'USD' as const, confidence: 'provider_estimate' as const, mandatory: true, assumptions: [] };
    expect(() => summarizeCosts([usd], 'CAD')).toThrow();
    const cad = convertLine(usd, 'CAD', 1.4);
    expect(cad.typical).toBe(14);
    expect(cad.currency).toBe('CAD');
  });
});

describe('weather review', () => {
  it('parses Environment Canada and NWS text', () => {
    const ec = parseForecastText('Cloudy with 60 percent chance of showers and risk of a thunderstorm. Wind southwest 20 km/h gusting to 40.');
    expect(ec.precipChancePct).toBe(60);
    expect(ec.thunder).toBe(true);
    expect(ec.gustKmh).toBe(40);
    const nws = parseForecastText('Snow likely. Mostly cloudy. Chance of precipitation is 70%.');
    expect(nws.snow).toBe(true);
    expect(nws.precipChancePct).toBe(70);
  });
  it('rates a snowy warning day as poor with suggestions', () => {
    const r = reviewDay({
      date: '2026-12-10',
      hasOutdoorStops: true,
      drivingHours: 6,
      observations: [
        { date: '2026-12-10', place: 'Sudbury', kind: 'forecast', precipChancePct: 80, snow: true, alerts: [{ title: 'Snowfall warning', severity: 'warning', issuedBy: 'Environment Canada' }] },
      ],
    });
    expect(r.rating).toBe('poor');
    expect(r.headline).toMatch(/per forecast/);
    expect(r.headline).not.toMatch(/safe/i);
    expect(r.suggestions.join(' ')).toMatch(/buffer night|split/);
  });
  it('labels days beyond the forecast window as unknown with climate context', () => {
    const r = reviewDay({
      date: '2027-01-20',
      hasOutdoorStops: false,
      drivingHours: 3,
      observations: [{ date: '2027-01-20', place: 'Ottawa', kind: 'climate', summary: 'Low -16. High -6.', alerts: [] }],
    });
    expect(r.rating).toBe('unknown');
    expect(r.headline).toMatch(/Outside the forecast window/);
  });
  it('rates a clear day as favourable', () => {
    const r = reviewDay({ date: '2026-07-01', hasOutdoorStops: true, drivingHours: 4, observations: [{ date: '2026-07-01', place: 'Kingston', kind: 'forecast', precipChancePct: 10, highC: 26, alerts: [] }] });
    expect(r.rating).toBe('favourable');
  });
  it('names each place once in the headline, without the forecast-city suffix', () => {
    const r = reviewDay({
      date: '2026-10-16',
      hasOutdoorStops: true,
      drivingHours: 0,
      observations: [
        { date: '2026-10-16', place: 'Ottawa, ON (forecast for Ottawa (Kanata - Orléans))', kind: 'forecast', precipChancePct: 80, lowC: -1, alerts: [] },
        { date: '2026-10-16', place: 'en route (Ottawa, ON → Kingston, ON)', kind: 'forecast', precipChancePct: 45, alerts: [] },
      ],
    });
    expect(r.headline).toBe('Mixed (per forecast): Rain likely (80%) and freezing temperatures with precipitation — Ottawa, ON; 45% chance of rain — en route.');
  });
});

describe('itinerary', () => {
  const line = encodePolyline([{ lat: 43.6, lng: -79.6 }, { lat: 43.6, lng: -75.6 }]);
  const steps: RouteStep[] = [
    { distanceMeters: 20_000, durationSeconds: 1200, startLocation: { lat: 43.6, lng: -79.7 }, endLocation: { lat: 43.6, lng: -79.6 }, roads: [] },
    { distanceMeters: 320_000, durationSeconds: 3 * 3600 * 3, polyline: line, startLocation: { lat: 43.6, lng: -79.6 }, endLocation: { lat: 43.6, lng: -75.6 }, roads: [] },
  ];

  it('round-trips polylines', () => {
    const pts = decodePolyline(line);
    expect(pts[0].lat).toBeCloseTo(43.6, 4);
    expect(pts[1].lng).toBeCloseTo(-75.6, 4);
    expect(pointAlong(pts, 0.5).lng).toBeCloseTo(-77.6, 1);
  });

  it('splits long steps into roughly equal driving days', () => {
    const total = steps.reduce((s, x) => s + x.durationSeconds, 0);
    const n = drivingDaysNeeded(total, 6);
    expect(n).toBe(2);
    const segs = splitIntoDrivingDays(steps, n);
    expect(segs).toHaveLength(2);
    expect(Math.abs(segs[0].drivingSeconds - segs[1].drivingSeconds)).toBeLessThan(5);
    expect(segs[0].endLocation!.lng).toBeGreaterThan(-79.6);
    expect(segs[0].endLocation!.lng).toBeLessThan(-75.6);
    expect(segs[0].distanceMeters + segs[1].distanceMeters).toBe(340_000);
  });

  it('schedules stops by route position and flags closed and out-of-order stops', () => {
    const day: DayPlan = {
      day: 1,
      date: '2026-10-14', // Wednesday
      startPlace: 'A',
      endPlace: 'B',
      distanceMeters: 400_000,
      drivingSeconds: 4 * 3600,
      departureTime: '08:00',
      stops: [
        { id: 's2', name: 'Museum', kind: 'attraction', location: { lat: 0, lng: 0 }, visitMinutes: 60, routeFraction: 0.5, openingHours: [{ day: 3, open: '13:00', close: '17:00' }] },
        { id: 's1', name: 'Falls', kind: 'attraction', location: { lat: 0, lng: 0 }, visitMinutes: 60, routeFraction: 0.25 },
      ],
    };
    const { stops, endMinutes } = scheduleDay(day);
    expect(stops.map((s) => s.id)).toEqual(['s1', 's2']);
    expect(stops[0].arrivalTime).toBe('09:00');
    expect(stops[1].arrivalTime).toBe('11:15'); // 8:00 + 2h drive + 1h visit + 15 min break
    expect(isOpenAt(stops[1], day.date, stops[1].arrivalTime!)).toBe(false);
    expect(endMinutes).toBe(8 * 60 + 240 + 120 + 30);

    const issues = validatePlan({
      days: [day],
      preferences: { pace: 'balanced', maxDrivingHoursPerDay: 3, interests: [], avoidTolls: false, includeParking: true },
      totalTripDays: 1,
      drivingDaysNeeded: 2,
    });
    const codes = issues.map((i) => i.code);
    expect(codes).toContain('TRIP_TOO_SHORT');
    expect(codes).toContain('DRIVE_LIMIT_EXCEEDED');
    expect(codes).toContain('CLOSED_ON_ARRIVAL');
    expect(codes).toContain('HOURS_UNKNOWN');
  });
});

describe('TripRequest schema', () => {
  it('applies defaults and validates dates', () => {
    const r = TripRequest.parse({ origin: { address: 'Mississauga, ON' }, destination: { address: 'Calgary, AB' }, startDate: '2026-11-01', endDate: '2026-11-06' });
    expect(r.vehicle.fuelType).toBe('gasoline');
    expect(r.preferences.maxDrivingHoursPerDay).toBe(6);
    expect(() => TripRequest.parse({ ...r, endDate: '2026-10-01' })).toThrow();
  });
});
