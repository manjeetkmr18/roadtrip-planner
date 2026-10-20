import { Global, Module, type DynamicModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ENV, type Env } from './config/env.js';
import { DbModule } from './db/db.module.js';
import { ProvidersModule } from './providers/providers.module.js';
import { AuthModule } from './auth/auth.js';
import { TripsModule } from './trips/trips.module.js';
import { FeedbackModule } from './feedback/feedback.module.js';
import { HealthModule } from './health/health.module.js';
import { PlacesModule } from './places/places.module.js';
import { UsersModule } from './users/users.module.js';
import { MembershipModule } from './membership/membership.module.js';
import { RateLimitGuard } from './common/rate-limit.js';

@Global()
@Module({})
class EnvModule {
  static register(env: Env): DynamicModule {
    return { module: EnvModule, providers: [{ provide: ENV, useValue: env }], exports: [ENV] };
  }
}

@Module({})
export class AppModule {
  static register(env: Env): DynamicModule {
    return {
      module: AppModule,
      imports: [
        EnvModule.register(env),
        DbModule,
        ProvidersModule,
        AuthModule,
        TripsModule.register({ inline: env.QUEUE_INLINE, redisUrl: env.REDIS_URL }),
        FeedbackModule,
        HealthModule,
        PlacesModule,
        UsersModule,
        MembershipModule,
      ],
      providers: [{ provide: APP_GUARD, useClass: RateLimitGuard }],
    };
  }
}
