'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Shell } from '@/components/shell';
import { Badge, Card, Spinner } from '@/components/ui';
import { tripsApi, type TripListItem } from '@/lib/api';
import { dateLabel } from '@/lib/format';

const STATUS_TONE = { draft: 'neutral', queued: 'info', generating: 'info', ready: 'good', failed: 'bad' } as const;

export default function TripsPage() {
  const [trips, setTrips] = useState<TripListItem[] | null>(null);
  const [usage, setUsage] = useState<{ usedThisMonth: number; limit: number | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    tripsApi.list().then(setTrips).catch((e) => setError(e.message));
    tripsApi.usage().then(setUsage).catch(() => undefined);
  }, []);

  return (
    <Shell requireAuth>
      <div className="mb-6 flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">My trips</h1>
          {usage?.limit != null && (
            <p className="mt-1 text-sm text-muted">
              {usage.usedThisMonth} of {usage.limit} free plans used this month
            </p>
          )}
        </div>
        <Link href="/trips/new" className="rounded-lg bg-road px-4 py-2 text-sm font-medium text-white hover:bg-road/90">
          New trip
        </Link>
      </div>
      {error && <p className="text-danger">{error}</p>}
      {!trips && !error && <Spinner />}
      {trips && trips.length === 0 && (
        <Card>
          <p className="text-muted">No trips yet. Start with where you’re going and when.</p>
        </Card>
      )}
      <div className="grid gap-3">
        {trips?.map((t) => (
          <Link key={t.id} href={`/trips/${t.id}`} className="block rounded-xl border border-line bg-white p-4 hover:border-road/40">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="font-medium">{t.title}</p>
                <p className="text-sm text-muted">
                  {dateLabel(t.startDate)} – {dateLabel(t.endDate)}
                </p>
              </div>
              <Badge tone={STATUS_TONE[t.status]}>{t.status}</Badge>
            </div>
          </Link>
        ))}
      </div>
    </Shell>
  );
}
