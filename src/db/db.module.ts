import { Global, Inject, Injectable, Module, OnApplicationShutdown } from '@nestjs/common';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';
import { ENV, type Env } from '../config/env.js';

export type Db = NodePgDatabase<typeof schema>;
export const DB = Symbol('DB');

@Injectable()
class PoolCloser implements OnApplicationShutdown {
  constructor(@Inject('PG_POOL') private readonly pool: pg.Pool) {}
  async onApplicationShutdown() {
    await this.pool.end();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: 'PG_POOL',
      inject: [ENV],
      useFactory: (env: Env) => new pg.Pool({ connectionString: env.DATABASE_URL, max: env.DB_POOL_MAX ?? 10, idleTimeoutMillis: 10_000 }),
    },
    {
      provide: DB,
      inject: ['PG_POOL'],
      useFactory: (pool: pg.Pool): Db => drizzle(pool, { schema }),
    },
    PoolCloser,
  ],
  exports: [DB, 'PG_POOL'],
})
export class DbModule {}
