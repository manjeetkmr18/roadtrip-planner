import type { LatLng, TravelOptions, TravelOptionsQuery } from '../core/index.js';
import { daysBetween, haversineMeters, timeZoneAt } from '../core/index.js';
import { nearestAirports } from '../providers/airports.js';
import { ProviderContext } from '../providers/infra.js';
import type { Providers } from '../providers/providers.module.js';
import { localIso } from './planner.js';

/** Below this straight-line distance flying is never worth suggesting. */
const FLY_MIN_KM = 400;

type Landmass = 'north_america' | 'south_america' | 'afro_eurasia' | 'oceania' | 'island';

/**
 * Very rough continents, only used to say "no road between these" without asking the routing
 * API (and in sample mode, where routes are straight-line guesses). Undefined = can't tell.
 */
export function landmass(p: LatLng): Landmass | undefined {
  const { lat, lng } = p;
  if (lat > 18 && lat < 23 && lng > -161 && lng < -154) return 'island'; // Hawaii
  if (lat > 59 && lng > -73 && lng < -11) return 'island'; // Greenland, Iceland
  if (lat >= 7.5 && lng >= -170 && lng <= -52) return 'north_america';
  if (lat < 7.5 && lat > -56 && lng >= -82 && lng <= -34) return 'south_america';
  if (lat < -10 && lng >= 112) return 'oceania';
  if (lng >= -26 && lat > -36) return 'afro_eurasia';
  return undefined;
}

const town = (label: string) => label.split(',')[0];

/** Drive vs fly + drive for a trip, with flights for the dates. */
export async function travelOptions(q: TravelOptionsQuery, p: Providers, ctx = new ProviderContext()): Promise<TravelOptions> {
  const [origin, destination] = await Promise.all([p.geocoding.resolve(q.origin, ctx), p.geocoding.resolve(q.destination, ctx)]);
  const straightLineKm = Math.round(haversineMeters(origin.location, destination.location) / 1000);
  const tripDays = daysBetween(q.startDate, q.endDate) + 1;
  const notes: string[] = [];

  // 1. Can you drive it, and how long does it take?
  const a = landmass(origin.location);
  const b = landmass(destination.location);
  const separated = !!a && !!b && (a !== b || a === 'island');
  let drive: TravelOptions['drive'];
  if (separated) {
    drive = { possible: false, note: `There's no road between ${town(origin.label)} and ${town(destination.label)}.` };
  } else {
    try {
      const routes = await p.routes.compute(
        {
          origin: origin.location,
          destination: destination.location,
          waypoints: [],
          departureIso: localIso(q.startDate, '08:00', timeZoneAt(origin)),
          alternatives: false,
        },
        ctx,
      );
      const r = routes[0];
      if (!r) drive = { possible: false, note: `No driving route found between ${town(origin.label)} and ${town(destination.label)}.` };
      else {
        const daysEachWay = Math.max(1, Math.ceil(r.durationSeconds / 3600 / q.maxDrivingHoursPerDay));
        const h = Math.round(r.durationSeconds / 3600);
        drive = {
          possible: true,
          distanceMeters: r.distanceMeters,
          durationSeconds: r.durationSeconds,
          daysEachWay,
          note: `About ${h} h of driving${daysEachWay > 1 ? `, ${daysEachWay} days each way at ${q.maxDrivingHoursPerDay} h a day` : ' each way'}.`,
        };
      }
    } catch (e) {
      notes.push(`Driving time could not be checked: ${(e as Error).message.slice(0, 80)}`);
      drive = { possible: true, note: 'Driving time could not be checked.' };
    }
  }

  // 2. Which way makes sense?
  let recommendation: TravelOptions['recommendation'] = 'drive';
  let reason: string;
  if (!drive.possible) {
    recommendation = 'fly_drive';
    reason = `${drive.note} Fly, then pick up a rental car and road-trip from the airport.`;
  } else if (straightLineKm < FLY_MIN_KM) {
    reason = 'Close enough that driving is the easy choice.';
  } else {
    const driveDays = (drive.daysEachWay ?? 1) * (q.roundTrip ? 2 : 1);
    if (driveDays >= Math.max(2, Math.ceil(tripDays / 2))) {
      recommendation = 'fly_drive';
      reason =
        driveDays >= tripDays
          ? `Driving takes about ${drive.daysEachWay} day${drive.daysEachWay === 1 ? '' : 's'} each way, longer than your whole ${tripDays}-day trip. Fly, then road-trip from the airport.`
          : `Driving takes ${driveDays} of your ${tripDays} days${q.roundTrip ? ' there and back' : ''}. Flying gives you that time at the destination.`;
    } else {
      reason = `${drive.note} That leaves most of your ${tripDays} days for the trip itself.`;
    }
  }

  // 3. Flights, when flying is a real option.
  const fromAirports = straightLineKm >= FLY_MIN_KM ? nearestAirports(origin.location) : [];
  const toAirports = straightLineKm >= FLY_MIN_KM ? nearestAirports(destination.location) : [];
  let outbound: TravelOptions['outbound'] = [];
  let ret: TravelOptions['return'] = [];
  if (fromAirports[0] && toAirports[0] && fromAirports[0].iata !== toAirports[0].iata) {
    const [o, r] = await Promise.allSettled([
      p.flights.search(fromAirports[0], toAirports[0], q.startDate, q.travellers, ctx),
      q.roundTrip ? p.flights.search(toAirports[0], fromAirports[0], q.endDate, q.travellers, ctx) : Promise.resolve([]),
    ]);
    if (o.status === 'fulfilled') outbound = o.value;
    else notes.push(`Flight search failed: ${(o.reason as Error).message.slice(0, 100)}`);
    if (r.status === 'fulfilled') ret = r.value;
    else notes.push(`Return flight search failed: ${(r.reason as Error).message.slice(0, 100)}`);
    if (!outbound.length && o.status === 'fulfilled') notes.push(`No flights found from ${fromAirports[0].iata} to ${toAirports[0].iata} on ${q.startDate}.`);
  }

  return {
    origin: { label: origin.label, location: origin.location },
    destination: { label: destination.label, location: destination.location },
    straightLineKm,
    drive,
    recommendation,
    reason,
    fromAirports,
    toAirports,
    outbound,
    return: ret,
    sampleFlights: [...outbound, ...ret].some((f) => f.sample) || (!p.flights.live && !!fromAirports.length),
    notes,
  };
}
