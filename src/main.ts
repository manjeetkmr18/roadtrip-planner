import 'reflect-metadata';
import { Global, Logger, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { ENV, loadEnv } from './config/env.js';
import { DbModule } from './db/db.module.js';
import { ProvidersModule } from './providers/providers.module.js';
import { AuthModule } from './auth/auth.js';
import { TripsModule } from './trips/trips.module.js';
import { MiscModule } from './misc.js';
import { setupDocs } from './docs.js';

// Load apps/api/.env when present (Node 22+); real environment variables win.
try {
  process.loadEnvFile('.env');
} catch {
  /* no .env file */
}
const env = loadEnv();

@Global()
@Module({ providers: [{ provide: ENV, useValue: env }], exports: [ENV] })
class EnvModule {}

@Module({
  imports: [
    EnvModule,
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
    DbModule,
    ProvidersModule,
    AuthModule,
    TripsModule.register({ inline: env.QUEUE_INLINE, redisUrl: env.REDIS_URL }),
    MiscModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
class AppModule {}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
  app.enableCors({ origin: env.WEB_ORIGIN.split(','), credentials: true });
  app.enableShutdownHooks();
  setupDocs(app, env);
  await app.listen(env.PORT);
  Logger.log(`API on http://localhost:${env.PORT}/api (queue: ${env.QUEUE_INLINE ? 'inline' : 'bullmq'}, providers: ${env.PROVIDER_MODE})`, 'Bootstrap');
}

bootstrap();
