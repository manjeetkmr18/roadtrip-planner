import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

const here = path.dirname(fileURLToPath(import.meta.url));

// Load apps/api/.env when present (Node 22+); real environment variables win.
try {
  process.loadEnvFile('.env');
} catch {
  /* no .env file */
}
async function main() {
  const url = process.env.DATABASE_URL ?? 'postgres://rtp:rtp@localhost:5432/roadtrip';
  const pool = new pg.Pool({ connectionString: url });
  await pool.query('CREATE EXTENSION IF NOT EXISTS postgis');
  await migrate(drizzle(pool), { migrationsFolder: path.resolve(here, '../../drizzle') });
  await pool.end();
  console.log('Migrations applied');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
