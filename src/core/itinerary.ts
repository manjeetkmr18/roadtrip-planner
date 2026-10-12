import type { LatLng, RouteStep, Stop, DayPlan, Pace } from './types.js';
import { decodePolyline, pointAlong } from './geo.js';
import { formatHHMM, parseHHMM } from './time.js';

export interface DriveSegment {
  index: number;
  distanceMeters: number;
  drivingSeconds: number;
  startLocation?: LatLng;
  endLocation?: LatLng;
  /** Route steps (or parts of steps) that fall in this segment, with their offsets in seconds from segment start. */
  steps: { step: RouteStep; offsetSeconds: number; share: number }[];
}

/** Driving days needed for a total driving time and a daily limit. */
export function drivingDaysNeeded(totalSeconds: number, maxDrivingHoursPerDay: number): number {
  return Math.max(1, Math.ceil(totalSeconds / (maxDrivingHoursPerDay * 3600) - 1e-9));
}

function locationWithinStep(step: RouteStep, fraction: number): LatLng | undefined {
  if (step.polyline) {
    const pts = decodePolyline(step.polyline);
    if (pts.length) return pointAlong(pts, fraction);
  }
  if (step.startLocation && step.endLocation) {
    return {
      lat: step.startLocation.lat + (step.endLocation.lat - step.startLocation.lat) * fraction,
      lng: step.startLocation.lng + (step.endLocation.lng - step.startLocation.lng) * fraction,
    };
  }
  return step.endLocation;
}

/**
 * Split a route into `days` driving segments of roughly equal driving time.
 * Cuts can fall inside a long highway step; the overnight point is then
 * interpolated along that step's polyline.
 */
export function splitIntoDrivingDays(steps: RouteStep[], days: number): DriveSegment[] {
  const total = steps.reduce((s, x) => s + x.durationSeconds, 0);
  const n = Math.max(1, days);
  const targets = Array.from({ length: n - 1 }, (_, k) => (total * (k + 1)) / n);
  const segments: DriveSegment[] = [];
  let current: DriveSegment = { index: 0, distanceMeters: 0, drivingSeconds: 0, startLocation: steps[0]?.startLocation, steps: [] };
  let cum = 0;

  for (const step of steps) {
    let consumed = 0; // fraction of this step already assigned
    while (targets.length && cum + step.durationSeconds * (1 - consumed) >= targets[0] && step.durationSeconds > 0) {
      const needSeconds = targets[0] - cum;
      const frac = Math.min(1, consumed + needSeconds / step.durationSeconds);
      const share = frac - consumed;
      current.steps.push({ step, offsetSeconds: current.drivingSeconds, share });
      current.drivingSeconds += step.durationSeconds * share;
      current.distanceMeters += step.distanceMeters * share;
      cum += step.durationSeconds * share;
      const cut = locationWithinStep(step, frac);
      current.endLocation = cut;
      segments.push(current);
      current = { index: segments.length, distanceMeters: 0, drivingSeconds: 0, startLocation: cut, steps: [] };
      consumed = frac;
      targets.shift();
    }
    const share = 1 - consumed;
    if (share > 0) {
      current.steps.push({ step, offsetSeconds: current.drivingSeconds, share });
      current.drivingSeconds += step.durationSeconds * share;
      current.distanceMeters += step.distanceMeters * share;
      cum += step.durationSeconds * share;
    }
    current.endLocation = step.endLocation ?? current.endLocation;
  }
  segments.push(current);
  return segments.map((s) => ({ ...s, drivingSeconds: Math.round(s.drivingSeconds), distanceMeters: Math.round(s.distanceMeters) }));
}

/** Default visit time by stop kind, in minutes. */
export const DEFAULT_VISIT_MINUTES: Record<Stop['kind'], number> = {
  attraction: 75,
  meal: 60,
  rest: 20,
  overnight: 0,
  fuel: 15,
};

/** Rest breaks: one 15-minute break every 2 hours of driving. */
export function restBreakMinutes(drivingSeconds: number): number {
  return Math.floor(drivingSeconds / 7200) * 15;
}

/**
 * Assign arrival times to a day's stops from its departure time, the driving time to each
 * stop (by its position along the route) and the time spent at earlier stops.
 * Returns the stops in route order and the estimated arrival time at the day's end.
 */
export function scheduleDay(day: Pick<DayPlan, 'departureTime' | 'drivingSeconds' | 'stops'>): { stops: Stop[]; endMinutes: number } {
  const start = parseHHMM(day.departureTime);
  const ordered = [...day.stops].filter((s) => s.kind !== 'overnight').sort((a, b) => (a.routeFraction ?? 0) - (b.routeFraction ?? 0));
  let spent = 0;
  const out: Stop[] = [];
  for (const s of ordered) {
    const driveMin = (day.drivingSeconds / 60) * (s.routeFraction ?? 0);
    const arrival = start + driveMin + spent + restBreakMinutes((day.drivingSeconds * (s.routeFraction ?? 0)));
    out.push({ ...s, arrivalTime: formatHHMM(arrival) });
    spent += (s.detourMinutes ?? 0) + s.visitMinutes;
  }
  const endMinutes = start + day.drivingSeconds / 60 + spent + restBreakMinutes(day.drivingSeconds);
  const overnight = day.stops.filter((s) => s.kind === 'overnight').map((s) => ({ ...s, arrivalTime: formatHHMM(endMinutes) }));
  return { stops: [...out, ...overnight], endMinutes };
}

/** Maximum active hours per day (driving + stops + breaks) for each pace. */
export const PACE_DAY_HOURS: Record<Pace, number> = { relaxed: 9, balanced: 11, packed: 13 };

/** How many attraction stops fit a day, given its driving time and pace. */
export function stopBudget(drivingSeconds: number, pace: Pace): number {
  const hoursLeft = PACE_DAY_HOURS[pace] - drivingSeconds / 3600 - restBreakMinutes(drivingSeconds) / 60 - 1; // 1h for a meal
  const perStop = DEFAULT_VISIT_MINUTES.attraction / 60 + 0.25; // visit + detour
  return Math.max(0, Math.min(pace === 'packed' ? 6 : pace === 'balanced' ? 4 : 3, Math.floor(hoursLeft / perStop)));
}
