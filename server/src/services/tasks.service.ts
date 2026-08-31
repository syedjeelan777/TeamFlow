import { AppError, ERROR_CODES, conflict, forbidden, notFound } from '../lib/errors.js';
import { prisma, type TransactionClient } from '../lib/prisma.js';
import { minimalUserSelect, publicUser, publicUserSelect, serialize } from '../lib/serialize.js';
import { authorize, can, canDeleteTask, canEditTask } from '../lib/permissions.js';
import type { TaskPriority, TaskStatus, WorkspaceRole } from '../generated/prisma/enums.js';
import { activityService } from './activity.service.js';
import { notificationsService } from './notifications.service.js';
import { projectsService } from './projects.service.js';
import { workspacesService } from './workspaces.service.js';
import { realtime } from './realtime.service.js';
import { logger } from '../config/logger.js';
import type {
  CreateTaskInput,
  MoveTaskInput,
  TaskBoardQueryInput,
  TaskListQueryInput,
  UpdateTaskInput,
} from '../validators/task.schema.js';
import { SERVER_EVENTS, TASK_STATUSES } from '@teamflow/shared';
import type { LabelDto, TaskDto } from '@teamflow/shared';

const labelSelect = { label: { select: { id: true, name: true, color: true, workspaceId: true } } } as const;

const taskInclude = {
  assignee: { select: publicUserSelect },
  reporter: { select: publicUserSelect },
  labels: { select: { label: { select: { id: true, name: true, color: true, workspaceId: true } } } },
  project: { select: { id: true, name: true, key: true, color: true } },
  _count: { select: { comments: true, attachments: true } },
} as const;

type RawTask = {
  id: string;
  reference: string;
  projectId: string;
  workspaceId: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  position: number;
  dueDate: Date | null;
  completedAt: Date | null;
  estimate: number | null;
  createdAt: Date;
  updatedAt: Date;
  assignee: Parameters<typeof publicUser>[0] | null;
  reporter: Parameters<typeof publicUser>[0];
  labels: { label: LabelDto }[];
  project: { id: string; name: string; key: string; color: string };
  _count: { comments: number; attachments: number };
};

/** Prisma rows carry `Date`; `serialize()` turns them into ISO strings later. */
type DateOrString = Date | string;
export type TaskRowDto = Omit<TaskDto, 'createdAt' | 'updatedAt' | 'dueDate' | 'completedAt'> & {
  createdAt: DateOrString;
  updatedAt: DateOrString;
  dueDate: DateOrString | null;
  completedAt: DateOrString | null;
};

export function taskDto(task: RawTask): TaskRowDto {
  return {
    id: task.id,
    reference: task.reference,
    projectId: task.projectId,
    workspaceId: task.workspaceId,
    title: task.title,
    description: task.description,
    status: task.status,
    priority: task.priority,
    position: task.position,
    dueDate: task.dueDate,
    completedAt: task.completedAt,
    estimate: task.estimate,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    assignee: task.assignee ? publicUser(task.assignee) : null,
    reporter: publicUser(task.reporter),
    labels: task.labels.map(entry => entry.label),
    project: task.project,
    commentCount: task._count.comments,
    attachmentCount: task._count.attachments,
  };
}

function dueFilter(due: TaskListQueryInput['due']) {
  const now = new Date();
  const endOfToday = new Date(now);
  endOfToday.setUTCHours(23, 59, 59, 999);
  switch (due) {
    case 'overdue':
      return { dueDate: { lt: new Date(now.getTime() - 0) }, status: { not: 'DONE' as TaskStatus } };
    case 'today':
      return { dueDate: { lte: endOfToday } };
    case 'week':
      return { dueDate: { lte: new Date(endOfToday.getTime() + 6 * 24 * 60 * 60 * 1000) } };
    case 'upcoming':
      return { dueDate: { gt: endOfToday } };
    case 'none':
      return { dueDate: null };
    default:
      return {};
  }
}

/** Board filters shared by the project board and the workspace-wide board. */
function boardFilter(query: TaskBoardQueryInput, userId: string): Record<string, unknown> {
  const filter: Record<string, unknown> = {};
  if (query.priority?.length) filter.priority = { in: query.priority };
  if (query.labelId) filter.labels = { some: { labelId: query.labelId } };
  if (query.assigneeId === 'me') filter.assigneeId = userId;
  else if (query.assigneeId === 'unassigned') filter.assigneeId = null;
  else if (query.assigneeId) filter.assigneeId = query.assigneeId;
  if (query.search) {
    filter.OR = [
      { title: { contains: query.search, mode: 'insensitive' } },
      { reference: { contains: query.search.toUpperCase(), mode: 'insensitive' } },
    ];
  }
  return filter;
}

export const tasksService = {
  taskInclude,
  taskDto,

  /** Verifies that `userId` may see/modify a task, returning the project scope. */
  async assertAccess(userId: string, taskId: string, tx: TransactionClient = prisma) {
    const task = await tx.task.findUnique({
      where: { id: taskId },
      select: {
        id: true,
        workspaceId: true,
        projectId: true,
        status: true,
        position: true,
        assigneeId: true,
        reporterId: true,
        title: true,
        reference: true,
      },
    });
    if (!task) throw notFound('Task not found', ERROR_CODES.TASK_NOT_FOUND);
    const membership = await tx.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: task.workspaceId, userId } },
      select: { role: true },
    });
    if (!membership) throw new AppError(ERROR_CODES.NOT_A_MEMBER, 'You are not a member of this workspace', 403);
    return { task, role: membership.role as WorkspaceRole };
  },

  async list(userId: string, query: TaskListQueryInput) {
    const where: Record<string, unknown> = {};
    if (query.workspaceId) where.workspaceId = query.workspaceId;
    if (query.projectId) where.projectId = query.projectId;
    if (query.status?.length) where.status = { in: query.status };
    if (query.priority?.length) where.priority = { in: query.priority };
    if (query.labelId) where.labels = { some: { labelId: query.labelId } };
    Object.assign(where, dueFilter(query.due));

    if (query.search) {
      where.OR = [
        { title: { contains: query.search, mode: 'insensitive' } },
        { reference: { contains: query.search.toUpperCase(), mode: 'insensitive' } },
        { description: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    if (query.assigneeId === 'me') where.assigneeId = userId;
    else if (query.assigneeId === 'unassigned') where.assigneeId = null;
    else if (query.assigneeId) where.assigneeId = query.assigneeId;
    else if (!query.projectId && !query.workspaceId) {
      // Without an explicit scope, default to "everything touching me".
      where.OR = where.OR ? [...(where.OR as unknown[]), { assigneeId: userId }, { reporterId: userId }] : [{ assigneeId: userId }, { reporterId: userId }];
    }

    const orderBy =
      query.sort === 'dueDate'
        ? [{ dueDate: { sort: 'asc', nulls: 'last' } }, { position: 'asc' }]
        : query.sort === 'priority'
          ? [{ priority: 'desc' }, { position: 'asc' }]
          : query.sort === 'created'
            ? [{ createdAt: 'desc' }]
            : [{ status: 'asc' }, { position: 'asc' }];

    const [rows, total] = await Promise.all([
      prisma.task.findMany({
        where: where as never,
        orderBy: orderBy as never,
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: taskInclude,
      }),
      prisma.task.count({ where: where as never }),
    ]);

    return {
      items: serialize(rows.map(task => taskDto(task as unknown as RawTask))),
      meta: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
        hasNextPage: query.page * query.pageSize < total,
      },
    };
  },

  /**
   * Whole workspace board in three queries (projects, labels, tasks) rather
   * than one board query per project — the same shape as `board()` plus the
   * project grouping the multi-project view needs.
   */
  async workspaceBoard(userId: string, workspaceId: string, query: TaskBoardQueryInput) {
    const { role } = await workspacesService.assertMembership(userId, workspaceId);
    const isManager = can(role, 'project:update');

    const projects = await prisma.project.findMany({
      where: {
        workspaceId,
        archivedAt: null,
        ...(isManager ? {} : { OR: [{ members: { some: { userId } } }, { createdById: userId }] }),
      },
      select: { id: true, name: true, key: true, color: true },
      orderBy: { updatedAt: 'desc' },
    });
    const projectIds = projects.map(project => project.id);

    const [rows, labels] = await Promise.all([
      projectIds.length
        ? prisma.task.findMany({
            where: { projectId: { in: projectIds }, ...boardFilter(query, userId) } as never,
            orderBy: [{ position: 'asc' }],
            include: taskInclude,
          })
        : Promise.resolve([]),
      prisma.label.findMany({
        where: { workspaceId },
        orderBy: { name: 'asc' },
        select: { id: true, name: true, color: true, workspaceId: true },
      }),
    ]);

    const columns = TASK_STATUSES.reduce<Record<TaskStatus, TaskRowDto[]>>(
      (acc, status) => ({ ...acc, [status]: [] }),
      {} as Record<TaskStatus, TaskRowDto[]>,
    );

    for (const row of rows as unknown as RawTask[]) {
      const dto = taskDto(row);
      columns[row.status].push(dto);
    }

    return serialize({
      workspaceId,
      projectIds,
      projects,
      labels: labels as LabelDto[],
      columns,
      counts: TASK_STATUSES.reduce<Record<string, number>>(
        (acc, status) => ({ ...acc, [status]: columns[status].length }),
        {},
      ),
      role,
    });
  },

  /** Whole board for one project (no pagination: a board column is bounded). */
  async board(userId: string, projectId: string, query: TaskBoardQueryInput) {
    const access = await projectsService.assertAccess(userId, projectId);
    const where: Record<string, unknown> = { projectId };
    if (query.priority?.length) where.priority = { in: query.priority };
    if (query.labelId) where.labels = { some: { labelId: query.labelId } };
    if (query.assigneeId === 'me') where.assigneeId = userId;
    else if (query.assigneeId === 'unassigned') where.assigneeId = null;
    else if (query.assigneeId) where.assigneeId = query.assigneeId;
    if (query.search) {
      where.OR = [
        { title: { contains: query.search, mode: 'insensitive' } },
        { reference: { contains: query.search.toUpperCase(), mode: 'insensitive' } },
      ];
    }

    const [rows, labels] = await Promise.all([
      prisma.task.findMany({ where: where as never, orderBy: [{ position: 'asc' }], include: taskInclude }),
      prisma.label.findMany({
        where: { workspaceId: access.workspaceId },
        orderBy: { name: 'asc' },
        select: { id: true, name: true, color: true, workspaceId: true },
      }),
    ]);

    const columns: Record<TaskStatus, TaskRowDto[]> = { TODO: [], IN_PROGRESS: [], REVIEW: [], DONE: [] };
    for (const row of rows) columns[(row as RawTask).status].push(taskDto(row as unknown as RawTask));

    return serialize({
      workspaceId: access.workspaceId,
      projectId,
      project: { id: access.project.id, name: access.project.name, key: access.project.key, color: access.project.color ?? 'indigo' },
      role: access.role,
      labels: labels as LabelDto[],
      columns,
      counts: TASK_STATUSES.reduce<Record<string, number>>((acc, status) => ({ ...acc, [status]: columns[status].length }), {}),
    });
  },

  async get(userId: string, taskId: string) {
    const { role } = await this.assertAccess(userId, taskId);
    const task = await prisma.task.findUnique({ where: { id: taskId }, include: taskInclude });
    if (!task) throw notFound('Task not found', ERROR_CODES.TASK_NOT_FOUND);
    return serialize({ ...taskDto(task as unknown as RawTask), canEdit: canEditTask(role, userId, task), canDelete: canDeleteTask(role, userId, task) });
  },

  async create(userId: string, projectId: string, input: CreateTaskInput) {
    const access = await projectsService.assertAccess(userId, projectId);
    authorize(access.role, 'task:create', { message: 'You cannot create tasks in this workspace' });
    if (input.assigneeId) await this.assertAssignable(access.workspaceId, input.assigneeId);
    await this.assertLabels(access.workspaceId, input.labelIds);

    const created = await prisma.$transaction(async tx => {
      const status = (input.status ?? 'TODO') as TaskStatus;
      const position = input.position ?? (await this.nextPosition(tx, projectId, status));
      const reference = await this.nextReference(tx, projectId, access.project.key);
      const task = await tx.task.create({
        data: {
          projectId,
          workspaceId: access.workspaceId,
          reference,
          title: input.title,
          description: input.description ?? null,
          status,
          priority: (input.priority ?? 'MEDIUM') as TaskPriority,
          position,
          dueDate: (input.dueDate as Date | null | undefined) ?? null,
          estimate: input.estimate ?? null,
          assigneeId: input.assigneeId ?? null,
          reporterId: userId,
          completedAt: status === 'DONE' ? new Date() : null,
          labels: input.labelIds?.length ? { create: input.labelIds.map(labelId => ({ labelId })) } : undefined,
        },
        select: { id: true },
      });
      await activityService.recordInTransaction(tx, {
        workspaceId: access.workspaceId,
        projectId,
        taskId: task.id,
        actorId: userId,
        type: 'TASK_CREATED',
        summary: `${reference} created`,
        metadata: { title: input.title, status },
      });
      const pending =
        input.assigneeId && input.assigneeId !== userId
          ? await notificationsService.createMany(tx, [
              {
                recipientId: input.assigneeId,
                workspaceId: access.workspaceId,
                projectId,
                taskId: task.id,
                type: 'TASK_ASSIGNED',
                title: `You were assigned ${reference}`,
                body: input.title,
                actorId: userId,
                link: `/app/workspaces/${access.workspaceId}/projects/${projectId}/tasks/${task.id}`,
              },
            ])
          : [];
      return { id: task.id, reference, pending };
    });

    const task = await prisma.task.findUniqueOrThrow({ where: { id: created.id }, include: taskInclude });
    const dto = serialize(taskDto(task as unknown as RawTask));
    await notificationsService.deliverAll(created.pending);
    realtime.toProject(projectId, SERVER_EVENTS.taskCreated, { workspaceId: access.workspaceId, projectId, task: dto });
    realtime.toWorkspace(access.workspaceId, SERVER_EVENTS.taskCreated, { workspaceId: access.workspaceId, projectId, task: dto });
    logger.info('task created', { taskId: created.id, reference: created.reference, projectId, by: userId });
    return dto;
  },

  async update(userId: string, taskId: string, input: UpdateTaskInput) {
    const { task, role } = await this.assertAccess(userId, taskId);
    if (!canEditTask(role, userId, task)) {
      throw forbidden('Only the assignee, reporter or a workspace manager can edit this task');
    }
    if (input.assigneeId) await this.assertAssignable(task.workspaceId, input.assigneeId);

    const data: Record<string, unknown> = {};
    if (input.title !== undefined) data.title = input.title;
    if (input.description !== undefined) data.description = input.description;
    if (input.priority) data.priority = input.priority;
    if (input.dueDate !== undefined) data.dueDate = input.dueDate ?? null;
    if (input.estimate !== undefined) data.estimate = input.estimate ?? null;
    if (input.assigneeId !== undefined) data.assigneeId = input.assigneeId ?? null;

    const statusChanged = !!input.status && input.status !== task.status;
    const completedNow = statusChanged && input.status === 'DONE';
    if (statusChanged) {
      data.status = input.status;
      data.position = await this.nextPosition(prisma, task.projectId, input.status as TaskStatus);
      data.completedAt = completedNow ? new Date() : null;
    }

    const { pending } = await prisma.$transaction(async tx => {
      await tx.task.update({ where: { id: taskId }, data: data as never });
      const actor = await tx.user.findUnique({ where: { id: userId }, select: { name: true } });
      const actorName = actor?.name ?? 'Someone';
      if (statusChanged) {
        await activityService.recordInTransaction(tx, {
          workspaceId: task.workspaceId,
          projectId: task.projectId,
          taskId,
          actorId: userId,
          type: completedNow ? 'TASK_COMPLETED' : 'TASK_STATUS_CHANGED',
          summary: `${actorName} moved ${task.reference} ${completedNow ? 'to Done' : `to ${String(input.status).replace('_', ' ')}`}`,
          metadata: { from: task.status, to: input.status },
        });
      } else {
        await activityService.recordInTransaction(tx, {
          workspaceId: task.workspaceId,
          projectId: task.projectId,
          taskId,
          actorId: userId,
          type: 'TASK_UPDATED',
          summary: `${actorName} updated ${task.reference}`,
          metadata: { fields: Object.keys(data) },
        });
      }

      // Notify whoever newly owns the work (and drop the previous assignee if changed).
      const recipients = new Set<string>();
      if (input.assigneeId) recipients.add(input.assigneeId);
      const newlyUnassigned = input.assigneeId === null || (input.assigneeId && input.assigneeId !== task.assigneeId);
      if (task.assigneeId && newlyUnassigned && task.assigneeId !== userId) recipients.add(task.assigneeId);
      const list = [...recipients].filter(id => id !== userId);

      const pending = list.length
        ? await notificationsService.createMany(
            tx,
            list.map(recipientId => ({
              recipientId,
              workspaceId: task.workspaceId,
              projectId: task.projectId,
              taskId,
              type: recipientId === input.assigneeId ? ('TASK_ASSIGNED' as const) : ('TASK_UPDATED' as const),
              title:
                recipientId === input.assigneeId
                  ? `You were assigned ${task.reference}`
                  : statusChanged
                    ? `${task.reference} moved to ${String(input.status).replace('_', ' ')}`
                    : `${task.reference} was updated`,
              body: input.title ?? task.title,
              actorId: userId,
              link: `/app/workspaces/${task.workspaceId}/projects/${task.projectId}/tasks/${taskId}`,
            })),
          )
        : [];
      return { pending };
    });

    const updated = await prisma.task.findUniqueOrThrow({ where: { id: taskId }, include: taskInclude });
    const dto = serialize(taskDto(updated as unknown as RawTask));
    await notificationsService.deliverAll(pending);

    realtime.toProject(task.projectId, SERVER_EVENTS.taskUpdated, { workspaceId: task.workspaceId, projectId: task.projectId, task: dto });
    realtime.toWorkspace(task.workspaceId, SERVER_EVENTS.taskUpdated, { workspaceId: task.workspaceId, projectId: task.projectId, task: dto });
    return { ...dto, canEdit: true, canDelete: canDeleteTask(role, userId, updated) };
  },

  async remove(userId: string, taskId: string) {
    const { task, role } = await this.assertAccess(userId, taskId);
    const taskRow = await prisma.task.findUniqueOrThrow({ where: { id: taskId }, select: { assigneeId: true, reporterId: true } });
    if (!canDeleteTask(role, userId, { assigneeId: taskRow.assigneeId, reporterId: taskRow.reporterId })) {
      throw forbidden('Only the reporter or a workspace manager can delete this task');
    }
    await prisma.$transaction(async tx => {
      await tx.task.delete({ where: { id: taskId } });
      await activityService.recordInTransaction(tx, {
        workspaceId: task.workspaceId,
        projectId: task.projectId,
        actorId: userId,
        type: 'TASK_DELETED',
        summary: `${task.reference} was deleted`,
        metadata: { title: task.title },
      });
    });
    realtime.toProject(task.projectId, SERVER_EVENTS.taskDeleted, {
      workspaceId: task.workspaceId,
      projectId: task.projectId,
      taskId,
      fromStatus: task.status,
    });
    realtime.toWorkspace(task.workspaceId, SERVER_EVENTS.taskDeleted, {
      workspaceId: task.workspaceId,
      projectId: task.projectId,
      taskId,
      fromStatus: task.status,
    });
    return { id: taskId };
  },

  /**
   * Kanban move — the only place allowed to rewrite ordering.
   * Ordering is persisted as a contiguous 0..n-1 sequence per (project, status).
   */
  async move(userId: string, taskId: string, input: MoveTaskInput) {
    const { task, role } = await this.assertAccess(userId, taskId);
    const taskFull = await prisma.task.findUniqueOrThrow({
      where: { id: taskId },
      select: { assigneeId: true, reporterId: true, status: true, position: true, projectId: true },
    });
    if (!canEditTask(role, userId, taskFull)) throw forbidden('You cannot move this task');
    if (input.expectedFromStatus && input.expectedFromStatus !== task.status) {
      throw conflict('This task moved since you last saw it — the board was refreshed', 'TASK_STALE_MOVE', {
        currentStatus: task.status,
      });
    }

    const targetProjectId = input.projectId ?? task.projectId;
    const targetStatus = input.status as TaskStatus;
    const crossColumn = targetStatus !== task.status;

    const movedNotifications: { id: string; recipientId: string }[] = [];
    const moved = await prisma.$transaction(async tx => {
      if (input.projectId && input.projectId !== task.projectId) {
        await this.assertProjectMove(tx, userId, task.workspaceId, input.projectId);
        await tx.task.update({ where: { id: taskId }, data: { projectId: input.projectId } });
      }

      const siblings = await tx.task.findMany({
        where: { projectId: targetProjectId, status: targetStatus, id: { not: taskId } },
        orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
        select: { id: true, position: true },
      });

      let insertAt = input.position ?? siblings.length;
      if (input.beforeTaskId) {
        const index = siblings.findIndex(s => s.id === input.beforeTaskId);
        if (index >= 0) insertAt = index;
      } else if (input.afterTaskId) {
        const index = siblings.findIndex(s => s.id === input.afterTaskId);
        if (index >= 0) insertAt = index + 1;
      }
      insertAt = Math.max(0, Math.min(insertAt, siblings.length));

      const ordered = siblings.map(s => s.id);
      ordered.splice(insertAt, 0, taskId);

      const operations: Promise<unknown>[] = [
        tx.task.update({
          where: { id: taskId },
          data: {
            status: targetStatus,
            position: insertAt,
            completedAt: targetStatus === 'DONE' ? taskFull.status === 'DONE' ? undefined : new Date() : null,
          } as never,
        }),
      ];
      for (const [index, id] of ordered.entries()) {
        if (id === taskId) continue;
        operations.push(tx.task.update({ where: { id }, data: { position: index } }));
      }
      await Promise.all(operations);

      if (crossColumn) {
        const actor = await tx.user.findUnique({ where: { id: userId }, select: { name: true } });
        await activityService.recordInTransaction(tx, {
          workspaceId: task.workspaceId,
          projectId: targetProjectId,
          taskId,
          actorId: userId,
          type: targetStatus === 'DONE' ? 'TASK_COMPLETED' : 'TASK_MOVED',
          summary: `${actor?.name ?? 'Someone'} moved ${task.reference} from ${task.status.replace('_', ' ')} to ${targetStatus.replace('_', ' ')}`,
          metadata: { from: task.status, to: targetStatus, fromPosition: task.position },
        });
        if (targetStatus === 'DONE' || task.status === 'DONE') {
          const recipients = [...new Set([taskFull.assigneeId, taskFull.reporterId].filter((id): id is string => !!id && id !== userId))];
          if (recipients.length) {
            const created = await notificationsService.createMany(tx, recipients.map(recipientId => ({
              recipientId,
              workspaceId: task.workspaceId,
              projectId: targetProjectId,
              taskId,
              type: 'TASK_UPDATED' as const,
              title: `${task.reference} was moved to ${targetStatus.replace('_', ' ')}`,
              body: task.title,
              actorId: userId,
              link: `/app/workspaces/${task.workspaceId}/projects/${targetProjectId}/tasks/${taskId}`,
            })));
            movedNotifications.push(...created);
          }
        }
      }
      return { insertAt, orderedIds: ordered, movedNotifications };
    });

    const [updated, actor] = await Promise.all([
      prisma.task.findUniqueOrThrow({ where: { id: taskId }, include: taskInclude }),
      prisma.user.findUnique({ where: { id: userId }, select: { name: true } }),
    ]);
    const movedBy = actor?.name ?? 'A teammate';
    const dto = serialize(taskDto(updated as unknown as RawTask));
    const event = {
      workspaceId: task.workspaceId,
      projectId: targetProjectId,
      task: dto,
      from: { status: task.status, position: task.position },
      to: { status: targetStatus, position: moved.insertAt },
      movedById: userId,
      movedByName: movedBy,
    };
    realtime.toProject(targetProjectId, SERVER_EVENTS.taskMoved, event);
    if (task.projectId !== targetProjectId) {
      realtime.toProject(task.projectId, SERVER_EVENTS.taskMoved, event);
    }
    realtime.toWorkspace(task.workspaceId, SERVER_EVENTS.taskMoved, event);
    if (movedNotifications.length) await notificationsService.deliverAll(movedNotifications);
    return dto;
  },

  async setLabels(userId: string, taskId: string, labelIds: string[]) {
    const { task, role } = await this.assertAccess(userId, taskId);
    const current = await prisma.task.findUniqueOrThrow({ where: { id: taskId }, select: { assigneeId: true, reporterId: true } });
    if (!canEditTask(role, userId, current)) throw forbidden('You cannot edit this task');
    await this.assertLabels(task.workspaceId, labelIds);
    await prisma.$transaction([
      prisma.taskLabel.deleteMany({ where: { taskId } }),
      ...(labelIds.length ? [prisma.taskLabel.createMany({ data: labelIds.map(labelId => ({ taskId, labelId })), skipDuplicates: true })] : []),
    ]);
    const updated = await prisma.task.findUniqueOrThrow({ where: { id: taskId }, include: taskInclude });
    const dto = serialize(taskDto(updated as unknown as RawTask));
    realtime.toProject(task.projectId, SERVER_EVENTS.taskUpdated, { workspaceId: task.workspaceId, projectId: task.projectId, task: dto });
    return dto;
  },

  async toggleLabel(userId: string, taskId: string, labelId: string, attach: boolean) {
    const { task } = await this.assertAccess(userId, taskId);
    await this.assertLabels(task.workspaceId, [labelId]);
    if (attach) {
      await prisma.taskLabel.upsert({ where: { taskId_labelId: { taskId, labelId } }, update: {}, create: { taskId, labelId } });
    } else {
      await prisma.taskLabel.deleteMany({ where: { taskId, labelId } });
    }
    const updated = await prisma.task.findUniqueOrThrow({ where: { id: taskId }, include: taskInclude });
    const dto = serialize(taskDto(updated as unknown as RawTask));
    realtime.toProject(task.projectId, SERVER_EVENTS.taskUpdated, { workspaceId: task.workspaceId, projectId: task.projectId, task: dto });
    return dto;
  },

  /* ─────────────────────────────── labels ─────────────────────────────── */

  async listLabels(userId: string, workspaceId: string) {
    await requireWorkspaceMember(userId, workspaceId);
    const labels = await prisma.label.findMany({
      where: { workspaceId },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, color: true, workspaceId: true },
    });
    return serialize(labels);
  },

  async createLabel(userId: string, workspaceId: string, name: string, color: string) {
    const role = await requireWorkspaceMember(userId, workspaceId);
    authorize(role, 'label:manage', { message: 'Only owners and admins can create labels' });
    const existing = await prisma.label.findFirst({ where: { workspaceId, name: { equals: name, mode: 'insensitive' } }, select: { id: true } });
    if (existing) throw conflict(`A label named "${name}" already exists`);
    const label = await prisma.label.create({ data: { workspaceId, name, color }, select: { id: true, name: true, color: true, workspaceId: true } });
    return serialize(label);
  },

  async updateLabel(userId: string, labelId: string, data: { name?: string; color?: string }) {
    const label = await prisma.label.findUnique({ where: { id: labelId }, select: { id: true, workspaceId: true } });
    if (!label) throw notFound('Label not found');
    const role = await requireWorkspaceMember(userId, label.workspaceId);
    authorize(role, 'label:manage');
    const updated = await prisma.label.update({
      where: { id: labelId },
      data: { ...(data.name ? { name: data.name } : {}), ...(data.color ? { color: data.color } : {}) },
      select: { id: true, name: true, color: true, workspaceId: true },
    });
    return serialize(updated);
  },

  async deleteLabel(userId: string, labelId: string) {
    const label = await prisma.label.findUnique({ where: { id: labelId }, select: { id: true, workspaceId: true } });
    if (!label) throw notFound('Label not found');
    const role = await requireWorkspaceMember(userId, label.workspaceId);
    authorize(role, 'label:manage');
    await prisma.label.delete({ where: { id: labelId } });
    return { id: labelId };
  },

  /** Assignees must belong to the workspace — blocks cross-workspace IDOR. */
  async assertAssignable(workspaceId: string, userIdToAssign: string) {
    const member = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: userIdToAssign }, },
      select: { id: true },
    });
    if (!member) throw forbidden('That user is not a member of this workspace', 'ASSIGNEE_NOT_MEMBER');
    return member;
  },

  async assertLabels(workspaceId: string, labelIds?: string[]) {
    if (!labelIds?.length) return;
    const count = await prisma.label.count({ where: { id: { in: labelIds }, workspaceId } });
    if (count !== labelIds.length) throw forbidden('One of the labels does not belong to this workspace', 'LABEL_NOT_IN_WORKSPACE');
  },

  async nextPosition(tx: TransactionClient, projectId: string, status: TaskStatus) {
    const agg = await tx.task.aggregate({ where: { projectId, status }, _max: { position: true }, _count: { _all: true } });
    return Math.max((agg._max.position ?? -1) + 1, agg._count._all);
  },

  async nextReference(tx: TransactionClient, projectId: string, projectKey: string) {
    const rows = await tx.task.findMany({ where: { projectId }, select: { reference: true }, orderBy: { reference: 'desc' }, take: 500 });
    let max = 0;
    for (const row of rows) {
      const match = /^([A-Z0-9]+)-(\d+)$/.exec(row.reference);
      if (match?.[2]) max = Math.max(max, Number(match[2]));
    }
    return `${projectKey}-${max + 1}`;
  },

  async assertProjectMove(tx: TransactionClient, userId: string, workspaceId: string, targetProjectId: string) {
    const project = await tx.project.findUnique({ where: { id: targetProjectId }, select: { id: true, workspaceId: true } });
    if (!project || project.workspaceId !== workspaceId) throw forbidden('You cannot move tasks across workspaces');
    await tx.projectMember.upsert({
      where: { projectId_userId: { projectId: targetProjectId, userId } },
      update: {},
      create: { projectId: targetProjectId, userId },
    });
  },
};

async function requireWorkspaceMember(userId: string, workspaceId: string): Promise<WorkspaceRole> {
  const membership = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
    select: { role: true },
  });
  if (!membership) throw new AppError(ERROR_CODES.NOT_A_MEMBER, 'You are not a member of this workspace', 403);
  return membership.role;
}

export { requireWorkspaceMember, minimalUserSelect };
