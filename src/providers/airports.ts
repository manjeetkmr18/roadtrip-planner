import type { Airport, LatLng } from '../core/index.js';
import { haversineMeters } from '../core/index.js';
import { AIRPORTS, type AirportRow } from '../data/airports.js';

const toAirport = (r: AirportRow): Airport => ({ iata: r[0], name: r[1], city: r[2].split(' (')[0] || r[1], country: r[3], location: { lat: r[4], lng: r[5] } });

/**
 * Airports a traveller would realistically use: large airports within `radiusKm`, nearest first;
 * if there are none, the nearest medium airports, then whatever is closest.
 */
export function nearestAirports(at: LatLng, max = 2, radiusKm = 150): Airport[] {
  const withDist = AIRPORTS.map((r) => ({ r, km: haversineMeters(at, { lat: r[4], lng: r[5] }) / 1000 })).sort((a, b) => a.km - b.km);
  const large = withDist.filter((x) => x.r[6] === 'L' && x.km <= radiusKm);
  if (large.length) return large.slice(0, max).map((x) => toAirport(x.r));
  const any = withDist.filter((x) => x.km <= radiusKm * 2);
  return (any.length ? any : withDist).slice(0, max).map((x) => toAirport(x.r));
}

export function airportByIata(iata: string): Airport | undefined {
  const r = AIRPORTS.find((a) => a[0] === iata.toUpperCase());
  return r ? toAirport(r) : undefined;
}

/**
 * Sample-mode geocoding for cities outside the sample list: the city of a large airport whose
 * name matches the query ("Paris" → Paris), so long-distance trips work without a Google key.
 */
export function findAirportCity(query: string): { city: string; country: string; location: LatLng } | undefined {
  const q = query.toLowerCase().split(',')[0].trim();
  if (q.length < 3) return undefined;
  const hit =
    AIRPORTS.find((a) => a[6] === 'L' && a[2].toLowerCase().split(' (')[0] === q) ??
    AIRPORTS.find((a) => a[6] === 'L' && a[2].toLowerCase().startsWith(q)) ??
    AIRPORTS.find((a) => a[2].toLowerCase().split(' (')[0] === q);
  return hit ? { city: hit[2].split(' (')[0], country: hit[3], location: { lat: hit[4], lng: hit[5] } } : undefined;
}
