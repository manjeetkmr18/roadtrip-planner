import type { Confidence, Currency } from '@rtp/core';

export function money(n: number | null | undefined, currency: Currency = 'CAD', digits = 0): string {
  if (n == null) return '—';
  return new Intl.NumberFormat('en-CA', { style: 'currency', currency, maximumFractionDigits: digits, minimumFractionDigits: digits }).format(n);
}

export function km(meters: number): string {
  return `${Math.round(meters / 1000).toLocaleString('en-CA')} km`;
}

export function hours(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h ? `${h} h ${String(m).padStart(2, '0')} min` : `${m} min`;
}

export function dateLabel(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export const CONFIDENCE_LABEL: Record<Confidence, string> = {
  verified: 'Verified',
  provider_estimate: 'Provider estimate',
  approximate: 'Approximate',
  unknown: 'Unknown',
};
