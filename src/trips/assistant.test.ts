import { describe, expect, it } from 'vitest';
import { PreferencesInput } from '../core/index.js';
import { readAssistantOutput } from './assistant.js';

const current = PreferencesInput.parse({});

describe('readAssistantOutput', () => {
  it('keeps the reply and drops a proposal that changes nothing', () => {
    const result = readAssistantOutput({ reply: 'Sure!', proposeChanges: true, needsClarification: false, preferences: current }, current);
    expect(result).toEqual({ reply: 'Sure!', needsClarification: false, preferences: null });
  });

  it('accepts a reply without preferences (a plain answer)', () => {
    expect(readAssistantOutput({ reply: 'Day 2 is a free day in Calgary.', proposeChanges: false, needsClarification: false }, current))
      ?.toMatchObject({ reply: 'Day 2 is a free day in Calgary.', preferences: null });
  });

  it('clamps out-of-range values instead of failing', () => {
    const result = readAssistantOutput(
      {
        reply: 'x'.repeat(1500),
        proposeChanges: true,
        needsClarification: false,
        preferences: { ...current, maxDrivingHoursPerDay: 20, maxDetourMinutes: 500, interests: ['Food', 'Food', ' museums '], pace: 'relaxed' },
      },
      current,
    );
    expect(result?.reply).toHaveLength(1000);
    expect(result?.preferences).toMatchObject({ maxDrivingHoursPerDay: 14, maxDetourMinutes: 180, interests: ['Food', 'museums'], pace: 'relaxed' });
  });

  it('ignores a proposal when the assistant is asking a question', () => {
    const result = readAssistantOutput(
      { reply: 'How many hours a day would you like to drive?', proposeChanges: false, needsClarification: true, preferences: { ...current, pace: 'relaxed' } },
      current,
    );
    expect(result).toMatchObject({ needsClarification: true, preferences: null });
  });

  it('rejects output without a reply', () => {
    expect(readAssistantOutput({ preferences: current }, current)).toBeNull();
    expect(readAssistantOutput('nonsense', current)).toBeNull();
  });
});
