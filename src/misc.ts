import { BadGatewayException, BadRequestException, Body, Controller, Get, Inject, Logger, Module, Post, Query, UseGuards } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { DB, type Db } from './db/db.module.js';
import { feedback } from './db/schema.js';
import { AuthModule, CurrentUser, JwtGuard, type AuthUser } from './auth/auth.js';
import { ZodPipe } from './common/zod.pipe.js';
import { ENV, type Env } from './config/env.js';
import { IntegrationsController } from './integrations.js';
import { Providers } from './providers/providers.module.js';
import { SESSION_TOKEN } from './providers/place-search.js';

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

const Suggest = z.object({
  q: z.string().trim().min(1).max(120),
  session: z.string().regex(SESSION_TOKEN).optional(),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
});
const Details = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{10,300}$/, 'Not a place ID'),
  session: z.string().regex(SESSION_TOKEN).optional(),
});

/** Type-ahead for the trip form's place fields. Signed-in only, so the Google key can't be farmed. */
@Controller('places')
@UseGuards(JwtGuard)
export class PlacesController {
  private readonly log = new Logger(PlacesController.name);
  constructor(private readonly p: Providers) {}

  @Get('autocomplete')
  async autocomplete(@Query(new ZodPipe(Suggest)) q: z.infer<typeof Suggest>) {
    const near = q.lat !== undefined && q.lng !== undefined ? { lat: q.lat, lng: q.lng } : undefined;
    try {
      return { live: this.p.placeSearch.live, suggestions: await this.p.placeSearch.suggest(q.q, { session: q.session, near }) };
    } catch (e) {
      // Typing still works without suggestions, so this is a warning, not an outage.
      this.log.warn(`autocomplete failed: ${(e as Error).message.slice(0, 300)}`);
      throw new BadGatewayException((e as Error).message.slice(0, 300));
    }
  }

  @Get('details')
  async details(@Query(new ZodPipe(Details)) q: z.infer<typeof Details>) {
    if (!this.p.placeSearch.live) throw new BadRequestException('Place details need a Google key');
    try {
      return await this.p.placeSearch.details(q.id, q.session);
    } catch (e) {
      this.log.warn(`place details failed: ${(e as Error).message.slice(0, 300)}`);
      throw new BadGatewayException((e as Error).message.slice(0, 300));
    }
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

@Module({ imports: [AuthModule], controllers: [FeedbackController, HealthController, IntegrationsController, PlacesController] })
export class MiscModule {}
