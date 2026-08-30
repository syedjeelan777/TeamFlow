import { createHash, randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, type ActivityType, type NotificationType, type TaskPriority, type TaskStatus } from '../src/generated/prisma/client.js';
import '../src/config/env.js';

/**
 * Development seed — realistic, database-backed demo data.
 *
 * • Deterministic (seeded PRNG) so screenshots/dashboards are reproducible.
 * • Dates are relative to "today" so analytics windows always have data.
 * • Refuses to run against a production database.
 */

const DAY = 24 * 60 * 60 * 1000;
const now = new Date();
const daysFromNow = (days: number, hour = 10) => {
  const value = new Date(now.getTime() + days * DAY);
  value.setUTCHours(hour, (Math.abs(days) * 7) % 60, 0, 0);
  return value;
};

let seedState = 20260830;
const rand = () => {
  seedState = (seedState * 1103515245 + 12345) & 0x7fffffff;
  return seedState / 0x7fffffff;
};
const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)] as T;
const chance = (probability: number) => rand() < probability;
const int = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));

const DEMO_PASSWORD = 'Teamflow#2026';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const USERS = [
  { key: 'amara', email: 'amara@teamflow.dev', name: 'Amara Osei', role: 'OWNER' as const, bio: 'Product lead. Keeps the roadmap honest.' },
  { key: 'rahim', email: 'rahim@teamflow.dev', name: 'Rahim Karim', role: 'ADMIN' as const, bio: 'Full-stack engineer, board-tickler.' },
  { key: 'lena', email: 'lena@teamflow.dev', name: 'Lena Fischer', role: 'MEMBER' as const, bio: 'Frontend + design systems.' },
  { key: 'marco', email: 'marco@teamflow.dev', name: 'Marco Bianchi', role: 'MEMBER' as const, bio: 'Backend, data, and reliability.' },
  { key: 'priya', email: 'priya@teamflow.dev', name: 'Priya Nair', role: 'MEMBER' as const, bio: 'QA automation and release checks.' },
];

const WORKSPACES = [
  {
    key: 'northwind',
    name: 'Northwind Product',
    slug: 'northwind-product',
    description: 'The core TeamFlow product squad: web app, API and realtime infra.',
    accentColor: 'indigo',
    projects: [
      {
        key: 'WEB',
        name: 'Web Client',
        color: 'indigo',
        status: 'ACTIVE' as const,
        description: 'React 19 + Vite client: boards, chat, notifications and the design system.',
        tasks: [
          ['Kanban drag & drop with optimistic rollback', 'Wire dnd-kit to the move endpoint and revert the local state when the API rejects.'],
          ['Persist card ordering per column', 'Positions must survive a reload; the move service rewrites neighbours in one transaction.'],
          ['Task detail drawer', 'Description, assignee, labels, comments and activity in one panel.'],
          ['Realtime board updates', 'Apply task:moved socket events into the TanStack Query cache without refetching.'],
          ['Notification centre', 'Grouped list with unread markers, mark-all-read and deep links.'],
          ['Presence indicators', 'Show online teammates in the team list and chat header.'],
          ['Typing indicator throttling', 'Debounce socket writes and expire the badge after 4s of silence.'],
          ['Command palette search', 'Backend search over tasks and projects with keyboard navigation.'],
          ['Board filter chips', 'Filter by priority, assignee and label — server-side, not client-side.'],
          ['Responsive sidebar drawer', 'Off-canvas navigation below 1024px with focus trapping.'],
          ['Skeleton loading states', 'Contextual skeletons per surface instead of one global spinner.'],
          ['Accessible dialogs', 'Focus trap, escape to close and labelled controls.'],
        ],
      },
      {
        key: 'API',
        name: 'Core API',
        color: 'violet',
        status: 'ACTIVE' as const,
        description: 'Express 5 + Prisma API with RBAC, transactions and realtime fan-out.',
        tasks: [
          ['Refresh token rotation', 'Rotate on every refresh and revoke the family on token reuse.'],
          ['Workspace membership guard', 'Every nested route resolves membership from the database.'],
          ['Centralise the permission matrix', 'Single capability map consumed by all controllers.'],
          ['Analytics aggregation queries', 'groupBy + date_trunc aggregates instead of loading rows into memory.'],
          ['Comment mention parsing', '@name mentions create notifications for workspace members.'],
          ['Move endpoint concurrency check', 'Reject stale drags with TASK_STALE_MOVE so the board can refresh.'],
          ['Structured error responses', 'Consistent { success: false, error: { code } } everywhere.'],
          ['Rate limit credential routes', 'Tighter buckets for login/refresh/register.'],
          ['Prisma migration workflow', 'Committed SQL migrations plus _prisma_migrations bookkeeping.'],
          ['Socket authorisation on joins', 'Room joins re-check membership; never trust the client.'],
        ],
      },
      {
        key: 'RT',
        name: 'Realtime & Chat',
        color: 'teal',
        status: 'PLANNING' as const,
        description: 'Socket.IO rooms, message pagination and presence.',
        tasks: [
          ['Channel message pagination', 'Cursor-based (seq) so history loads bounded pages.'],
          ['Presence fan-out', 'Broadcast join/leave to the workspace room only.'],
          ['Reconnect recovery', 'Refetch affected queries after a socket reconnect.'],
          ['Delivery guarantees', 'Never emit a socket event before the DB commit succeeds.'],
        ],
      },
      {
        key: 'OPS',
        name: 'Infrastructure',
        color: 'amber',
        status: 'ON_HOLD' as const,
        description: 'Deployment, backups and observability for the platform.',
        tasks: [
          ['Docker Compose for Postgres', 'Optional local stack; never a blocker for development.'],
          ['Structured log shipping', 'JSON logs already emitted; wire a collector.'],
          ['Nightly database snapshot', 'pg_dump + retention policy.'],
        ],
      },
    ],
  },
  {
    key: 'growth',
    name: 'Growth Studio',
    slug: 'growth-studio',
    description: 'Marketing site, onboarding and lifecycle experiments.',
    accentColor: 'rose',
    projects: [
      {
        key: 'SITE',
        name: 'Marketing Site',
        color: 'rose',
        status: 'ACTIVE' as const,
        description: 'Landing page and product tour for TeamFlow.',
        tasks: [
          ['Landing hero copy', 'Focus on realtime collaboration, not generic kanban claims.'],
          ['Product screenshots', 'Capture authenticated views for the feature sections.'],
          ['Pricing table experiment', 'A/B test annual-first layout.'],
          ['Docs page', 'Setup, API overview and architecture.'],
        ],
      },
      {
        key: 'ONB',
        name: 'Onboarding',
        color: 'sky',
        status: 'COMPLETED' as const,
        description: 'First-run experience: workspace creation and invitations.',
        tasks: [
          ['Empty states everywhere', 'Every list explains what to do next.'],
          ['Invitation flow', 'Email invite, accept link, membership creation.'],
        ],
      },
    ],
  },
];

const LABELS = [
  ['Feature', 'indigo'],
  ['Bug', 'rose'],
  ['Design', 'violet'],
  ['Performance', 'amber'],
  ['Security', 'teal'],
  ['Chore', 'slate'],
  ['Docs', 'sky'],
] as const;

const COMMENT_BODIES = [
  'Pushed a first pass — the optimistic rollback is the tricky part.',
  'Can we reuse the board filter state in the list view too?',
  'This blocks the release, raising the priority.',
  'Left review notes, mostly about the transaction boundaries.',
  'Nice. I added an index for the ordering query as discussed.',
  'Reproduced once, then it stopped. Watching the logs.',
  'Docs updated with the new endpoint contract.',
  'Suggest splitting this into two tasks: API and UI wiring.',
];

const CHAT_MESSAGES: Record<string, string[]> = {
  general: [
    'Morning! Board v2 is deployed to staging.',
    'Anyone else seeing the demo workspace seeded twice?',
    'That was me — fixed, the seed is idempotent now.',
    'Reminder: standup notes live in the Web Client project.',
    'Analytics dashboard is showing real numbers now, no more placeholders 🎉',
  ],
  development: [
    'Move endpoint now rejects stale drags with TASK_STALE_MOVE.',
    'That is a good pattern — the client just refetches the column.',
    'Socket events are emitted strictly after the transaction commits.',
    'I added a regression test for the ordering rewrite.',
  ],
  frontend: [
    'dnd-kit is wired; keyboard dragging works with the sortable preset.',
    'Do we want column virtualisation? 500+ cards feels fine at 60fps to me.',
    'Let us keep the board dense — fewer shadows, more information.',
  ],
  backend: [
    'Prisma 7 with the pg driver adapter — no engine binary needed at runtime.',
    'Aggregations run through groupBy, one query per metric.',
    'Auth: access token 15m, rotating refresh cookie, sessions revocable.',
  ],
  testing: [
    'Added coverage for workspace access denial and task moves.',
    'Chat pagination test needs a bigger fixture set — 120 messages.',
    'All green locally, running the full suite now.',
  ],
};

async function main() {
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_SEED_IN_PRODUCTION !== 'true') {
    throw new Error('Refusing to seed a production database. Set ALLOW_SEED_IN_PRODUCTION=true to override.');
  }

  console.log('→ seeding TeamFlow demo data');
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);

  // Idempotency: wipe the demo accounts and everything they own.
  const demoUserIds = USERS.map(() => null);
  void demoUserIds;
  const existingUsers = await prisma.user.findMany({ where: { email: { in: USERS.map(u => u.email) } }, select: { id: true, email: true } });
  for (const user of existingUsers) {
    const owned = await prisma.workspaceMember.findMany({ where: { userId: user.id }, select: { workspaceId: true } });
    const workspaceIds = [...new Set(owned.map(m => m.workspaceId))];
    if (workspaceIds.length) {
      await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
    }
    await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);
  }

  const userRows = new Map<string, { id: string; name: string }>();
  for (const spec of USERS) {
    const user = await prisma.user.create({
      data: { email: spec.email, name: spec.name, passwordHash, bio: spec.bio, lastSeenAt: daysFromNow(0, int(8, 18)) },
      select: { id: true, name: true },
    });
    userRows.set(spec.key, user);
  }
  const users = [...userRows.values()];
  const byKey = (key: string) => {
    const user = userRows.get(key);
    if (!user) throw new Error(`unknown seeded user ${key}`);
    return user;
  };

  for (const wsSpec of WORKSPACES) {
    const owner = byKey(wsSpec.key === 'northwind' ? 'amara' : 'priya');
    const workspace = await prisma.workspace.create({
      data: {
        name: wsSpec.name,
        slug: wsSpec.slug,
        description: wsSpec.description,
        accentColor: wsSpec.accentColor,
        creatorId: owner.id,
        members: {
          create: users.map((user, index) => ({
            userId: user.id,
            role: index === 0 && wsSpec.key === 'northwind' ? 'OWNER' : index === 1 ? 'ADMIN' : 'MEMBER',
            joinedAt: daysFromNow(-120 + index * 3),
          })),
        },
      },
    });

    const membership = await prisma.workspaceMember.findMany({ where: { workspaceId: workspace.id }, select: { id: true, userId: true } });

    // Labels
    const labelIds = new Map<string, string>();
    for (const [name, color] of LABELS) {
      const label = await prisma.label.create({ data: { workspaceId: workspace.id, name, color }, select: { id: true } });
      labelIds.set(name, label.id);
    }

    // Channels
    const channelNames = Object.keys(CHAT_MESSAGES);
    for (const name of channelNames) {
      const channel = await prisma.channel.create({ data: { workspaceId: workspace.id, name, type: 'GENERAL' } });
      const bodies = CHAT_MESSAGES[name] ?? [];
      let createdAt = now.getTime() - 3 * DAY;
      for (const [index, body] of bodies.entries()) {
        createdAt += int(20, 260) * 60 * 1000;
        const author = users[index % users.length]!;
        await prisma.message.create({
          data: {
            channelId: channel.id,
            authorId: author.id,
            body,
            createdAt: new Date(Math.min(createdAt, now.getTime() - int(1, 90) * 60 * 1000)),
            editedAt: chance(0.15) ? new Date(createdAt + 60_000) : null,
          },
        });
      }
    }

    let taskCounter = 0;
    for (const projectSpec of wsSpec.projects) {
      const project = await prisma.project.create({
        data: {
          workspaceId: workspace.id,
          key: projectSpec.key,
          name: projectSpec.name,
          description: projectSpec.description,
          status: projectSpec.status,
          color: projectSpec.color,
          createdById: owner.id,
          startDate: daysFromNow(-int(40, 90)),
          dueDate: daysFromNow(int(5, 60)),
          createdAt: daysFromNow(-int(45, 100)),
          members: { create: membership.slice(0, int(2, 4)).map(m => ({ userId: m.userId })) },
        },
      });

      const projectMembers = await prisma.projectMember.findMany({ where: { projectId: project.id }, select: { userId: true } });
      const memberIds = projectMembers.map(m => m.userId);
      const positions: Record<TaskStatus, number> = { TODO: 0, IN_PROGRESS: 0, REVIEW: 0, DONE: 0 };
      const createdTaskIds: string[] = [];

      for (const [index, [title = 'Untitled task', description]] of projectSpec.tasks.entries()) {
        const isCompleted = projectSpec.status === 'COMPLETED' ? true : chance(index < 3 ? 0.35 : 0.5);
        const status: TaskStatus = isCompleted ? 'DONE' : pick<TaskStatus>(['TODO', 'TODO', 'IN_PROGRESS', 'IN_PROGRESS', 'REVIEW']);
        const priority: TaskPriority = pick<TaskPriority>(['LOW', 'MEDIUM', 'MEDIUM', 'HIGH', 'HIGH', 'URGENT']);
        const dueOffset = isCompleted ? -int(2, 25) : chance(0.3) ? -int(1, 6) : int(1, 30);
        const assigneeId = memberIds.length && chance(0.85) ? (pick(memberIds) as string) : null;
        const labelNames = [...labelIds.keys()].filter(() => chance(0.25)).slice(0, 2);
        taskCounter += 1;
        positions[status] += 1;

        const task = await prisma.task.create({
          data: {
            id: randomUUID(),
            reference: `${projectSpec.key}-${taskCounter}`,
            projectId: project.id,
            workspaceId: workspace.id,
            title,
            description: `${description ?? title}\n\nAcceptance criteria:\n• Behaviour is covered by an automated test.\n• Empty, loading and error states are handled in the UI.`,
            status,
            priority,
            position: positions[status] - 1,
            dueDate: daysFromNow(dueOffset),
            completedAt: isCompleted ? daysFromNow(-int(1, 20)) : null,
            estimate: pick([1, 2, 3, 5, 8]),
            assigneeId,
            reporterId: owner.id,
            createdAt: daysFromNow(-int(5, 70)),
            labels: { create: labelNames.filter(name => labelIds.has(name)).map(name => ({ labelId: labelIds.get(name) as string })) },
          },
          select: { id: true, reference: true, title: true, assigneeId: true, status: true, workspaceId: true, projectId: true },
        });
        createdTaskIds.push(task.id);

        if (task.assigneeId) {
          await prisma.notification.create({
            data: {
              recipientId: task.assigneeId,
              workspaceId: workspace.id,
              projectId: project.id,
              taskId: task.id,
              type: 'TASK_ASSIGNED' as NotificationType,
              title: `You were assigned ${task.reference}`,
              body: task.title,
              actorId: owner.id,
              link: `/app/workspaces/${workspace.id}/projects/${project.id}/tasks/${task.id}`,
              createdAt: daysFromNow(-int(1, 12)),
              readAt: chance(0.5) ? daysFromNow(-int(0, 5)) : null,
            },
          });
        }

        const commentCount = isCompleted ? int(1, 3) : int(0, 2);
        for (let c = 0; c < commentCount; c += 1) {
          const author = pick(users) as { id: string; name: string };
          const comment = await prisma.comment.create({
            data: {
              taskId: task.id,
              authorId: author.id,
              body: pick(COMMENT_BODIES),
              createdAt: daysFromNow(-int(1, 20)),
            },
            select: { id: true },
          });
          await prisma.activityLog.create({
            data: {
              workspaceId: workspace.id,
              projectId: project.id,
              taskId: task.id,
              commentId: comment.id,
              actorId: author.id,
              type: 'COMMENT_CREATED' as ActivityType,
              summary: `${author.name} commented on ${task.reference}`,
              createdAt: daysFromNow(-int(1, 20)),
            },
          });
        }

        if (chance(0.4)) {
          await prisma.attachment.create({
            data: {
              taskId: task.id,
              label: pick(['Design spec', 'Sentry issue', 'API contract', 'Figma board', 'Incident notes']),
              url: pick(['https://figma.com/file/teamflow-board', 'https://github.com/syedjeelan777/TeamFlow/pulls', 'https://postman.com/teamflow-api']),
              addedById: pick(users)!.id,
            },
          });
        }

        await prisma.activityLog.create({
          data: {
            workspaceId: workspace.id,
            projectId: project.id,
            taskId: task.id,
            actorId: owner.id,
            type: 'TASK_CREATED' as ActivityType,
            summary: `${owner.name} created ${task.reference}`,
            createdAt: daysFromNow(-int(2, 60)),
          },
        });
        if (isCompleted) {
          await prisma.activityLog.create({
            data: {
              workspaceId: workspace.id,
              projectId: project.id,
              taskId: task.id,
              actorId: pick(users)!.id,
              type: 'TASK_COMPLETED' as ActivityType,
              summary: `${pick(users)!.name} moved ${task.reference} to Done`,
              createdAt: daysFromNow(-int(0, 20)),
            },
          });
        }
      }

      await prisma.activityLog.create({
        data: {
          workspaceId: workspace.id,
          projectId: project.id,
          actorId: owner.id,
          type: 'PROJECT_CREATED' as ActivityType,
          summary: `${projectSpec.name} project created`,
          createdAt: daysFromNow(-int(45, 100)),
        },
      });

      // Project channel
      const projectChannel = await prisma.channel.create({
        data: { workspaceId: workspace.id, projectId: project.id, name: `proj-${projectSpec.key.toLowerCase()}`, type: 'PROJECT' },
      });
      for (const body of ['Kicking off this board — tasks mirror the sprint plan.', 'Board looks healthy today.', 'Please add estimates before grooming.']) {
        await prisma.message.create({ data: { channelId: projectChannel.id, authorId: pick(users)!.id, body, createdAt: daysFromNow(-int(1, 14)) } });
      }
    }

    // A pending invitation so the invite UI has something real to show.
    await prisma.workspaceInvitation.create({
      data: {
        workspaceId: workspace.id,
        email: `sofia@teamflow.dev`,
        role: 'MEMBER',
        message: 'Join us — we need a hand with the design system.',
        tokenHash: createHash('sha256').update(`demo-invite-${workspace.slug}`).digest('hex'),
        invitedById: owner.id,
        expiresAt: daysFromNow(7),
      },
    });

    // Unread notifications for the demo owner (mentions + role change).
    await prisma.notification.create({
      data: {
        recipientId: owner.id,
        workspaceId: workspace.id,
        type: 'MENTION' as NotificationType,
        title: 'Priya Nair mentioned you in #general',
        body: 'Analytics dashboard is showing real numbers now, no more placeholders 🎉',
        actorId: byKey('priya').id,
        link: `/app/workspaces/${workspace.id}/chat`,
        createdAt: daysFromNow(0, 9),
      },
    });

    console.log(`  workspace ${workspace.name}: ${wsSpec.projects.length} projects, ${taskCounter} tasks`);
  }

  const counts = {
    users: await prisma.user.count(),
    workspaces: await prisma.workspace.count(),
    projects: await prisma.project.count(),
    tasks: await prisma.task.count(),
    comments: await prisma.comment.count(),
    messages: await prisma.message.count(),
    notifications: await prisma.notification.count(),
    activities: await prisma.activityLog.count(),
  };
  console.log('\n✔ seed complete', counts);
  console.log(`\nDemo logins (password: ${DEMO_PASSWORD}):`);
  for (const spec of USERS) console.log(`  • ${spec.email.padEnd(22)} ${WORKSPACES.some(w => w.key === 'northwind') ? spec.role : 'MEMBER'}`);
}

main()
  .catch(error => {
    console.error('✖ seed failed', error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
