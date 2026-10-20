import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.js';
import { HealthController } from './health.controller.js';
import { IntegrationsController } from './integrations.controller.js';

@Module({ imports: [AuthModule], controllers: [HealthController, IntegrationsController] })
export class HealthModule {}
