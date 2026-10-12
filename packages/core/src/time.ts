/** Small date/time helpers that work on local calendar dates (YYYY-MM-DD) and minutes since midnight. */

export function parseHHMM(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

export function formatHHMM(minutes: number): string {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** Day of week for a calendar date, 0 = Sunday. Timezone-independent. */
export function dayOfWeek(isoDate: string): number {
  const [y, mo, d] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
}

export function addDays(isoDate: string, days: number): string {
  const [y, mo, d] = isoDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

export function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.parse(`${fromIso}T00:00:00Z`);
  const b = Date.parse(`${toIso}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

export function month(isoDate: string): number {
  return Number(isoDate.slice(5, 7));
}

function iso(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** nth weekday (0=Sun) of a month; n = -1 for last. */
function nthWeekday(y: number, m: number, weekday: number, n: number): string {
  if (n > 0) {
    const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
    const day = 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
    return iso(y, m, day);
  }
  const lastDate = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const last = new Date(Date.UTC(y, m - 1, lastDate)).getUTCDay();
  return iso(y, m, lastDate - ((last - weekday + 7) % 7));
}

/** Gregorian Easter Sunday (anonymous algorithm). */
function easterSunday(y: number): string {
  const a = y % 19;
  const b = Math.floor(y / 100);
  const c = y % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const mm = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * mm + 114) / 31);
  const day = ((h + l - 7 * mm + 114) % 31) + 1;
  return iso(y, month, day);
}

/** Ontario statutory holidays (the 407 ETR applies weekend rates on these). */
export function ontarioStatutoryHolidays(year: number): string[] {
  // Victoria Day: the Monday before May 25.
  const may24 = new Date(Date.UTC(year, 4, 24)).getUTCDay();
  const victoria = iso(year, 5, 24 - ((may24 + 6) % 7));
  return [
    iso(year, 1, 1),
    nthWeekday(year, 2, 1, 3), // Family Day
    addDays(easterSunday(year), -2), // Good Friday
    victoria,
    iso(year, 7, 1),
    nthWeekday(year, 9, 1, 1), // Labour Day
    nthWeekday(year, 10, 1, 2), // Thanksgiving
    iso(year, 12, 25),
    iso(year, 12, 26),
  ];
}

export function isOntarioWeekendOrHoliday(isoDate: string): boolean {
  const dow = dayOfWeek(isoDate);
  if (dow === 0 || dow === 6) return true;
  return ontarioStatutoryHolidays(Number(isoDate.slice(0, 4))).includes(isoDate);
}
