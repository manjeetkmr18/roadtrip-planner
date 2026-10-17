import { Body, Controller, Get, Inject, Module, Post, UseGuards } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { DB, type Db } from './db/db.module.js';
import { feedback } from './db/schema.js';
import { AuthModule, CurrentUser, JwtGuard, type AuthUser } from './auth/auth.js';
import { ZodPipe } from './common/zod.pipe.js';
import { ENV, type Env } from './config/env.js';

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
  async create(@CurrentUser() user: AuthUser, @Body(new ZodPipe(Feedback)) body: z.infer<typeof Feedback>) {
    const [row] = await this.db.insert(feedback).values({ ...body, userId: user.id }).returning({ id: feedback.id });
    return { id: row.id, received: true };
  }
}

@Controller('health')
export class HealthController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Which integrations are live, so setup problems are visible at a glance. */
  @Get()
  async health() {
    let db = false;
    try {
      await this.db.execute(sql`select 1`);
      db = true;
    } catch {
      db = false;
    }
    const live = this.env.PROVIDER_MODE !== 'sample';
    return {
      ok: db,
      db,
      queue: this.env.QUEUE_INLINE ? 'inline' : 'bullmq',
      providers: {
        googleMaps: live && !!this.env.GOOGLE_MAPS_API_KEY,
        flights: live && !!this.env.DUFFEL_ACCESS_TOKEN,
        bedrock: live && !!this.env.AWS_REGION && !!this.env.BEDROCK_MODEL_ID,
        ontario511: live && !!this.env.ONTARIO_511_API_KEY,
        fuelPricesCanada: live && !!this.env.OILPRICEAPI_KEY,
        fuelPricesUs: live && !!this.env.EIA_API_KEY,
        weatherCanada: true,
        weatherUs: true,
        travelAdvisories: true,
      },
    };
  }
}

@Module({ imports: [AuthModule], controllers: [FeedbackController, HealthController] })
export class MiscModule {}
