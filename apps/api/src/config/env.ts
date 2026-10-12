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
  WEB_ORIGIN: z.string().default('http://localhost:3000'),

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
  NWS_USER_AGENT: z.string().default('roadtrip-planner (dev@example.com)'),

  /** Used only to convert USD tolls/fuel into CAD; shown as approximate. */
  USD_CAD_RATE: z.coerce.number().positive().default(1.38),
  FREE_TRIPS_PER_MONTH: z.coerce.number().int().min(0).default(3),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`Invalid environment:\n${parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')}`);
  }
  if (parsed.data.NODE_ENV === 'production' && parsed.data.JWT_SECRET.startsWith('dev-only')) {
    throw new Error('Set JWT_SECRET in production');
  }
  return parsed.data;
}

export const ENV = Symbol('ENV');
