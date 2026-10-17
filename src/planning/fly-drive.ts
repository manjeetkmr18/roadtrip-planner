import type { Airport, CostLine, Currency, DayPlan, FlightOffer, Issue, PlaceInput, TripRequest } from '../core/index.js';
import { addDays, formatHHMM, parseHHMM } from '../core/index.js';
import type { ResolvedPlace } from '../providers/google.js';

/** Rental-car day rates in CAD (economy, before insurance and fees). */
const RENTAL_CAD_PER_DAY = { low: 45, typical: 70, high: 110 };

const intl = (f: FlightOffer) => f.from.country !== f.to.country;
const flightNo = (f: FlightOffer) => f.segments.map((s) => s.flightNumber).join(' / ');
const airportPlace = (a: Airport): { input: PlaceInput; resolved: ResolvedPlace } => ({
  input: { address: `${a.name} (${a.iata})`, location: a.location },
  resolved: { label: `${a.city} airport (${a.iata})`, location: a.location, country: a.country, urban: true },
});

export interface RoadTrip {
  /** The request the road-trip planner runs on (origin = arrival airport, dates = on the ground). */
  req: TripRequest;
  /** Day 1 starts when the traveller has their bags and car (later days keep the usual start time). */
  firstDayDeparture?: string;
  /** Places already known, so they aren't geocoded again. */
  resolvedOrigin?: ResolvedPlace;
  resolvedDestination?: ResolvedPlace;
}

/**
 * Turns a fly + drive request into the road trip on the ground: it starts at the arrival
 * airport once the traveller has their bags and car, and ends at the return flight's airport.
 */
export function roadTripFor(req: TripRequest): RoadTrip {
  const out = req.travel.mode === 'fly_drive' ? req.travel.outbound : undefined;
  if (!out) return { req };
  const ret = req.travel.return;

  // Bags + rental counter: about an hour after a domestic flight, 90 minutes after an international one.
  let startDate = out.arriveLocal.slice(0, 10);
  let start = Math.ceil((parseHHMM(out.arriveLocal.slice(11, 16)) + (intl(out) ? 90 : 60)) / 15) * 15;
  if (start > 21 * 60) {
    // Landing late: the road trip starts the next morning.
    startDate = addDays(startDate, 1);
    start = 9 * 60;
  }
  const endDate = ret ? ret.departLocal.slice(0, 10) : req.endDate;

  const arrival = airportPlace(out.to);
  let destination = req.destination;
  let waypoints = req.waypoints;
  let roundTrip = req.roundTrip;
  let resolvedDestination: ResolvedPlace | undefined;
  if (ret) {
    if (ret.from.iata === out.to.iata) roundTrip = true;
    else {
      // Flying home from another airport: drive through the destination and finish there.
      const dep = airportPlace(ret.from);
      waypoints = [...req.waypoints, req.destination];
      destination = dep.input;
      resolvedDestination = dep.resolved;
      roundTrip = false;
    }
  }

  return {
    req: {
      ...req,
      origin: arrival.input,
      destination,
      waypoints,
      roundTrip,
      startDate,
      endDate: endDate < startDate ? startDate : endDate,
    },
    firstDayDeparture: formatHHMM(Math.min(start, 23 * 60 + 45)),
    resolvedOrigin: arrival.resolved,
    resolvedDestination,
  };
}

function convert(amount: number, from: string, to: Currency, usdToCad: number): number | null {
  if (from === to) return amount;
  if (from === 'USD' && to === 'CAD') return amount * usdToCad;
  if (from === 'CAD' && to === 'USD') return amount / usdToCad;
  return null;
}

const money = (n: number, c: string) => `${c} ${n.toLocaleString('en-CA', { maximumFractionDigits: 0 })}`;

function flightLine(id: string, f: FlightOffer, currency: Currency, usdToCad: number): CostLine {
  const amount = f.price === null ? null : convert(f.price, f.currency, currency, usdToCad);
  const r = (n: number) => Math.round(n);
  const assumptions = [
    `${flightNo(f)}, ${f.departLocal.replace('T', ' ')} → ${f.arriveLocal.replace('T', ' ')} local, ${f.stops ? `${f.stops} stop` : 'non-stop'}`,
    `Fare for ${f.travellers} traveller${f.travellers > 1 ? 's' : ''} at search time; it changes until you book`,
  ];
  if (f.price !== null && amount === null) assumptions.push(`Fare shown in ${f.currency}: ${money(f.price, f.currency)}`);
  if (f.price !== null && amount !== null && f.currency !== currency) assumptions.push(`Converted from ${money(f.price, f.currency)}`);
  return {
    id,
    category: 'flight',
    label: `Flight ${f.from.iata} → ${f.to.iata}`,
    low: amount === null ? null : r(amount),
    typical: amount === null ? null : r(amount),
    high: amount === null ? null : r(amount * 1.25),
    currency,
    confidence: f.sample ? 'approximate' : 'provider_estimate',
    mandatory: true,
    assumptions,
    source: f.source,
  };
}

/** Flight and rental-car cost lines for a fly + drive trip (empty for a drive trip). */
export function flyDriveCosts(req: TripRequest, roadDays: number, usdToCad: number): CostLine[] {
  const t = req.travel;
  if (t.mode !== 'fly_drive' || !t.outbound) return [];
  const lines = [flightLine('flight-out', t.outbound, req.currency, usdToCad)];
  if (t.return) lines.push(flightLine('flight-ret', t.return, req.currency, usdToCad));
  if (t.rentalCar) {
    const k = req.currency === 'CAD' ? 1 : 1 / usdToCad;
    lines.push({
      id: 'rental-car',
      category: 'rental',
      label: `Rental car (${roadDays} day${roadDays > 1 ? 's' : ''})`,
      low: Math.round(RENTAL_CAD_PER_DAY.low * roadDays * k),
      typical: Math.round(RENTAL_CAD_PER_DAY.typical * roadDays * k),
      high: Math.round(RENTAL_CAD_PER_DAY.high * roadDays * k),
      currency: req.currency,
      confidence: 'approximate',
      mandatory: true,
      assumptions: [`Economy car picked up at ${t.outbound.to.iata}`, 'Before insurance, taxes, young-driver and extra-driver fees'],
    });
    if (t.return && t.return.from.iata !== t.outbound.to.iata) {
      lines.push({
        id: 'rental-dropoff',
        category: 'rental',
        label: `One-way drop-off (${t.outbound.to.iata} → ${t.return.from.iata})`,
        low: null,
        typical: null,
        high: null,
        currency: req.currency,
        confidence: 'unknown',
        mandatory: true,
        assumptions: ['Most rental companies charge for returning the car elsewhere; ask when you book'],
      });
    }
  }
  return lines;
}

/** Notes about meeting the flights: pickup on arrival, and getting back for the return flight. */
export function flyDriveIssues(req: TripRequest, days: DayPlan[]): Issue[] {
  const t = req.travel;
  if (t.mode !== 'fly_drive' || !t.outbound) return [];
  const out = t.outbound;
  const issues: Issue[] = [
    {
      severity: 'info',
      code: 'FLY_DRIVE_ARRIVAL',
      day: 1,
      message: `Day 1 starts at ${out.to.iata} after ${flightNo(out)} lands at ${out.arriveLocal.slice(11)}: allow ${intl(out) ? '90 minutes' : 'an hour'} for bags and the rental car.`,
    },
  ];
  if (intl(out)) {
    issues.push({ severity: 'info', code: 'DRIVING_ABROAD', message: `Driving in ${out.to.country}: check whether you need an International Driving Permit, and the local road rules.` });
  }
  if (!['CA', 'US'].includes(out.to.country)) {
    issues.push({ severity: 'info', code: 'OUTSIDE_NORTH_AMERICA', message: 'Fuel prices and road notices are checked for Canada and the US only, so costs here are rougher.' });
  }
  const ret = t.return;
  if (ret) {
    const bufferMin = intl(ret) ? 180 : 120;
    const flightAt = parseHHMM(ret.departLocal.slice(11, 16));
    const beThere = flightAt - bufferMin;
    issues.push({
      severity: 'info',
      code: 'FLY_DRIVE_RETURN',
      day: days.length || undefined,
      message: `${flightNo(ret)} leaves ${ret.from.iata} at ${ret.departLocal.slice(11)} on ${ret.departLocal.slice(0, 10)}: return the car and be at the airport by ${formatHHMM(Math.max(0, beThere))}.`,
    });
    const last = days.find((d) => d.date === ret.departLocal.slice(0, 10));
    if (last && last.drivingSeconds > 0) {
      const visits = last.stops.reduce((m, s) => m + (s.visitMinutes ?? 0), 0);
      const arrive = parseHHMM(last.departureTime) + Math.round(last.drivingSeconds / 60) + visits;
      if (arrive > beThere) {
        issues.push({
          severity: 'warning',
          code: 'RETURN_FLIGHT_TIGHT',
          day: last.day,
          message: `Day ${last.day} ends around ${formatHHMM(Math.min(arrive, 23 * 60 + 59))}, after you need to be at ${ret.from.iata} (${formatHHMM(Math.max(0, beThere))}). Leave earlier or drop a stop.`,
        });
      }
    }
  }
  return issues;
}
