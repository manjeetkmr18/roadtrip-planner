import { boolean, geometry, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uuid, real } from 'drizzle-orm/pg-core';
import type { TripPlan, TripRequest } from '@rtp/core';

export const tripStatus = pgEnum('trip_status', ['draft', 'queued', 'generating', 'ready', 'failed']);

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  name: text('name'),
  plan: text('plan').notNull().default('free'), // free | pro
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

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
