import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { TravelOptionsQuery, TripAdjustmentRequest, TripAssistantApplyRequest, TripAssistantRequest, TripNoteInput, TripNoteUpdate, TripRequest } from '../core/index.js';
import { TripNotesService } from './notes.service.js';
import { ASSISTANT_PRO_MESSAGE } from './assistant.js';
import { CurrentUser, VerifiedGuard, type AuthUser } from '../auth/auth.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { ApiEndpoint } from '../common/api-docs.decorator.js';
import { MembershipService } from '../membership/membership.service.js';
import { TripsService } from './trips.service.js';
import { TripAdjustmentsService } from './trip-adjustments.service.js';

const Nearby = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  radiusKm: z.coerce.number().positive().max(200).default(25),
});

@Controller('trips')
@UseGuards(VerifiedGuard)
export class TripsController {
  constructor(
    private readonly trips: TripsService,
    private readonly adjustments: TripAdjustmentsService,
    private readonly membership: MembershipService,
    private readonly notes: TripNotesService,
  ) {}

  @Get()
  @ApiEndpoint({ tag: 'Trips', summary: 'List the signed-in user trips', security: 'bearer', errors: [401, 403] })
  list(@CurrentUser() user: AuthUser) {
    return this.trips.list(user);
  }

  @Get('usage')
  @ApiEndpoint({ tag: 'Trips', summary: 'Get this month trip-plan usage and limit', security: 'bearer', errors: [401, 403] })
  usage(@CurrentUser() user: AuthUser) {
    return this.trips.usage(user);
  }

  @Get('saved-stops/nearby')
  @ApiEndpoint({ tag: 'Trips', summary: 'Find saved trip stops near coordinates', security: 'bearer', errors: [400, 401, 403] })
  nearby(@CurrentUser() user: AuthUser, @Query(new ZodPipe(Nearby)) q: z.infer<typeof Nearby>) {
    return this.trips.nearbySavedStops(user, q.lat, q.lng, q.radiusKm);
  }

  /** Drive vs fly + drive for a trip, with flights for the dates (not saved, not counted as a plan). */
  @Post('travel-options')
  @ApiEndpoint({ tag: 'Trips', summary: 'Compare driving and fly-plus-drive options', security: 'bearer', response: { status: 201, description: 'Travel options' }, errors: [400, 401, 429, 502] })
  travelOptions(@Body(new ZodPipe(TravelOptionsQuery)) body: TravelOptionsQuery) {
    return this.trips.travelOptions(body);
  }

  @Post()
  @ApiEndpoint({ tag: 'Trips', summary: 'Create a trip draft', security: 'bearer', response: { status: 201, description: 'Trip draft created' }, errors: [400, 401, 403] })
  create(@CurrentUser() user: AuthUser, @Body(new ZodPipe(TripRequest)) body: TripRequest) {
    return this.trips.create(user, body);
  }

  @Get(':id')
  @ApiEndpoint({ tag: 'Trips', summary: 'Get a trip and its current plan', security: 'bearer', errors: [401, 403, 404] })
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.trips.get(user, id);
  }

  @Put(':id')
  @ApiEndpoint({ tag: 'Trips', summary: 'Update a trip draft', security: 'bearer', errors: [400, 401, 403, 404] })
  update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(TripRequest)) body: TripRequest) {
    return this.trips.update(user, id, body);
  }

  @Delete(':id')
  @ApiEndpoint({ tag: 'Trips', summary: 'Delete one of the signed-in user trips', security: 'bearer', errors: [401, 403, 404] })
  remove(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.trips.remove(user, id);
  }

  /** Queue a (re)generation: routes, costs, weather, stops. Also used for "refresh before departure". */
  @Post(':id/generate')
  @ApiEndpoint({ tag: 'Trips', summary: 'Queue or refresh a trip plan', security: 'bearer', response: { status: 201, description: 'Trip plan queued' }, errors: [401, 402, 403, 404, 429, 503] })
  generate(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.trips.requestGeneration(user, id);
  }

  @Post(':id/adjustments/preview')
  @ApiEndpoint({ tag: 'Trips', summary: 'Preview a late-arrival trip adjustment', security: 'bearer', response: { status: 201, description: 'Adjustment preview created' }, errors: [400, 401, 403, 404, 409, 503] })
  previewAdjustment(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(TripAdjustmentRequest)) body: TripAdjustmentRequest,
  ) {
    return this.adjustments.preview(user, id, body);
  }

  @Post(':id/assistant')
  @ApiEndpoint({ tag: 'Trips', summary: 'Chat with the personal trip assistant and preview preference changes', security: 'bearer', response: { status: 201, description: 'Assistant reply and optional trip preference proposal' }, errors: [400, 401, 403, 404, 409, 429, 503] })
  assistant(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(TripAssistantRequest)) body: TripAssistantRequest,
  ) {
    return this.adjustments.chat(user, id, body);
  }

  @Post(':id/assistant/apply')
  @ApiEndpoint({ tag: 'Trips', summary: 'Confirm assistant preferences and queue a new trip plan', security: 'bearer', response: { status: 201, description: 'Preference update saved and trip plan queued' }, errors: [400, 401, 402, 403, 404, 409, 503] })
  async applyAssistant(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(TripAssistantApplyRequest)) body: TripAssistantApplyRequest,
  ) {
    await this.membership.assertPro(user, ASSISTANT_PRO_MESSAGE);
    return this.trips.requestGeneration(user, id, body.request, body.baseGeneratedAt);
  }

  @Post(':id/adjustments/:adjustmentId/apply')
  @ApiEndpoint({ tag: 'Trips', summary: 'Apply a previewed trip adjustment', security: 'bearer', response: { status: 201, description: 'Adjustment applied' }, errors: [401, 403, 404, 409] })
  applyAdjustment(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('adjustmentId', ParseUUIDPipe) adjustmentId: string,
  ) {
    return this.adjustments.apply(user, id, adjustmentId);
  }

  @Post(':id/adjustments/:adjustmentId/undo')
  @ApiEndpoint({ tag: 'Trips', summary: 'Undo an applied trip adjustment', security: 'bearer', response: { status: 201, description: 'Adjustment undone' }, errors: [401, 403, 404, 409] })
  undoAdjustment(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('adjustmentId', ParseUUIDPipe) adjustmentId: string,
  ) {
    return this.adjustments.undo(user, id, adjustmentId);
  }

  @Get(':id/notes')
  @ApiEndpoint({ tag: 'Trip notes', summary: 'List your notes on a trip (whole trip first, then by day and time)', security: 'bearer', errors: [401, 403, 404] })
  listNotes(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.notes.list(user, id);
  }

  @Post(':id/notes')
  @ApiEndpoint({ tag: 'Trip notes', summary: 'Add a note: something to do on the trip or one day, optionally at a time and place', security: 'bearer', response: { status: 201, description: 'Note added' }, errors: [400, 401, 403, 404, 409] })
  createNote(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(TripNoteInput)) body: TripNoteInput) {
    return this.notes.create(user, id, body);
  }

  @Patch(':id/notes/:noteId')
  @ApiEndpoint({ tag: 'Trip notes', summary: 'Edit a note', security: 'bearer', errors: [400, 401, 403, 404] })
  updateNote(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('noteId', ParseUUIDPipe) noteId: string,
    @Body(new ZodPipe(TripNoteUpdate)) body: TripNoteUpdate,
  ) {
    return this.notes.update(user, id, noteId, body);
  }

  @Delete(':id/notes/:noteId')
  @ApiEndpoint({ tag: 'Trip notes', summary: 'Delete a note', security: 'bearer', errors: [401, 403, 404] })
  removeNote(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Param('noteId', ParseUUIDPipe) noteId: string) {
    return this.notes.remove(user, id, noteId);
  }

  @Post(':id/share')
  @ApiEndpoint({ tag: 'Trips', summary: 'Create a share link (returns the existing one if already shared)', security: 'bearer', response: { status: 201, description: 'Share link created' }, errors: [401, 403, 404] })
  share(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.trips.share(user, id);
  }

  @Delete(':id/share')
  @ApiEndpoint({ tag: 'Trips', summary: 'Stop sharing: the share link stops working', security: 'bearer', errors: [401, 403, 404] })
  unshare(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.trips.unshare(user, id);
  }
}

@Controller('share')
export class ShareController {
  constructor(private readonly trips: TripsService) {}

  @Get(':token')
  @ApiEndpoint({ tag: 'Public', summary: 'Read a shared trip', errors: [404] })
  get(@Param('token') token: string) {
    return this.trips.getShared(token);
  }
}
