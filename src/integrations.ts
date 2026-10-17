import { Controller, Get, Inject, NotFoundException, Req, Res, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { addDays, encodePolyline } from './core/index.js';
import { DB, type Db } from './db/db.module.js';
import { ENV, type Env } from './config/env.js';
import { basicAuthOk } from './docs.js';
import { airportByIata } from './providers/airports.js';
import { fetchJson, ProviderContext } from './providers/infra.js';
import { Providers } from './providers/providers.module.js';

export type CheckStatus = 'ok' | 'fail' | 'off';
export interface CheckResult {
  name: string;
  status: CheckStatus;
  ms: number;
  detail: string;
}

const TABLES = ['users', 'trips', 'generations', 'trip_stops', 'feedback'];
const TORONTO = { lat: 43.6532, lng: -79.3832 };
const today = () => new Date().toISOString().slice(0, 10);

class Off extends Error {}
const off = (why: string) => {
  throw new Off(why);
};

async function run(name: string, fn: () => Promise<string>, timeoutMs = 25_000): Promise<CheckResult> {
  const t0 = Date.now();
  try {
    const detail = await Promise.race([fn(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`timed out after ${timeoutMs / 1000} s`)), timeoutMs))]);
    return { name, status: 'ok', ms: Date.now() - t0, detail };
  } catch (e) {
    const err = e as Error;
    return { name, status: e instanceof Off ? 'off' : 'fail', ms: Date.now() - t0, detail: err.message.slice(0, 300) };
  }
}

/**
 * Live check of every outside service the planner depends on. Each check makes one small real call,
 * so it costs a few cents of Google/Bedrock usage; it's protected with the docs username and password
 * (and is off when those aren't set).
 */
@Controller('health')
export class IntegrationsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ENV) private readonly env: Env,
    private readonly p: Providers,
  ) {}

  @Get('integrations')
  async integrations(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { DOCS_USERNAME: u, DOCS_PASSWORD: pw } = this.env;
    if (!u || !pw) throw new NotFoundException();
    if (!basicAuthOk(req.headers.authorization, u, pw)) {
      res.setHeader('WWW-Authenticate', 'Basic realm="Travlio API docs", charset="UTF-8"');
      throw new UnauthorizedException('Use the API docs username and password');
    }
    res.setHeader('Cache-Control', 'no-store');
    const results = await this.checkAll();
    return {
      ok: results.every((r) => r.status !== 'fail'),
      checkedAt: new Date().toISOString(),
      summary: { ok: results.filter((r) => r.status === 'ok').length, fail: results.filter((r) => r.status === 'fail').length, off: results.filter((r) => r.status === 'off').length },
      results,
    };
  }

  checkAll(): Promise<CheckResult[]> {
    const { p, env } = this;
    const live = env.PROVIDER_MODE !== 'sample';
    const ctx = () => new ProviderContext();
    const key = (v: string | undefined, name: string) => (live && v ? v : off(`${name} not set${live ? '' : ' (PROVIDER_MODE=sample)'}`));
    const tomorrow = addDays(today(), 1);

    return Promise.all([
      run('Database + tables', async () => {
        await this.db.execute(sql`select 1`);
        const rows = await this.db.execute<{ t: string; reg: string | null }>(
          sql`select t, to_regclass('public.' || t)::text as reg from unnest(${sql.raw(`array[${TABLES.map((t) => `'${t}'`).join(',')}]`)}) as t`,
        );
        const missing = (rows.rows ?? (rows as unknown as { t: string; reg: string | null }[])).filter((r) => !r.reg).map((r) => r.t);
        if (missing.length) throw new Error(`Tables missing: ${missing.join(', ')}. Run "npm run db:migrate" against this database.`);
        return `connected; ${TABLES.length} tables present`;
      }),
      run('Queue', async () => {
        if (env.QUEUE_INLINE) return 'inline (plans run inside the API)';
        const where = env.REDIS_URL.replace(/\/\/.*@/, '//***@');
        const redis = new Redis(env.REDIS_URL, { lazyConnect: true, connectTimeout: 3000, maxRetriesPerRequest: 0, retryStrategy: () => null });
        try {
          await redis.connect();
          await redis.ping();
          return `BullMQ, Redis reachable at ${where}`;
        } catch (e) {
          throw new Error(`Redis at ${where} not reachable (${(e as Error).message}); trips would never start planning`);
        } finally {
          redis.disconnect();
        }
      }),
      run('Google Geocoding', async () => {
        key(env.GOOGLE_MAPS_API_KEY, 'GOOGLE_MAPS_API_KEY');
        const r = await p.geocoding.resolve({ address: 'Toronto, ON' }, ctx());
        return `Toronto → ${r.label} (${r.location.lat.toFixed(3)}, ${r.location.lng.toFixed(3)})`;
      }),
      run('Google Routes', async () => {
        key(env.GOOGLE_MAPS_API_KEY, 'GOOGLE_MAPS_API_KEY');
        const [r] = await p.routes.compute({ origin: TORONTO, destination: { lat: 43.2557, lng: -79.8711 }, waypoints: [], departureIso: `${tomorrow}T09:00:00-04:00`, alternatives: false }, ctx());
        if (!r) throw new Error('No route returned for Toronto → Hamilton');
        return `Toronto → Hamilton ${(r.distanceMeters / 1000).toFixed(0)} km, ${Math.round(r.durationSeconds / 60)} min`;
      }),
      run('Google Places', async () => {
        key(env.GOOGLE_MAPS_API_KEY, 'GOOGLE_MAPS_API_KEY');
        const found = await p.places.near('museum', TORONTO, 5000, 5, ctx());
        if (!found.length) throw new Error('No places returned for "museum" near Toronto');
        return `${found.length} museums near Toronto, e.g. ${found[0].name}`;
      }),
      run('Google Places Autocomplete', async () => {
        key(env.GOOGLE_MAPS_API_KEY, 'GOOGLE_MAPS_API_KEY');
        const s = await p.placeSearch.suggest('Banff', { near: TORONTO });
        if (!s.length || !s[0].placeId) throw new Error('No suggestions for "Banff"');
        const d = await p.placeSearch.details(s[0].placeId);
        return `"Banff" → ${s[0].address} (${d.location.lat.toFixed(3)}, ${d.location.lng.toFixed(3)})`;
      }),
      run('AI (Amazon Bedrock)', async () => {
        if (!p.llm.enabled) off('AWS_REGION and BEDROCK_MODEL_ID not set');
        const text = await p.llm.complete({ system: 'Reply with the single word OK.', prompt: 'Health check', maxTokens: 10, fast: true }, ctx());
        return `model ${env.BEDROCK_FAST_MODEL_ID || env.BEDROCK_MODEL_ID} replied "${text.trim().slice(0, 20)}"`;
      }),
      run('Weather: Environment Canada', async () => {
        const o = await p.weather.observe(TORONTO, tomorrow, 'Toronto');
        if (!o.source?.name.includes('Environment')) throw new Error(`Got ${o.source?.name ?? o.kind} instead (${o.summary ?? ''})`);
        return `Toronto tomorrow: ${o.summary}, ${o.highC}°/${o.lowC}°`;
      }),
      run('Weather: US National Weather Service', async () => {
        const o = await p.weather.observe({ lat: 42.8864, lng: -78.8784 }, tomorrow, 'Buffalo');
        if (!o.source?.name.includes('National Weather Service')) throw new Error(`Got ${o.source?.name ?? o.kind} instead (${o.summary ?? ''}). Check NWS_USER_AGENT.`);
        return `Buffalo tomorrow: ${o.summary}, ${o.highC}°/${o.lowC}°`;
      }),
      run('Weather: MET Norway (worldwide)', async () => {
        const o = await p.weather.observe({ lat: 48.857, lng: 2.352 }, tomorrow, 'Paris');
        if (!o.source?.name.includes('MET Norway')) throw new Error(`Got ${o.source?.name ?? o.kind} instead (${o.summary ?? ''}). MET Norway needs NWS_USER_AGENT with a contact email.`);
        return `Paris tomorrow: ${o.summary}, ${o.highC}°/${o.lowC}°`;
      }),
      run('Weather: NASA POWER (typical weather)', async () => {
        const o = await p.weather.observe({ lat: 48.857, lng: 2.352 }, addDays(today(), 45), 'Paris');
        if (o.kind !== 'climate') throw new Error(`Got ${o.kind} instead (${o.summary ?? ''})`);
        return `Paris in 45 days: ${o.summary}`;
      }),
      run('Fuel prices: Canada (OilPriceAPI)', async () => {
        key(env.OILPRICEAPI_KEY, 'OILPRICEAPI_KEY');
        const r = await p.fuel.range('CA', 'ON', 'gasoline', ctx());
        if (/default/i.test(r.note ?? '')) throw new Error('Key is set but the price fell back to the planning default');
        return `Ontario gasoline ${r.typical.toFixed(2)} ${r.currency}/L (${r.source?.name ?? 'live'})`;
      }),
      run('Fuel prices: US (EIA)', async () => {
        key(env.EIA_API_KEY, 'EIA_API_KEY');
        const r = await p.fuel.range('US', 'NY', 'gasoline', ctx());
        if (/default/i.test(r.note ?? '')) throw new Error('Key is set but the price fell back to the planning default');
        return `US gasoline ${r.typical.toFixed(2)} ${r.currency}/L (${r.source?.name ?? 'live'})`;
      }),
      run('Road notices: Ontario 511', async () => {
        key(env.ONTARIO_511_API_KEY, 'ONTARIO_511_API_KEY');
        const events = await p.roads.eventsNearRoute(encodePolyline([TORONTO, { lat: 45.4215, lng: -75.6972 }]), ctx(), 50_000);
        return `feed reachable; ${events.length} major event(s) near Toronto → Ottawa`;
      }),
      run('Travel advisories (Global Affairs Canada)', async () => {
        const a = await p.advisories.forCountries(['US', 'FR']);
        if (a.length < 2) throw new Error(`Expected advisories for US and France, got ${a.length}`);
        return a.map((x) => `${x.country}: level ${x.level}`).join(' · ');
      }),
      run('Flights (Duffel)', async () => {
        key(env.DUFFEL_ACCESS_TOKEN, 'DUFFEL_ACCESS_TOKEN');
        const offers = await p.flights.search(airportByIata('YYZ')!, airportByIata('YUL')!, addDays(today(), 21), 1, ctx());
        if (!offers.length) throw new Error('No offers for YYZ → YUL in 3 weeks');
        return `${offers.length} offers YYZ → YUL${p.flights.live ? '' : ' (test mode token)'}, from ${Math.min(...offers.map((o) => o.price ?? Infinity))} ${offers[0].currency}`;
      }),
      run('Exchange rate (Bank of Canada)', async () => {
        const r = await fetchJson<{ observations: { d: string; FXUSDCAD: { v: string } }[] }>('Bank of Canada', 'https://www.bankofcanada.ca/valet/observations/FXUSDCAD/json?recent=1', { timeoutMs: 8_000 });
        const o = r.observations.at(-1)!;
        return `1 USD = ${o.FXUSDCAD.v} CAD (${o.d})`;
      }),
    ]);
  }
}
