import { SERVER_EVENTS, room } from '@teamflow/shared';
import type { Server as SocketServer } from 'socket.io';
import { logger } from '../config/logger.js';

/**
 * Realtime fan-out hub.
 *
 * Services publish *after* a database write has committed. Keeping the socket
 * server behind this tiny indirection means:
 *   • services never import the socket module (no circular deps)
 *   • unit/integration tests can run without a socket server at all
 *   • a socket failure can never break a REST mutation
 */
let io: SocketServer | null = null;

export function bindSocketServer(server: SocketServer | null) {
  io = server;
}

export function isRealtimeConnected(): boolean {
  return io !== null;
}

function publish(eventName: string, target: string, payload: unknown) {
  if (!io) {
    logger.debug('realtime skipped (no socket server bound)', { eventName, target });
    return;
  }
  io.to(target).emit(eventName, payload);
}

export const realtime = {
  /** Low-level: publish to an arbitrary room (used by the socket layer). */
  toRoom: <T>(roomName: string, eventName: string, payload: T) => publish(eventName, roomName, payload),
  toWorkspace: <T>(workspaceId: string, eventName: string, payload: T) =>
    publish(eventName, room.workspace(workspaceId), payload),
  toProject: <T>(projectId: string, eventName: string, payload: T) => publish(eventName, room.project(projectId), payload),
  toChannel: <T>(channelId: string, eventName: string, payload: T) => publish(eventName, room.channel(channelId), payload),
  toUser: <T>(userId: string, eventName: string, payload: T) => publish(eventName, room.user(userId), payload),
  /** Notification delivery to a single recipient, globally scoped. */
  notification: <T>(userId: string, payload: T) => publish(SERVER_EVENTS.notificationNew, room.user(userId), payload),
  presence: <T>(workspaceId: string, payload: T) => publish(SERVER_EVENTS.presenceUpdate, room.workspace(workspaceId), payload),
};
