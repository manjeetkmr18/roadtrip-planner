'use client';
/// <reference types="google.maps" />

import { useEffect, useMemo } from 'react';
import { APIProvider, AdvancedMarker, Map, useMap } from '@vis.gl/react-google-maps';
import { decodePolyline, type DayPlan, type LatLng } from '@rtp/core';

const MAPS_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
const MAP_ID = process.env.NEXT_PUBLIC_GOOGLE_MAP_ID ?? 'DEMO_MAP_ID';

interface Pin {
  n: number;
  label: string;
  location: LatLng;
  overnight: boolean;
}

function pinsFor(days: DayPlan[]): Pin[] {
  let n = 0;
  return days.flatMap((d) => d.stops.map((s) => ({ n: ++n, label: `Day ${d.day}: ${s.name}`, location: s.location, overnight: s.kind === 'overnight' })));
}

function RouteLine({ path }: { path: LatLng[] }) {
  const map = useMap();
  useEffect(() => {
    if (!map || !path.length || typeof google === 'undefined') return;
    const line = new google.maps.Polyline({ path, strokeColor: '#1f5f46', strokeOpacity: 0.9, strokeWeight: 4, map });
    const bounds = new google.maps.LatLngBounds();
    path.forEach((p) => bounds.extend(p));
    map.fitBounds(bounds, 40);
    return () => line.setMap(null);
  }, [map, path]);
  return null;
}

/** Interactive Google map when a browser key is configured; a simple SVG sketch otherwise. */
export function RouteMap({ polyline, days }: { polyline?: string; days: DayPlan[] }) {
  const path = useMemo(() => (polyline ? decodePolyline(polyline) : []), [polyline]);
  const pins = useMemo(() => pinsFor(days), [days]);

  if (MAPS_KEY && path.length) {
    return (
      <div className="h-80 overflow-hidden rounded-xl border border-line md:h-96">
        <APIProvider apiKey={MAPS_KEY}>
          <Map mapId={MAP_ID} defaultCenter={path[0]} defaultZoom={6} gestureHandling="cooperative" disableDefaultUI={false}>
            <RouteLine path={path} />
            {pins.map((p) => (
              <AdvancedMarker key={p.n} position={p.location} title={p.label}>
                <span className={`flex h-6 w-6 items-center justify-center rounded-full border-2 border-white text-xs font-semibold text-white shadow ${p.overnight ? 'bg-ink' : 'bg-road'}`}>
                  {p.overnight ? '☾' : p.n}
                </span>
              </AdvancedMarker>
            ))}
          </Map>
        </APIProvider>
      </div>
    );
  }
  return <RouteSketch path={path} pins={pins} />;
}

function RouteSketch({ path, pins }: { path: LatLng[]; pins: Pin[] }) {
  const all = [...path, ...pins.map((p) => p.location)];
  if (!all.length) return null;
  const W = 640;
  const H = 300;
  const pad = 24;
  const k = Math.cos((all[0].lat * Math.PI) / 180);
  const xs = all.map((p) => p.lng * k);
  const ys = all.map((p) => p.lat);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const scale = Math.min((W - 2 * pad) / (maxX - minX || 1), (H - 2 * pad) / (maxY - minY || 1));
  const px = (p: LatLng) => pad + (p.lng * k - minX) * scale;
  const py = (p: LatLng) => H - pad - (p.lat - minY) * scale;
  const d = path.map((p, i) => `${i ? 'L' : 'M'}${px(p).toFixed(1)} ${py(p).toFixed(1)}`).join(' ');
  return (
    <figure className="rounded-xl border border-line bg-white p-3">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Route sketch with numbered stops">
        <path d={d} fill="none" stroke="#1f5f46" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        {pins.map((p) => (
          <g key={p.n}>
            <circle cx={px(p.location)} cy={py(p.location)} r="9" fill={p.overnight ? '#17201b' : '#1f5f46'} stroke="white" strokeWidth="2" />
            <text x={px(p.location)} y={py(p.location) + 3.5} textAnchor="middle" fontSize="9" fill="white" fontWeight="600">
              {p.overnight ? '☾' : p.n}
            </text>
            <title>{p.label}</title>
          </g>
        ))}
      </svg>
      <figcaption className="mt-1 text-xs text-muted">Route sketch. Set NEXT_PUBLIC_GOOGLE_MAPS_API_KEY for an interactive Google map.</figcaption>
    </figure>
  );
}
