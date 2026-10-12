'use client';

import type { TripPlan, TripRequest, TripRequestInput } from '@rtp/core';

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api';
const TOKEN_KEY = 'rtp_token';

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}
export function setToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable */
  }
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly issues?: { path: string; message: string }[],
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit & { auth?: boolean } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set('content-type', 'application/json');
  const token = getToken();
  if (token && init.auth !== false) headers.set('authorization', `Bearer ${token}`);
  const res = await fetch(`${API_URL}${path}`, { ...init, headers });
  const text = await res.text();
  const body = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    const msg = body?.message;
    const message = typeof msg === 'string' ? msg : (msg?.message ?? `Request failed (${res.status})`);
    if (res.status === 401) setToken(null);
    throw new ApiError(message, res.status, msg?.issues ?? body?.issues);
  }
  return body as T;
}

export type TripStatus = 'draft' | 'queued' | 'generating' | 'ready' | 'failed';

export interface TripRecord {
  id: string;
  title: string;
  status: TripStatus;
  request: TripRequest;
  plan: TripPlan | null;
  error: string | null;
  shareToken: string | null;
  updatedAt: string;
}

export interface TripListItem {
  id: string;
  title: string;
  status: TripStatus;
  startDate: string;
  endDate: string;
  updatedAt: string;
}

export const tripsApi = {
  list: () => api<TripListItem[]>('/trips'),
  usage: () => api<{ plan: string; usedThisMonth: number; limit: number | null }>('/trips/usage'),
  get: (id: string) => api<TripRecord>(`/trips/${id}`),
  create: (req: TripRequestInput) => api<TripRecord>('/trips', { method: 'POST', body: JSON.stringify(req) }),
  update: (id: string, req: TripRequestInput) => api<TripRecord>(`/trips/${id}`, { method: 'PUT', body: JSON.stringify(req) }),
  remove: (id: string) => api<{ deleted: boolean }>(`/trips/${id}`, { method: 'DELETE' }),
  generate: (id: string) => api<TripRecord>(`/trips/${id}/generate`, { method: 'POST' }),
  share: (id: string) => api<{ shareToken: string }>(`/trips/${id}/share`, { method: 'POST' }),
  shared: (token: string) => api<{ id: string; title: string; plan: TripPlan; updatedAt: string }>(`/share/${token}`, { auth: false }),
  feedback: (body: { tripId?: string; itemType: string; itemId?: string; message: string }) =>
    api<{ received: boolean }>('/feedback', { method: 'POST', body: JSON.stringify(body) }),
};

export const authApi = {
  login: (email: string, password: string) =>
    api<{ token: string; user: { email: string } }>('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }), auth: false }),
  register: (email: string, password: string, name?: string) =>
    api<{ token: string; user: { email: string } }>('/auth/register', { method: 'POST', body: JSON.stringify({ email, password, name }), auth: false }),
  me: () => api<{ id: string; email: string; plan: string }>('/auth/me'),
};
