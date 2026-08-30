import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import { config } from '../config/env.js';

/**
 * Prisma Client (v7, WASM query compiler) + `pg` driver adapter.
 *
 * There is a single client instance for the process: it owns the connection
 * pool, which is what we want for a long-lived API server.
 */
const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL,
  // `pg`-proxy backed databases (including the bundled `prisma dev` server)
  // cap concurrent connections; a pool larger than the cap gets connections
  // reset mid-flight, so keep this small and fan out reads through `mapLimited`.
  max: Number(process.env.DB_POOL_MAX ?? 8),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 20_000,
});

export const prisma = new PrismaClient({
  adapter,
  log: config.isDevelopment ? [{ emit: 'event', level: 'query' }] : undefined,
});

export type PrismaClientLike = typeof prisma;
export type TransactionClient = Omit<
  PrismaClientLike,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

/** Health check used by `GET /health` and by the readiness probe. */
export async function assertDatabaseReachable(): Promise<boolean> {
  await prisma.$queryRaw`SELECT 1`;
  return true;
}

export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect();
}
