CREATE TABLE IF NOT EXISTS "store_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"entitlement" text NOT NULL,
	"store" text NOT NULL,
	"product_id" text NOT NULL,
	"status" text NOT NULL,
	"expires_at" timestamp with time zone,
	"will_renew" boolean DEFAULT false NOT NULL,
	"sandbox" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "store_subscriptions" ADD CONSTRAINT "store_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "store_subscriptions_user_entitlement_idx" ON "store_subscriptions" USING btree ("user_id","entitlement");
