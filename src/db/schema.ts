import { boolean, geometry, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uuid, real } from 'drizzle-orm/pg-core';
import type { TripPlan, TripRequest } from '../core/index.js';

export const tripStatus = pgEnum('trip_status', ['draft', 'queued', 'generating', 'ready', 'failed']);
export const generationJobStatus = pgEnum('generation_job_status', ['queued', 'generating', 'completed', 'failed', 'released']);
export const membershipStatus = pgEnum('membership_status', ['incomplete', 'trialing', 'active', 'past_due', 'cancel_pending', 'canceled', 'unpaid', 'paused', 'expired']);

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  name: text('name'),
  plan: text('plan').notNull().default('free'), // free | pro
  stripeCustomerId: text('stripe_customer_id').unique(),
  /** Set once the user enters the code emailed at sign-up (or resets their password). */
  emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const membershipSubscriptions = pgTable(
  'membership_subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    stripeSubscriptionId: text('stripe_subscription_id').notNull().unique(),
    stripePriceId: text('stripe_price_id').notNull(),
    planCode: text('plan_code').notNull(),
    status: membershipStatus('status').notNull(),
    currentPeriodStart: timestamp('current_period_start', { withTimezone: true }),
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
    cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
    canceledAt: timestamp('canceled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index('membership_subscriptions_user_status_idx').on(t.userId, t.status)],
);

export const membershipWebhookEvents = pgTable('membership_webhook_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  stripeEventId: text('stripe_event_id').notNull().unique(),
  eventType: text('event_type').notNull(),
  processedAt: timestamp('processed_at', { withTimezone: true }).notNull().defaultNow(),
});

/** One-time 6-digit codes for email verification and password resets (only a hash is stored). */
export const authCodes = pgTable(
  'auth_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    purpose: text('purpose').notNull(), // verify_email | reset_password
    codeHash: text('code_hash').notNull(),
    attempts: integer('attempts').notNull().default(0),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('auth_codes_user_idx').on(t.userId, t.purpose)],
);

export const trips = pgTable(
  'trips',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    status: tripStatus('status').notNull().default('draft'),
    request: jsonb('request').$type<TripRequest>().notNull(),
    plan: jsonb('plan').$type<TripPlan>(),
    error: text('error'),
    shareToken: text('share_token').unique(),
    generationCount: integer('generation_count').notNull().default(0),
    lastGeneratedAt: timestamp('last_generated_at', { withTimezone: true }),
    apiCostUsd: real('api_cost_usd').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index('trips_user_idx').on(t.userId)],
);

export const tripAdjustments = pgTable(
  'trip_adjustments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tripId: uuid('trip_id')
      .notNull()
      .references(() => trips.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: text('status').notNull().default('proposed'),
    baseGeneratedAt: text('base_generated_at').notNull(),
    previousPlan: jsonb('previous_plan').$type<TripPlan>().notNull(),
    proposedPlan: jsonb('proposed_plan').$type<TripPlan>().notNull(),
    apiCostUsd: real('api_cost_usd').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    appliedAt: timestamp('applied_at', { withTimezone: true }),
    undoneAt: timestamp('undone_at', { withTimezone: true }),
  },
  (t) => [index('trip_adjustments_user_trip_created_idx').on(t.userId, t.tripId, t.createdAt)],
);

/** One row per generation run, for per-user limits and cost tracking. */
export const generations = pgTable(
  'generations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tripId: uuid('trip_id')
      .notNull()
      .references(() => trips.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    ok: boolean('ok').notNull().default(false),
    apiCostUsd: real('api_cost_usd').notNull().default(0),
    usedSampleData: boolean('used_sample_data').notNull().default(false),
    durationMs: integer('duration_ms'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('generations_user_created_idx').on(t.userId, t.createdAt)],
);

/** Durable admission and lifecycle record for a queued generation. */
export const generationJobs = pgTable(
  'generation_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tripId: uuid('trip_id')
      .notNull()
      .references(() => trips.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: generationJobStatus('status').notNull().default('queued'),
    attempts: integer('attempts').notNull().default(0),
    queuedAt: timestamp('queued_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index('generation_jobs_user_created_idx').on(t.userId, t.createdAt),
    index('generation_jobs_trip_status_idx').on(t.tripId, t.status),
  ],
);

/**
 * Stops chosen for a trip, with a PostGIS point for spatial queries
 * (nearby alternatives, "what else is on the way"). Google Maps Platform
 * terms allow storing place IDs indefinitely; coordinates are refreshed with each generation.
 */
export const tripStops = pgTable(
  'trip_stops',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tripId: uuid('trip_id')
      .notNull()
      .references(() => trips.id, { onDelete: 'cascade' }),
    day: integer('day').notNull(),
    position: integer('position').notNull(),
    name: text('name').notNull(),
    kind: text('kind').notNull(),
    placeId: text('place_id'),
    location: geometry('location', { type: 'point', mode: 'xy', srid: 4326 }).notNull(),
  },
  (t) => [index('trip_stops_location_idx').using('gist', t.location), index('trip_stops_trip_idx').on(t.tripId)],
);

/** "Report incorrect info" submissions from the cost report and stops. */
export const feedback = pgTable('feedback', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  tripId: uuid('trip_id').references(() => trips.id, { onDelete: 'cascade' }),
  itemType: text('item_type').notNull(), // cost_line | stop | weather | road_event | other
  itemId: text('item_id'),
  message: text('message').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
