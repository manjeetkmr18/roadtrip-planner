-- Store itinerary proposals and plan snapshots so changes can be safely applied or undone.
CREATE TABLE "trip_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trip_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"base_generated_at" text NOT NULL,
	"previous_plan" jsonb NOT NULL,
	"proposed_plan" jsonb NOT NULL,
	"api_cost_usd" real DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp with time zone,
	"undone_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "trip_adjustments" ADD CONSTRAINT "trip_adjustments_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_adjustments" ADD CONSTRAINT "trip_adjustments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "trip_adjustments_user_trip_created_idx" ON "trip_adjustments" USING btree ("user_id","trip_id","created_at");