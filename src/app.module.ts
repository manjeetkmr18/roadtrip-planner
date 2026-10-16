import { Global, Module, type DynamicModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ENV, type Env } from './config/env.js';
import { DbModule } from './db/db.module.js';
import { ProvidersModule } from './providers/providers.module.js';
import { AuthModule } from './auth/auth.js';
import { TripsModule } from './trips/trips.module.js';
import { MiscModule } from './misc.js';

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
        ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
        DbModule,
        ProvidersModule,
        AuthModule,
        TripsModule.register({ inline: env.QUEUE_INLINE, redisUrl: env.REDIS_URL }),
        MiscModule,
      ],
      providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
    };
  }
}
