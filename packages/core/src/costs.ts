import type { CostLine, CostSummary, Currency, FuelType, SourceRef, Confidence } from './types';
import { month } from './time';

const round2 = (n: number) => Math.round(n * 100) / 100;

/** A price per litre (or per kWh for EVs) as a low / typical / high range. */
export interface EnergyPriceRange {
  low: number;
  typical: number;
  high: number;
  currency: Currency;
  unit: 'L' | 'kWh';
  confidence: Confidence;
  source?: SourceRef;
  note?: string;
}

/** Real-world consumption is usually above the rated figure; winter adds more. */
export function consumptionMultipliers(isoDate: string): { low: number; typical: number; high: number; winter: boolean } {
  const m = month(isoDate);
  const winter = m === 12 || m <= 3;
  return winter ? { low: 1.05, typical: 1.15, high: 1.3, winter } : { low: 1.0, typical: 1.05, high: 1.15, winter };
}

export function energyCostLine(args: {
  id: string;
  distanceKm: number;
  fuelType: FuelType;
  consumptionPer100km: number;
  price: EnergyPriceRange;
  date: string;
}): CostLine {
  const { distanceKm, consumptionPer100km, price } = args;
  const mult = consumptionMultipliers(args.date);
  const units = (distanceKm * consumptionPer100km) / 100;
  const isEv = args.fuelType === 'electric';
  const unitLabel = isEv ? 'kWh' : 'L';
  return {
    id: args.id,
    category: isEv ? 'charging' : 'fuel',
    label: isEv ? 'Charging' : args.fuelType === 'diesel' ? 'Diesel' : 'Fuel',
    low: round2(units * mult.low * price.low),
    typical: round2(units * mult.typical * price.typical),
    high: round2(units * mult.high * price.high),
    currency: price.currency,
    confidence: price.confidence === 'unknown' ? 'unknown' : 'approximate',
    mandatory: true,
    assumptions: [
      `${Math.round(distanceKm)} km at ${consumptionPer100km} ${unitLabel}/100 km (your vehicle)`,
      `Consumption ×${mult.low} / ×${mult.typical} / ×${mult.high} for low / typical / high${mult.winter ? ' (winter driving)' : ''}`,
      `Price ${price.low.toFixed(2)} / ${price.typical.toFixed(2)} / ${price.high.toFixed(2)} ${price.currency} per ${unitLabel}${price.note ? ` — ${price.note}` : ''}`,
    ],
    source: price.source,
  };
}

/** Parking is rarely published by APIs; we estimate from the number and type of stops. */
export function parkingCostLine(args: {
  id: string;
  urbanStops: number;
  otherStops: number;
  overnights: number;
  currency: Currency;
  retrievedAt: string;
}): CostLine {
  const perUrban = { typical: 12, high: 25 };
  const perOther = { typical: 0, high: 8 };
  const perNight = { typical: 0, high: 30 };
  return {
    id: args.id,
    category: 'parking',
    label: 'Parking',
    low: 0,
    typical: round2(args.urbanStops * perUrban.typical + args.otherStops * perOther.typical + args.overnights * perNight.typical),
    high: round2(args.urbanStops * perUrban.high + args.otherStops * perOther.high + args.overnights * perNight.high),
    currency: args.currency,
    confidence: 'approximate',
    mandatory: false,
    assumptions: [
      'Low: free parking options only',
      `Typical: ~$${perUrban.typical} at each of ${args.urbanStops} city stop(s); free elsewhere`,
      `High: paid parking at every stop (~$${perUrban.high} city, ~$${perOther.high} other) and ~$${perNight.high} per overnight (${args.overnights})`,
      'Confirm rates with the parking operator',
    ],
    source: { name: 'Estimate from stop types', retrievedAt: args.retrievedAt },
  };
}

/** Convert a line to the trip currency using a configured exchange rate (marked approximate). */
export function convertLine(line: CostLine, to: Currency, usdToCad: number): CostLine {
  if (line.currency === to) return line;
  const rate = line.currency === 'USD' && to === 'CAD' ? usdToCad : 1 / usdToCad;
  const conv = (v: number | null) => (v == null ? null : round2(v * rate));
  return {
    ...line,
    low: conv(line.low),
    typical: conv(line.typical),
    high: conv(line.high),
    currency: to,
    confidence: line.confidence === 'verified' ? 'provider_estimate' : line.confidence,
    assumptions: [...line.assumptions, `Converted from ${line.currency} at 1 USD = ${usdToCad.toFixed(2)} CAD (approximate)`],
  };
}

/** Totals for the three scenarios. Unknown amounts are listed, never counted as $0. */
export function summarizeCosts(lines: CostLine[], currency: Currency): CostSummary {
  let low = 0;
  let typical = 0;
  let high = 0;
  const unknownLabels: string[] = [];
  const spreadDrivers: { label: string; spread: number }[] = [];
  for (const l of lines) {
    if (l.currency !== currency) throw new Error(`Cost line ${l.id} is in ${l.currency}; convert to ${currency} first`);
    if (l.typical == null || l.low == null || l.high == null) {
      unknownLabels.push(l.label);
      continue;
    }
    low += l.low;
    typical += l.typical;
    high += l.high;
    spreadDrivers.push({ label: l.label, spread: round2(l.high - l.low) });
  }
  spreadDrivers.sort((a, b) => b.spread - a.spread);
  return {
    low: round2(low),
    typical: round2(typical),
    high: round2(high),
    currency,
    unknownCount: unknownLabels.length,
    unknownLabels,
    spreadDrivers: spreadDrivers.filter((d) => d.spread > 0).slice(0, 3),
  };
}

/** A toll the provider knows exists but cannot price. */
export function unknownTollLine(id: string, label: string, currency: Currency, source?: SourceRef): CostLine {
  return {
    id,
    category: 'toll',
    label,
    low: null,
    typical: null,
    high: null,
    currency,
    confidence: 'unknown',
    mandatory: true,
    assumptions: ['A toll exists on this route but its price is not available. Budget extra and check with the operator.'],
    source,
  };
}
