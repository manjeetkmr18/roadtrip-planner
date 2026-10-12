'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { authApi, setToken, ApiError } from '@/lib/api';
import { Button, Card, Field, Input } from './ui';
import { Shell } from './shell';

export function AuthForm({ mode }: { mode: 'login' | 'register' }) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = mode === 'login' ? await authApi.login(email, password) : await authApi.register(email, password, name || undefined);
      setToken(res.token);
      router.push('/trips');
    } catch (err) {
      setError(err instanceof ApiError ? (err.issues?.map((i) => `${i.path}: ${i.message}`).join('; ') || err.message) : 'Could not reach the server');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell>
      <div className="mx-auto max-w-sm">
        <h1 className="mb-6 text-2xl font-semibold">{mode === 'login' ? 'Sign in' : 'Create your account'}</h1>
        <Card>
          <form onSubmit={submit} className="space-y-4">
            {mode === 'register' && (
              <Field label="Name (optional)">
                <Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
              </Field>
            )}
            <Field label="Email">
              <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
            </Field>
            <Field label="Password" hint={mode === 'register' ? 'At least 8 characters' : undefined}>
              <Input type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
            </Field>
            {error && <p className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>}
            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}
            </Button>
          </form>
        </Card>
        <p className="mt-4 text-center text-sm text-muted">
          {mode === 'login' ? (
            <>
              New here? <Link className="text-road underline" href="/register">Create an account</Link>
            </>
          ) : (
            <>
              Already have an account? <Link className="text-road underline" href="/login">Sign in</Link>
            </>
          )}
        </p>
      </div>
    </Shell>
  );
}
