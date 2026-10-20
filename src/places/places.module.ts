import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.js';
import { MembershipModule } from '../membership/membership.module.js';
import { PlacesController } from './places.controller.js';

@Module({ imports: [AuthModule, MembershipModule], controllers: [PlacesController] })
export class PlacesModule {}
