import { sql } from 'drizzle-orm';
import type { Db } from '../db/db.module.js';

/**
 * The store_subscriptions table (drizzle/0008_store_subscriptions.sql). Created on first use so a
 * deployment works before `npm run db:migrate` is run; every statement is safe to repeat.
 */
export const STORE_SCHEMA_SQL = `
SELECT pg_advisory_xact_lock(724002);
CREATE TABLE IF NOT EXISTS "store_subscriptions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "entitlement" text NOT NULL,
  "store" text NOT NULL,
  "product_id" text NOT NULL,
  "status" text NOT NULL,
  "expires_at" timestamp with time zone,
  "will_renew" boolean DEFAULT false NOT NULL,
  "sandbox" boolean DEFAULT false NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "store_subscriptions_user_entitlement_idx" ON "store_subscriptions" USING btree ("user_id","entitlement");
`;

let ready: Promise<void> | undefined;

export function ensureStoreSchema(db: Db): Promise<void> {
  ready ??= db
    .transaction(async (tx) => {
      await tx.execute(sql.raw(STORE_SCHEMA_SQL));
    })
    .catch((e) => {
      ready = undefined;
      throw e;
    });
  return ready;
}

/** Postgres "undefined_table": the store table hasn't been created yet on this database. */
export function isMissingTable(e: unknown) {
  return typeof e === 'object' && e !== null && ((e as { code?: string }).code === '42P01' || (e as { cause?: { code?: string } }).cause?.code === '42P01');
}
