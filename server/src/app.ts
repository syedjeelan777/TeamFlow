import fs from 'node:fs';
import path from 'node:path';
import cookieParser from 'cookie-parser';
import express, { type Express } from 'express';
import { config } from './config/env.js';
import { logger } from './config/logger.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { apiLimiter, securityMiddleware } from './middleware/security.js';
import { buildApiRouter } from './routes/index.js';
import { prisma } from './lib/prisma.js';
import { presenceService } from './services/presence.service.js';
import { isRealtimeConnected } from './services/realtime.service.js';
import { assertDatabaseReachable } from './lib/prisma.js';

/**
 * Express application factory.
 *
 * Exported separately from `server.ts` so integration tests can mount the exact
 * same middleware stack with `supertest` and no network listener.
 */
export function createApp(): Express {
  const app = express();

  app.set('trust proxy', 1); // behind the preview/reverse proxy
  app.disable('x-powered-by');
  app.use(securityMiddleware);
  app.use(express.json({ limit: '512kb' }));
  app.use(express.urlencoded({ extended: false, limit: '128kb' }));
  app.use(cookieParser());

  app.use((req, res, next) => {
    const started = Date.now();
    res.on('finish', () => {
      const level = res.statusCode >= 500 ? 'warn' : res.statusCode >= 400 ? 'warn' : 'debug';
      logger[level]('http', {
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        ms: Date.now() - started,
        userId: req.user?.id,
      });
    });
    res.setHeader('X-Request-Id', randomId());
    next();
  });

  app.get('/health', (_req, res) => {
    res.json({
      success: true,
      data: {
        status: 'ok',
        uptimeSeconds: Math.round(process.uptime()),
        env: config.env,
        realtime: isRealtimeConnected() ? 'connected' : 'unavailable',
        presence: presenceService.stats(),
      },
    });
  });

  app.get('/health/ready', async (_req, res) => {
    try {
      await assertDatabaseReachable();
      res.json({ success: true, data: { status: 'ready' } });
    } catch (error) {
      logger.error(error, { context: 'health.ready' });
      res.status(503).json({ success: false, error: { code: 'NOT_READY', message: 'Database unreachable' } });
    }
  });

  app.get('/api', (_req, res) => {
    res.json({
      success: true,
      data: {
        name: 'TeamFlow API',
        version: '1.0.0',
        docs: '/api-docs.md',
        endpoints: [
          'POST /api/auth/register',
          'POST /api/auth/login',
          'POST /api/auth/refresh',
          'GET  /api/auth/me',
          'GET  /api/workspaces',
          'POST /api/workspaces',
          'GET  /api/workspaces/:workspaceId/projects',
          'POST /api/projects/:projectId/tasks',
          'PATCH /api/tasks/:taskId/move',
          'GET  /api/channels/:channelId/messages',
          'GET  /api/notifications',
          'GET  /api/workspaces/:workspaceId/analytics',
        ],
      },
    });
  });

  app.use('/api', apiLimiter, buildApiRouter());

  // Serve the built SPA when the API also hosts the frontend (single port).
  if (config.serveClient) {
    const dist = path.resolve(process.cwd(), config.clientDistPath);
    if (fs.existsSync(dist)) {
      app.use(express.static(dist, { index: false, maxAge: '1h' }));
      app.get(/^\/(?!api|health|socket\.io).*/, (_req, res, next) => {
        const index = path.join(dist, 'index.html');
        if (fs.existsSync(index)) res.sendFile(index);
        else next();
      });
      logger.info('serving built client', { dist });
    } else {
      logger.warn('SERVE_CLIENT enabled but client build is missing', { dist });
    }
  }

  app.use(notFoundHandler);
  app.use(errorHandler);

  // Prisma pool warm-up failure must be visible, not fatal at import time.
  void prisma.$transaction(async () => undefined).catch(error => logger.error(error, { context: 'prisma.warmup' }));

  return app;
}

function randomId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
