import { isIP } from 'node:net';
import { z } from 'zod';

function validProxyRange(value: string) {
  const [address, prefix, ...extra] = value.split('/');
  const version = isIP(address);
  if (!version || extra.length > 0) return false;
  if (prefix === undefined) return true;
  const maxPrefix = version === 4 ? 32 : 128;
  return /^\d+$/.test(prefix) && Number(prefix) <= maxPrefix;
}

const bool = z
  .enum(['true', 'false', '1', '0', ''])
  .optional()
  .transform((v) => v === 'true' || v === '1');
const optional = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : undefined));
const proxyCidrs = z
  .string()
  .optional()
  .transform((v) => (v?.trim() ? v.split(',').map((item) => item.trim()).filter(Boolean) : undefined))
  .pipe(z.array(z.string().refine(validProxyRange, 'Use a valid IP address or CIDR')).optional());

export const EnvSchema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().default(4000),
  /** Browser origins allowed by CORS (comma-separated). 8081 is the Expo web dev server. Native apps don't need CORS. */
  WEB_ORIGIN: z.string().default('http://localhost:8081,http://localhost:3000'),
  /** Explicit trusted proxy IPs/CIDRs. Leave unset unless requests arrive through known, controlled proxies. */
  TRUSTED_PROXY_CIDRS: proxyCidrs,

  DATABASE_URL: z.string().default('postgres://rtp:rtp@localhost:5432/roadtrip'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  /** Run trip generation in-process instead of through the BullMQ worker (handy for local dev). */
  QUEUE_INLINE: bool,

  JWT_SECRET: z.string().min(16).default('dev-only-secret-change-me-please'),
  JWT_EXPIRES_IN: z.string().default('7d'),

  /** "auto": live APIs where a key exists, sample data otherwise. "sample": always sample data. */
  PROVIDER_MODE: z.enum(['auto', 'sample']).default('auto'),

  GOOGLE_MAPS_API_KEY: optional,
  /** Duffel flight search (fly + drive). Without it, flights are sample data. */
  DUFFEL_ACCESS_TOKEN: optional,

  AWS_REGION: optional,
  BEDROCK_MODEL_ID: optional,
  /** Cheaper model for small tasks; falls back to BEDROCK_MODEL_ID. */
  BEDROCK_FAST_MODEL_ID: optional,

  ONTARIO_511_API_KEY: optional,
  OILPRICEAPI_KEY: optional,
  EIA_API_KEY: optional,
  /** api.weather.gov requires an identifying User-Agent with contact details. */
  NWS_USER_AGENT: z.string().default('travlio (dev@example.com)'),

  /** Fallback USD→CAD rate when the Bank of Canada feed can't be reached. */
  USD_CAD_RATE: z.coerce.number().positive().default(1.38),
  /** Google Places searches per trip day (1 = interests take turns across days). */
  PLACES_SEARCHES_PER_DAY: z.coerce.number().int().min(1).max(4).default(1),
  FREE_TRIPS_PER_MONTH: z.coerce.number().int().min(0).default(3),
  /** Stripe web subscription billing. Leave all values unset to disable checkout. */
  STRIPE_SECRET_KEY: optional,
  STRIPE_WEBHOOK_SECRET: optional,
  STRIPE_PRICE_ID_MONTHLY: optional,
  STRIPE_PRICE_ID_ANNUAL: optional,
  WEB_APP_URL: optional.pipe(z.url().optional()),
  /** RevenueCat (App Store / Google Play subscriptions). Secret API key, used to re-read customers. */
  REVENUECAT_SECRET_KEY: optional,
  /** The Authorization header value set on the RevenueCat webhook (16+ random characters). */
  REVENUECAT_WEBHOOK_AUTH: optional.refine((v) => !v || v.length >= 16, 'REVENUECAT_WEBHOOK_AUTH must be at least 16 characters'),
  /** The RevenueCat entitlement that means Travlio Pro. */
  REVENUECAT_ENTITLEMENT_ID: z.string().trim().min(1).default('pro'),
  /** RevenueCat REST API base; only changed for local end-to-end tests. */
  REVENUECAT_API_URL: z.url().default('https://api.revenuecat.com/v1'),

  /** Postgres pool size. Serverless functions should keep this small (use Neon's pooled URL). */
  DB_POOL_MAX: z.coerce.number().int().min(1).max(50).optional(),

  /** Sender for verification and password-reset emails, e.g. "Travlio <no-reply@travlio.app>" (Amazon SES). */
  EMAIL_FROM: optional,
  /** SES region; defaults to AWS_REGION. The sending domain must be verified in SES in this region. */
  SES_REGION: optional,

  /** API docs at /api/docs are only served when both are set, behind HTTP Basic auth. */
  DOCS_USERNAME: optional,
  DOCS_PASSWORD: optional.refine((v) => !v || v.length >= 12, 'DOCS_PASSWORD must be at least 12 characters'),

  /** Set automatically on Vercel. */
  VERCEL: optional,
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`Invalid environment:\n${parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')}`);
  }
  const env = parsed.data;
  const onVercel = !!env.VERCEL;
  const production = env.NODE_ENV === 'production';
  const stripeSettings = [env.STRIPE_SECRET_KEY, env.STRIPE_WEBHOOK_SECRET, env.STRIPE_PRICE_ID_MONTHLY, env.STRIPE_PRICE_ID_ANNUAL, env.WEB_APP_URL];
  if (stripeSettings.some(Boolean) && !stripeSettings.every(Boolean)) {
    throw new Error('Set STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, both Stripe price IDs, and WEB_APP_URL together');
  }
  if (!!env.REVENUECAT_SECRET_KEY !== !!env.REVENUECAT_WEBHOOK_AUTH) {
    throw new Error('Set REVENUECAT_SECRET_KEY and REVENUECAT_WEBHOOK_AUTH together');
  }
  if (production && env.WEB_APP_URL && !env.WEB_APP_URL.startsWith('https://')) {
    throw new Error('Set WEB_APP_URL to an HTTPS URL in production');
  }
  if (production && !env.EMAIL_FROM) {
    throw new Error('Set EMAIL_FROM in production so account verification and password resets can be delivered');
  }
  if (production && !(env.SES_REGION || env.AWS_REGION)) {
    throw new Error('Set SES_REGION or AWS_REGION in production so account emails can be delivered');
  }
  if ((production || onVercel) && env.JWT_SECRET.startsWith('dev-only')) {
    throw new Error('Set JWT_SECRET (at least 16 random characters) in production');
  }
  if (onVercel && /localhost|127\.0\.0\.1/.test(env.DATABASE_URL)) {
    throw new Error('Set DATABASE_URL to your Neon connection string on Vercel');
  }
  // Serverless functions can't reach a local Redis or keep a BullMQ worker running: plan in-process
  // unless a real (non-local) REDIS_URL is set and QUEUE_INLINE isn't forced on.
  const localRedis = !source.REDIS_URL || /localhost|127\.0\.0\.1/.test(env.REDIS_URL);
  if (onVercel && localRedis) env.QUEUE_INLINE = true;
  env.DB_POOL_MAX ??= onVercel ? 3 : 10;
  return env;
}

export const ENV = Symbol('ENV');
