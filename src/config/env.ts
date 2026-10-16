import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0', ''])
  .optional()
  .transform((v) => v === 'true' || v === '1');
const optional = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : undefined));

export const EnvSchema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().default(4000),
  /** Browser origins allowed by CORS (comma-separated). 8081 is the Expo web dev server. Native apps don't need CORS. */
  WEB_ORIGIN: z.string().default('http://localhost:8081,http://localhost:3000'),

  DATABASE_URL: z.string().default('postgres://rtp:rtp@localhost:5432/roadtrip'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  /** Run trip generation in-process instead of through the BullMQ worker (handy for local dev). */
  QUEUE_INLINE: bool,

  JWT_SECRET: z.string().min(16).default('dev-only-secret-change-me-please'),
  JWT_EXPIRES_IN: z.string().default('7d'),

  /** "auto": live APIs where a key exists, sample data otherwise. "sample": always sample data. */
  PROVIDER_MODE: z.enum(['auto', 'sample']).default('auto'),

  GOOGLE_MAPS_API_KEY: optional,
  TOLLGURU_API_KEY: optional,

  AWS_REGION: optional,
  BEDROCK_MODEL_ID: optional,
  /** Cheaper model for small tasks; falls back to BEDROCK_MODEL_ID. */
  BEDROCK_FAST_MODEL_ID: optional,

  ONTARIO_511_API_KEY: optional,
  OILPRICEAPI_KEY: optional,
  EIA_API_KEY: optional,
  /** api.weather.gov requires an identifying User-Agent with contact details. */
  NWS_USER_AGENT: z.string().default('travlio (dev@example.com)'),

  /** Used only to convert USD tolls/fuel into CAD; shown as approximate. */
  USD_CAD_RATE: z.coerce.number().positive().default(1.38),
  /** Google Places searches per trip day (1 = interests take turns across days). */
  PLACES_SEARCHES_PER_DAY: z.coerce.number().int().min(1).max(4).default(1),
  FREE_TRIPS_PER_MONTH: z.coerce.number().int().min(0).default(3),

  /** Postgres pool size. Serverless functions should keep this small (use Neon's pooled URL). */
  DB_POOL_MAX: z.coerce.number().int().min(1).max(50).optional(),

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
  if ((env.NODE_ENV === 'production' || onVercel) && env.JWT_SECRET.startsWith('dev-only')) {
    throw new Error('Set JWT_SECRET (at least 16 random characters) in production');
  }
  if (onVercel && /localhost|127\.0\.0\.1/.test(env.DATABASE_URL)) {
    throw new Error('Set DATABASE_URL to your Neon connection string on Vercel');
  }
  // Serverless functions can't run a BullMQ worker: plan in-process unless a REDIS_URL is set explicitly.
  if (onVercel && source.QUEUE_INLINE === undefined && !source.REDIS_URL) env.QUEUE_INLINE = true;
  env.DB_POOL_MAX ??= onVercel ? 3 : 10;
  return env;
}

export const ENV = Symbol('ENV');
