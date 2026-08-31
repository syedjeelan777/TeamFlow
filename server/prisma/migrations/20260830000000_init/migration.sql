-- TeamFlow initial schema
-- Generated to match server/prisma/schema.prisma exactly (Prisma naming conventions:
-- quoted PascalCase tables/columns, `_prisma_migrations` bookkeeping, FK/IDX names).

-- CreateEnum
CREATE TYPE "WorkspaceRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER');
CREATE TYPE "ProjectStatus" AS ENUM ('PLANNING', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'ARCHIVED');
CREATE TYPE "TaskStatus" AS ENUM ('TODO', 'IN_PROGRESS', 'REVIEW', 'DONE');
CREATE TYPE "TaskPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'URGENT');
CREATE TYPE "ChannelType" AS ENUM ('GENERAL', 'PROJECT');
CREATE TYPE "NotificationType" AS ENUM ('TASK_ASSIGNED', 'TASK_UPDATED', 'TASK_COMMENTED', 'TASK_DUE_SOON', 'PROJECT_ADDED', 'WORKSPACE_ROLE_CHANGED', 'WORKSPACE_INVITED', 'MENTION');
CREATE TYPE "ActivityType" AS ENUM ('WORKSPACE_CREATED', 'WORKSPACE_UPDATED', 'PROJECT_CREATED', 'PROJECT_UPDATED', 'PROJECT_ARCHIVED', 'PROJECT_DELETED', 'TASK_CREATED', 'TASK_UPDATED', 'TASK_ASSIGNED', 'TASK_STATUS_CHANGED', 'TASK_MOVED', 'TASK_COMPLETED', 'TASK_DELETED', 'COMMENT_CREATED', 'COMMENT_DELETED', 'MEMBER_ADDED', 'MEMBER_REMOVED', 'ROLE_CHANGED', 'INVITATION_CREATED', 'MESSAGE_SENT');

-- CreateTable: User
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "avatarUrl" TEXT,
    "bio" TEXT,
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable: RefreshToken
CREATE TABLE "RefreshToken" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "replacedById" UUID,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable: PasswordResetToken
CREATE TABLE "PasswordResetToken" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable: Workspace
CREATE TABLE "Workspace" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "accentColor" TEXT NOT NULL DEFAULT 'indigo',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "creatorId" UUID NOT NULL,

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable: WorkspaceMember
CREATE TABLE "WorkspaceMember" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" "WorkspaceRole" NOT NULL DEFAULT 'MEMBER',
    "invitedById" UUID,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkspaceMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable: WorkspaceInvitation
CREATE TABLE "WorkspaceInvitation" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "role" "WorkspaceRole" NOT NULL DEFAULT 'MEMBER',
    "tokenHash" TEXT NOT NULL,
    "message" TEXT,
    "invitedById" UUID,
    "acceptedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkspaceInvitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable: Project
CREATE TABLE "Project" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "ProjectStatus" NOT NULL DEFAULT 'PLANNING',
    "color" TEXT NOT NULL DEFAULT 'indigo',
    "startDate" TIMESTAMP(3),
    "dueDate" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable: ProjectMember
CREATE TABLE "ProjectMember" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable: Task
CREATE TABLE "Task" (
    "id" UUID NOT NULL,
    "reference" TEXT NOT NULL,
    "projectId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" "TaskStatus" NOT NULL DEFAULT 'TODO',
    "priority" "TaskPriority" NOT NULL DEFAULT 'MEDIUM',
    "position" INTEGER NOT NULL DEFAULT 0,
    "dueDate" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "estimate" INTEGER,
    "assigneeId" UUID,
    "reporterId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable: Label
CREATE TABLE "Label" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT 'slate',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Label_pkey" PRIMARY KEY ("id")
);

-- CreateTable: TaskLabel
CREATE TABLE "TaskLabel" (
    "taskId" UUID NOT NULL,
    "labelId" UUID NOT NULL,

    CONSTRAINT "TaskLabel_pkey" PRIMARY KEY ("taskId","labelId")
);

-- CreateTable: Comment
CREATE TABLE "Comment" (
    "id" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "authorId" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "editedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Comment_pkey" PRIMARY KEY ("id")
);

-- CreateTable: Attachment
CREATE TABLE "Attachment" (
    "id" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "addedById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Attachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable: Channel
CREATE TABLE "Channel" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "type" "ChannelType" NOT NULL DEFAULT 'GENERAL',
    "name" TEXT NOT NULL,
    "topic" TEXT,
    "projectId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Channel_pkey" PRIMARY KEY ("id")
);

-- CreateTable: Message
CREATE SEQUENCE "Message_seq_seq";
CREATE TABLE "Message" (
    "id" UUID NOT NULL,
    "channelId" UUID NOT NULL,
    "authorId" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "editedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "seq" BIGINT NOT NULL DEFAULT nextval('"Message_seq_seq"'),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);
ALTER SEQUENCE "Message_seq_seq" OWNED BY "Message"."seq";

-- CreateTable: Notification
CREATE TABLE "Notification" (
    "id" UUID NOT NULL,
    "recipientId" UUID NOT NULL,
    "workspaceId" UUID,
    "type" "NotificationType" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "actorId" UUID,
    "taskId" UUID,
    "projectId" UUID,
    "channelId" UUID,
    "commentId" UUID,
    "link" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable: ActivityLog
CREATE TABLE "ActivityLog" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "projectId" UUID,
    "taskId" UUID,
    "commentId" UUID,
    "actorId" UUID,
    "type" "ActivityType" NOT NULL,
    "summary" TEXT NOT NULL,
    "metadata" JSON,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActivityLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE INDEX "User_lastSeenAt_idx" ON "User"("lastSeenAt");
CREATE INDEX "RefreshToken_userId_idx" ON "RefreshToken"("userId");
CREATE INDEX "RefreshToken_expiresAt_idx" ON "RefreshToken"("expiresAt");
CREATE UNIQUE INDEX "RefreshToken_tokenHash_key" ON "RefreshToken"("tokenHash");
CREATE INDEX "PasswordResetToken_userId_idx" ON "PasswordResetToken"("userId");
CREATE UNIQUE INDEX "PasswordResetToken_tokenHash_key" ON "PasswordResetToken"("tokenHash");
CREATE UNIQUE INDEX "Workspace_slug_key" ON "Workspace"("slug");
CREATE INDEX "Workspace_creatorId_idx" ON "Workspace"("creatorId");
CREATE INDEX "WorkspaceMember_userId_idx" ON "WorkspaceMember"("userId");
CREATE INDEX "WorkspaceMember_workspaceId_role_idx" ON "WorkspaceMember"("workspaceId", "role");
CREATE UNIQUE INDEX "WorkspaceMember_workspaceId_userId_key" ON "WorkspaceMember"("workspaceId", "userId");
CREATE INDEX "WorkspaceInvitation_email_idx" ON "WorkspaceInvitation"("email");
CREATE INDEX "WorkspaceInvitation_tokenHash_idx" ON "WorkspaceInvitation"("tokenHash");
CREATE UNIQUE INDEX "WorkspaceInvitation_workspaceId_email_key" ON "WorkspaceInvitation"("workspaceId", "email");
CREATE INDEX "Project_workspaceId_status_idx" ON "Project"("workspaceId", "status");
CREATE INDEX "Project_workspaceId_archivedAt_idx" ON "Project"("workspaceId", "archivedAt");
CREATE UNIQUE INDEX "Project_workspaceId_key_key" ON "Project"("workspaceId", "key");
CREATE INDEX "ProjectMember_userId_idx" ON "ProjectMember"("userId");
CREATE UNIQUE INDEX "ProjectMember_projectId_userId_key" ON "ProjectMember"("projectId", "userId");
CREATE UNIQUE INDEX "Task_reference_key" ON "Task"("reference");
CREATE INDEX "Task_projectId_status_position_idx" ON "Task"("projectId", "status", "position");
CREATE INDEX "Task_workspaceId_status_idx" ON "Task"("workspaceId", "status");
CREATE INDEX "Task_workspaceId_dueDate_idx" ON "Task"("workspaceId", "dueDate");
CREATE INDEX "Task_assigneeId_status_idx" ON "Task"("assigneeId", "status");
CREATE INDEX "Task_reporterId_idx" ON "Task"("reporterId");
CREATE INDEX "Task_completedAt_idx" ON "Task"("completedAt");
CREATE UNIQUE INDEX "Label_workspaceId_name_key" ON "Label"("workspaceId", "name");
CREATE INDEX "TaskLabel_labelId_idx" ON "TaskLabel"("labelId");
CREATE INDEX "Comment_taskId_createdAt_idx" ON "Comment"("taskId", "createdAt");
CREATE INDEX "Comment_authorId_idx" ON "Comment"("authorId");
CREATE INDEX "Attachment_taskId_idx" ON "Attachment"("taskId");
CREATE UNIQUE INDEX "Channel_workspaceId_name_key" ON "Channel"("workspaceId", "name");
CREATE INDEX "Channel_workspaceId_type_idx" ON "Channel"("workspaceId", "type");
CREATE INDEX "Channel_projectId_idx" ON "Channel"("projectId");
CREATE INDEX "Message_channelId_seq_idx" ON "Message"("channelId", "seq");
CREATE INDEX "Message_channelId_deletedAt_idx" ON "Message"("channelId", "deletedAt");
CREATE INDEX "Message_authorId_idx" ON "Message"("authorId");
CREATE INDEX "Notification_recipientId_readAt_createdAt_idx" ON "Notification"("recipientId", "readAt", "createdAt");
CREATE INDEX "Notification_workspaceId_idx" ON "Notification"("workspaceId");
CREATE INDEX "ActivityLog_workspaceId_createdAt_idx" ON "ActivityLog"("workspaceId", "createdAt");
CREATE INDEX "ActivityLog_projectId_createdAt_idx" ON "ActivityLog"("projectId", "createdAt");
CREATE INDEX "ActivityLog_taskId_idx" ON "ActivityLog"("taskId");

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PasswordResetToken" ADD CONSTRAINT "PasswordResetToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Workspace" ADD CONSTRAINT "Workspace_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WorkspaceMember" ADD CONSTRAINT "WorkspaceMember_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkspaceMember" ADD CONSTRAINT "WorkspaceMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkspaceMember" ADD CONSTRAINT "WorkspaceMember_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "WorkspaceInvitation" ADD CONSTRAINT "WorkspaceInvitation_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkspaceInvitation" ADD CONSTRAINT "WorkspaceInvitation_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Project" ADD CONSTRAINT "Project_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Project" ADD CONSTRAINT "Project_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProjectMember" ADD CONSTRAINT "ProjectMember_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectMember" ADD CONSTRAINT "ProjectMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Task" ADD CONSTRAINT "Task_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Task" ADD CONSTRAINT "Task_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Task" ADD CONSTRAINT "Task_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Task" ADD CONSTRAINT "Task_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Label" ADD CONSTRAINT "Label_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TaskLabel" ADD CONSTRAINT "TaskLabel_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TaskLabel" ADD CONSTRAINT "TaskLabel_labelId_fkey" FOREIGN KEY ("labelId") REFERENCES "Label"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_addedById_fkey" FOREIGN KEY ("addedById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Channel" ADD CONSTRAINT "Channel_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Channel" ADD CONSTRAINT "Channel_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Message" ADD CONSTRAINT "Message_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Message" ADD CONSTRAINT "Message_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ActivityLog" ADD CONSTRAINT "ActivityLog_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ActivityLog" ADD CONSTRAINT "ActivityLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
