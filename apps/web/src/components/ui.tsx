'use client';

import clsx from 'clsx';
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';

export function Button({ variant = 'primary', className, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger' }) {
  return (
    <button
      {...props}
      className={clsx(
        'inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50',
        variant === 'primary' && 'bg-road text-white hover:bg-road/90',
        variant === 'secondary' && 'border border-line bg-white text-ink hover:bg-paper',
        variant === 'ghost' && 'text-muted hover:bg-white hover:text-ink',
        variant === 'danger' && 'border border-danger/30 bg-white text-danger hover:bg-danger-soft',
        className,
      )}
    />
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={clsx('rounded-xl border border-line bg-white p-5', className)}>{children}</section>;
}

export function Field({ label, hint, children, className }: { label: string; hint?: string; children: ReactNode; className?: string }) {
  return (
    <label className={clsx('block text-sm', className)}>
      <span className="mb-1 block font-medium text-ink">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  );
}

const inputClass = 'w-full rounded-lg border border-line bg-white px-3 py-2 text-sm outline-none focus:border-road focus:ring-2 focus:ring-road/15';

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={clsx(inputClass, props.className)} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={clsx(inputClass, props.className)} />;
}

export function Badge({ tone = 'neutral', children }: { tone?: 'neutral' | 'good' | 'warn' | 'bad' | 'info'; children: ReactNode }) {
  return (
    <span
      className={clsx(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        tone === 'neutral' && 'bg-paper text-muted',
        tone === 'good' && 'bg-road-soft text-road',
        tone === 'warn' && 'bg-amber-soft text-amber',
        tone === 'bad' && 'bg-danger-soft text-danger',
        tone === 'info' && 'bg-sky-50 text-sky-800',
      )}
    >
      {children}
    </span>
  );
}

export function Spinner() {
  return <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-road/30 border-t-road" aria-hidden />;
}
