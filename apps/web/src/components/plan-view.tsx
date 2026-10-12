'use client';

import { useMemo, useState } from 'react';
import clsx from 'clsx';
import { AlertTriangle, CloudRain, CloudSun, ExternalLink, Flag, Info, MapPin, Moon, Sun, XCircle } from 'lucide-react';
import type { CostLine, DayPlan, Issue, RouteOption, TripPlan, WeatherRating } from '@rtp/core';
import { tripsApi } from '@/lib/api';
import { CONFIDENCE_LABEL, dateLabel, hours, km, money } from '@/lib/format';
import { Badge, Card } from './ui';
import { RouteMap } from './route-map';

const CONF_TONE = { verified: 'good', provider_estimate: 'info', approximate: 'warn', unknown: 'bad' } as const;
const WEATHER: Record<WeatherRating, { tone: 'good' | 'warn' | 'bad' | 'neutral'; icon: typeof Sun; label: string }> = {
  favourable: { tone: 'good', icon: Sun, label: 'Favourable' },
  mixed: { tone: 'warn', icon: CloudSun, label: 'Mixed' },
  poor: { tone: 'bad', icon: CloudRain, label: 'Poor' },
  unknown: { tone: 'neutral', icon: CloudSun, label: 'No forecast yet' },
};

function ReportButton({ tripId, itemType, itemId, label }: { tripId?: string; itemType: string; itemId?: string; label: string }) {
  const [state, setState] = useState<'idle' | 'sent'>('idle');
  if (!tripId) return null;
  return (
    <button
      className="inline-flex items-center gap-1 text-xs text-muted hover:text-danger"
      title={`Report incorrect info: ${label}`}
      onClick={async () => {
        const message = window.prompt(`What's wrong with "${label}"?`);
        if (!message || message.trim().length < 3) return;
        await tripsApi.feedback({ tripId, itemType, itemId, message }).catch(() => undefined);
        setState('sent');
      }}
    >
      <Flag className="h-3 w-3" /> {state === 'sent' ? 'Thanks' : 'Report'}
    </button>
  );
}

/** Low–high band with a typical marker, scaled to the most expensive option. */
function RangeBar({ low, typical, high, max }: { low: number; typical: number; high: number; max: number }) {
  const pct = (v: number) => `${Math.min(100, (v / (max || 1)) * 100)}%`;
  return (
    <div className="relative mt-2 h-2 rounded-full bg-paper" aria-hidden>
      <div className="absolute h-2 rounded-full bg-road/25" style={{ left: pct(low), width: `calc(${pct(high)} - ${pct(low)})` }} />
      <div className="absolute -top-1 h-4 w-1 rounded bg-road" style={{ left: pct(typical) }} />
    </div>
  );
}

function RouteCards({ routes, selected, onSelect, recommended }: { routes: RouteOption[]; selected: string; onSelect: (id: string) => void; recommended: string }) {
  const max = Math.max(...routes.map((r) => r.summary.high));
  return (
    <div className="grid gap-3 md:grid-cols-3">
      {routes.map((r) => (
        <button
          key={r.id}
          onClick={() => onSelect(r.id)}
          className={clsx('rounded-xl border bg-white p-4 text-left transition', selected === r.id ? 'border-road ring-2 ring-road/15' : 'border-line hover:border-road/40')}
        >
          <div className="flex items-center justify-between">
            <span className="font-semibold">{r.label}</span>
            {r.id === recommended && <Badge tone="good">Planned route</Badge>}
          </div>
          <p className="mt-1 text-sm text-muted">
            {km(r.distanceMeters)} · {hours(r.durationSeconds)} driving
          </p>
          <p className="num mt-3 text-lg font-semibold">
            {money(r.summary.low, r.summary.currency)} – {money(r.summary.high, r.summary.currency)}
          </p>
          <p className="num text-sm text-muted">typical {money(r.summary.typical, r.summary.currency)}</p>
          <RangeBar low={r.summary.low} typical={r.summary.typical} high={r.summary.high} max={max} />
          {r.summary.unknownCount > 0 && <p className="mt-2 text-xs text-danger">+ {r.summary.unknownCount} toll(s) with unknown price</p>}
          {!r.hasTolls && <p className="mt-2 text-xs text-road">No tolls</p>}
        </button>
      ))}
    </div>
  );
}

function CostTable({ route, tripId }: { route: RouteOption; tripId?: string }) {
  const s = route.summary;
  return (
    <Card>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold">Trip cost: {route.label.toLowerCase()} route</h2>
        <p className="num text-sm text-muted">
          Low {money(s.low, s.currency)} · Typical <strong className="text-ink">{money(s.typical, s.currency)}</strong> · High {money(s.high, s.currency)}
        </p>
      </div>
      {s.spreadDrivers.length > 0 && <p className="mt-1 text-xs text-muted">Biggest swing: {s.spreadDrivers.map((d) => d.label).join(', ')}.</p>}
      <div className="mt-4 overflow-x-auto">
        <table className="num w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs text-muted">
              <th className="py-2 pr-3 font-medium">Item</th>
              <th className="py-2 pr-3 text-right font-medium">Low</th>
              <th className="py-2 pr-3 text-right font-medium">Typical</th>
              <th className="py-2 pr-3 text-right font-medium">High</th>
              <th className="py-2 font-medium">Confidence</th>
            </tr>
          </thead>
          <tbody>
            {route.costs.map((c: CostLine) => (
              <tr key={c.id} className="border-b border-line/60 align-top">
                <td className="py-2 pr-3">
                  <details>
                    <summary className="cursor-pointer">{c.label}</summary>
                    <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-muted">
                      {c.assumptions.map((a, i) => (
                        <li key={i}>{a}</li>
                      ))}
                    </ul>
                    <div className="mt-1 flex items-center gap-3 text-xs text-muted">
                      {c.source &&
                        (c.source.url ? (
                          <a href={c.source.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline">
                            {c.source.name} <ExternalLink className="h-3 w-3" />
                          </a>
                        ) : (
                          <span>{c.source.name}</span>
                        ))}
                      <ReportButton tripId={tripId} itemType="cost_line" itemId={c.id} label={c.label} />
                    </div>
                  </details>
                </td>
                <td className="py-2 pr-3 text-right">{money(c.low, c.currency, 2)}</td>
                <td className="py-2 pr-3 text-right font-medium">{c.typical == null ? <span className="text-danger">Unknown</span> : money(c.typical, c.currency, 2)}</td>
                <td className="py-2 pr-3 text-right">{money(c.high, c.currency, 2)}</td>
                <td className="py-2">
                  <Badge tone={CONF_TONE[c.confidence]}>{CONFIDENCE_LABEL[c.confidence]}</Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {s.unknownCount > 0 && (
        <p className="mt-3 rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">
          Not included in the totals because the price is unknown: {s.unknownLabels.join(', ')}. Budget extra and check with the operator.
        </p>
      )}
    </Card>
  );
}

function IssueIcon({ severity }: { severity: Issue['severity'] }) {
  if (severity === 'error') return <XCircle className="h-4 w-4 shrink-0 text-danger" />;
  if (severity === 'warning') return <AlertTriangle className="h-4 w-4 shrink-0 text-amber" />;
  return <Info className="h-4 w-4 shrink-0 text-sky-700" />;
}

function DayCard({ day, issues, tripId }: { day: DayPlan; issues: Issue[]; tripId?: string }) {
  const w = day.weather;
  const meta = WEATHER[w?.rating ?? 'unknown'];
  const WIcon = meta.icon;
  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-xs font-medium tracking-wide text-muted uppercase">
            Day {day.day} · {dateLabel(day.date)}
          </p>
          <h3 className="text-lg font-semibold">{day.drivingSeconds > 0 ? `${day.startPlace} → ${day.endPlace}` : `Explore ${day.endPlace}`}</h3>
          {day.drivingSeconds > 0 && (
            <p className="num text-sm text-muted">
              {km(day.distanceMeters)} · {hours(day.drivingSeconds)} driving · leave {day.departureTime}
            </p>
          )}
        </div>
        <Badge tone={meta.tone}>
          <WIcon className="mr-1 h-3 w-3" /> {meta.label}
        </Badge>
      </div>

      {w && (
        <div className={clsx('mt-3 rounded-lg px-3 py-2 text-sm', meta.tone === 'bad' ? 'bg-danger-soft' : meta.tone === 'warn' ? 'bg-amber-soft' : 'bg-paper')}>
          <p>{w.headline}</p>
          {w.suggestions.length > 0 && (
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-muted">
              {w.suggestions.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          )}
          <details className="mt-1 text-xs text-muted">
            <summary className="cursor-pointer">Forecast details</summary>
            <ul className="mt-1 space-y-1">
              {w.observations.map((o, i) => (
                <li key={i}>
                  <strong className="text-ink">{o.place}</strong>: {o.summary ?? o.kind}
                  {o.highC != null && ` · high ${o.highC}°C`}
                  {o.lowC != null && ` · low ${o.lowC}°C`}
                  {o.precipChancePct != null && ` · ${o.precipChancePct}% precip.`}
                  {o.alerts.map((a) => (
                    <span key={a.title} className="ml-1 font-medium text-danger">
                      {a.title} ({a.issuedBy})
                    </span>
                  ))}
                  {o.source?.url && (
                    <a className="ml-1 underline" href={o.source.url} target="_blank" rel="noreferrer">
                      source
                    </a>
                  )}
                </li>
              ))}
            </ul>
          </details>
        </div>
      )}

      {day.narrative && <p className="mt-3 text-sm">{day.narrative}</p>}

      <ol className="mt-4 space-y-3 border-l border-line pl-4">
        {day.stops.map((s) => {
          const stopIssues = issues.filter((i) => i.stopId === s.id);
          return (
            <li key={s.id} className="relative">
              <span className={clsx('absolute top-1.5 -left-[21px] h-2.5 w-2.5 rounded-full', s.kind === 'overnight' ? 'bg-ink' : 'bg-road')} />
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="num text-sm font-medium text-muted">{s.arrivalTime}</span>
                <span className="font-medium">{s.name}</span>
                {s.kind === 'overnight' ? <Moon className="h-3.5 w-3.5 text-muted" /> : <span className="text-xs text-muted">{s.visitMinutes} min</span>}
                {s.rating != null && (
                  <span className="num text-xs text-muted">
                    ★ {s.rating.toFixed(1)} ({s.ratingCount?.toLocaleString('en-CA')})
                  </span>
                )}
                {(s.detourMinutes ?? 0) > 10 && <span className="text-xs text-muted">+{s.detourMinutes} min detour</span>}
              </div>
              {s.description && <p className="text-xs text-muted">{s.description}</p>}
              <div className="mt-0.5 flex gap-3 text-xs">
                {s.mapsUrl && (
                  <a href={s.mapsUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-road underline">
                    <MapPin className="h-3 w-3" /> Google Maps
                  </a>
                )}
                {s.kind !== 'overnight' && <ReportButton tripId={tripId} itemType="stop" itemId={s.id} label={s.name} />}
              </div>
              {stopIssues.map((i) => (
                <p key={i.code} className="mt-1 flex items-center gap-1 text-xs text-amber">
                  <IssueIcon severity={i.severity} /> {i.message}
                </p>
              ))}
            </li>
          );
        })}
        {day.stops.length === 0 && <li className="text-sm text-muted">No stops planned. Free time.</li>}
      </ol>
    </Card>
  );
}

export function PlanView({ plan, tripId }: { plan: TripPlan; tripId?: string }) {
  const [routeId, setRouteId] = useState(plan.selectedRouteId);
  const route = plan.routes.find((r) => r.id === routeId) ?? plan.routes[0];
  const tripIssues = useMemo(() => plan.issues.filter((i) => !i.stopId), [plan.issues]);

  return (
    <div className="space-y-6">
      {plan.usedSampleData && (
        <div className="rounded-xl border border-amber/30 bg-amber-soft px-4 py-3 text-sm text-amber">
          <strong>Sample data:</strong> some providers are not configured, so routes or stops are placeholders. Weather and advisories are live.
        </div>
      )}

      {tripIssues.length > 0 && (
        <Card>
          <h2 className="mb-2 font-semibold">Before you go</h2>
          <ul className="space-y-2 text-sm">
            {tripIssues.map((i, k) => (
              <li key={k} className="flex gap-2">
                <IssueIcon severity={i.severity} /> <span>{i.message}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <RouteCards routes={plan.routes} selected={route.id} onSelect={setRouteId} recommended={plan.selectedRouteId} />
      {route.id !== plan.selectedRouteId && (
        <p className="text-sm text-muted">The day-by-day plan below follows the {plan.routes.find((r) => r.id === plan.selectedRouteId)?.label.toLowerCase()} route. Edit the trip to switch.</p>
      )}

      <div className="grid gap-6 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <CostTable route={route} tripId={tripId} />
        </div>
        <div className="lg:col-span-2">
          <RouteMap polyline={plan.routes.find((r) => r.id === plan.selectedRouteId)?.polyline} days={plan.days} />
        </div>
      </div>

      <div className="space-y-4">
        <h2 className="text-lg font-semibold">Day by day</h2>
        {plan.days.map((d) => (
          <DayCard key={d.day} day={d} issues={plan.issues.filter((i) => i.day === d.day)} tripId={tripId} />
        ))}
      </div>

      {(plan.advisories.length > 0 || plan.roadEvents.length > 0) && (
        <Card>
          <h2 className="mb-2 font-semibold">Official notices</h2>
          <ul className="space-y-2 text-sm">
            {plan.advisories.map((a) => (
              <li key={a.countryCode}>
                <strong>{a.country}:</strong> {a.text}{' '}
                <a className="text-road underline" href={a.url} target="_blank" rel="noreferrer">
                  {a.issuedBy}, updated {a.updatedAt.slice(0, 10)}
                </a>
              </li>
            ))}
            {plan.roadEvents.map((e) => (
              <li key={e.id}>
                <strong>{e.road}</strong> ({e.type}
                {e.fullClosure ? ', full closure' : ''}): {e.description}{' '}
                <a className="text-road underline" href={e.source.url} target="_blank" rel="noreferrer">
                  {e.source.name}
                </a>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted">No notice does not mean no risk. Confirm conditions with the issuing authority before you leave.</p>
        </Card>
      )}

      <details className="text-xs text-muted">
        <summary className="cursor-pointer">About this plan</summary>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>Generated {new Date(plan.generatedAt).toLocaleString('en-CA')}. Refresh 72 and 24 hours before departure for current forecasts and closures.</li>
          {plan.providerNotes.map((n) => (
            <li key={n}>{n}</li>
          ))}
          <li>Estimated data cost for this plan: US${plan.apiCostUsd.toFixed(3)}.</li>
          <li>Planning information only. Prices and conditions change; confirm with operators. Never use the app while driving.</li>
        </ul>
      </details>
    </div>
  );
}
