import { prisma } from '../lib/prisma.js';
import { serialize } from '../lib/serialize.js';
import { workspacesService } from './workspaces.service.js';
import { projectsService } from './projects.service.js';
import type { TaskPriority, TaskStatus } from '../generated/prisma/enums.js';
import { TASK_PRIORITIES, TASK_STATUSES, type WorkspaceAnalytics } from '@teamflow/shared';

const DAY_MS = 24 * 60 * 60 * 1000;

const mondayOf = (date: Date) => {
  const value = new Date(date);
  value.setUTCHours(0, 0, 0, 0);
  value.setUTCDate(value.getUTCDate() - ((value.getUTCDay() + 6) % 7));
  return value;
};

/**
 * Workspace analytics. Every number is a live aggregate over PostgreSQL
 * (Prisma `groupBy`/`count` plus one indexed `date_trunc` query for weekly
 * throughput) — nothing is estimated or hardcoded.
 */
export const analyticsService = {
  async workspace(userId: string, workspaceId: string, rangeDays = 84): Promise<WorkspaceAnalytics> {
    await workspacesService.assertMembership(userId, workspaceId);

    const now = new Date();
    const weekStart = mondayOf(now);
    const rangeFrom = new Date(weekStart.getTime() - Math.max(0, rangeDays - 7) * DAY_MS);
    const soonCutoff = new Date(now.getTime() + 7 * DAY_MS);

    const projectRows = await prisma.project.findMany({
      where: { workspaceId, archivedAt: null },
      select: { id: true, name: true, key: true, color: true, status: true },
      orderBy: { updatedAt: 'desc' },
      take: 12,
    });
    const projectIds = projectRows.map(row => row.id);

    const [
      projects,
      activeProjects,
      tasks,
      completedTasks,
      overdueTasks,
      dueSoonTasks,
      members,
      messagesThisWeek,
      statusGroups,
      priorityGroups,
      completedPerWeek,
      memberGroups,
      projectTaskGroups,
      projectOverdueGroups,
    ] = await Promise.all([
      prisma.project.count({ where: { workspaceId, archivedAt: null } }),
      prisma.project.count({ where: { workspaceId, archivedAt: null, status: 'ACTIVE' } }),
      prisma.task.count({ where: { workspaceId } }),
      prisma.task.count({ where: { workspaceId, status: 'DONE' } }),
      prisma.task.count({ where: { workspaceId, status: { not: 'DONE' }, dueDate: { lt: now } } }),
      prisma.task.count({ where: { workspaceId, status: { not: 'DONE' }, dueDate: { gte: now, lte: soonCutoff } } }),
      prisma.workspaceMember.count({ where: { workspaceId } }),
      prisma.message.count({ where: { channel: { workspaceId }, deletedAt: null, createdAt: { gte: weekStart } } }),
      prisma.task.groupBy({ by: ['status'], where: { workspaceId }, _count: { _all: true } }),
      prisma.task.groupBy({ by: ['priority'], where: { workspaceId, status: { not: 'DONE' } }, _count: { _all: true } }),
      prisma.$queryRaw<Array<{ bucket: Date; completed: bigint; created: bigint }>>`
        SELECT date_trunc('week', bucket)::date AS bucket,
               SUM(completed)::bigint            AS completed,
               SUM(created)::bigint              AS created
        FROM (
          SELECT date_trunc('week', "completedAt") AS bucket, 1 AS completed, 0 AS created
          FROM "Task"
          WHERE "workspaceId" = ${workspaceId}::uuid
            AND "completedAt" IS NOT NULL
            AND "completedAt" >= ${rangeFrom} AND "completedAt" <= ${now}
          UNION ALL
          SELECT date_trunc('week', "createdAt") AS bucket, 0 AS completed, 1 AS created
          FROM "Task"
          WHERE "workspaceId" = ${workspaceId}::uuid
            AND "createdAt" >= ${rangeFrom} AND "createdAt" <= ${now}
        ) weekly
        GROUP BY 1
        ORDER BY 1 ASC`,
      prisma.task.groupBy({
        by: ['assigneeId'],
        where: { workspaceId, assigneeId: { not: null } },
        _count: { _all: true },
      }),
      projectIds.length
        ? prisma.task.groupBy({ by: ['projectId', 'status'], where: { projectId: { in: projectIds } }, _count: { _all: true } })
        : Promise.resolve([]),
      projectIds.length
        ? prisma.task.groupBy({
            by: ['projectId'],
            where: { projectId: { in: projectIds }, status: { not: 'DONE' }, dueDate: { lt: now } },
            _count: { _all: true },
          })
        : Promise.resolve([]),
    ]);

    const assigneeIds = [...memberGroups]
      .sort((a, b) => b._count._all - a._count._all)
      .slice(0, 8)
      .map(row => row.assigneeId as string)
      .filter(Boolean);
    const [assigneeUsers, completedByUser, overdueByUser] = await Promise.all([
      assigneeIds.length
        ? prisma.user.findMany({ where: { id: { in: assigneeIds } }, select: { id: true, name: true, avatarUrl: true } })
        : Promise.resolve([]),
      assigneeIds.length
        ? prisma.task.groupBy({
            by: ['assigneeId'],
            where: { workspaceId, status: 'DONE', assigneeId: { in: assigneeIds } },
            _count: { _all: true },
          })
        : Promise.resolve([]),
      assigneeIds.length
        ? prisma.task.groupBy({
            by: ['assigneeId'],
            where: { workspaceId, status: { not: 'DONE' }, dueDate: { lt: now }, assigneeId: { in: assigneeIds } },
            _count: { _all: true },
          })
        : Promise.resolve([]),
    ]);

    const byStatus = new Map<string, number>(statusGroups.map(row => [row.status as string, row._count._all]));
    const taskMatrix = new Map<string, { total: number; completed: number }>();
    for (const row of projectTaskGroups) {
      const key = row.projectId as string;
      const entry = taskMatrix.get(key) ?? { total: 0, completed: 0 };
      entry.total += row._count._all;
      if (row.status === 'DONE') entry.completed += row._count._all;
      taskMatrix.set(key, entry);
    }
    const overdueMatrix = new Map(projectOverdueGroups.map(row => [row.projectId as string, row._count._all]));

    const analytics: WorkspaceAnalytics = {
      range: { days: rangeDays, from: rangeFrom.toISOString() },
      totals: {
        projects,
        activeProjects,
        tasks,
        completedTasks,
        overdueTasks,
        dueSoonTasks,
        members,
        messagesThisWeek,
      },
      tasksByStatus: TASK_STATUSES.map(status => ({ status, count: byStatus.get(status) ?? 0 })),
      tasksByPriority: TASK_PRIORITIES.map(priority => ({
        priority,
        count: priorityGroups.find(row => row.priority === priority)?._count._all ?? 0,
      })),
      completedPerWeek: completedPerWeek.map(row => ({
        week: new Date(row.bucket).toISOString().slice(0, 10),
        completed: Number(row.completed),
        created: Number(row.created),
      })),
      tasksByMember: assigneeIds
        .map(assigneeId => {
          const user = assigneeUsers.find(candidate => candidate.id === assigneeId);
          const group = memberGroups.find(row => row.assigneeId === assigneeId);
          if (!user || !group) return null;
          const completed = completedByUser.find(row => row.assigneeId === assigneeId)?._count._all ?? 0;
          const overdue = overdueByUser.find(row => row.assigneeId === assigneeId)?._count._all ?? 0;
          return {
            user: { id: user.id, name: user.name, avatarUrl: user.avatarUrl },
            total: group._count._all,
            completed,
            open: group._count._all - completed,
            overdue,
          };
        })
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null),
      projectProgress: projectRows.map(project => {
        const entry = taskMatrix.get(project.id) ?? { total: 0, completed: 0 };
        return {
          id: project.id,
          name: project.name,
          key: project.key,
          color: project.color,
          status: project.status,
          total: entry.total,
          completed: entry.completed,
          percent: entry.total === 0 ? 0 : Math.round((entry.completed / entry.total) * 100),
          overdue: overdueMatrix.get(project.id) ?? 0,
        };
      }),
      completedVsPending: { completed: completedTasks, pending: Math.max(tasks - completedTasks, 0) },
    };
    return serialize(analytics) as WorkspaceAnalytics;
  },

  async project(userId: string, projectId: string) {
    await projectsService.assertAccess(userId, projectId);
    const [total, statusGroups, priorityGroups, memberCount, overdue] = await Promise.all([
      prisma.task.count({ where: { projectId } }),
      prisma.task.groupBy({ by: ['status'], where: { projectId }, _count: { _all: true } }),
      prisma.task.groupBy({ by: ['priority'], where: { projectId, status: { not: 'DONE' } }, _count: { _all: true } }),
      prisma.projectMember.count({ where: { projectId } }),
      prisma.task.count({ where: { projectId, status: { not: 'DONE' }, dueDate: { lt: new Date() } } }),
    ]);
    const byStatus = TASK_STATUSES.map(status => ({
      status,
      count: statusGroups.find(row => row.status === status)?._count._all ?? 0,
    })) as Array<{ status: TaskStatus; count: number }>;
    const completed = byStatus.find(row => row.status === 'DONE')?.count ?? 0;
    return serialize({
      total,
      completed,
      percent: total === 0 ? 0 : Math.round((completed / total) * 100),
      members: memberCount,
      overdue,
      byStatus,
      byPriority: TASK_PRIORITIES.map(priority => ({
        priority,
        count: priorityGroups.find(row => row.priority === priority)?._count._all ?? 0,
      })) as Array<{ priority: TaskPriority; count: number }>,
    });
  },
};
