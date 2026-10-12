'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Share2, Pencil, Trash2 } from 'lucide-react';
import { Shell } from '@/components/shell';
import { PlanView } from '@/components/plan-view';
import { Button, Card, Spinner } from '@/components/ui';
import { ApiError, tripsApi, type TripRecord } from '@/lib/api';
import { dateLabel } from '@/lib/format';

export default function TripPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [trip, setTrip] = useState<TripRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => tripsApi.get(id).then(setTrip).catch((e) => setError(e.message)), [id]);

  useEffect(() => {
    load();
  }, [load]);

  // Poll while the plan is being generated.
  useEffect(() => {
    if (!trip || (trip.status !== 'queued' && trip.status !== 'generating')) return;
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [trip, load]);

  async function regenerate() {
    setNotice(null);
    try {
      setTrip(await tripsApi.generate(id));
    } catch (e) {
      setNotice(e instanceof ApiError ? e.message : 'Could not start a refresh');
    }
  }

  async function share() {
    const { shareToken } = await tripsApi.share(id);
    const url = `${window.location.origin}/share/${shareToken}`;
    await navigator.clipboard?.writeText(url).catch(() => undefined);
    setNotice(`Share link copied: ${url}`);
  }

  async function remove() {
    if (!window.confirm('Delete this trip?')) return;
    await tripsApi.remove(id);
    router.push('/trips');
  }

  const busy = trip?.status === 'queued' || trip?.status === 'generating';

  return (
    <Shell requireAuth>
      {error && <p className="text-danger">{error}</p>}
      {!trip && !error && <Spinner />}
      {trip && (
        <>
          <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
            <div>
              <Link href="/trips" className="text-sm text-muted hover:text-ink">
                ← My trips
              </Link>
              <h1 className="mt-1 text-2xl font-semibold">{trip.title}</h1>
              <p className="text-sm text-muted">
                {dateLabel(trip.request.startDate)} – {dateLabel(trip.request.endDate)} · {trip.request.roundTrip ? 'Round trip' : 'One way'}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={regenerate} disabled={busy}>
                <RefreshCw className="h-4 w-4" /> Refresh
              </Button>
              <Link href={`/trips/${id}/edit`} className="inline-flex items-center gap-2 rounded-lg border border-line bg-white px-4 py-2 text-sm font-medium hover:bg-paper">
                <Pencil className="h-4 w-4" /> Edit
              </Link>
              <Button variant="secondary" onClick={share} disabled={!trip.plan}>
                <Share2 className="h-4 w-4" /> Share
              </Button>
              <Button variant="danger" onClick={remove} aria-label="Delete trip">
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          </div>
          {notice && <p className="mb-4 rounded-lg bg-road-soft px-3 py-2 text-sm text-road">{notice}</p>}
          {busy && (
            <Card className="mb-6 flex items-center gap-3">
              <Spinner /> <span>Planning: checking routes, tolls, weather and stops…</span>
            </Card>
          )}
          {trip.status === 'failed' && (
            <Card className="mb-6 border-danger/30">
              <p className="text-danger">Planning failed: {trip.error}</p>
              <p className="mt-1 text-sm text-muted">Check the places and dates, then try Refresh.</p>
            </Card>
          )}
          {trip.status === 'draft' && !trip.plan && (
            <Card className="mb-6">
              <p>This trip hasn’t been planned yet.</p>
              <Button className="mt-3" onClick={regenerate}>
                Plan it now
              </Button>
            </Card>
          )}
          {trip.plan && <PlanView plan={trip.plan} tripId={id} />}
        </>
      )}
    </Shell>
  );
}
