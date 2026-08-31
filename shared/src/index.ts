/**
 * TeamFlow shared wire contract.
 *
 * Single source of truth for:
 *   • REST payload shapes (DTOs)
 *   • Socket.IO event names + event payload shapes
 *   • Enum literal unions that mirror the Prisma enums
 *
 * The server re-validates everything on the way in (Zod) — these types are a
 * contract, not a security boundary.
 */

/* ─────────────────────────────────────────────────────────────────────────────
 * Enums (must stay in sync with server/prisma/schema.prisma)
 * ──────────────────────────────────────────────────────────────────────────── */

export type WorkspaceRole = 'OWNER' | 'ADMIN' | 'MEMBER';
export type ProjectStatus = 'PLANNING' | 'ACTIVE' | 'ON_HOLD' | 'COMPLETED' | 'ARCHIVED';
export type TaskStatus = 'TODO' | 'IN_PROGRESS' | 'REVIEW' | 'DONE';
export type TaskPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
export type ChannelType = 'GENERAL' | 'PROJECT';
export type NotificationType =
  | 'TASK_ASSIGNED'
  | 'TASK_UPDATED'
  | 'TASK_COMMENTED'
  | 'TASK_DUE_SOON'
  | 'PROJECT_ADDED'
  | 'WORKSPACE_ROLE_CHANGED'
  | 'WORKSPACE_INVITED'
  | 'MENTION';
export type ActivityType =
  | 'WORKSPACE_CREATED'
  | 'WORKSPACE_UPDATED'
  | 'PROJECT_CREATED'
  | 'PROJECT_UPDATED'
  | 'PROJECT_ARCHIVED'
  | 'PROJECT_DELETED'
  | 'TASK_CREATED'
  | 'TASK_UPDATED'
  | 'TASK_ASSIGNED'
  | 'TASK_STATUS_CHANGED'
  | 'TASK_MOVED'
  | 'TASK_COMPLETED'
  | 'TASK_DELETED'
  | 'COMMENT_CREATED'
  | 'COMMENT_DELETED'
  | 'MEMBER_ADDED'
  | 'MEMBER_REMOVED'
  | 'ROLE_CHANGED'
  | 'INVITATION_CREATED'
  | 'MESSAGE_SENT';

export const TASK_STATUSES = ['TODO', 'IN_PROGRESS', 'REVIEW', 'DONE'] as const;
export const TASK_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const;
export const PROJECT_STATUSES = ['PLANNING', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'ARCHIVED'] as const;
export const WORKSPACE_ROLES = ['OWNER', 'ADMIN', 'MEMBER'] as const;

export const LABEL_COLORS = [
  'slate',
  'indigo',
  'violet',
  'sky',
  'emerald',
  'amber',
  'rose',
  'teal',
] as const;
export type LabelColor = (typeof LABEL_COLORS)[number];

/* ─────────────────────────────────────────────────────────────────────────────
 * REST envelope helpers
 * ──────────────────────────────────────────────────────────────────────────── */

export interface ApiErrorBody {
  success: false;
  error: { code: string; message: string; details?: unknown };
}

export interface ApiSuccessBody<T> {
  success: true;
  data: T;
}

export interface PageMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasNextPage: boolean;
}

export interface Paginated<T> {
  items: T[];
  meta: PageMeta;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * DTOs
 * ──────────────────────────────────────────────────────────────────────────── */

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  bio: string | null;
  createdAt: string;
  lastSeenAt?: string | null;
  /** Presence is served from the socket layer, never persisted as a "state". */
  presence?: 'online' | 'offline';
}

export interface AuthResponse {
  user: PublicUser;
  accessToken: string;
  accessTokenExpiresAt: string;
  /** Refresh token lives in an httpOnly cookie; only its expiry is exposed. */
  refreshExpiresAt: string;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  accentColor: string;
  role: WorkspaceRole;
  memberCount: number;
  projectCount: number;
  createdAt: string;
}

export interface WorkspaceMemberDto {
  id: string;
  role: WorkspaceRole;
  joinedAt: string;
  user: PublicUser;
}

export interface WorkspaceInvitationDto {
  id: string;
  email: string;
  role: WorkspaceRole;
  message: string | null;
  expiresAt: string;
  createdAt: string;
  invitedBy?: PublicUser | null;
}

export interface ProjectProgress {
  total: number;
  completed: number;
  percent: number;
  byStatus: Record<TaskStatus, number>;
}

export interface ProjectDto {
  id: string;
  workspaceId: string;
  key: string;
  name: string;
  description: string | null;
  status: ProjectStatus;
  color: string;
  startDate: string | null;
  dueDate: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  progress: ProjectProgress;
  memberCount: number;
  taskCount: number;
  overdueCount?: number;
  createdBy?: PublicUser | null;
  members?: WorkspaceMemberDto[];
  myRole?: WorkspaceRole | null;
}

export interface LabelDto {
  id: string;
  workspaceId: string;
  name: string;
  color: string;
}

export interface TaskRef {
  id: string;
  name: string;
  key: string;
  color: string;
}

export interface TaskDto {
  id: string;
  reference: string;
  projectId: string;
  workspaceId: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  position: number;
  dueDate: string | null;
  completedAt: string | null;
  estimate: number | null;
  createdAt: string;
  updatedAt: string;
  assignee: PublicUser | null;
  reporter: PublicUser;
  labels: LabelDto[];
  commentCount?: number;
  attachmentCount?: number;
  project?: TaskRef;
}

export interface CommentDto {
  id: string;
  taskId: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  editedAt: string | null;
  author: PublicUser;
}

export interface AttachmentDto {
  id: string;
  taskId: string;
  label: string;
  url: string;
  createdAt: string;
  addedBy: PublicUser;
}

export interface ChannelDto {
  id: string;
  workspaceId: string;
  name: string;
  topic: string | null;
  type: ChannelType;
  projectId: string | null;
  project?: TaskRef | null;
  lastMessageAt?: string | null;
  unreadCount?: number;
  memberCount?: number;
}

export interface MessageDto {
  id: string;
  channelId: string;
  body: string;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
  /** Stringified BigInt so JSON stays safe. */
  seq: string;
  author: PublicUser;
}

export interface NotificationDto {
  id: string;
  type: NotificationType;
  title: string;
  body: string | null;
  link: string | null;
  readAt: string | null;
  createdAt: string;
  workspaceId: string | null;
  actor?: PublicUser | null;
}

export interface ActivityDto {
  id: string;
  type: ActivityType;
  summary: string;
  createdAt: string;
  actor: PublicUser | null;
  taskId?: string | null;
  projectId?: string | null;
  metadata?: Record<string, unknown> | null;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Analytics
 * ──────────────────────────────────────────────────────────────────────────── */

export interface WorkspaceAnalytics {
  range: { days: number; from: string };
  totals: {
    projects: number;
    activeProjects: number;
    tasks: number;
    completedTasks: number;
    overdueTasks: number;
    dueSoonTasks: number;
    members: number;
    messagesThisWeek: number;
  };
  tasksByStatus: Array<{ status: TaskStatus; count: number }>;
  tasksByPriority: Array<{ priority: TaskPriority; count: number }>;
  completedPerWeek: Array<{ week: string; completed: number; created: number }>;
  tasksByMember: Array<{
    user: Pick<PublicUser, 'id' | 'name' | 'avatarUrl'>;
    total: number;
    completed: number;
    open: number;
    overdue: number;
  }>;
  projectProgress: Array<{
    id: string;
    name: string;
    key: string;
    color: string;
    status: ProjectStatus;
    total: number;
    completed: number;
    percent: number;
    overdue: number;
  }>;
  completedVsPending: { completed: number; pending: number };
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Realtime
 * ──────────────────────────────────────────────────────────────────────────── */

/** Client → server (all of these are re-authorised in `sockets/`). */
export const CLIENT_EVENTS = {
  workspaceJoin: 'workspace:join',
  workspaceLeave: 'workspace:leave',
  channelJoin: 'channel:join',
  channelLeave: 'channel:leave',
  typing: 'typing:update',
  messageSeen: 'message:seen',
} as const;

/** Server → client. */
export const SERVER_EVENTS = {
  taskCreated: 'task:created',
  taskUpdated: 'task:updated',
  taskMoved: 'task:moved',
  taskDeleted: 'task:deleted',
  commentCreated: 'comment:created',
  commentDeleted: 'comment:deleted',
  messageNew: 'message:new',
  messageUpdated: 'message:updated',
  messageDeleted: 'message:deleted',
  typingUpdate: 'typing:update',
  presenceUpdate: 'presence:update',
  notificationNew: 'notification:new',
  memberJoined: 'member:joined',
  memberRemoved: 'member:removed',
  roleChanged: 'role:changed',
  projectUpdated: 'project:updated',
  connectionError: 'connection:error',
} as const;

export interface TaskMutatedEvent {
  workspaceId: string;
  projectId: string;
  task: TaskDto;
}

export interface TaskMovedEvent extends TaskMutatedEvent {
  from: { status: TaskStatus; position: number };
  to: { status: TaskStatus; position: number };
  movedById: string;
  movedByName: string;
}

export interface TaskDeletedEvent {
  workspaceId: string;
  projectId: string;
  taskId: string;
  fromStatus: TaskStatus;
}

export interface CommentCreatedEvent {
  workspaceId: string;
  projectId: string;
  taskId: string;
  comment: CommentDto;
}

export interface CommentDeletedEvent {
  workspaceId: string;
  projectId: string;
  taskId: string;
  commentId: string;
}

export interface MessageEvent {
  workspaceId: string;
  channelId: string;
  message: MessageDto;
}

export interface MessageUpdatedEvent extends MessageEvent {
  messageId: string;
}

export interface MessageDeletedEvent {
  workspaceId: string;
  channelId: string;
  messageId: string;
}

export interface TypingEvent {
  workspaceId: string;
  channelId: string;
  userId: string;
  name: string;
  isTyping: boolean;
  at: string;
}

export interface PresenceEvent {
  workspaceId: string;
  userId: string;
  presence: 'online' | 'offline';
  lastSeenAt?: string | null;
}

export interface MemberEvent {
  workspaceId: string;
  member: WorkspaceMemberDto;
}

export interface ProjectUpdatedEvent {
  workspaceId: string;
  project: ProjectDto;
}

/** Rooms are derived from ids; these are the exact strings both sides use. */
export const room = {
  workspace: (workspaceId: string) => `workspace:${workspaceId}`,
  project: (projectId: string) => `project:${projectId}`,
  channel: (channelId: string) => `channel:${channelId}`,
  user: (userId: string) => `user:${userId}`,
} as const;
