import { describe, expect, it } from 'vitest';
import { reviewDay } from '../core/index.js';
import { climateDay, metDay } from './weather.js';

const hour = (time: string, t: number, symbol: string, pop = 0, wind = 3) => ({
  time,
  data: { instant: { details: { air_temperature: t, wind_speed: wind } }, next_1_hours: { summary: { symbol_code: symbol }, details: { probability_of_precipitation: pop } } },
});

describe('MET Norway day', () => {
  // Paris is UTC+0 by longitude here (2.35° → offset 0), so times read as local.
  const series = [
    hour('2026-10-20T06:00:00Z', 6, 'cloudy'),
    hour('2026-10-20T09:00:00Z', 9, 'partlycloudy_day'),
    hour('2026-10-20T12:00:00Z', 14, 'rain', 80, 9),
    hour('2026-10-20T15:00:00Z', 13, 'partlycloudy_day', 30),
    hour('2026-10-20T18:00:00Z', 10, 'partlycloudy_day'),
    hour('2026-10-21T12:00:00Z', 15, 'clearsky_day'),
  ];
  it('summarises the daytime with the wettest condition and the rain chance', () => {
    const o = metDay(series, '2026-10-20', 2.35, 'Paris')!;
    expect(o.kind).toBe('forecast');
    expect(o.summary).toBe('Partly cloudy, rain at times');
    expect([o.highC, o.lowC]).toEqual([14, 6]);
    expect(o.precipChancePct).toBe(80);
    expect(o.windKmh).toBe(32);
    expect(reviewDay({ date: '2026-10-20', observations: [o], hasOutdoorStops: true, drivingHours: 2 }).rating).toBe('mixed');
  });
  it('returns nothing for a day outside the series', () => {
    expect(metDay(series, '2026-10-25', 2.35, 'Paris')).toBeUndefined();
  });
});

describe('typical weather', () => {
  it('turns monthly normals into a labelled summary', () => {
    const o = climateDay({ T2M: 3.4, T2M_RANGE: 11.2, PRECTOTCORR: 1.03, FROST_DAYS: 19.9 }, '2026-10-28', 'Calgary, AB');
    expect(o.kind).toBe('climate');
    expect([o.highC, o.lowC]).toEqual([9, -2]);
    expect(o.summary).toBe('Highs about 9°, lows about -2°, frost most nights, mostly dry, snow is possible (typical for late October)');
    const r = reviewDay({ date: '2026-10-28', observations: [o], hasOutdoorStops: true, drivingHours: 4 });
    expect(r.rating).toBe('unknown');
    expect(r.headline).toContain('typical for this time of year');
    expect(r.suggestions[0]).toContain('winter tires');
  });
});
