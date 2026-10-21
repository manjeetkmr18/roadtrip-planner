import { describe, expect, it, vi } from 'vitest';
import { TripNoteInput, TripNoteUpdate } from '../core/index.js';
import { chooseStops, type DayChoiceInput } from '../planning/stops.js';
import { ProviderContext } from '../providers/infra.js';
import { planDigest } from './assistant.js';
import { sortNotes, tripLength } from './notes.service.js';

describe('trip notes', () => {
  it('validates input: text required, day 1-14, HH:MM time, defaults', () => {
    expect(TripNoteInput.parse({ text: '  Lunch with Priya  ' })).toEqual({ text: 'Lunch with Priya', day: null, time: null, place: null, includeInPlan: true });
    expect(TripNoteInput.safeParse({ text: '' }).success).toBe(false);
    expect(TripNoteInput.safeParse({ text: 'x', day: 0 }).success).toBe(false);
    expect(TripNoteInput.safeParse({ text: 'x', day: 15 }).success).toBe(false);
    expect(TripNoteInput.safeParse({ text: 'x', time: '25:00' }).success).toBe(false);
    expect(TripNoteInput.safeParse({ text: 'x'.repeat(501) }).success).toBe(false);
    expect(TripNoteInput.parse({ text: 'x', day: 2, time: '13:00', place: { address: 'Kingston, ON' } })).toMatchObject({ day: 2, time: '13:00', place: { address: 'Kingston, ON' } });
    expect(TripNoteUpdate.parse({ includeInPlan: false })).toEqual({ includeInPlan: false });
  });

  it('sorts whole-trip notes first, then by day and time', () => {
    const at = (s: string) => new Date(`2026-10-20T${s}Z`);
    const sorted = sortNotes([
      { day: 2, time: '13:00', createdAt: at('10:00:00'), id: 'c' },
      { day: 2, time: null, createdAt: at('10:00:01'), id: 'b' },
      { day: null, time: null, createdAt: at('10:00:02'), id: 'a' },
      { day: 1, time: '09:00', createdAt: at('10:00:03'), id: 'x' },
    ]);
    expect(sorted.map((n) => n.id)).toEqual(['a', 'x', 'b', 'c']);
  });

  it('counts trip days inclusively', () => {
    expect(tripLength({ startDate: '2026-10-27', endDate: '2026-11-03' })).toBe(8);
    expect(tripLength({ startDate: '2026-10-27', endDate: '2026-10-27' })).toBe(1);
  });

  it('sends day and trip notes to the stop-choosing model', async () => {
    const completeJson = vi.fn(async () => ({ days: [{ day: 1, stopIds: [], narrative: 'Before your lunch in Kingston, a short drive.' }] }));
    const day: DayChoiceInput = {
      day: 1, date: '2026-11-07', from: 'Toronto, ON', to: 'Kingston, ON', drivingHours: 2.6, budget: 2, candidates: [],
      travellerNotes: [{ text: 'Lunch with Priya', time: '13:00', place: 'Kingston, ON' }],
    };
    const result = await chooseStops([day], {
      interests: ['food'], pace: 'balanced', provider: new ProviderContext(),
      llm: { enabled: true, complete: vi.fn(), completeJson } as never,
      tripNotes: [{ text: 'Vegetarian food only', place: null, time: null }],
    });
    const call = completeJson.mock.calls[0] as unknown as [{ prompt: string; system: string }];
    const payload = JSON.parse(call[0].prompt);
    expect(payload.days[0].travellerNotes).toEqual([{ text: 'Lunch with Priya', time: '13:00', place: 'Kingston, ON' }]);
    expect(payload.tripNotes).toEqual([{ text: 'Vegetarian food only' }]);
    expect(call[0].system).toMatch(/travellerNotes/);
    expect(result.get(1)?.narrative).toContain('lunch');
  });

  it('gives the assistant the traveller notes', () => {
    const plan = { routes: [], days: [], issues: [], roadEvents: [], advisories: [], selectedRouteId: 'r', usedSampleData: false } as never;
    const draft = { origin: { address: 'A' }, destination: { address: 'B' }, startDate: '2026-11-07', endDate: '2026-11-08', travel: { mode: 'drive' }, roundTrip: false, preferences: {} } as never;
    expect(planDigest(plan, draft, [{ day: 2, time: null, place: 'Ottawa', text: 'Parliament tour' }]).yourNotes).toEqual([{ day: 2, time: null, place: 'Ottawa', text: 'Parliament tour' }]);
    expect(planDigest(plan, draft).yourNotes).toBeUndefined();
  });
});
