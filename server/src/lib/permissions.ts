import { AppError, ERROR_CODES } from '../lib/errors.js';
import type { WorkspaceRole } from '../generated/prisma/enums.js';

/**
 * Centralised RBAC matrix.
 *
 * This is the *only* place where role → capability mapping lives. Controllers
 * call `authorize(role, capability)`; nothing compares roles directly except
 * the helpers in this file, which keeps privilege logic from drifting across
 * the codebase.
 */
export const CAPABILITIES = [
  'workspace:update',
  'workspace:delete',
  'workspace:transfer',
  'member:invite',
  'member:remove',
  'member:changeRole',
  'project:create',
  'project:update',
  'project:delete',
  'project:archive',
  'project:manageMembers',
  'task:create',
  'task:update:any',
  'task:delete:any',
  'task:update:own',
  'comment:create',
  'comment:moderate',
  'channel:create',
  'message:delete:any',
  'label:manage',
  'analytics:view',
  'settings:manage',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

const MATRIX: Record<WorkspaceRole, ReadonlySet<Capability>> = {
  OWNER: new Set<Capability>(CAPABILITIES),
  ADMIN: new Set<Capability>([
    'workspace:update',
    'member:invite',
    'member:remove',
    'member:changeRole',
    'project:create',
    'project:update',
    'project:delete',
    'project:archive',
    'project:manageMembers',
    'task:create',
    'task:update:any',
    'task:delete:any',
    'task:update:own',
    'comment:create',
    'comment:moderate',
    'channel:create',
    'message:delete:any',
    'label:manage',
    'analytics:view',
    'settings:manage',
  ]),
  MEMBER: new Set<Capability>(['task:create', 'task:update:own', 'comment:create', 'analytics:view', 'project:manageMembers']),
};

/** Owners and admins can change roles; a member never can — including their own. */
const ROLE_HIERARCHY: Record<WorkspaceRole, number> = { OWNER: 30, ADMIN: 20, MEMBER: 10 };

export function can(role: WorkspaceRole | null | undefined, capability: Capability): boolean {
  if (!role) return false;
  return MATRIX[role]?.has(capability) ?? false;
}

export function hasWorkspaceRole(memberRole: WorkspaceRole | null | undefined): boolean {
  return memberRole === 'OWNER' || memberRole === 'ADMIN' || memberRole === 'MEMBER';
}

export function isWorkspaceManager(role: WorkspaceRole | null | undefined): boolean {
  return role === 'OWNER' || role === 'ADMIN';
}

export function roleAtLeast(role: WorkspaceRole | null | undefined, minimum: WorkspaceRole): boolean {
  if (!role) return false;
  return ROLE_HIERARCHY[role] >= ROLE_HIERARCHY[minimum];
}

/**
 * Throws a 403 `PERMISSION_DENIED` when `role` lacks `capability`.
 * `own` allows a member to act on a resource they own (e.g. their own task).
 */
export function authorize(
  role: WorkspaceRole | null | undefined,
  capability: Capability,
  options: { message?: string } = {},
): void {
  if (!role) {
    throw new AppError(ERROR_CODES.NOT_A_MEMBER, 'You are not a member of this workspace', 403);
  }
  if (!can(role, capability)) {
    throw new AppError(ERROR_CODES.PERMISSION_DENIED, options.message ?? `Your role (${role}) cannot perform: ${capability}`, 403);
  }
}

/**
 * Members may edit their own tasks; managers may edit any task.
 * Keeps the "task:update:own vs task:update:any" rule in one place.
 */
export function canEditTask(
  role: WorkspaceRole | null | undefined,
  actorId: string,
  task: { assigneeId: string | null; reporterId: string },
): boolean {
  if (can(role, 'task:update:any')) return true;
  if (!can(role, 'task:update:own')) return false;
  return task.assigneeId === actorId || task.reporterId === actorId;
}

export function canDeleteTask(role: WorkspaceRole | null | undefined, actorId: string, task: { assigneeId: string | null; reporterId: string }): boolean {
  if (can(role, 'task:delete:any')) return true;
  return task.reporterId === actorId;
}

/** Managers (and the owner themself) may remove a member; never below OWNER. */
export function canManageTargetRole(actorRole: WorkspaceRole, targetRole: WorkspaceRole, isSelf: boolean): boolean {
  if (isSelf) return true;
  if (actorRole === 'OWNER') return true;
  if (actorRole === 'ADMIN') return targetRole !== 'OWNER';
  return false;
}

export const ROLE_WEIGHT = ROLE_HIERARCHY;
