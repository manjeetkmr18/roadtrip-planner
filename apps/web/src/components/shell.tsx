'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { Route } from 'lucide-react';
import { getToken, setToken } from '@/lib/api';

/** Page frame. With `requireAuth`, sends signed-out visitors to /login. */
export function Shell({ children, requireAuth = false }: { children: ReactNode; requireAuth?: boolean }) {
  const router = useRouter();
  const [signedIn, setSignedIn] = useState<boolean | null>(null);

  useEffect(() => {
    const has = !!getToken();
    setSignedIn(has);
    if (requireAuth && !has) router.replace('/login');
  }, [requireAuth, router]);

  return (
    <div className="min-h-screen">
      <header className="border-b border-line bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <Link href="/" className="flex items-center gap-2 font-semibold text-ink">
            <Route className="h-5 w-5 text-road" aria-hidden />
            <span className="hidden sm:inline">Road Trip Planner</span>
          </Link>
          <nav className="flex items-center gap-1 text-sm whitespace-nowrap">
            {signedIn ? (
              <>
                <Link className="rounded-lg px-3 py-2 text-muted hover:bg-paper hover:text-ink" href="/trips">
                  My trips
                </Link>
                <Link className="rounded-lg bg-road px-3 py-2 font-medium text-white hover:bg-road/90" href="/trips/new">
                  New trip
                </Link>
                <button
                  className="rounded-lg px-3 py-2 text-muted hover:bg-paper hover:text-ink"
                  onClick={() => {
                    setToken(null);
                    router.push('/login');
                  }}
                >
                  Sign out
                </button>
              </>
            ) : signedIn === false ? (
              <Link className="rounded-lg px-3 py-2 text-muted hover:bg-paper hover:text-ink" href="/login">
                Sign in
              </Link>
            ) : null}
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8">{requireAuth && !signedIn ? null : children}</main>
    </div>
  );
}
