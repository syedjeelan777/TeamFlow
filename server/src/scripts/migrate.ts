#!/usr/bin/env tsx
/**
 * Prisma-compatible migration runner.
 *
 * Reads `prisma/migrations/<timestamp>_<name>/migration.sql`, applies any
 * unapplied migration inside a transaction and records it in Prisma's own
 * `_prisma_migrations` bookkeeping table — so `prisma migrate status`, Prisma
 * Studio and `prisma migrate dev` keep working with the exact same history.
 *
 * Why not `prisma migrate dev`? In air-gapped/sandboxed environments the Prisma
 * CLI cannot download its native schema-engine binary. This runner covers the
 * common path (apply committed SQL) with zero extra tooling; if you have the
 * engine available you can keep using `prisma migrate dev` unchanged.
 *
 * Usage:
 *   tsx src/scripts/migrate.ts             # apply pending migrations
 *   tsx src/scripts/migrate.ts --status    # show migration history
 *   tsx src/scripts/migrate.ts --reset     # drop schema, re-apply everything
 *   tsx src/scripts/migrate.ts --create-only --name my_change  (needs a real engine)
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import '../config/env.js'; // loads .env + validates configuration

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(here, '../../prisma/migrations');

interface MigrationFile {
  name: string;
  filePath: string;
  sql: string;
  checksum: string;
}

export function readMigrations(dir = migrationsDir): MigrationFile[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .filter(name => !name.startsWith('.') && name !== 'migration_lock.toml')
    .sort()
    .map(name => {
      const filePath = path.join(dir, name, 'migration.sql');
      if (!existsSync(filePath)) throw new Error(`Migration ${name} is missing migration.sql`);
      const sql = readFileSync(filePath, 'utf8');
      return { name, filePath, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    });
}

const BOOKKEEPING_SQL = `
CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
  "id" UUID NOT NULL,
  "checksum" VARCHAR(64) NOT NULL,
  "finished_at" TIMESTAMPTZ,
  "migration_name" VARCHAR(255) NOT NULL,
  "logs" TEXT,
  "rolled_back_at" TIMESTAMPTZ,
  "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "applied_steps_count" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "_prisma_migrations_pkey" PRIMARY KEY ("id")
);
`;

interface AppliedRow {
  migration_name: string;
  checksum: string;
  finished_at: Date | null;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const args = process.argv.slice(2);
  const wantReset = args.includes('--reset');
  const statusOnly = args.includes('--status');

  const client = new Client({ connectionString: url, ssl: false });
  await client.connect();

  try {
    await client.query(BOOKKEEPING_SQL);
    const { rows } = await client.query<{ migration_name: string; checksum: string; finished_at: Date | null }>(
      `SELECT migration_name, checksum, finished_at FROM "_prisma_migrations" ORDER BY started_at ASC, migration_name ASC`,
    );
    const applied = new Map<string, AppliedRow>(rows.map(r => [r.migration_name, r]));

    if (wantReset) {
      if (!statusOnly) {
        console.log('! Resetting schema (drop cascade) …');
        await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
        await client.query(BOOKKEEPING_SQL);
        applied.clear();
      }
    }

    const migrations = readMigrations();
    if (migrations.length === 0) throw new Error(`No migrations found in ${migrationsDir}`);

    let pending = 0;
    for (const migration of migrations) {
      const existing = applied.get(migration.name);
      if (existing?.finished_at) {
        if (existing.checksum !== migration.checksum) {
          console.warn(`⚠  ${migration.name}: file changed since it was applied (checksum mismatch).`);
        }
        if (statusOnly) console.log(`✓  ${migration.name} (applied)`);
        continue;
      }
      pending += 1;
      if (statusOnly) {
        console.log(`•  ${migration.name} (pending)`);
        continue;
      }
      const started = Date.now();
      console.log(`→  applying ${migration.name} …`);
      await client.query('BEGIN');
      try {
        if (existing) {
          await client.query(`DELETE FROM "_prisma_migrations" WHERE migration_name = $1`, [migration.name]);
        }
        await client.query(migration.sql);
        await client.query(
          `INSERT INTO "_prisma_migrations" ("id", "checksum", "finished_at", "started_at", "migration_name", "applied_steps_count", "logs")
           VALUES (gen_random_uuid(), $1, now(), now(), $2, 1, '[]')`,
          [migration.checksum, migration.name],
        );
        await client.query('COMMIT');
        console.log(`✓  ${migration.name} applied in ${Date.now() - started}ms`);
      } catch (error) {
        await client.query('ROLLBACK');
        await client
          .query(
            `INSERT INTO "_prisma_migrations" ("id", "checksum", "finished_at", "started_at", "migration_name", "logs")
             VALUES (gen_random_uuid(), $1, NULL, now(), $2, $3)
             ON CONFLICT DO NOTHING`,
            [migration.checksum, migration.name, JSON.stringify([String(error)])],
          )
          .catch(() => undefined);
        throw error;
      }
    }

    if (statusOnly) {
      console.log(pending === 0 ? '\nDatabase is up to date.' : `\n${pending} migration(s) pending.`);
      process.exitCode = pending === 0 ? 0 : 1;
      return;
    }
    console.log(pending === 0 ? 'Database already up to date — nothing to do.' : `\nApplied ${pending} migration(s).`);
  } finally {
    await client.end();
  }
}

// Only execute when run directly (tests import `readMigrations`).
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath.endsWith('migrate.ts') || invokedPath.endsWith('migrate.js')) {
  main().catch(error => {
    console.error('Migration failed:', error);
    process.exit(1);
  });
}
