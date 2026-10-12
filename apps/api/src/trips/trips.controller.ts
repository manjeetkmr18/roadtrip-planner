import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { TripRequest } from '@rtp/core';
import { CurrentUser, JwtGuard, type AuthUser } from '../auth/auth.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { TripsService } from './trips.service.js';

const Nearby = z.object({ lat: z.coerce.number(), lng: z.coerce.number(), radiusKm: z.coerce.number().default(25) });

@Controller('trips')
@UseGuards(JwtGuard)
export class TripsController {
  constructor(private readonly trips: TripsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.trips.list(user);
  }

  @Get('usage')
  usage(@CurrentUser() user: AuthUser) {
    return this.trips.usage(user);
  }

  @Get('saved-stops/nearby')
  nearby(@CurrentUser() user: AuthUser, @Query(new ZodPipe(Nearby)) q: z.infer<typeof Nearby>) {
    return this.trips.nearbySavedStops(user, q.lat, q.lng, q.radiusKm);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body(new ZodPipe(TripRequest)) body: TripRequest) {
    return this.trips.create(user, body);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.trips.get(user, id);
  }

  @Put(':id')
  update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(TripRequest)) body: TripRequest) {
    return this.trips.update(user, id, body);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.trips.remove(user, id);
  }

  /** Queue a (re)generation: routes, costs, weather, stops. Also used for "refresh before departure". */
  @Post(':id/generate')
  generate(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.trips.requestGeneration(user, id);
  }

  @Post(':id/share')
  share(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.trips.share(user, id);
  }
}

@Controller('share')
export class ShareController {
  constructor(private readonly trips: TripsService) {}

  @Get(':token')
  get(@Param('token') token: string) {
    return this.trips.getShared(token);
  }
}
