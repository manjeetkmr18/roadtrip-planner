import Link from 'next/link';
import { Route, Receipt, CloudSun, ShieldCheck } from 'lucide-react';

const points = [
  { icon: Receipt, title: 'The real trip cost', body: 'Tolls by segment, the 407 ETR plate billing, fuel or charging and parking, as a low / typical / high range with sources.' },
  { icon: Route, title: 'A plan you can actually drive', body: 'Even driving days within your limit, stops checked against opening hours, rest breaks and arrival times.' },
  { icon: CloudSun, title: 'Weather, day by day', body: 'Forecast review for every driving day from Environment Canada and the US National Weather Service, with suggestions.' },
  { icon: ShieldCheck, title: 'Honest about gaps', body: '“Toll present, price unknown” is shown as such. Nothing is guessed, and nothing is called “safe”.' },
];

export default function Home() {
  return (
    <div className="min-h-screen">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-4 py-5">
        <span className="flex items-center gap-2 font-semibold">
          <Route className="h-5 w-5 text-road" aria-hidden /> Road Trip Planner
        </span>
        <Link href="/login" className="rounded-lg px-3 py-2 text-sm text-muted hover:bg-white hover:text-ink">
          Sign in
        </Link>
      </header>
      <main className="mx-auto max-w-6xl px-4 pb-20">
        <section className="py-14 md:py-20">
          <p className="mb-3 text-sm font-medium text-road">Canada and cross-border road trips</p>
          <h1 className="max-w-3xl text-4xl font-semibold tracking-tight md:text-5xl">Know the real cost and a doable plan before you go.</h1>
          <p className="mt-5 max-w-2xl text-lg text-muted">
            Enter where you’re going and what you drive. Get a day-by-day plan with every toll, fuel and parking cost itemised, weather reviewed for each
            driving day, and stops that fit your hours.
          </p>
          <div className="mt-8 flex gap-3">
            <Link href="/register" className="rounded-lg bg-road px-5 py-3 font-medium text-white hover:bg-road/90">
              Plan a trip
            </Link>
            <Link href="/login" className="rounded-lg border border-line bg-white px-5 py-3 font-medium hover:bg-paper">
              I have an account
            </Link>
          </div>
        </section>
        <section className="grid gap-4 md:grid-cols-2">
          {points.map(({ icon: Icon, title, body }) => (
            <div key={title} className="rounded-xl border border-line bg-white p-5">
              <Icon className="mb-3 h-5 w-5 text-road" aria-hidden />
              <h2 className="font-semibold">{title}</h2>
              <p className="mt-1 text-sm text-muted">{body}</p>
            </div>
          ))}
        </section>
        <p className="mt-10 text-xs text-muted">Planning only: no bookings. Estimates can be incomplete; confirm tolls, hours and road conditions with the operators.</p>
      </main>
    </div>
  );
}
