import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../db/db.module.js';
import { FeedbackController } from './feedback.controller.js';

const user = { id: 'user-id', email: 'user@example.com', plan: 'free' };
const feedbackBody = {
  tripId: '35bf4fd2-65ef-4fc7-91a5-cb9cb0c72ef6',
  itemType: 'stop' as const,
  message: 'This stop is permanently closed.',
};

describe('FeedbackController', () => {
  it('rejects feedback for a trip the user does not own', async () => {
    const findFirst = vi.fn().mockResolvedValue(undefined);
    const insert = vi.fn();
    const db = { query: { trips: { findFirst } }, insert } as unknown as Db;
    const controller = new FeedbackController(db);

    await expect(controller.create(user, feedbackBody)).rejects.toBeInstanceOf(NotFoundException);
    expect(findFirst).toHaveBeenCalledOnce();
    expect(insert).not.toHaveBeenCalled();
  });

  it('accepts feedback for an owned trip', async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: feedbackBody.tripId });
    const returning = vi.fn().mockResolvedValue([{ id: 'feedback-id' }]);
    const values = vi.fn(() => ({ returning }));
    const insert = vi.fn(() => ({ values }));
    const db = { query: { trips: { findFirst } }, insert } as unknown as Db;
    const controller = new FeedbackController(db);

    await expect(controller.create(user, feedbackBody)).resolves.toEqual({ id: 'feedback-id', received: true });
    expect(findFirst).toHaveBeenCalledOnce();
    expect(insert).toHaveBeenCalledOnce();
  });
});
