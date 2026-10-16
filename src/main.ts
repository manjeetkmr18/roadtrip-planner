import 'reflect-metadata';
import { createServer } from 'node:http';
import { Logger } from '@nestjs/common';
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
function startupFailed(err: unknown) {
  const e = err instanceof Error ? err : new Error(String(err));
  Logger.error(e.stack ?? e.message, 'Bootstrap');
  const config = /^(Invalid environment|Set [A-Z_]+)/.test(e.message);
  const body = JSON.stringify({ ok: false, error: 'API failed to start', reason: config ? e.message : `${e.name} (see server logs)` });
  createServer((_req, res) => {
    res.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(body);
  }).listen(Number(process.env.PORT) || 4000);
}

bootstrap().catch(startupFailed);
