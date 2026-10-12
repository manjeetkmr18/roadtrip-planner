'use client';

import { Shell } from '@/components/shell';
import { TripForm } from '@/components/trip-form';

export default function NewTripPage() {
  return (
    <Shell requireAuth>
      <h1 className="mb-6 text-2xl font-semibold">Plan a trip</h1>
      <TripForm />
    </Shell>
  );
}
