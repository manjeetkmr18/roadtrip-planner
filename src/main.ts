import 'reflect-metadata';
import { createServer } from 'node:http';
import { Logger, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { loadEnv } from './config/env.js';
import { AppModule } from './app.module.js';
import { setupDocs } from './docs.js';

// Load .env when present (Node 22+); real environment variables win.
try {
  process.loadEnvFile('.env');
} catch {
  /* no .env file */
}

async function bootstrap() {
  const env = loadEnv();
  const app = await NestFactory.create(AppModule.register(env));
  app.setGlobalPrefix('api');
  app.enableCors({ origin: env.WEB_ORIGIN.split(','), credentials: true });
  app.enableShutdownHooks();
  setupDocs(app, env);
  await app.listen(env.PORT);
  Logger.log(`API on http://localhost:${env.PORT}/api (queue: ${env.QUEUE_INLINE ? 'inline' : 'bullmq'}, providers: ${env.PROVIDER_MODE})`, 'Bootstrap');
}

/**
 * If the API can't start (usually a missing setting on the host), answer every request with a 503
 * that says why, instead of crashing. Only configuration messages are shown; they name settings,
 * never their values.
 */
@Module({})
class StartupErrorModule {}

async function startupFailed(err: unknown) {
  const e = err instanceof Error ? err : new Error(String(err));
  Logger.error(e.stack ?? e.message, 'Bootstrap');
  const config = /^(Invalid environment|Set [A-Z_]+)/.test(e.message);
  const body = JSON.stringify({ ok: false, error: 'API failed to start', reason: config ? e.message : `${e.name} (see server logs)` });
  const send = (res: { writeHead: (s: number, h: Record<string, string>) => void; end: (b: string) => void }) => {
    res.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(body);
  };
  const port = Number(process.env.PORT) || 4000;
  try {
    // A bare Nest app, so hosts that wrap Nest's listen() (Vercel) still serve the message.
    const app = await NestFactory.create(StartupErrorModule, { logger: false });
    app.use((_req: unknown, res: Parameters<typeof send>[0]) => send(res));
    await app.listen(port);
  } catch {
    createServer((_req, res) => send(res)).listen(port);
  }
}

bootstrap().catch(startupFailed);
