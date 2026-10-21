import { describe, expect, it } from 'vitest';
import type { TripPlan } from '../core/index.js';
import { publicPlan } from './trips.service.js';

describe('shared trip view', () => {
  it('leaves out the owner\'s private notes, provider notes and API spend', () => {
    const plan = {
      generatedAt: '2026-10-20T00:00:00Z',
      request: { title: 'Fall drive', preferences: { pace: 'balanced', personalInstructions: 'I use a wheelchair; budget is tight' } },
      selectedRouteId: 'r1',
      routes: [],
      days: [],
      issues: [],
      roadEvents: [],
      advisories: [],
      usedSampleData: false,
      providerNotes: ['Google Places quota at 80%'],
      apiCostUsd: 0.42,
    } as unknown as TripPlan;

    const shared = publicPlan(plan);

    expect(shared.request.preferences.personalInstructions).toBe('');
    expect(shared.request.preferences.pace).toBe('balanced');
    expect(shared.request.title).toBe('Fall drive');
    expect(shared.providerNotes).toEqual([]);
    expect(shared.apiCostUsd).toBe(0);
    // The stored plan is not changed.
    expect(plan.request.preferences.personalInstructions).toContain('wheelchair');
  });
});
