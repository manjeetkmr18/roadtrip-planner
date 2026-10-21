import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { and, asc, count, eq, sql } from 'drizzle-orm';
import { daysBetween, MAX_TRIP_NOTES, TripNoteInput, TripNoteUpdate, type TripNote, type TripRequest } from '../core/index.js';
import { DB, type Db } from '../db/db.module.js';
import { tripNotes, trips } from '../db/schema.js';
import type { AuthUser } from '../auth/auth.js';

/** The trip_notes table (also drizzle/0009_trip_notes.sql), created at startup so a deploy works before db:migrate. */
export const NOTES_SCHEMA_SQL = `
SELECT pg_advisory_xact_lock(724003);
CREATE TABLE IF NOT EXISTS "trip_notes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "trip_id" uuid NOT NULL REFERENCES "trips"("id") ON DELETE cascade,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "day" integer,
  "time" text,
  "text" text NOT NULL,
  "place" jsonb,
  "include_in_plan" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "trip_notes_trip_idx" ON "trip_notes" USING btree ("trip_id","created_at");
`;

type Row = typeof tripNotes.$inferSelect;

export function toNote(r: Row): TripNote {
  return {
    id: r.id,
    text: r.text,
    day: r.day,
    time: r.time,
    place: r.place ?? null,
    includeInPlan: r.includeInPlan,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/** Whole-trip notes first, then by day and time; untimed notes before timed ones on a day. */
export function sortNotes<T extends { day: number | null; time: string | null; createdAt: string | Date }>(notes: T[]): T[] {
  return [...notes].sort(
    (a, b) =>
      (a.day ?? 0) - (b.day ?? 0) ||
      (a.time ?? '').localeCompare(b.time ?? '') ||
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
}

/** Number of days in the trip, from its dates. */
export function tripLength(req: Pick<TripRequest, 'startDate' | 'endDate'>) {
  return daysBetween(req.startDate, req.endDate) + 1;
}

/** What the planner and assistant are told about the traveller's own plans. */
export interface PlannerNote {
  day: number | null;
  time: string | null;
  place: string | null;
  text: string;
}

@Injectable()
export class TripNotesService implements OnModuleInit {
  private readonly log = new Logger(TripNotesService.name);
  private ready?: Promise<void>;

  constructor(@Inject(DB) private readonly db: Db) {}

  async onModuleInit() {
    try {
      await this.ensureSchema();
    } catch (e) {
      this.log.warn(`trip_notes table not ready yet: ${(e as Error).message}`);
    }
  }

  private ensureSchema() {
    this.ready ??= this.db
      .transaction(async (tx) => {
        await tx.execute(sql.raw(NOTES_SCHEMA_SQL));
      })
      .catch((e) => {
        this.ready = undefined;
        throw e;
      });
    return this.ready;
  }

  private async ownTrip(user: AuthUser, tripId: string) {
    const trip = await this.db.query.trips.findFirst({
      where: and(eq(trips.id, tripId), eq(trips.userId, user.id)),
      columns: { id: true, request: true },
    });
    if (!trip) throw new NotFoundException('Trip not found');
    return trip;
  }

  private checkDay(day: number | null | undefined, req: TripRequest) {
    if (day != null && day > tripLength(req)) {
      throw new BadRequestException({ message: `This trip has ${tripLength(req)} days. Pick a day from 1 to ${tripLength(req)}.`, issues: [{ path: 'day', message: 'Day is after the trip ends' }] });
    }
  }

  async list(user: AuthUser, tripId: string) {
    await this.ownTrip(user, tripId);
    await this.ensureSchema();
    const rows = await this.db.query.tripNotes.findMany({
      where: and(eq(tripNotes.tripId, tripId), eq(tripNotes.userId, user.id)),
      orderBy: [asc(tripNotes.createdAt)],
    });
    return sortNotes(rows.map(toNote));
  }

  async create(user: AuthUser, tripId: string, input: TripNoteInput) {
    const trip = await this.ownTrip(user, tripId);
    const note = TripNoteInput.parse(input);
    this.checkDay(note.day, trip.request);
    await this.ensureSchema();
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`trip-notes:${tripId}`}, 0))`);
      const [{ n }] = await tx.select({ n: count() }).from(tripNotes).where(eq(tripNotes.tripId, tripId));
      if (n >= MAX_TRIP_NOTES) throw new ConflictException(`A trip can have up to ${MAX_TRIP_NOTES} notes.`);
      const [row] = await tx
        .insert(tripNotes)
        // A time only means something on a day.
        .values({ tripId, userId: user.id, text: note.text, day: note.day, time: note.day == null ? null : note.time, place: note.place, includeInPlan: note.includeInPlan })
        .returning();
      return toNote(row);
    });
  }

  async update(user: AuthUser, tripId: string, noteId: string, input: TripNoteUpdate) {
    const trip = await this.ownTrip(user, tripId);
    const patch = TripNoteUpdate.parse(input);
    if (!Object.keys(patch).length) throw new BadRequestException('Nothing to change');
    this.checkDay(patch.day, trip.request);
    await this.ensureSchema();
    // Moving a note to the whole trip drops its time; a time needs a day.
    const changes = patch.day === null ? { ...patch, time: null } : patch;
    const [row] = await this.db
      .update(tripNotes)
      .set(changes)
      .where(and(eq(tripNotes.id, noteId), eq(tripNotes.tripId, tripId), eq(tripNotes.userId, user.id)))
      .returning();
    if (!row) throw new NotFoundException('Note not found');
    if (row.day == null && row.time != null) {
      const [fixed] = await this.db.update(tripNotes).set({ time: null }).where(eq(tripNotes.id, row.id)).returning();
      return toNote(fixed);
    }
    return toNote(row);
  }

  async remove(user: AuthUser, tripId: string, noteId: string) {
    await this.ownTrip(user, tripId);
    await this.ensureSchema();
    const [row] = await this.db
      .delete(tripNotes)
      .where(and(eq(tripNotes.id, noteId), eq(tripNotes.tripId, tripId), eq(tripNotes.userId, user.id)))
      .returning({ id: tripNotes.id });
    if (!row) throw new NotFoundException('Note not found');
    return { deleted: true };
  }

  /** Notes the traveller wants the planner to use (no ownership check: callers already loaded the trip). */
  async forPlanner(tripId: string, onlyIncluded = true): Promise<PlannerNote[]> {
    try {
      await this.ensureSchema();
      const rows = await this.db.query.tripNotes.findMany({ where: eq(tripNotes.tripId, tripId) });
      return sortNotes(rows.filter((r) => !onlyIncluded || r.includeInPlan).map(toNote)).map((n) => ({
        day: n.day,
        time: n.time,
        place: n.place?.address ?? null,
        text: n.text,
      }));
    } catch (e) {
      // Notes help but are never worth failing a plan over.
      this.log.warn(`could not read trip notes for planning: ${(e as Error).message}`);
      return [];
    }
  }
}
