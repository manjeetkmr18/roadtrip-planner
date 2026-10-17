import { convertLine, energyCostLine, parkingCostLine, type CostLine, type Currency, type TripRequest } from '../core/index.js';
import type { RawRoute, ResolvedPlace } from '../providers/google.js';
import type { Providers } from '../providers/providers.module.js';
import { nowIso, type ProviderContext } from '../providers/infra.js';

export interface RouteCostInput {
  idPrefix: string;
  labelPrefix: string;
  raw: RawRoute;
  date: string;
  from: ResolvedPlace;
  to: ResolvedPlace;
}

/**
 * Cost lines for one driving leg, in the trip currency. Travlio doesn't price tolls (the traveller
 * plans their own route), so a leg costs its fuel or charging.
 */
export async function legCostLines(input: RouteCostInput, req: TripRequest, providers: Providers, ctx: ProviderContext, usdToCad: number): Promise<CostLine[]> {
  const { raw, idPrefix: id, labelPrefix: lp } = input;
  const currency: Currency = req.currency;
  const price = await providers.fuel.range(input.from.country, input.from.region, req.vehicle.fuelType, ctx);
  const line = energyCostLine({
    id: `${id}-energy`,
    distanceKm: raw.distanceMeters / 1000,
    fuelType: req.vehicle.fuelType,
    consumptionPer100km: req.vehicle.consumptionPer100km,
    price,
    date: input.date,
  });
  line.label = `${lp}${line.label}`;
  if (input.from.country && input.to.country && input.from.country !== input.to.country) {
    line.assumptions.push(`Priced at ${input.from.country} rates for the whole leg; prices differ across the border`);
  }
  return [convertLine(line, currency, usdToCad)];
}

export function parkingLine(args: { urbanStops: number; otherStops: number; overnights: number; currency: Currency }): CostLine {
  return parkingCostLine({ id: 'parking', ...args, retrievedAt: nowIso() });
}
