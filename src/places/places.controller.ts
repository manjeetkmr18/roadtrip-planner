import { BadGatewayException, BadRequestException, Controller, Get, Headers, Header, HttpException, HttpStatus, Logger, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { AuthService } from '../auth/auth.js';
import { clientIp, RateLimiter } from '../common/rate-limit.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { ApiEndpoint } from '../common/api-docs.decorator.js';
import { Providers } from '../providers/providers.module.js';
import { SESSION_TOKEN } from '../providers/place-search.js';

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
const Photo = z.object({
  placeId: z.string().regex(/^[A-Za-z0-9_-]{10,300}$/, 'Not a Google Place ID'),
});

/** Approximate location of the caller from Vercel's IP geolocation headers, if present and sane. */
export function visitorLocation(h: Record<string, string | undefined>) {
  const lat = Number(h['x-vercel-ip-latitude']);
  const lng = Number(h['x-vercel-ip-longitude']);
  if (!h['x-vercel-ip-latitude'] || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return undefined;
  return { lat, lng };
}

/**
 * Type-ahead for the place fields, including the homepage search box (so signed out too).
 * Signed-out callers get a tighter per-IP budget, so the Google key can't be farmed.
 */
@Controller('places')
export class PlacesController {
  private readonly log = new Logger(PlacesController.name);
  private readonly perMinute = new RateLimiter(40, 60_000);
  private readonly perDay = new RateLimiter(400, 24 * 60 * 60 * 1000);

  constructor(
    private readonly p: Providers,
    private readonly auth: AuthService,
  ) {}

  private budget(req: Request) {
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) {
      try {
        this.auth.verify(header.slice(7));
        return;
      } catch {
        // Invalid or expired tokens are treated as signed out.
      }
    }
    const ip = clientIp(req);
    const wait = this.perMinute.hit(ip) || this.perDay.hit(ip);
    if (wait) throw new HttpException({ statusCode: 429, message: 'Too many place searches. Sign in or try again later.' }, HttpStatus.TOO_MANY_REQUESTS);
  }

  @Get('autocomplete')
  @ApiEndpoint({ tag: 'Places', summary: 'Suggest matching places', errors: [400, 429, 502] })
  async autocomplete(@Query(new ZodPipe(Suggest)) q: z.infer<typeof Suggest>, @Headers() h: Record<string, string | undefined>, @Req() req: Request) {
    this.budget(req);
    const near = q.lat !== undefined && q.lng !== undefined ? { lat: q.lat, lng: q.lng } : visitorLocation(h);
    try {
      return { live: this.p.placeSearch.live, suggestions: await this.p.placeSearch.suggest(q.q, { session: q.session, near }) };
    } catch (e) {
      this.log.warn(`autocomplete failed: ${(e as Error).message.slice(0, 300)}`);
      throw new BadGatewayException((e as Error).message.slice(0, 300));
    }
  }

  @Get('details')
  @ApiEndpoint({ tag: 'Places', summary: 'Resolve a place ID to address and coordinates', errors: [400, 429, 502] })
  async details(@Query(new ZodPipe(Details)) q: z.infer<typeof Details>, @Req() req: Request) {
    this.budget(req);
    if (!this.p.placeSearch.live) throw new BadRequestException('Place details need a Google key');
    try {
      return await this.p.placeSearch.details(q.id, q.session);
    } catch (e) {
      this.log.warn(`place details failed: ${(e as Error).message.slice(0, 300)}`);
      throw new BadGatewayException((e as Error).message.slice(0, 300));
    }
  }

  @Get('photo')
  @Header('Cache-Control', 'no-store')
  @ApiEndpoint({ tag: 'Places', summary: 'Get photo metadata for a place', errors: [400, 429, 502] })
  async photo(
    @Query(new ZodPipe(Photo)) query: z.infer<typeof Photo>,
    @Req() req: Request,
  ) {
    this.budget(req);
    if (!this.p.placeSearch.live) throw new BadRequestException('Place photos need GOOGLE_MAPS_API_KEY');
    try {
      return { photo: await this.p.places.photo(query.placeId) };
    } catch (e) {
      this.log.warn(`place photo failed: ${(e as Error).message.slice(0, 300)}`);
      throw new BadGatewayException('Place photo metadata is temporarily unavailable');
    }
  }
}
