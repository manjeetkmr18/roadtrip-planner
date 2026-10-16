import type { LatLng } from './types.js';

const CA_REGION_TZ: Record<string, string> = {
  BC: 'America/Vancouver',
  AB: 'America/Edmonton',
  SK: 'America/Regina',
  MB: 'America/Winnipeg',
  ON: 'America/Toronto',
  QC: 'America/Toronto',
  NB: 'America/Halifax',
  NS: 'America/Halifax',
  PE: 'America/Halifax',
  NL: 'America/St_Johns',
  YT: 'America/Whitehorse',
  NT: 'America/Yellowknife',
  NU: 'America/Iqaluit',
};

/** One zone per country for countries that have a single zone (or one main one). */
const COUNTRY_TZ: Record<string, string> = {
  GB: 'Europe/London', IE: 'Europe/Dublin', PT: 'Europe/Lisbon', IS: 'Atlantic/Reykjavik',
  FR: 'Europe/Paris', BE: 'Europe/Brussels', NL: 'Europe/Amsterdam', LU: 'Europe/Luxembourg',
  DE: 'Europe/Berlin', CH: 'Europe/Zurich', AT: 'Europe/Vienna', IT: 'Europe/Rome', ES: 'Europe/Madrid',
  DK: 'Europe/Copenhagen', NO: 'Europe/Oslo', SE: 'Europe/Stockholm', FI: 'Europe/Helsinki',
  PL: 'Europe/Warsaw', CZ: 'Europe/Prague', SK: 'Europe/Bratislava', HU: 'Europe/Budapest',
  SI: 'Europe/Ljubljana', HR: 'Europe/Zagreb', RO: 'Europe/Bucharest', BG: 'Europe/Sofia',
  GR: 'Europe/Athens', TR: 'Europe/Istanbul', UA: 'Europe/Kyiv', EE: 'Europe/Tallinn',
  LV: 'Europe/Riga', LT: 'Europe/Vilnius', MT: 'Europe/Malta', CY: 'Asia/Nicosia',
  IN: 'Asia/Kolkata', PK: 'Asia/Karachi', AE: 'Asia/Dubai', QA: 'Asia/Qatar', SA: 'Asia/Riyadh',
  IL: 'Asia/Jerusalem', JP: 'Asia/Tokyo', KR: 'Asia/Seoul', CN: 'Asia/Shanghai', HK: 'Asia/Hong_Kong',
  TW: 'Asia/Taipei', SG: 'Asia/Singapore', TH: 'Asia/Bangkok', VN: 'Asia/Ho_Chi_Minh', PH: 'Asia/Manila',
  MY: 'Asia/Kuala_Lumpur', NZ: 'Pacific/Auckland', ZA: 'Africa/Johannesburg', EG: 'Africa/Cairo',
  MA: 'Africa/Casablanca', KE: 'Africa/Nairobi', NG: 'Africa/Lagos', CR: 'America/Costa_Rica',
  JM: 'America/Jamaica', DO: 'America/Santo_Domingo', CU: 'America/Havana', PE: 'America/Lima',
  CO: 'America/Bogota', CL: 'America/Santiago', AR: 'America/Argentina/Buenos_Aires',
};

/** Rough split for large countries with several zones, by longitude. */
function byLongitude(country: string | undefined, lng: number): string | undefined {
  switch (country) {
    case 'US':
    case undefined:
      if (lng < -154) return 'Pacific/Honolulu';
      if (lng < -130) return 'America/Anchorage';
      if (lng > -87.5) return 'America/New_York';
      if (lng > -101) return 'America/Chicago';
      if (lng > -114) return 'America/Denver';
      return 'America/Los_Angeles';
    case 'CA':
      if (lng > -61) return 'America/Halifax';
      if (lng > -90) return 'America/Toronto';
      if (lng > -102) return 'America/Winnipeg';
      if (lng > -120) return 'America/Edmonton';
      return 'America/Vancouver';
    case 'MX':
      return lng < -106 ? 'America/Tijuana' : 'America/Mexico_City';
    case 'BR':
      return lng < -54 ? 'America/Manaus' : 'America/Sao_Paulo';
    case 'AU':
      if (lng < 129) return 'Australia/Perth';
      if (lng < 141) return 'Australia/Adelaide';
      return 'Australia/Sydney';
    case 'RU':
      return lng < 40 ? 'Europe/Moscow' : lng < 70 ? 'Asia/Yekaterinburg' : 'Asia/Novosibirsk';
    case 'ID':
      return lng < 115 ? 'Asia/Jakarta' : 'Asia/Makassar';
    default:
      return undefined;
  }
}

/** Best-effort IANA time zone for a place. Falls back to a fixed offset from longitude. */
export function timeZoneAt(p: { location: LatLng; country?: string; region?: string }): string {
  if (p.country === 'CA' && p.region && CA_REGION_TZ[p.region]) return CA_REGION_TZ[p.region];
  if (p.country && COUNTRY_TZ[p.country]) return COUNTRY_TZ[p.country];
  const z = byLongitude(p.country, p.location.lng);
  if (z) return z;
  // Etc/GMT zones have inverted signs: Etc/GMT-2 is UTC+2.
  const h = Math.round(p.location.lng / 15);
  return h === 0 ? 'Etc/UTC' : `Etc/GMT${h > 0 ? '-' : '+'}${Math.abs(h)}`;
}

/** UTC offset string (e.g. "-04:00") of a zone at an instant. */
function offsetAt(timeZone: string, at: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' }).formatToParts(at);
  const off = parts.find((x) => x.type === 'timeZoneName')?.value.replace('GMT', '') ?? '';
  return off || '+00:00';
}

/** The instant a local wall-clock time happens in a zone. `local` is YYYY-MM-DDTHH:MM. */
export function localToInstant(local: string, timeZone: string): Date {
  const guess = new Date(`${local}:00Z`);
  const off = offsetAt(timeZone, guess);
  const first = new Date(`${local}:00${off}`);
  // Second pass fixes the rare case where the guess sat on the other side of a DST change.
  const off2 = offsetAt(timeZone, first);
  return off2 === off ? first : new Date(`${local}:00${off2}`);
}

/** Local wall-clock time (YYYY-MM-DDTHH:MM) of an instant in a zone. */
export function instantToLocal(at: Date, timeZone: string): string {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const v = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, x.value]));
  return `${v.year}-${v.month}-${v.day}T${v.hour}:${v.minute}`;
}
