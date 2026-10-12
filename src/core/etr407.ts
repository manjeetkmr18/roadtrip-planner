/**
 * Highway 407 ETR toll estimator for light vehicles, from the operator's published
 * 2026 rate chart (https://www.407etr.com/en/rate-chart-light, effective 2026-01-01).
 *
 * Google's Routes API does not price the 407 ETR (no Ontario toll pass is supported),
 * so this calculator fills that gap. Rates vary by zone (12), direction, day type and
 * entry time. Routes rarely tell us exact zones, so we return a low / typical / high
 * range across zones and across the neighbouring time period (timing can slip).
 *
 * Review this table every January when 407 ETR publishes new rates.
 */
import { isOntarioWeekendOrHoliday, parseHHMM } from './time.js';

export const ETR407_RATES_EFFECTIVE = '2026-01-01';
export const ETR407_SOURCE_URL = 'https://www.407etr.com/en/rate-chart-light';

type RateRow = { start: string; cents: number[] }; // cents/km for zones 1..12

/** Weekday rates, by time of entry. */
const WEEKDAY: RateRow[] = [
  { start: '05:00', cents: [79.13, 65.16, 66.61, 61.18, 79.08, 71.55, 76.23, 72.83, 72.83, 56.49, 64.05, 64.05] },
  { start: '07:00', cents: [97.39, 65.17, 67.47, 69.59, 85.35, 100.12, 108.79, 108.79, 108.79, 62.3, 99.24, 99.24] },
  { start: '09:30', cents: [79.08, 65.16, 66.59, 61.18, 79.08, 71.55, 76.23, 72.83, 72.83, 62.29, 66.5, 66.5] },
  { start: '10:30', cents: [79.07, 65.15, 66.58, 61.17, 79.07, 71.54, 76.22, 72.82, 72.82, 56.48, 62.27, 64.04] },
  { start: '14:30', cents: [99.81, 65.17, 67.48, 69.59, 79.08, 71.55, 76.23, 72.83, 72.83, 62.28, 62.28, 64.05] },
  { start: '15:30', cents: [99.81, 65.18, 67.49, 69.6, 85.36, 100.13, 108.8, 108.79, 108.79, 62.29, 70.76, 70.76] },
  { start: '18:00', cents: [79.08, 65.17, 66.59, 69.48, 79.08, 71.55, 76.23, 72.83, 72.83, 62.28, 62.28, 64.05] },
  { start: '21:00', cents: [50.66, 50.56, 50.53, 50.49, 50.56, 50.56, 50.56, 50.56, 50.56, 50.56, 50.56, 50.56] },
];

/**
 * Weekend and Ontario statutory holiday rates. The rate chart publishes two tables
 * (one per direction); the page does not label which is which, so we use both and
 * let the range cover the difference.
 */
const WEEKEND_A: RateRow[] = [
  { start: '08:30', cents: [63.43, 59.31, 50.54, 50.5, 50.57, 50.57, 71.91, 71.91, 55.99, 50.57, 50.57, 71.91] },
  { start: '10:00', cents: [63.44, 59.32, 50.55, 50.51, 59.61, 83.19, 87.27, 78.86, 87.27, 50.58, 50.58, 83.99] },
  { start: '19:00', cents: [63.43, 58.29, 50.54, 50.5, 50.57, 50.57, 50.57, 50.57, 50.57, 50.57, 50.57, 50.57] },
  { start: '21:00', cents: [50.66, 50.56, 50.53, 50.49, 50.56, 50.56, 50.56, 50.56, 50.56, 50.56, 50.56, 50.56] },
];
const WEEKEND_B: RateRow[] = [
  { start: '08:30', cents: [49.94, 50.57, 50.57, 50.57, 50.57, 71.91, 71.91, 71.91, 71.91, 56.14, 50.57, 71.9] },
  { start: '10:00', cents: [49.95, 50.58, 50.58, 50.58, 50.58, 79.01, 87.27, 87.27, 87.27, 56.15, 52.84, 84.04] },
  { start: '19:00', cents: [49.94, 50.57, 50.57, 50.57, 50.57, 50.57, 50.57, 50.57, 50.57, 50.57, 50.57, 71.91] },
  { start: '21:00', cents: [49.93, 50.56, 50.56, 50.56, 50.56, 50.56, 50.56, 50.56, 50.56, 50.56, 50.56, 50.56] },
];

export const ETR407_FEES = {
  tripTollCharge: 1.0, // every trip, with or without transponder
  cameraChargePerTrip: 5.3, // no transponder
  accountFeePerMonth: 5.0, // no transponder, billed monthly when used
} as const;

/** Index of the rate row in effect at `minutes` (rows wrap: before the first start, the last row applies). */
function rowIndex(rows: RateRow[], minutes: number): number {
  let idx = rows.length - 1;
  for (let i = 0; i < rows.length; i++) {
    if (minutes >= parseHHMM(rows[i].start)) idx = i;
  }
  return idx;
}

function tablesFor(isoDate: string): RateRow[][] {
  return isOntarioWeekendOrHoliday(isoDate) ? [WEEKEND_A, WEEKEND_B] : [WEEKDAY];
}

/** All per-km rates (cents) that could apply at this entry time, for the given zones. */
export function candidateRates(isoDate: string, entryMinutes: number, zones?: number[], includeNeighbours = false): number[] {
  const zoneIdx = (zones && zones.length ? zones : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]).map((z) => z - 1);
  const out: number[] = [];
  for (const table of tablesFor(isoDate)) {
    const i = rowIndex(table, entryMinutes);
    const rows = includeNeighbours
      ? [table[(i - 1 + table.length) % table.length], table[i], table[(i + 1) % table.length]]
      : [table[i]];
    for (const row of rows) for (const z of zoneIdx) out.push(row.cents[z]);
  }
  return out;
}

export interface Etr407Estimate {
  km: number;
  low: number;
  typical: number;
  high: number;
  assumptions: string[];
}

export interface Etr407Input {
  /** Kilometres driven on the 407 ETR section (QEW to Brock Road). */
  km: number;
  date: string;
  /** Local time of entry, minutes since midnight. */
  entryMinutes: number;
  hasTransponder: boolean;
  /** Known zones (1..12). Leave empty when the route does not tell us. */
  zones?: number[];
  /** Number of separate 407 trips (entries) on this day. */
  trips?: number;
  /** The no-transponder account fee is monthly; set false when another leg in the same month already counts it. */
  includeAccountFee?: boolean;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function estimate407(input: Etr407Input): Etr407Estimate {
  const trips = Math.max(1, input.trips ?? 1);
  const now = candidateRates(input.date, input.entryMinutes, input.zones);
  const wide = candidateRates(input.date, input.entryMinutes, input.zones, true);
  const avg = now.reduce((s, r) => s + r, 0) / now.length;
  const minRate = Math.min(...now);
  const maxRate = Math.max(...wide);

  const perTripFees =
    ETR407_FEES.tripTollCharge + (input.hasTransponder ? 0 : ETR407_FEES.cameraChargePerTrip);
  const fees = perTripFees * trips;
  const accountFee = input.hasTransponder || input.includeAccountFee === false ? 0 : ETR407_FEES.accountFeePerMonth;

  const dayType = isOntarioWeekendOrHoliday(input.date) ? 'weekend/holiday' : 'weekday';
  const assumptions = [
    `${round2(input.km)} km on 407 ETR, ${dayType} rates, entry around the planned time`,
    input.zones?.length
      ? `Zones ${input.zones.join(', ')}`
      : 'Exact zones unknown: range spans the cheapest to the most expensive zone',
    input.hasTransponder
      ? 'With transponder: $1 trip toll charge per trip'
      : `No transponder: $1 trip toll charge + $${ETR407_FEES.cameraChargePerTrip.toFixed(2)} camera charge per trip${accountFee ? `, plus a $${ETR407_FEES.accountFeePerMonth.toFixed(2)} monthly account fee` : ' (monthly account fee counted on another leg)'}`,
    'High case allows for entering in the neighbouring (pricier) time period',
    `Rates effective ${ETR407_RATES_EFFECTIVE}; light vehicle; taxes not included`,
  ];

  return {
    km: input.km,
    low: round2((input.km * minRate) / 100 + fees),
    typical: round2((input.km * avg) / 100 + fees + accountFee),
    high: round2((input.km * maxRate) / 100 + fees + accountFee),
    assumptions,
  };
}

/** Does a road name / navigation instruction refer to Highway 407 (either section)? */
export function mentions407(text: string): boolean {
  return /\b(on-)?407\b|highway 407|hwy 407/i.test(text);
}

/**
 * The privately operated 407 ETR runs from the QEW (Burlington) to Brock Road (Pickering).
 * East of Brock Road it continues as the provincially tolled Highway 407, priced differently.
 * Directions in instructions ("407 E") are compass directions, so we split by longitude.
 */
export const ETR407_EAST_END_LNG = -79.09;
export const ETR407_WEST_END_LNG = -79.84;

export function is407EtrSection(lng: number): boolean {
  return lng >= ETR407_WEST_END_LNG - 0.05 && lng <= ETR407_EAST_END_LNG;
}
