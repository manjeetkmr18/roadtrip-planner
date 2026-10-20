import { Controller, Get, Inject } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DB, type Db } from '../db/db.module.js';
import { ENV, type Env } from '../config/env.js';
import { ApiEndpoint } from '../common/api-docs.decorator.js';

@Controller('health')
export class HealthController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Which integrations are live, so setup problems are visible at a glance. */
  @Get()
  @ApiEndpoint({ tag: 'Health', summary: 'Check API and database health without provider calls' })
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
