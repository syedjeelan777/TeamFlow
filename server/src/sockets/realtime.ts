import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import { config } from '../config/env.js';
import { logger } from '../config/logger.js';
import { prisma } from '../lib/prisma.js';
import { bindRoomLookup, presenceService } from '../services/presence.service.js';
import { bindSocketServer } from '../services/realtime.service.js';
import { verifyAccessToken } from '../utils/tokens.js';
import { REFRESH_COOKIE } from '../utils/tokens.js';
import { parse as parseCookie } from 'cookie';
import { SERVER_EVENTS, room } from '@teamflow/shared';
import { realtime } from '../services/realtime.service.js';
import { channelsService } from '../services/channels.service.js';
import { z } from 'zod';
import { isUuid } from '../lib/ids.js';

interface SocketUser {
  id: string;
  name: string;
  email: string;
}

const typingSchema = z.object({
  channelId: z.string().refine(isUuid, 'channelId must be an id'),
  isTyping: z.boolean(),
});

/** Per-socket throttle so a held-down key cannot flood the room. */
const TYPING_INTERVAL_MS = 1500;
const TYPING_TIMEOUT_MS = 4000;

export interface RealtimeHandle {
  io: Server;
  close: () => Promise<void>;
}

/**
 * Socket.IO layer.
 *
 * Security notes (spec §67): sockets are *not* a trusted mutation path. The
 * handshake authenticates a real access token, room joins are verified against
 * membership rows, and every state change still goes through the REST API.
 */
export function attachRealtime(httpServer: HttpServer): RealtimeHandle {
  const io = new Server(httpServer, {
    path: '/socket.io',
    cors: {
      origin: config.corsOrigins(),
      credentials: true,
    },
    serveClient: false,
    pingInterval: 20_000,
    pingTimeout: 25_000,
    connectionStateRecovery: { maxDisconnectionDuration: 120_000 },
  });

  io.use(async (socket, next) => {
    try {
      const user = await authenticate(socket);
      if (!user) {
        next(new Error('UNAUTHENTICATED'));
        return;
      }
      socket.data.user = user;
      const memberships = await prisma.workspaceMember.findMany({
        where: { userId: user.id },
        select: { workspaceId: true },
      });
      socket.data.workspaceIds = new Set<string>(memberships.map(m => m.workspaceId));
      next();
    } catch (error) {
      logger.error(error, { context: 'socket.handshake' });
      next(new Error('UNAUTHENTICATED'));
    }
  });

  io.on('connection', socket => {
    void onConnection(socket);
  });

  bindSocketServer(io);
  bindRoomLookup(roomName => {
    const adapter = io.sockets.adapter as { rooms?: Map<string, Set<string>> };
    const set = adapter.rooms?.get(roomName);
    return set ? [...set] : [];
  });

  logger.info('realtime ready', { rooms: 'workspace, project, channel, user' });

  return {
    io,
    close: async () => {
      await io.close();
      bindSocketServer(null);
    },
  };
}

async function authenticate(socket: Socket): Promise<SocketUser | null> {
  const handshake = socket.handshake;
  const authHeader = handshake.headers.authorization;
  let token: string | null = null;
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) token = authHeader.slice(7).trim();
  if (!token) {
    const provided = (handshake.auth ?? {}) as { token?: unknown };
    if (typeof provided.token === 'string' && provided.token) token = provided.token;
  }
  if (!token) {
    // Fallback: rotate the httpOnly refresh cookie for a short-lived access token.
    const cookieHeader = handshake.headers.cookie;
    if (!cookieHeader) return null;
    const parsed = parseCookie(cookieHeader);
    const refresh = parsed[REFRESH_COOKIE];
    if (!refresh) return null;
    const { authService } = await import('../services/auth.service.js');
    try {
      const rotated = await authService.refresh(refresh);
      token = rotated.accessToken;
      socket.data.rotatedRefresh = rotated.refreshToken;
    } catch (error) {
      logger.debug('socket cookie auth failed', { message: (error as Error).message });
      return null;
    }
  }
  if (!token) return null;

  const payload = verifyAccessToken(token);
  const session = await prisma.refreshToken.findFirst({ where: { id: payload.sid, revokedAt: null }, select: { id: true } });
  if (!session) return null;
  return { id: payload.sub, name: payload.name, email: payload.email };
}

async function onConnection(socket: Socket) {
  const user = socket.data.user as SocketUser;
  const workspaceIds = socket.data.workspaceIds as Set<string>;
  const typingAt = new Map<string, number>();
  const typingTimers = new Map<string, NodeJS.Timeout>();

  await socket.join(room.user(user.id));
  for (const workspaceId of workspaceIds) {
    await socket.join(room.workspace(workspaceId));
  }
  presenceService.addSocket(socket.id, user.id, [...workspaceIds]);

  logger.debug('socket connected', { socketId: socket.id, userId: user.id, workspaces: workspaceIds.size });

  socket.on('disconnect', reason => {
    for (const timer of typingTimers.values()) clearTimeout(timer);
    typingTimers.clear();
    presenceService.removeSocket(socket.id);
    logger.debug('socket disconnected', { socketId: socket.id, userId: user.id, reason });
  });

  /** Joining a project/channel room requires the same membership check as REST. */
  socket.on('workspace:join', async (payload: unknown) => {
    const workspaceId = typeof payload === 'string' ? payload : (payload as { workspaceId?: string })?.workspaceId;
    if (!workspaceId || !isUuid(workspaceId)) return;
    try {
      const membership = await prisma.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId, userId: user.id } },
        select: { id: true },
      });
      if (!membership) {
        socket.emit(SERVER_EVENTS.connectionError, { code: 'NOT_A_MEMBER', message: 'You are not a member of this workspace' });
        return;
      }
      (workspaceIds as Set<string>).add(workspaceId);
      await socket.join(room.workspace(workspaceId));
      presenceService.addWorkspace(socket.id, workspaceId);
    } catch (error) {
      logger.error(error, { context: 'socket.workspace:join' });
    }
  });

  socket.on('workspace:leave', async (payload: unknown) => {
    const workspaceId = typeof payload === 'string' ? payload : (payload as { workspaceId?: string })?.workspaceId;
    if (!workspaceId || !isUuid(workspaceId)) return;
    await socket.leave(room.workspace(workspaceId));
    (workspaceIds as Set<string>).delete(workspaceId);
    presenceService.removeWorkspace(socket.id, workspaceId);
  });

  socket.on('channel:join', async (payload: unknown) => {
    const channelId = typeof payload === 'string' ? payload : (payload as { channelId?: string })?.channelId;
    if (!channelId || !isUuid(channelId)) return;
    try {
      const { channel } = await channelsService.assertAccess(user.id, channelId);
      await socket.join(room.channel(channel.id));
      socket.emit('channel:joined', { channelId: channel.id });
    } catch (error) {
      socket.emit(SERVER_EVENTS.connectionError, { code: 'FORBIDDEN', message: (error as Error).message });
    }
  });

  socket.on('channel:leave', async (payload: unknown) => {
    const channelId = typeof payload === 'string' ? payload : (payload as { channelId?: string })?.channelId;
    if (!channelId || !isUuid(channelId)) return;
    await socket.leave(room.channel(channelId));
    socket.emit('typing:update', { channelId, isTyping: false, userId: user.id, name: user.name });
  });

  socket.on('project:join', async (payload: unknown) => {
    const projectId = typeof payload === 'string' ? payload : (payload as { projectId?: string })?.projectId;
    if (!projectId || !isUuid(projectId)) return;
    const { projectsService } = await import('../services/projects.service.js');
    try {
      const access = await projectsService.assertAccess(user.id, projectId);
      await socket.join(room.project(access.projectId));
    } catch {
      socket.emit(SERVER_EVENTS.connectionError, { code: 'FORBIDDEN', message: 'No access to that project' });
    }
  });

  socket.on('project:leave', async (payload: unknown) => {
    const projectId = typeof payload === 'string' ? payload : (payload as { projectId?: string })?.projectId;
    if (!projectId || !isUuid(projectId)) return;
    await socket.leave(room.project(projectId));
  });

  /**
   * Typing indicators are ephemeral: they are fanned out to the channel room
   * only, throttled per socket, and self-expire — never persisted.
   */
  socket.on('typing:update', async (payload: unknown) => {
    const parsed = typingSchema.safeParse(payload);
    if (!parsed.success) return;
    const { channelId, isTyping } = parsed.data;
    const now = Date.now();
    const last = typingAt.get(channelId) ?? 0;

    if (!isTyping) {
      typingAt.set(channelId, 0);
      clearTypingTimer(socket, typingTimers, typingAt, channelId);
      return;
    }
    if (now - last < TYPING_INTERVAL_MS) return;
    typingAt.set(channelId, now);

    // Only relay to sockets that actually joined the channel room.
    const channel = await prisma.channel.findUnique({ where: { id: channelId }, select: { workspaceId: true, id: true } });
    if (!channel || !workspaceIds.has(channel.workspaceId)) return;

    realtime.toRoom(room.channel(channelId), SERVER_EVENTS.typingUpdate, {
      workspaceId: channel.workspaceId,
      channelId,
      userId: user.id,
      name: user.name,
      isTyping: true,
      at: new Date(now).toISOString(),
    });

    const existing = typingTimers.get(channelId);
    if (existing) clearTimeout(existing);
    typingTimers.set(
      channelId,
      setTimeout(() => clearTypingTimer(socket, typingTimers, typingAt, channelId), TYPING_TIMEOUT_MS),
    );
  });
}

function clearTypingTimer(
  socket: Socket,
  timers: Map<string, NodeJS.Timeout>,
  typingAt: Map<string, number>,
  channelId: string,
) {
  const timer = timers.get(channelId);
  if (timer) clearTimeout(timer);
  timers.delete(channelId);
  typingAt.set(channelId, 0);
  socket.emit('typing:update', { channelId, userId: (socket.data.user as SocketUser).id, isTyping: false, name: (socket.data.user as SocketUser).name });
}
