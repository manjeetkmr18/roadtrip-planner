import {
  convertLine,
  decodePolyline,
  haversineMeters,
  energyCostLine,
  estimate407,
  is407EtrSection,
  mentions407,
  parkingCostLine,
  unknownTollLine,
  type CostLine,
  type Currency,
  type RouteStep,
  type TripRequest,
} from '@rtp/core';
import type { RawRoute } from '../providers/google.js';
import type { Providers } from '../providers/providers.module.js';
import { nowIso, type ProviderContext } from '../providers/infra.js';
import type { ResolvedPlace } from '../providers/google.js';

export interface TollSegments {
  etrKm: number;
  etrTrips: number;
  /** Seconds from departure until first entry onto the 407 ETR. */
  etrEntryOffsetSeconds: number | null;
  provincial407Km: number;
}

function splitByEtrSection(s: RouteStep): { etr: number; provincial: number } {
  const pts = s.polyline ? decodePolyline(s.polyline) : [s.startLocation, s.endLocation].filter((x): x is NonNullable<typeof x> => !!x);
  if (pts.length < 2) return { etr: 1, provincial: 0 };
  let etr = 0;
  let provincial = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = haversineMeters(pts[i - 1], pts[i]);
    if (is407EtrSection((pts[i - 1].lng + pts[i].lng) / 2)) etr += d;
    else provincial += d;
  }
  return { etr, provincial };
}

/** Find kilometres on the 407 ETR (and on the provincial 407 East) from route steps. */
export function find407(steps: RouteStep[]): TollSegments {
  let offset = 0;
  let etrKm = 0;
  let provincial407Km = 0;
  let etrTrips = 0;
  let entry: number | null = null;
  let onEtr = false;
  for (const s of steps) {
    const is407 = s.roads.includes('407') || (s.instruction ? mentions407(s.instruction) : false);
    if (!is407) {
      onEtr = false;
      offset += s.durationSeconds;
      continue;
    }
    // Split the step at Brock Road using its polyline: west = 407 ETR, east = provincial 407.
    const { etr, provincial } = splitByEtrSection(s);
    const km = s.distanceMeters / 1000;
    const total = etr + provincial || 1;
    if (etr > 0) {
      etrKm += (km * etr) / total;
      if (!onEtr) etrTrips++;
      if (entry == null) entry = offset;
      onEtr = true;
    } else {
      onEtr = false;
    }
    provincial407Km += (km * provincial) / total;
    offset += s.durationSeconds;
  }
  return { etrKm, etrTrips, etrEntryOffsetSeconds: entry, provincial407Km };
}

export interface RouteCostInput {
  idPrefix: string;
  labelPrefix: string;
  raw: RawRoute;
  date: string;
  departureMinutes: number;
  departureIso: string;
  from: ResolvedPlace;
  to: ResolvedPlace;
  waypoints: ResolvedPlace[];
  /** Try TollGuru as a cross-check / backup for tolls Google cannot price. */
  useTollGuru: boolean;
  /** False when the 407 monthly account fee is already counted on another leg this month. */
  chargeEtrAccountFee?: boolean;
}

/** Toll and energy cost lines for one leg of the trip, in the trip currency. */
export async function legCostLines(input: RouteCostInput, req: TripRequest, providers: Providers, ctx: ProviderContext, usdToCad: number): Promise<CostLine[]> {
  const { raw, idPrefix: id, labelPrefix: lp } = input;
  const currency: Currency = req.currency;
  const lines: CostLine[] = [];
  const retrievedAt = nowIso();
  const googleSource = raw.sample
    ? { name: 'Sample route (no Google key)', retrievedAt }
    : { name: 'Google Routes API toll estimate', url: 'https://developers.google.com/maps/documentation/routes/calculate_toll_fees', retrievedAt };

  // 1. 407 ETR from our own calculator (Google does not price it)
  const seg = find407(raw.steps);
  if (seg.etrKm > 0.5) {
    const entryMinutes = input.departureMinutes + (seg.etrEntryOffsetSeconds ?? 0) / 60;
    const e = estimate407({
      km: seg.etrKm,
      date: input.date,
      entryMinutes: entryMinutes % 1440,
      hasTransponder: req.vehicle.has407Transponder,
      trips: seg.etrTrips,
      includeAccountFee: input.chargeEtrAccountFee !== false,
    });
    lines.push({
      id: `${id}-etr407`,
      category: 'etr407',
      label: `${lp}Highway 407 ETR`,
      low: e.low,
      typical: e.typical,
      high: e.high,
      currency: 'CAD',
      confidence: 'approximate',
      mandatory: true,
      assumptions: [...e.assumptions, 'Billed later by licence plate if you have no transponder'],
      source: { name: '407 ETR published 2026 light-vehicle rates', url: 'https://www.407etr.com/en/rate-chart-light', retrievedAt },
    });
  }
  if (seg.provincial407Km > 0.5) {
    lines.push(unknownTollLine(`${id}-407east`, `${lp}Highway 407 East (provincial toll, ${Math.round(seg.provincial407Km)} km)`, currency, googleSource));
  }

  // 2. Other tolls from Google
  if (raw.toll?.known) {
    const byCurrency = new Map<string, number>();
    for (const p of raw.toll.prices) byCurrency.set(p.currency, (byCurrency.get(p.currency) ?? 0) + p.amount);
    for (const [cur, amount] of byCurrency) {
      lines.push({
        id: `${id}-toll-${cur}`,
        category: 'toll',
        label: `${lp}Tolls (bridges, highways)`,
        low: amount,
        typical: amount,
        high: amount,
        currency: (cur === 'USD' ? 'USD' : 'CAD') as Currency,
        confidence: 'provider_estimate',
        mandatory: true,
        assumptions: [
          req.vehicle.tollPasses.length ? `Pass prices for: ${req.vehicle.tollPasses.join(', ')}` : 'Cash / no-pass prices (usually the highest)',
          'Excludes the 407 ETR, priced separately',
        ],
        source: googleSource,
      });
    }
  } else if (raw.toll && !raw.toll.known && seg.etrKm <= 0.5) {
    lines.push(unknownTollLine(`${id}-toll-unknown`, `${lp}Toll on route (price not available)`, currency, googleSource));
  }

  // 3. TollGuru cross-check: when it matches our route, its figure covers all tolls (including the 407)
  const hasUnknown = lines.some((l) => l.confidence === 'unknown');
  if (input.useTollGuru && providers.tollguru.enabled && !raw.sample && (hasUnknown || seg.etrKm > 0.5)) {
    try {
      const tg = await providers.tollguru.routes(input.from.location, input.to.location, input.waypoints.map((w) => w.location), input.departureIso, ctx);
      const match = tg
        .filter((r) => Math.abs(r.distanceMeters - raw.distanceMeters) / raw.distanceMeters < 0.08)
        .sort((a, b) => Math.abs(a.distanceMeters - raw.distanceMeters) - Math.abs(b.distanceMeters - raw.distanceMeters))[0];
      if (match && match.hasTolls) {
        const vals = [match.tag, match.cash, match.licensePlate, match.min, match.max].filter((v): v is number => v != null);
        if (vals.length) {
          const typical = req.vehicle.has407Transponder || req.vehicle.tollPasses.length ? (match.tag ?? Math.min(...vals)) : (match.licensePlate ?? match.cash ?? Math.max(...vals));
          const own407 = lines.find((l) => l.category === 'etr407');
          const replaced = lines.filter((l) => l.category === 'toll' || l.category === 'etr407').map((l) => l.label);
          for (let i = lines.length - 1; i >= 0; i--) if (lines[i].category === 'toll' || lines[i].category === 'etr407') lines.splice(i, 1);
          lines.push({
            id: `${id}-tollguru`,
            category: 'toll',
            label: `${lp}All tolls (TollGuru)`,
            low: match.min ?? Math.min(...vals),
            typical,
            high: match.max ?? Math.max(...vals),
            currency: (match.currency === 'CAD' ? 'CAD' : 'USD') as Currency,
            confidence: 'provider_estimate',
            mandatory: true,
            assumptions: [
              `Covers every toll on a TollGuru route within 8% of this route's distance; replaces: ${replaced.join(', ')}`,
              own407 ? `Our own 407 ETR check: ${own407.low}–${own407.high} CAD` : 'No 407 ETR on this route',
              'Low = cheapest payment method, high = most expensive',
            ],
            source: { name: 'TollGuru Toll API', url: 'https://tollguru.com', retrievedAt },
          });
        }
      }
    } catch (e) {
      ctx.note(`TollGuru cross-check failed: ${(e as Error).message.slice(0, 120)}`);
    }
  }

  // 4. Fuel / charging, priced for the starting region
  const price = await providers.fuel.range(input.from.country, input.from.region, req.vehicle.fuelType, ctx);
  lines.push(
    energyCostLine({
      id: `${id}-energy`,
      distanceKm: raw.distanceMeters / 1000,
      fuelType: req.vehicle.fuelType,
      consumptionPer100km: req.vehicle.consumptionPer100km,
      price,
      date: input.date,
    }),
  );
  const last = lines[lines.length - 1];
  last.label = `${lp}${last.label}`;
  if (input.from.country && input.to.country && input.from.country !== input.to.country) {
    last.assumptions.push(`Priced at ${input.from.country} rates for the whole leg; prices differ across the border`);
  }

  return lines.map((l) => convertLine(l, currency, usdToCad));
}

export function parkingLine(args: { urbanStops: number; otherStops: number; overnights: number; currency: Currency }): CostLine {
  return parkingCostLine({ id: 'parking', ...args, retrievedAt: nowIso() });
}
