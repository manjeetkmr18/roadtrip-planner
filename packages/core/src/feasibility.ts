import type { DayPlan, Issue, PreferencesInput, Stop } from './types';
import { dayOfWeek, parseHHMM, formatHHMM } from './time';
import { PACE_DAY_HOURS, scheduleDay } from './itinerary';

/**
 * Deterministic checks run on every generated plan before it is shown.
 * The language model never decides whether a plan is feasible; this code does.
 */

export function isOpenAt(stop: Stop, isoDate: string, arrivalHHMM: string): boolean | undefined {
  if (!stop.openingHours || stop.openingHours.length === 0) return undefined; // unknown
  const dow = dayOfWeek(isoDate);
  const arrive = parseHHMM(arrivalHHMM);
  const leave = arrive + stop.visitMinutes;
  return stop.openingHours.some((p) => {
    if (p.day !== dow) return false;
    const open = parseHHMM(p.open);
    let close = parseHHMM(p.close);
    if (close <= open) close += 1440; // past midnight
    return arrive >= open && Math.min(leave, close) - arrive >= Math.min(30, stop.visitMinutes);
  });
}

export function validatePlan(args: {
  days: DayPlan[];
  preferences: PreferencesInput;
  totalTripDays: number;
  drivingDaysNeeded: number;
}): Issue[] {
  const { days, preferences } = args;
  const issues: Issue[] = [];
  const maxDrive = preferences.maxDrivingHoursPerDay * 3600;

  if (args.drivingDaysNeeded > args.totalTripDays) {
    issues.push({
      severity: 'error',
      code: 'TRIP_TOO_SHORT',
      message: `This trip needs about ${args.drivingDaysNeeded} driving days at ${preferences.maxDrivingHoursPerDay} h/day, but only ${args.totalTripDays} day(s) are planned. Add days, raise the daily driving limit, or choose a closer destination.`,
    });
  }

  for (const day of days) {
    if (day.drivingSeconds > maxDrive + 7200) {
      issues.push({
        severity: 'error',
        code: 'DRIVE_LIMIT_EXCEEDED',
        day: day.day,
        message: `Day ${day.day} has ${(day.drivingSeconds / 3600).toFixed(1)} h of driving, well over your ${preferences.maxDrivingHoursPerDay} h limit.`,
      });
    } else if (day.drivingSeconds > maxDrive * 1.1) {
      issues.push({
        severity: 'warning',
        code: 'DRIVE_LIMIT_EXCEEDED',
        day: day.day,
        message: `Day ${day.day} has ${(day.drivingSeconds / 3600).toFixed(1)} h of driving, above your ${preferences.maxDrivingHoursPerDay} h limit.`,
      });
    }

    const { stops, endMinutes } = scheduleDay(day);
    const activeHours = (endMinutes - parseHHMM(day.departureTime)) / 60;
    if (activeHours > PACE_DAY_HOURS[preferences.pace]) {
      issues.push({
        severity: 'warning',
        code: 'DAY_TOO_LONG',
        day: day.day,
        message: `Day ${day.day} runs about ${activeHours.toFixed(1)} h including stops and breaks, longer than a ${preferences.pace} pace (${PACE_DAY_HOURS[preferences.pace]} h). Drop a stop or leave earlier.`,
      });
    }
    if (endMinutes >= 21 * 60 && day.drivingSeconds > 0) {
      issues.push({
        severity: 'warning',
        code: 'LATE_ARRIVAL',
        day: day.day,
        message: `Day ${day.day} arrives around ${formatHHMM(endMinutes)}. Driving late in the evening is tiring; consider an earlier start or fewer stops.`,
      });
    }

    let lastFraction = -1;
    for (const s of stops) {
      if (s.kind === 'overnight') continue;
      if (s.routeFraction != null) {
        if (s.routeFraction + 0.02 < lastFraction) {
          issues.push({
            severity: 'warning',
            code: 'STOP_ORDER',
            day: day.day,
            stopId: s.id,
            message: `${s.name} is out of order along the route on day ${day.day}; it would mean backtracking.`,
          });
        }
        lastFraction = Math.max(lastFraction, s.routeFraction);
      }
      if (s.arrivalTime) {
        const open = isOpenAt(s, day.date, s.arrivalTime);
        if (open === false) {
          issues.push({
            severity: 'warning',
            code: 'CLOSED_ON_ARRIVAL',
            day: day.day,
            stopId: s.id,
            message: `${s.name} may be closed when you arrive (~${s.arrivalTime} on day ${day.day}). Check its hours or move it.`,
          });
        } else if (open === undefined && s.kind === 'attraction') {
          issues.push({
            severity: 'info',
            code: 'HOURS_UNKNOWN',
            day: day.day,
            stopId: s.id,
            message: `Opening hours for ${s.name} are not available; confirm before you go.`,
          });
        }
      }
      if ((s.detourMinutes ?? 0) > 45) {
        issues.push({
          severity: 'info',
          code: 'LONG_DETOUR',
          day: day.day,
          stopId: s.id,
          message: `${s.name} adds about ${Math.round(s.detourMinutes ?? 0)} minutes of detour.`,
        });
      }
    }
  }
  return issues;
}
