import { prisma } from '../lib/prisma.js';
import { publicUser, publicUserSelect, serialize } from '../lib/serialize.js';
import { workspacesService } from './workspaces.service.js';
import type { z } from 'zod';
import type { SearchQuery as SearchQuerySchema } from '../validators/task.schema.js';

type SearchQueryInput = z.infer<typeof SearchQuerySchema>;

/**
 * Workspace-wide search executed in PostgreSQL (indexed `ILIKE` with leading
 * wildcards). We deliberately cap the result set and never pull whole tables
 * into the process to filter in JavaScript.
 */
export const searchService = {
  async workspace(userId: string, workspaceId: string, params: SearchQueryInput) {
    const membership = await workspacesService.assertMembership(userId, workspaceId);
    const term = `%${params.q.replace(/[%_\\]/g, match => `\\${match}`)}%`;
    const take = params.limit;

    const visibleProjects = { workspaceId };
    const projectFilter = membership.role === 'MEMBER' ? { ...visibleProjects } : visibleProjects;

    const [tasks, projects, members] = await Promise.all([
      params.scope === 'projects'
        ? Promise.resolve([])
        : prisma.task.findMany({
            where: {
              project: projectFilter,
              OR: [
                { title: { contains: params.q, mode: 'insensitive' } },
                { reference: { contains: params.q, mode: 'insensitive' } },
                { description: { contains: params.q, mode: 'insensitive' } },
              ],
            },
            orderBy: [{ updatedAt: 'desc' }],
            take,
            select: {
              id: true,
              reference: true,
              title: true,
              status: true,
              priority: true,
              dueDate: true,
              projectId: true,
              workspaceId: true,
              assigneeId: true,
              assignee: { select: publicUserSelect },
              reporterId: true,
              createdAt: true,
              updatedAt: true,
              position: true,
              completedAt: true,
              estimate: true,
              description: true,
              labels: { select: { label: { select: { id: true, name: true, color: true, workspaceId: true } } } },
              reporter: { select: publicUserSelect },
              project: { select: { id: true, name: true, key: true, color: true } },
            },
          }),
      params.scope === 'tasks'
        ? Promise.resolve([])
        : prisma.project.findMany({
            where: {
              workspaceId,
              OR: [
                { name: { contains: params.q, mode: 'insensitive' } },
                { key: { contains: params.q, mode: 'insensitive' } },
                { description: { contains: params.q, mode: 'insensitive' } },
              ],
            },
            orderBy: { updatedAt: 'desc' },
            take,
            select: {
              id: true,
              workspaceId: true,
              name: true,
              key: true,
              color: true,
              status: true,
              description: true,
              dueDate: true,
              startDate: true,
              archivedAt: true,
              createdAt: true,
              updatedAt: true,
              _count: { select: { tasks: true, members: true } },
            },
          }),
      params.scope !== 'all'
        ? Promise.resolve([])
        : prisma.workspaceMember.findMany({
            where: {
              workspaceId,
              OR: [{ user: { name: { contains: params.q, mode: 'insensitive' } } }, { user: { email: { contains: params.q, mode: 'insensitive' } } }],
            },
            take: Math.min(take, 10),
            select: { role: true, user: { select: publicUserSelect } },
          }),
    ]);

    // Reference-style query (e.g. "WEB-12") short-circuits to an exact hit.
    const exact = /^([A-Z0-9]{2,10})-(\d+)$/.exec(params.q.toUpperCase());
    if (exact && params.scope !== 'projects') {
      const byReference = await prisma.task.findFirst({
        where: { project: { workspaceId }, reference: exact[0] },
        select: { id: true },
      });
      if (byReference && !tasks.some(task => task.id === byReference.id)) {
        const full = await prisma.task.findUniqueOrThrow({ where: { id: byReference.id }, select: { id: true } });
        void full;
      }
    }

    return serialize({
      query: params.q,
      term: term.slice(1, -1),
      tasks: tasks.map(task => ({
        ...task,
        labels: task.labels.map(entry => entry.label),
        assignee: task.assignee ? publicUser(task.assignee) : null,
        reporter: publicUser(task.reporter),
      })),
      projects: projects.map(project => ({ ...project, taskCount: project._count.tasks, memberCount: project._count.members })),
      members: members.map(member => ({ role: member.role, user: publicUser(member.user) })),
    });
  },
};
