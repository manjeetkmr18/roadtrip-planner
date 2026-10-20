import 'reflect-metadata';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';
import { loadEnv } from './config/env.js';
import { AppModule } from './app.module.js';
import { FeedbackController } from './feedback/feedback.controller.js';
import { FeedbackModule } from './feedback/feedback.module.js';
import { HealthController } from './health/health.controller.js';
import { HealthModule } from './health/health.module.js';
import { IntegrationsController } from './health/integrations.controller.js';
import { PlacesController } from './places/places.controller.js';
import { PlacesModule } from './places/places.module.js';
import { MembershipController } from './membership/membership.controller.js';
import { MembershipModule } from './membership/membership.module.js';
import { UsersController } from './users/users.controller.js';
import { UsersModule } from './users/users.module.js';

describe('feature module registration', () => {
  it('registers feedback, places, health, user, and membership controllers in their feature modules', () => {
    expect(Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, FeedbackModule)).toEqual([FeedbackController]);
    expect(Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, PlacesModule)).toEqual([PlacesController]);
    expect(Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, HealthModule)).toEqual([HealthController, IntegrationsController]);
    expect(Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, UsersModule)).toEqual([UsersController]);
    expect(Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, MembershipModule)).toEqual([MembershipController]);
  });

  it('imports the feature modules into the application', () => {
    const app = AppModule.register(loadEnv({ QUEUE_INLINE: 'true', JWT_SECRET: 'test-secret-with-sufficient-length' }));
    expect(app.imports).toEqual(expect.arrayContaining([FeedbackModule, HealthModule, PlacesModule, UsersModule, MembershipModule]));
  });
});
