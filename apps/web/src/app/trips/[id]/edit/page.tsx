'use client';

import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Shell } from '@/components/shell';
import { TripForm } from '@/components/trip-form';
import { Spinner } from '@/components/ui';
import { tripsApi, type TripRecord } from '@/lib/api';

export default function EditTripPage() {
  const { id } = useParams<{ id: string }>();
  const [trip, setTrip] = useState<TripRecord | null>(null);
  useEffect(() => {
    tripsApi.get(id).then(setTrip).catch(() => undefined);
  }, [id]);
  return (
    <Shell requireAuth>
      <h1 className="mb-6 text-2xl font-semibold">Edit trip</h1>
      {trip ? <TripForm tripId={id} initial={trip.request} /> : <Spinner />}
    </Shell>
  );
}
