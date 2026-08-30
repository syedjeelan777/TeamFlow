import { prisma } from '../lib/prisma.js';
import { logger } from '../config/logger.js';
import { realtime } from './realtime.service.js';

/**
 * Ephemeral presence.
 *
 * Deliberately *not* stored in PostgreSQL: who is connected right now is
 * derived from live socket connections. The only thing we persist is a
 * throttled `lastSeenAt` stamp so the team list can show "active 12m ago".
 */
interface Connection {
  userId: string;
  socketId: string;
  workspaces: Set<string>;
}

const connections = new Map<string, Connection>();
const userSockets = new Map<string, Set<string>>();
let lastSeenWrite = 0;
const LAST_SEEN_WRITE_INTERVAL_MS = 60_000;

export const presenceService = {
  addSocket(socketId: string, userId: string, workspaces: string[] = []) {
    const connection: Connection = { userId, socketId, workspaces: new Set(workspaces) };
    connections.set(socketId, connection);
    const set = userSockets.get(userId) ?? new Set<string>();
    set.add(socketId);
    userSockets.set(userId, set);
    void touchLastSeen(userId);
  },

  addWorkspace(socketId: string, workspaceId: string) {
    const connection = connections.get(socketId);
    if (!connection) return;
    const alreadyOnline = connection.workspaces.size > 0;
    connection.workspaces.add(workspaceId);
    if (!alreadyOnline) broadcastPresence(connection, 'online');
  },

  removeWorkspace(socketId: string, workspaceId: string) {
    const connection = connections.get(socketId);
    if (!connection) return;
    connection.workspaces.delete(workspaceId);
  },

  removeSocket(socketId: string) {
    const connection = connections.get(socketId);
    if (!connection) return;
    const remaining = connection.workspaces.size;
    connections.delete(socketId);
    const set = userSockets.get(connection.userId);
    if (set) {
      set.delete(socketId);
      if (set.size === 0) userSockets.delete(connection.userId);
    }
    // Only report offline when this was the user's last workspace-attached socket.
    const stillOnline = (userSockets.get(connection.userId)?.size ?? 0) > 0;
    if (remaining > 0 && !stillOnline) broadcastPresence(connection, 'offline');
    void touchLastSeen(connection.userId, true);
  },

  isOnline(userId: string): boolean {
    return (userSockets.get(userId)?.size ?? 0) > 0;
  },

  onlineUserIds(): string[] {
    return [...userSockets.keys()];
  },

  onlineUserIdsInWorkspace(workspaceId: string): string[] {
    const ids = new Set<string>();
    for (const connection of connections.values()) {
      if (connection.workspaces.has(workspaceId)) ids.add(connection.userId);
    }
    return [...ids];
  },

  /** Users currently viewing a channel (used by typing indicators). */
  channelViewers(channelId: string): string[] {
    const socketIds = realtimeSocketIdsInRoom(channelId);
    const users = new Set<string>();
    for (const socketId of socketIds) {
      const connection = connections.get(socketId);
      if (connection) users.add(connection.userId);
    }
    return [...users];
  },

  stats() {
    return { sockets: connections.size, users: userSockets.size };
  },

  /** Test helper. */
  reset() {
    connections.clear();
    userSockets.clear();
  },
};

// The socket layer registers a room-lookup callback so presence can ask
// "who is in this room" without importing socket.io internals here.
let roomLookup: ((room: string) => string[]) | null = null;
export function bindRoomLookup(fn: (room: string) => string[]) {
  roomLookup = fn;
}
function realtimeSocketIdsInRoom(roomName: string): string[] {
  try {
    return roomLookup ? roomLookup(`channel:${roomName}`) : [];
  } catch (error) {
    logger.error(error, { context: 'presence.roomLookup', roomName });
    return [];
  }
}

function broadcastPresence(connection: Connection, presence: 'online' | 'offline') {
  for (const workspaceId of connection.workspaces) {
    realtime.presence(workspaceId, { workspaceId, userId: connection.userId, presence });
  }
}

async function touchLastSeen(userId: string, force = false) {
  const now = Date.now();
  if (!force && now - lastSeenWrite < LAST_SEEN_WRITE_INTERVAL_MS) return;
  lastSeenWrite = now;
  try {
    await prisma.user.update({ where: { id: userId }, data: { lastSeenAt: new Date() } });
  } catch (error) {
    // Presence bookkeeping must never break a socket connection.
    logger.error(error, { context: 'presence.touchLastSeen', userId });
  }
}
