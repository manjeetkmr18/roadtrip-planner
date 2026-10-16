import type { Airport, FlightOffer, FlightSegment } from '../core/index.js';
import { haversineMeters, instantToLocal, localToInstant, timeZoneAt } from '../core/index.js';
import { airportByIata } from './airports.js';
import { fetchJson, nowIso, type ProviderContext } from './infra.js';

/** Google Flights search for the same route and date, for comparing and booking. */
export function flightSearchUrl(from: string, to: string, date: string, travellers: number): string {
  const q = `Flights from ${from} to ${to} on ${date}${travellers > 1 ? ` for ${travellers} adults` : ''}`;
  return `https://www.google.com/travel/flights?q=${encodeURIComponent(q)}`;
}

const tz = (a: Airport) => timeZoneAt({ location: a.location, country: a.country });
const addMinutes = (local: string, from: Airport, minutes: number, to: Airport) =>
  instantToLocal(new Date(localToInstant(local, tz(from)).getTime() + minutes * 60_000), tz(to));

/** Big connecting airports used for sample one-stop itineraries. */
const HUBS = ['YYZ', 'YUL', 'YVR', 'ORD', 'ATL', 'DFW', 'DEN', 'JFK', 'LAX', 'SFO', 'LHR', 'CDG', 'FRA', 'AMS', 'MAD', 'IST', 'DXB', 'DOH', 'SIN', 'HND'];

const flightMinutes = (km: number) => Math.round((km / 820) * 60 + 35);

/**
 * Flight search. With a Duffel access token it returns airline offers from Duffel's search
 * (prices at search time; booking happens on the airline or flight site). Without one it
 * returns sample flights with realistic times, durations and price ranges, marked as sample.
 */
export class FlightsProvider {
  constructor(private readonly duffelToken?: string) {}

  get live() {
    return !!this.duffelToken && !this.duffelToken.startsWith('duffel_test');
  }

  async search(from: Airport, to: Airport, date: string, travellers: number, ctx?: ProviderContext): Promise<FlightOffer[]> {
    if (from.iata === to.iata) return [];
    if (!this.duffelToken) {
      ctx?.sample('Flights are sample data (no DUFFEL_ACCESS_TOKEN): times and fares are typical, not real offers.');
      return this.sample(from, to, date, travellers);
    }
    return this.duffel(from, to, date, travellers);
  }

  // ---------------- Duffel ----------------

  private async duffel(from: Airport, to: Airport, date: string, travellers: number): Promise<FlightOffer[]> {
    const body = {
      data: {
        slices: [{ origin: from.iata, destination: to.iata, departure_date: date }],
        passengers: Array.from({ length: travellers }, () => ({ type: 'adult' })),
        cabin_class: 'economy',
        max_connections: 1,
      },
    };
    const res = await fetchJson<DuffelResponse>('Duffel', 'https://api.duffel.com/air/offer_requests?return_offers=true&supplier_timeout=10000', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.duffelToken}`, 'Duffel-Version': 'v2', 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      timeoutMs: 25_000,
      retries: 0,
    });
    const sample = !this.live;
    const retrievedAt = nowIso();
    const offers = (res.data?.offers ?? [])
      .map((o): FlightOffer | undefined => {
        const slice = o.slices?.[0];
        const segs = slice?.segments ?? [];
        if (!segs.length) return undefined;
        const first = segs[0];
        const last = segs[segs.length - 1];
        const departLocal = first.departing_at.slice(0, 16);
        const arriveLocal = last.arriving_at.slice(0, 16);
        const a = airportByIata(first.origin.iata_code) ?? from;
        const b = airportByIata(last.destination.iata_code) ?? to;
        const minutes = isoMinutes(slice?.duration) ?? Math.round((localToInstant(arriveLocal, tz(b)).getTime() - localToInstant(departLocal, tz(a)).getTime()) / 60_000);
        const segments: FlightSegment[] = segs.map((s) => ({
          carrier: s.marketing_carrier?.name ?? o.owner?.name ?? 'Airline',
          carrierCode: s.marketing_carrier?.iata_code,
          flightNumber: `${s.marketing_carrier?.iata_code ?? ''} ${s.marketing_carrier_flight_number ?? ''}`.trim(),
          from: s.origin.iata_code,
          to: s.destination.iata_code,
          departLocal: s.departing_at.slice(0, 16),
          arriveLocal: s.arriving_at.slice(0, 16),
        }));
        return {
          id: `duffel-${o.id}`,
          from: a,
          to: b,
          departLocal,
          arriveLocal,
          durationMinutes: minutes,
          stops: segs.length - 1,
          carrier: o.owner?.name ?? segments[0].carrier,
          segments,
          price: o.total_amount ? Number(o.total_amount) : null,
          currency: o.total_currency ?? 'USD',
          travellers,
          sample,
          source: { name: sample ? 'Duffel (test mode)' : 'Duffel flight search', url: 'https://duffel.com', retrievedAt },
          searchUrl: flightSearchUrl(from.iata, to.iata, date, travellers),
        };
      })
      .filter((x): x is FlightOffer => !!x);
    return pickVariety(offers);
  }

  // ---------------- Sample ----------------

  private sample(from: Airport, to: Airport, date: string, travellers: number): FlightOffer[] {
    const km = haversineMeters(from.location, to.location) / 1000;
    if (km < 150) return [];
    const longHaul = km > 4500;
    const times = longHaul ? ['10:15', '17:30', '19:45', '22:10'] : ['06:45', '09:30', '13:15', '17:40', '21:55'];
    const factor = [1.15, 0.95, 1, 1.1, 0.85];
    const hub = HUBS.map(airportByIata)
      .filter((h): h is Airport => !!h && h.iata !== from.iata && h.iata !== to.iata)
      .map((h) => ({ h, extra: haversineMeters(from.location, h.location) + haversineMeters(h.location, to.location) - km * 1000 }))
      .sort((a, b) => a.extra - b.extra)[0]?.h;
    const perPerson = longHaul ? 250 + 0.09 * km : 90 + 0.12 * km;
    const retrievedAt = nowIso();
    return times.map((t, i) => {
      // Most sample itineraries are non-stop; one per search connects through a hub, like real results.
      const viaHub = !!hub && (i === times.length - 2 || km > 9500);
      const departLocal = `${date}T${t}`;
      let segments: FlightSegment[];
      if (viaHub) {
        const m1 = flightMinutes(haversineMeters(from.location, hub!.location) / 1000);
        const arrHub = addMinutes(departLocal, from, m1, hub!);
        const depHub = addMinutes(arrHub, hub!, 95, hub!);
        const m2 = flightMinutes(haversineMeters(hub!.location, to.location) / 1000);
        segments = [
          { carrier: 'Sample Air', flightNumber: `SA ${200 + i * 7}`, from: from.iata, to: hub!.iata, departLocal, arriveLocal: arrHub },
          { carrier: 'Sample Air', flightNumber: `SA ${600 + i * 7}`, from: hub!.iata, to: to.iata, departLocal: depHub, arriveLocal: addMinutes(depHub, hub!, m2, to) },
        ];
      } else {
        segments = [{ carrier: 'Sample Air', flightNumber: `SA ${100 + i * 11}`, from: from.iata, to: to.iata, departLocal, arriveLocal: addMinutes(departLocal, from, flightMinutes(km), to) }];
      }
      const arriveLocal = segments[segments.length - 1].arriveLocal;
      const minutes = Math.round((localToInstant(arriveLocal, tz(to)).getTime() - localToInstant(departLocal, tz(from)).getTime()) / 60_000);
      const price = Math.round((perPerson * factor[i % factor.length] * (viaHub ? 0.85 : 1)) / 5) * 5 * travellers;
      return {
        id: `sample-${from.iata}-${to.iata}-${date}-${t.replace(':', '')}`,
        from,
        to,
        departLocal,
        arriveLocal,
        durationMinutes: minutes,
        stops: segments.length - 1,
        carrier: 'Sample Air',
        segments,
        price,
        currency: 'CAD',
        travellers,
        sample: true,
        source: { name: 'Sample flights', retrievedAt },
        searchUrl: flightSearchUrl(from.iata, to.iata, date, travellers),
      };
    });
  }
}

/** Keeps a useful spread: the cheapest offer at each departure time, at most 8, in time order. */
function pickVariety(offers: FlightOffer[]): FlightOffer[] {
  const byTime = new Map<string, FlightOffer>();
  for (const o of offers) {
    const k = `${o.departLocal}|${o.stops}`;
    const cur = byTime.get(k);
    if (!cur || (o.price ?? Infinity) < (cur.price ?? Infinity)) byTime.set(k, o);
  }
  return [...byTime.values()]
    .sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity))
    .slice(0, 8)
    .sort((a, b) => a.departLocal.localeCompare(b.departLocal));
}

/** "PT5H10M" / "P1DT2H" → minutes. */
function isoMinutes(d?: string): number | undefined {
  const m = d?.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/);
  if (!m) return undefined;
  return Number(m[1] ?? 0) * 1440 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

interface DuffelPlace {
  iata_code: string;
  name?: string;
}
interface DuffelResponse {
  data?: {
    offers?: {
      id: string;
      total_amount?: string;
      total_currency?: string;
      owner?: { name?: string; iata_code?: string };
      slices?: {
        duration?: string;
        segments?: {
          departing_at: string;
          arriving_at: string;
          origin: DuffelPlace;
          destination: DuffelPlace;
          marketing_carrier?: { name?: string; iata_code?: string };
          marketing_carrier_flight_number?: string;
        }[];
      }[];
    }[];
  };
}
