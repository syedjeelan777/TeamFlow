import http from 'node:http';
import { config } from './config/env.js';
import { logger } from './config/logger.js';
import { createApp } from './app.js';
import { attachRealtime } from './sockets/realtime.js';
import { assertDatabaseReachable, disconnectPrisma } from './lib/prisma.js';

/**
 * Process entry point: one HTTP server hosts both the REST API and Socket.IO,
 * which keeps reverse-proxy/Cookie/Origin handling simple.
 */
async function main() {
  const app = createApp();
  const server = http.createServer(app);
  const realtime = attachRealtime(server);

  try {
    await assertDatabaseReachable();
  } catch (error) {
    logger.error(error, { context: 'startup.db' });
    process.stderr.write('TeamFlow cannot reach PostgreSQL. Is DATABASE_URL correct and is the database running?\n');
    process.exitCode = 1;
    await realtime.close();
    server.close();
    return;
  }

  server.listen(config.port, '0.0.0.0', () => {
    logger.info('TeamFlow API listening', {
      port: config.port,
      env: config.env,
      clientUrl: config.clientUrl,
      realtime: 'socket.io ready at /socket.io',
    });
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down', { signal });
    // Ask the client to reconnect elsewhere while we drain.
    realtime.io.emit('connection:error', { code: 'SERVER_SHUTDOWN', message: 'Server is restarting' });
    await realtime.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await disconnectPrisma();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', reason => logger.error(reason, { context: 'unhandledRejection' }));
  process.on('uncaughtException', error => {
    logger.error(error, { context: 'uncaughtException' });
    process.exit(1);
  });
}

void main();
