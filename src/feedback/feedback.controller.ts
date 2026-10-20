import { Body, Controller, Inject, NotFoundException, Post, UseGuards } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { AuthModule, CurrentUser, JwtGuard, type AuthUser } from '../auth/auth.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { ApiEndpoint } from '../common/api-docs.decorator.js';
import { DB, type Db } from '../db/db.module.js';
import { feedback, trips } from '../db/schema.js';

const Feedback = z.object({
  tripId: z.uuid().optional(),
  itemType: z.enum(['cost_line', 'stop', 'weather', 'road_event', 'other']),
  itemId: z.string().max(200).optional(),
  message: z.string().min(3).max(2000),
});

@Controller('feedback')
export class FeedbackController {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** "Report incorrect info" from the cost report, a stop, or a weather card. */
  @Post()
  @UseGuards(JwtGuard)
  @ApiEndpoint({ tag: 'Feedback', summary: 'Submit a report about incorrect trip information', security: 'bearer', response: { status: 201, description: 'Feedback received' }, errors: [400, 401, 404] })
  async create(@CurrentUser() user: AuthUser, @Body(new ZodPipe(Feedback)) body: z.infer<typeof Feedback>) {
    if (body.tripId) {
      const trip = await this.db.query.trips.findFirst({
        where: and(eq(trips.id, body.tripId), eq(trips.userId, user.id)),
        columns: { id: true },
      });
      if (!trip) throw new NotFoundException('Trip not found');
    }
    const [row] = await this.db.insert(feedback).values({ ...body, userId: user.id }).returning({ id: feedback.id });
    return { id: row.id, received: true };
  }
}
