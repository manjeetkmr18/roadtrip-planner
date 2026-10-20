import { HttpException, HttpStatus, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';

/**
 * A small fixed-window rate limit per client IP (default 120 requests a minute), kept in memory.
 * Replaces @nestjs/throttler, which is CommonJS and can't load the ESM-only Nest 12 on Vercel.
 * On serverless each instance counts separately, as the throttler's in-memory store did.
 */
export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit = 120,
    private readonly windowMs = 60_000,
  ) {}

  /** Records a hit; returns seconds to wait when over the limit, else 0. */
  hit(key: string, now = Date.now()): number {
    const h = this.hits.get(key);
    if (!h || h.resetAt <= now) {
      if (this.hits.size > 10_000) this.sweep(now);
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return 0;
    }
    h.count++;
    return h.count > this.limit ? Math.ceil((h.resetAt - now) / 1000) : 0;
  }

  private sweep(now: number) {
    for (const [k, h] of this.hits) if (h.resetAt <= now) this.hits.delete(k);
  }
}

type Req = { ip?: string; headers: Record<string, string | string[] | undefined>; socket?: { remoteAddress?: string } };
type Res = { setHeader: (k: string, v: string) => void };

/**
 * The caller's IP. On Vercel the socket address can be Vercel's own infrastructure rather than the client, so
 * the x-vercel-forwarded-for header is used instead: Vercel sets it and overwrites any value a client sends.
 * Elsewhere, forwarded headers are only honoured through Express's trust proxy (TRUSTED_PROXY_CIDRS).
 */
export function clientIp(req: Req, onVercel = !!process.env.VERCEL): string {
  if (onVercel) {
    const raw = req.headers['x-vercel-forwarded-for'];
    const first = (Array.isArray(raw) ? raw[0] : raw)?.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly limiter = new RateLimiter();

  canActivate(ctx: ExecutionContext): boolean {
    if (ctx.getType() !== 'http') return true;
    const http = ctx.switchToHttp();
    const wait = this.limiter.hit(clientIp(http.getRequest<Req>()));
    if (!wait) return true;
    http.getResponse<Res>().setHeader('Retry-After', String(wait));
    throw new HttpException({ statusCode: 429, message: 'Too many requests. Try again in a minute.' }, HttpStatus.TOO_MANY_REQUESTS);
  }
}
