/**
 * Sunrise and sunset from the NOAA solar equations (accurate to about a minute at road-trip latitudes).
 * No API needed. Returns null when the sun doesn't rise or set that day (polar day or night).
 */
const rad = Math.PI / 180;

function julianDay(date: string): number {
  return Date.parse(`${date}T12:00:00Z`) / 86_400_000 + 2440587.5;
}

/** UTC times of sunrise and sunset for a date (YYYY-MM-DD) at a point. */
export function sunTimesUtc(date: string, lat: number, lng: number): { sunrise: Date; sunset: Date } | null {
  const n = Math.round(julianDay(date) - 2451545.0 + 0.0008);
  const meanNoon = n - lng / 360;
  const M = (357.5291 + 0.98560028 * meanNoon) % 360;
  const C = 1.9148 * Math.sin(M * rad) + 0.02 * Math.sin(2 * M * rad) + 0.0003 * Math.sin(3 * M * rad);
  const lambda = (M + C + 180 + 102.9372) % 360;
  const transit = 2451545.0 + meanNoon + 0.0053 * Math.sin(M * rad) - 0.0069 * Math.sin(2 * lambda * rad);
  const decl = Math.asin(Math.sin(lambda * rad) * Math.sin(23.4397 * rad));
  const cosH = (Math.sin(-0.833 * rad) - Math.sin(lat * rad) * Math.sin(decl)) / (Math.cos(lat * rad) * Math.cos(decl));
  if (cosH < -1 || cosH > 1) return null;
  const H = Math.acos(cosH) / rad;
  const toDate = (jd: number) => new Date((jd - 2440587.5) * 86_400_000);
  return { sunrise: toDate(transit - H / 360), sunset: toDate(transit + H / 360) };
}

/** Local HH:MM sunrise and sunset in an IANA time zone. */
export function sunTimesLocal(date: string, lat: number, lng: number, timeZone: string): { sunrise: string; sunset: string } | null {
  const t = sunTimesUtc(date, lat, lng);
  if (!t) return null;
  const fmt = (d: Date) => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone }).format(d);
  return { sunrise: fmt(t.sunrise), sunset: fmt(t.sunset) };
}
