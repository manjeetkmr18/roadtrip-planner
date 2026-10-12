import type { LatLng } from './types';

/** Decode a Google encoded polyline (precision 5). */
export function decodePolyline(encoded: string, precision = 5): LatLng[] {
  const factor = 10 ** precision;
  const points: LatLng[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < encoded.length) {
    for (const which of [0, 1]) {
      let result = 0;
      let shift = 0;
      let b: number;
      do {
        b = encoded.charCodeAt(index++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20 && index < encoded.length);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (which === 0) lat += delta;
      else lng += delta;
    }
    points.push({ lat: lat / factor, lng: lng / factor });
  }
  return points;
}

export function encodePolyline(points: LatLng[], precision = 5): string {
  const factor = 10 ** precision;
  let out = '';
  let pLat = 0;
  let pLng = 0;
  const enc = (v: number) => {
    let s = v < 0 ? ~(v << 1) : v << 1;
    let str = '';
    while (s >= 0x20) {
      str += String.fromCharCode((0x20 | (s & 0x1f)) + 63);
      s >>= 5;
    }
    return str + String.fromCharCode(s + 63);
  };
  for (const p of points) {
    const lat = Math.round(p.lat * factor);
    const lng = Math.round(p.lng * factor);
    out += enc(lat - pLat) + enc(lng - pLng);
    pLat = lat;
    pLng = lng;
  }
  return out;
}

export function haversineMeters(a: LatLng, b: LatLng): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Point at `fraction` (0..1) of the way along a polyline, by distance. */
export function pointAlong(points: LatLng[], fraction: number): LatLng {
  if (points.length === 0) throw new Error('empty polyline');
  if (points.length === 1 || fraction <= 0) return points[0];
  if (fraction >= 1) return points[points.length - 1];
  const segs: number[] = [];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const d = haversineMeters(points[i - 1], points[i]);
    segs.push(d);
    total += d;
  }
  let target = total * fraction;
  for (let i = 0; i < segs.length; i++) {
    if (target <= segs[i]) {
      const t = segs[i] === 0 ? 0 : target / segs[i];
      const a = points[i];
      const b = points[i + 1];
      return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
    }
    target -= segs[i];
  }
  return points[points.length - 1];
}

/** Evenly spaced sample points along a route (for weather, closures). */
export function samplePoints(points: LatLng[], count: number): LatLng[] {
  if (count <= 1) return [points[0]];
  return Array.from({ length: count }, (_, i) => pointAlong(points, i / (count - 1)));
}

/** Project p onto segment a→b in a local flat approximation; returns t in [0,1] and the distance in metres. */
function projectOnSegment(a: LatLng, b: LatLng, p: LatLng): { t: number; meters: number } {
  const k = Math.cos((p.lat * Math.PI) / 180);
  const ax = a.lng * k, ay = a.lat, bx = b.lng * k, by = b.lat, px = p.lng * k, py = p.lat;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  const q = { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
  return { t, meters: haversineMeters(p, q) };
}

/** Fraction (0..1) of the way along a polyline at the point closest to `p`. */
export function fractionAlong(points: LatLng[], p: LatLng): number {
  if (points.length < 2) return 0;
  let total = 0;
  const cum = [0];
  for (let i = 1; i < points.length; i++) {
    total += haversineMeters(points[i - 1], points[i]);
    cum.push(total);
  }
  if (total === 0) return 0;
  let best = Infinity;
  let at = 0;
  for (let i = 1; i < points.length; i++) {
    const { t, meters } = projectOnSegment(points[i - 1], points[i], p);
    if (meters < best) {
      best = meters;
      at = cum[i - 1] + (cum[i] - cum[i - 1]) * t;
    }
  }
  return at / total;
}

/** Bounding box [minLng, minLat, maxLng, maxLat] around points, padded in degrees. */
export function bbox(points: LatLng[], pad = 0.1): [number, number, number, number] {
  const lats = points.map((p) => p.lat);
  const lngs = points.map((p) => p.lng);
  return [Math.min(...lngs) - pad, Math.min(...lats) - pad, Math.max(...lngs) + pad, Math.max(...lats) + pad];
}

/** Distance in metres from a point to the nearest point on a polyline. */
export function distanceToRoute(points: LatLng[], p: LatLng): number {
  if (points.length === 1) return haversineMeters(points[0], p);
  let best = Infinity;
  for (let i = 1; i < points.length; i++) best = Math.min(best, projectOnSegment(points[i - 1], points[i], p).meters);
  return best;
}
