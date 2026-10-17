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
  // Long-distance flights mostly use the international airport, even when a smaller one is closer
  // (Paris: CDG over Orly; New York: JFK over LaGuardia), so those get a 30 km head start.
  const score = (x: { r: AirportRow; km: number }) => x.km - (/international/i.test(x.r[1]) ? 30 : 0);
  const large = withDist.filter((x) => x.r[6] === 'L' && x.km <= radiusKm).sort((a, b) => score(a) - score(b));
  if (large.length) return large.slice(0, max).map((x) => toAirport(x.r));
  const any = withDist.filter((x) => x.km <= radiusKm * 2);
  return (any.length ? any : withDist).slice(0, max).map((x) => toAirport(x.r));
}

export function airportByIata(iata: string): Airport | undefined {
  const r = AIRPORTS.find((a) => a[0] === iata.toUpperCase());
  return r ? toAirport(r) : undefined;
}

/** City centres for common long-distance destinations (sample mode; airports sit outside town). */
const WORLD_CITIES: { city: string; country: string; location: LatLng }[] = [
  ['Paris', 'FR', 48.8566, 2.3522], ['London', 'GB', 51.5072, -0.1276], ['Rome', 'IT', 41.9028, 12.4964], ['Milan', 'IT', 45.4642, 9.19],
  ['Barcelona', 'ES', 41.3874, 2.1686], ['Madrid', 'ES', 40.4168, -3.7038], ['Lisbon', 'PT', 38.7223, -9.1393], ['Dublin', 'IE', 53.3498, -6.2603],
  ['Amsterdam', 'NL', 52.3676, 4.9041], ['Berlin', 'DE', 52.52, 13.405], ['Munich', 'DE', 48.1351, 11.582], ['Vienna', 'AT', 48.2082, 16.3738],
  ['Zurich', 'CH', 47.3769, 8.5417], ['Prague', 'CZ', 50.0755, 14.4378], ['Athens', 'GR', 37.9838, 23.7275], ['Reykjavik', 'IS', 64.1466, -21.9426],
  ['Edinburgh', 'GB', 55.9533, -3.1883], ['Nice', 'FR', 43.7102, 7.262], ['Tokyo', 'JP', 35.6762, 139.6503], ['Sydney', 'AU', -33.8688, 151.2093],
  ['Melbourne', 'AU', -37.8136, 144.9631], ['Auckland', 'NZ', -36.8485, 174.7633], ['Delhi', 'IN', 28.6139, 77.209], ['Mumbai', 'IN', 19.076, 72.8777],
  ['Dubai', 'AE', 25.2048, 55.2708], ['Mexico City', 'MX', 19.4326, -99.1332], ['Cancun', 'MX', 21.1619, -86.8515], ['Los Angeles', 'US', 34.0522, -118.2437],
  ['San Francisco', 'US', 37.7749, -122.4194], ['Seattle', 'US', 47.6062, -122.3321], ['Las Vegas', 'US', 36.1699, -115.1398], ['Phoenix', 'US', 33.4484, -112.074],
  ['Denver', 'US', 39.7392, -104.9903], ['Dallas', 'US', 32.7767, -96.797], ['Houston', 'US', 29.7604, -95.3698], ['Miami', 'US', 25.7617, -80.1918],
  ['Orlando', 'US', 28.5384, -81.3789], ['Atlanta', 'US', 33.749, -84.388], ['Washington', 'US', 38.9072, -77.0369], ['Nashville', 'US', 36.1627, -86.7816],
  ['New Orleans', 'US', 29.9511, -90.0715], ['Salt Lake City', 'US', 40.7608, -111.891], ['Honolulu', 'US', 21.3069, -157.8583], ['Victoria', 'CA', 48.4284, -123.3656],
  ['Kelowna', 'CA', 49.888, -119.496], ['Jasper', 'CA', 52.8737, -118.0814], ['Whitehorse', 'CA', 60.7212, -135.0568], ["St. John's", 'CA', 47.5615, -52.7126],
  ['Charlottetown', 'CA', 46.2382, -63.1311], ['Moncton', 'CA', 46.0878, -64.7782], ['Saskatoon', 'CA', 52.1332, -106.67],
].map(([city, country, lat, lng]) => ({ city: city as string, country: country as string, location: { lat: lat as number, lng: lng as number } }));

/** The built-in city centres (sample-mode suggestions). */
export const worldCities = () => WORLD_CITIES;

/**
 * Sample-mode geocoding for cities outside the sample list: the city of a large airport whose
 * name matches the query ("Paris" → Paris), so long-distance trips work without a Google key.
 */
export function findAirportCity(query: string): { city: string; country: string; location: LatLng } | undefined {
  const q = query.toLowerCase().split(',')[0].trim();
  if (q.length < 3) return undefined;
  const known = WORLD_CITIES.find((c) => c.city.toLowerCase() === q);
  if (known) return known;
  const hit =
    AIRPORTS.find((a) => a[6] === 'L' && a[2].toLowerCase().split(' (')[0] === q) ??
    AIRPORTS.find((a) => a[6] === 'L' && a[2].toLowerCase().startsWith(q)) ??
    AIRPORTS.find((a) => a[2].toLowerCase().split(' (')[0] === q);
  return hit ? { city: hit[2].split(' (')[0], country: hit[3], location: { lat: hit[4], lng: hit[5] } } : undefined;
}
