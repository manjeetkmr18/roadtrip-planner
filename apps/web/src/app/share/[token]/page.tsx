'use client';

import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Shell } from '@/components/shell';
import { PlanView } from '@/components/plan-view';
import { Spinner } from '@/components/ui';
import { tripsApi } from '@/lib/api';
import type { TripPlan } from '@rtp/core';

export default function SharedTripPage() {
  const { token } = useParams<{ token: string }>();
  const [data, setData] = useState<{ title: string; plan: TripPlan } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    tripsApi.shared(token).then(setData).catch((e) => setError(e.message));
  }, [token]);
  return (
    <Shell>
      {error && <p className="text-danger">{error}</p>}
      {!data && !error && <Spinner />}
      {data && (
        <>
          <h1 className="mb-6 text-2xl font-semibold">{data.title}</h1>
          <PlanView plan={data.plan} />
        </>
      )}
    </Shell>
  );
}
