import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

/**
 * Prisma 7 configuration. The datasource URL is resolved from `DATABASE_URL`
 * at runtime, so `schema.prisma` stays free of environment-specific values.
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});
