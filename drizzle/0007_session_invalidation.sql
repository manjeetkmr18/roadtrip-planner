ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "sessions_valid_after" timestamp with time zone;
