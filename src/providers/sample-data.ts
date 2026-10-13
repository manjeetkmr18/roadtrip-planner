import type { LatLng } from '../core/index.js';

/**
 * Sample-mode gazetteer: lets the app run end to end without a Google key.
 * Everything produced from it is labelled "sample data" in the plan.
 */
export interface SamplePlace {
  name: string;
  region: string; // province/state code
  country: 'CA' | 'US';
  location: LatLng;
  urban: boolean;
}

export const SAMPLE_PLACES: SamplePlace[] = [
  { name: 'Toronto', region: 'ON', country: 'CA', location: { lat: 43.6532, lng: -79.3832 }, urban: true },
  { name: 'Mississauga', region: 'ON', country: 'CA', location: { lat: 43.589, lng: -79.6441 }, urban: true },
  { name: 'Brampton', region: 'ON', country: 'CA', location: { lat: 43.7315, lng: -79.7624 }, urban: true },
  { name: 'Vaughan', region: 'ON', country: 'CA', location: { lat: 43.8361, lng: -79.4983 }, urban: true },
  { name: 'Markham', region: 'ON', country: 'CA', location: { lat: 43.8561, lng: -79.337 }, urban: true },
  { name: 'Pickering', region: 'ON', country: 'CA', location: { lat: 43.8384, lng: -79.0868 }, urban: false },
  { name: 'Oshawa', region: 'ON', country: 'CA', location: { lat: 43.8971, lng: -78.8658 }, urban: true },
  { name: 'Hamilton', region: 'ON', country: 'CA', location: { lat: 43.2557, lng: -79.8711 }, urban: true },
  { name: 'Burlington', region: 'ON', country: 'CA', location: { lat: 43.3255, lng: -79.799 }, urban: false },
  { name: 'Niagara Falls', region: 'ON', country: 'CA', location: { lat: 43.0896, lng: -79.0849 }, urban: true },
  { name: 'Kingston', region: 'ON', country: 'CA', location: { lat: 44.2312, lng: -76.486 }, urban: true },
  { name: 'Ottawa', region: 'ON', country: 'CA', location: { lat: 45.4215, lng: -75.6972 }, urban: true },
  { name: 'Barrie', region: 'ON', country: 'CA', location: { lat: 44.3894, lng: -79.6903 }, urban: false },
  { name: 'Sudbury', region: 'ON', country: 'CA', location: { lat: 46.4917, lng: -80.993 }, urban: false },
  { name: 'Sault Ste. Marie', region: 'ON', country: 'CA', location: { lat: 46.5219, lng: -84.3461 }, urban: false },
  { name: 'Wawa', region: 'ON', country: 'CA', location: { lat: 47.9936, lng: -84.7738 }, urban: false },
  { name: 'Thunder Bay', region: 'ON', country: 'CA', location: { lat: 48.3809, lng: -89.2477 }, urban: false },
  { name: 'Kenora', region: 'ON', country: 'CA', location: { lat: 49.7671, lng: -94.4894 }, urban: false },
  { name: 'Winnipeg', region: 'MB', country: 'CA', location: { lat: 49.8951, lng: -97.1384 }, urban: true },
  { name: 'Brandon', region: 'MB', country: 'CA', location: { lat: 49.8485, lng: -99.95 }, urban: false },
  { name: 'Regina', region: 'SK', country: 'CA', location: { lat: 50.4452, lng: -104.6189 }, urban: true },
  { name: 'Swift Current', region: 'SK', country: 'CA', location: { lat: 50.2851, lng: -107.7972 }, urban: false },
  { name: 'Medicine Hat', region: 'AB', country: 'CA', location: { lat: 50.0405, lng: -110.6766 }, urban: false },
  { name: 'Calgary', region: 'AB', country: 'CA', location: { lat: 51.0447, lng: -114.0719 }, urban: true },
  { name: 'Banff', region: 'AB', country: 'CA', location: { lat: 51.1784, lng: -115.5708 }, urban: false },
  { name: 'Edmonton', region: 'AB', country: 'CA', location: { lat: 53.5461, lng: -113.4938 }, urban: true },
  { name: 'Vancouver', region: 'BC', country: 'CA', location: { lat: 49.2827, lng: -123.1207 }, urban: true },
  { name: 'Montreal', region: 'QC', country: 'CA', location: { lat: 45.5019, lng: -73.5674 }, urban: true },
  { name: 'Quebec City', region: 'QC', country: 'CA', location: { lat: 46.8139, lng: -71.208 }, urban: true },
  { name: 'Halifax', region: 'NS', country: 'CA', location: { lat: 44.6488, lng: -63.5752 }, urban: true },
  { name: 'Kitchener', region: 'ON', country: 'CA', location: { lat: 43.4516, lng: -80.4925 }, urban: true },
  { name: 'London', region: 'ON', country: 'CA', location: { lat: 42.9849, lng: -81.2453 }, urban: true },
  { name: 'Sarnia', region: 'ON', country: 'CA', location: { lat: 42.9745, lng: -82.4066 }, urban: false },
  { name: 'Windsor', region: 'ON', country: 'CA', location: { lat: 42.3149, lng: -83.0364 }, urban: true },
  { name: 'Peterborough', region: 'ON', country: 'CA', location: { lat: 44.3091, lng: -78.3197 }, urban: false },
  { name: 'Belleville', region: 'ON', country: 'CA', location: { lat: 44.1628, lng: -77.3832 }, urban: false },
  { name: 'Brockville', region: 'ON', country: 'CA', location: { lat: 44.5895, lng: -75.6843 }, urban: false },
  { name: 'Cornwall', region: 'ON', country: 'CA', location: { lat: 45.0213, lng: -74.7303 }, urban: false },
  { name: 'Drummondville', region: 'QC', country: 'CA', location: { lat: 45.8838, lng: -72.4843 }, urban: false },
  { name: 'Trois-Rivières', region: 'QC', country: 'CA', location: { lat: 46.3432, lng: -72.5477 }, urban: false },
  { name: 'Buffalo', region: 'NY', country: 'US', location: { lat: 42.8864, lng: -78.8784 }, urban: true },
  { name: 'Rochester', region: 'NY', country: 'US', location: { lat: 43.1566, lng: -77.6088 }, urban: true },
  { name: 'Syracuse', region: 'NY', country: 'US', location: { lat: 43.0481, lng: -76.1474 }, urban: true },
  { name: 'Albany', region: 'NY', country: 'US', location: { lat: 42.6526, lng: -73.7562 }, urban: true },
  { name: 'Scranton', region: 'PA', country: 'US', location: { lat: 41.4089, lng: -75.6624 }, urban: false },
  { name: 'New York', region: 'NY', country: 'US', location: { lat: 40.7128, lng: -74.006 }, urban: true },
  { name: 'Detroit', region: 'MI', country: 'US', location: { lat: 42.3314, lng: -83.0458 }, urban: true },
  { name: 'Chicago', region: 'IL', country: 'US', location: { lat: 41.8781, lng: -87.6298 }, urban: true },
  { name: 'Kalamazoo', region: 'MI', country: 'US', location: { lat: 42.2917, lng: -85.5872 }, urban: false },
  { name: 'Boston', region: 'MA', country: 'US', location: { lat: 42.3601, lng: -71.0589 }, urban: true },
];

export function findSamplePlace(query: string): SamplePlace | undefined {
  const q = query.toLowerCase();
  return SAMPLE_PLACES.find((p) => q.includes(p.name.toLowerCase()));
}

export function nearestSamplePlace(p: LatLng): SamplePlace {
  let best = SAMPLE_PLACES[0];
  let bestD = Infinity;
  for (const s of SAMPLE_PLACES) {
    const d = (s.location.lat - p.lat) ** 2 + ((s.location.lng - p.lng) * Math.cos((p.lat * Math.PI) / 180)) ** 2;
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return best;
}
