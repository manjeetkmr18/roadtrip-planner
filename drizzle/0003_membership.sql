CREATE TYPE "public"."membership_status" AS ENUM('incomplete', 'trialing', 'active', 'past_due', 'cancel_pending', 'canceled', 'unpaid', 'paused', 'expired');--> statement-breakpoint
CREATE TABLE "membership_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"stripe_subscription_id" text NOT NULL,
	"stripe_price_id" text NOT NULL,
	"plan_code" text NOT NULL,
	"status" "membership_status" NOT NULL,
	"current_period_start" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"canceled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "membership_subscriptions_stripe_subscription_id_unique" UNIQUE("stripe_subscription_id")
);
--> statement-breakpoint
CREATE TABLE "membership_webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"stripe_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "membership_webhook_events_stripe_event_id_unique" UNIQUE("stripe_event_id")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "stripe_customer_id" text;--> statement-breakpoint
ALTER TABLE "membership_subscriptions" ADD CONSTRAINT "membership_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "membership_subscriptions_user_status_idx" ON "membership_subscriptions" USING btree ("user_id","status");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_stripe_customer_id_unique" UNIQUE("stripe_customer_id");