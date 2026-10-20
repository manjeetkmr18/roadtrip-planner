import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.js';
import { PlacesController } from './places.controller.js';

@Module({ imports: [AuthModule], controllers: [PlacesController] })
export class PlacesModule {}
