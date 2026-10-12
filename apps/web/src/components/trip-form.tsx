'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Plus, X } from 'lucide-react';
import type { FuelType, Pace, TripRequest, TripRequestInput } from '@rtp/core';
import { ApiError, tripsApi } from '@/lib/api';
import { Button, Card, Field, Input, Select } from './ui';

const INTERESTS = ['nature', 'famous attractions', 'history', 'museums', 'food discovery', 'hiking', 'beaches', 'photography', 'family activities', 'architecture', 'shopping'];

function isoIn(days: number) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

export function TripForm({ tripId, initial }: { tripId?: string; initial?: TripRequest }) {
  const router = useRouter();
  const [origin, setOrigin] = useState(initial?.origin.address ?? '');
  const [destination, setDestination] = useState(initial?.destination.address ?? '');
  const [waypoints, setWaypoints] = useState<string[]>(initial?.waypoints.map((w) => w.address) ?? []);
  const [startDate, setStartDate] = useState(initial?.startDate ?? isoIn(7));
  const [endDate, setEndDate] = useState(initial?.endDate ?? isoIn(10));
  const [departureTime, setDepartureTime] = useState(initial?.departureTime ?? '08:00');
  const [roundTrip, setRoundTrip] = useState(initial?.roundTrip ?? true);
  const [fuelType, setFuelType] = useState<FuelType>(initial?.vehicle.fuelType ?? 'gasoline');
  const [consumption, setConsumption] = useState(String(initial?.vehicle.consumptionPer100km ?? 8.5));
  const [transponder, setTransponder] = useState(initial?.vehicle.has407Transponder ?? false);
  const [pace, setPace] = useState<Pace>(initial?.preferences.pace ?? 'balanced');
  const [maxHours, setMaxHours] = useState(String(initial?.preferences.maxDrivingHoursPerDay ?? 6));
  const [interests, setInterests] = useState<string[]>(initial?.preferences.interests ?? ['nature', 'famous attractions']);
  const [avoidTolls, setAvoidTolls] = useState(initial?.preferences.avoidTolls ?? false);
  const [includeParking, setIncludeParking] = useState(initial?.preferences.includeParking ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const body: TripRequestInput = {
      origin: { address: origin },
      destination: { address: destination },
      waypoints: waypoints.filter((w) => w.trim()).map((address) => ({ address })),
      startDate,
      endDate,
      departureTime,
      roundTrip,
      currency: 'CAD',
      vehicle: { fuelType, consumptionPer100km: Number(consumption), has407Transponder: transponder, tollPasses: initial?.vehicle.tollPasses ?? [] },
      preferences: { pace, maxDrivingHoursPerDay: Number(maxHours), interests, avoidTolls, includeParking },
    };
    try {
      const trip = tripId ? await tripsApi.update(tripId, body) : await tripsApi.create(body);
      await tripsApi.generate(trip.id).catch((err: ApiError) => {
        if (err.status === 402) throw err;
      });
      router.push(`/trips/${trip.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? (err.issues?.map((i) => `${i.path}: ${i.message}`).join('; ') || err.message) : 'Could not reach the server');
      setBusy(false);
    }
  }

  const unit = fuelType === 'electric' ? 'kWh/100 km' : 'L/100 km';

  return (
    <form onSubmit={submit} className="space-y-6">
      <Card>
        <h2 className="mb-4 font-semibold">Where and when</h2>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Starting point">
            <Input required value={origin} onChange={(e) => setOrigin(e.target.value)} placeholder="Mississauga, ON" />
          </Field>
          <Field label="Destination">
            <Input required value={destination} onChange={(e) => setDestination(e.target.value)} placeholder="Ottawa, ON" />
          </Field>
        </div>
        <div className="mt-3 space-y-2">
          {waypoints.map((w, i) => (
            <div key={i} className="flex gap-2">
              <Input value={w} placeholder="Stop on the way (optional)" onChange={(e) => setWaypoints(waypoints.map((x, j) => (j === i ? e.target.value : x)))} />
              <Button type="button" variant="ghost" aria-label="Remove stop" onClick={() => setWaypoints(waypoints.filter((_, j) => j !== i))}>
                <X className="h-4 w-4" />
              </Button>
            </div>
          ))}
          {waypoints.length < 8 && (
            <Button type="button" variant="ghost" onClick={() => setWaypoints([...waypoints, ''])}>
              <Plus className="h-4 w-4" /> Add a stop on the way
            </Button>
          )}
        </div>
        <div className="mt-4 grid gap-4 md:grid-cols-4">
          <Field label="Start date">
            <Input type="date" required value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </Field>
          <Field label="End date">
            <Input type="date" required min={startDate} value={endDate} onChange={(e) => setEndDate(e.target.value)} />
          </Field>
          <Field label="Departure time">
            <Input type="time" required value={departureTime} onChange={(e) => setDepartureTime(e.target.value)} />
          </Field>
          <Field label="Trip type">
            <Select value={roundTrip ? 'round' : 'one'} onChange={(e) => setRoundTrip(e.target.value === 'round')}>
              <option value="round">Round trip</option>
              <option value="one">One way</option>
            </Select>
          </Field>
        </div>
      </Card>

      <Card>
        <h2 className="mb-4 font-semibold">Your car</h2>
        <div className="grid gap-4 md:grid-cols-3">
          <Field label="Fuel">
            <Select value={fuelType} onChange={(e) => setFuelType(e.target.value as FuelType)}>
              <option value="gasoline">Gasoline</option>
              <option value="hybrid">Hybrid</option>
              <option value="diesel">Diesel</option>
              <option value="electric">Electric</option>
            </Select>
          </Field>
          <Field label={`Consumption (${unit})`} hint="From your dashboard or the manufacturer">
            <Input type="number" step="0.1" min="1" max="60" required value={consumption} onChange={(e) => setConsumption(e.target.value)} />
          </Field>
          <Field label="407 ETR transponder" hint="Without one, the 407 bills by licence plate with extra fees">
            <Select value={transponder ? 'yes' : 'no'} onChange={(e) => setTransponder(e.target.value === 'yes')}>
              <option value="no">No transponder</option>
              <option value="yes">I have a transponder</option>
            </Select>
          </Field>
        </div>
      </Card>

      <Card>
        <h2 className="mb-4 font-semibold">How you like to travel</h2>
        <div className="grid gap-4 md:grid-cols-3">
          <Field label="Pace">
            <Select value={pace} onChange={(e) => setPace(e.target.value as Pace)}>
              <option value="relaxed">Relaxed</option>
              <option value="balanced">Balanced</option>
              <option value="packed">Packed</option>
            </Select>
          </Field>
          <Field label="Max driving per day (hours)">
            <Input type="number" min="1" max="14" step="0.5" required value={maxHours} onChange={(e) => setMaxHours(e.target.value)} />
          </Field>
          <div className="space-y-2 text-sm">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={avoidTolls} onChange={(e) => setAvoidTolls(e.target.checked)} /> Prefer routes without tolls
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={includeParking} onChange={(e) => setIncludeParking(e.target.checked)} /> Include parking estimates
            </label>
          </div>
        </div>
        <div className="mt-4">
          <span className="mb-2 block text-sm font-medium">Interests</span>
          <div className="flex flex-wrap gap-2">
            {INTERESTS.map((i) => {
              const on = interests.includes(i);
              return (
                <button
                  type="button"
                  key={i}
                  onClick={() => setInterests(on ? interests.filter((x) => x !== i) : [...interests, i])}
                  className={`rounded-full border px-3 py-1 text-sm ${on ? 'border-road bg-road-soft text-road' : 'border-line bg-white text-muted hover:text-ink'}`}
                  aria-pressed={on}
                >
                  {i}
                </button>
              );
            })}
          </div>
          <p className="mt-2 text-xs text-muted">The first two shape the stop search.</p>
        </div>
      </Card>

      {error && <p className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>}
      <div className="flex justify-end">
        <Button type="submit" disabled={busy}>
          {busy ? 'Planning…' : tripId ? 'Save and re-plan' : 'Plan my trip'}
        </Button>
      </div>
    </form>
  );
}
