import { sql } from 'drizzle-orm';
import type { Db } from '../db/db.module.js';

/**
 * The email-verification and session schema (also in drizzle/0001_email_codes.sql and 0007_session_invalidation.sql). Run on first use so a
 * deployment works even before `npm run db:migrate`; every statement is safe to repeat.
 * Accounts that existed before verification was added are treated as verified.
 */
export const AUTH_SCHEMA_SQL = `
SELECT pg_advisory_xact_lock(724001);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'email_verified_at') THEN
    ALTER TABLE "users" ADD COLUMN "email_verified_at" timestamp with time zone;
    UPDATE "users" SET "email_verified_at" = "created_at";
  END IF;
END $$;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "sessions_valid_after" timestamp with time zone;
CREATE TABLE IF NOT EXISTS "auth_codes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "purpose" text NOT NULL,
  "code_hash" text NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "auth_codes_user_idx" ON "auth_codes" USING btree ("user_id","purpose");
`;

let ready: Promise<void> | undefined;

export function ensureAuthSchema(db: Db): Promise<void> {
  ready ??= db
    .transaction(async (tx) => {
      await tx.execute(sql.raw(AUTH_SCHEMA_SQL));
    })
    .catch((e) => {
      ready = undefined; // try again on the next request
      throw e;
    });
  return ready;
}
