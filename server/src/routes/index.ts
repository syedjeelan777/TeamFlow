import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import {
  requireAttachmentScope,
  requireChannelScope,
  requireCommentScope,
  requireMessageScope,
  requireProjectScope,
  requireTaskScope,
  requireWorkspaceScope,
  requireWorkspaceScopeFromQuery,
} from '../middleware/authz.js';
import { loginLimiter, messageLimiter, writeLimiter } from '../middleware/security.js';
import { authController } from '../controllers/auth.controller.js';
import { workspacesController } from '../controllers/workspaces.controller.js';
import { projectsController } from '../controllers/projects.controller.js';
import { tasksController, workspaceBoardController } from '../controllers/tasks.controller.js';
import { chatController } from '../controllers/chat.controller.js';
import {
  activityController,
  analyticsController,
  notificationsController,
  presenceController,
  searchController,
} from '../controllers/misc.controller.js';

/**
 * REST surface. Handlers stay thin: validate → authorise (middleware) →
 * service. Every nested resource runs an access guard derived from the
 * database, so an id guessed by a client can never reach another tenant's row.
 */
export function buildApiRouter(): Router {
  const api = Router();

  /* ── auth ── */
  const auth = Router();
  auth.post('/register', loginLimiter, authController.register);
  auth.post('/login', loginLimiter, authController.login);
  auth.post('/logout', authController.logout);
  auth.post('/refresh', loginLimiter, authController.refresh);
  auth.post('/forgot-password', loginLimiter, authController.forgotPassword);
  auth.post('/reset-password', loginLimiter, authController.resetPassword);
  auth.get('/me', requireAuth, authController.me);
  auth.patch('/me', requireAuth, authController.updateProfile);
  auth.post('/change-password', requireAuth, writeLimiter, authController.changePassword);
  auth.delete('/account', requireAuth, authController.deleteAccount);
  api.use('/auth', auth);

  /* ── public invitation preview (no auth: the token is the capability) ── */
  api.get('/invitations/:token', workspacesController.previewInvite);
  api.post('/invitations/accept', requireAuth, workspacesController.acceptInvite);

  /* ── workspaces ── */
  const workspaces = Router();
  workspaces.get('/', workspacesController.list);
  workspaces.post('/', writeLimiter, workspacesController.create);
  workspaces.get('/:workspaceId', requireWorkspaceScope(), workspacesController.get);
  workspaces.patch('/:workspaceId', requireWorkspaceScope(), writeLimiter, workspacesController.update);
  workspaces.delete('/:workspaceId', requireWorkspaceScope(), workspacesController.remove);
  workspaces.post('/:workspaceId/leave', requireWorkspaceScope(), workspacesController.leave);

  workspaces.get('/:workspaceId/members', requireWorkspaceScope(), workspacesController.members);
  workspaces.delete('/:workspaceId/members/:memberId', requireWorkspaceScope(), writeLimiter, workspacesController.removeMember);
  workspaces.patch('/:workspaceId/members/:memberId/role', requireWorkspaceScope(), writeLimiter, workspacesController.updateRole);
  workspaces.patch('/:workspaceId/members/:memberId/ownership', requireWorkspaceScope(), writeLimiter, workspacesController.transferOwnership);

  workspaces.get('/:workspaceId/invitations', requireWorkspaceScope(), workspacesController.invitations);
  workspaces.post('/:workspaceId/invitations', requireWorkspaceScope(), writeLimiter, workspacesController.invite);
  workspaces.delete('/:workspaceId/invitations/:invitationId', requireWorkspaceScope(), workspacesController.revokeInvitation);

  workspaces.get('/:workspaceId/projects', requireWorkspaceScope(), projectsController.list);
  workspaces.post('/:workspaceId/projects', requireWorkspaceScope(), writeLimiter, projectsController.create);
  workspaces.get('/:workspaceId/board', requireWorkspaceScope(), workspaceBoardController.board);
  workspaces.get('/:workspaceId/tasks', requireWorkspaceScope(), tasksController.list);
  workspaces.get('/:workspaceId/labels', requireWorkspaceScope(), tasksController.labels);
  workspaces.post('/:workspaceId/labels', requireWorkspaceScope(), writeLimiter, tasksController.createLabel);
  workspaces.patch('/:workspaceId/labels/:labelId', requireWorkspaceScope(), tasksController.updateLabel);
  workspaces.delete('/:workspaceId/labels/:labelId', requireWorkspaceScope(), tasksController.removeLabel);
  workspaces.get('/:workspaceId/analytics', requireWorkspaceScope(), analyticsController.workspace);
  workspaces.get('/:workspaceId/activity', requireWorkspaceScope(), activityController.list);
  workspaces.get('/:workspaceId/search', requireWorkspaceScope(), searchController.workspace);
  workspaces.get('/:workspaceId/channels', requireWorkspaceScope(), chatController.channels);
  workspaces.post('/:workspaceId/channels', requireWorkspaceScope(), writeLimiter, chatController.createChannel);
  workspaces.get('/:workspaceId/presence', requireWorkspaceScope(), presenceController.workspace);
  api.use('/workspaces', requireAuth, workspaces);

  /* ── projects ── */
  const projects = Router();
  projects.get('/:projectId', requireProjectScope(), projectsController.get);
  projects.patch('/:projectId', requireProjectScope(), writeLimiter, projectsController.update);
  projects.delete('/:projectId', requireProjectScope(), projectsController.remove);
  projects.post('/:projectId/archive', requireProjectScope(), projectsController.archive);
  projects.get('/:projectId/members', requireProjectScope(), projectsController.members);
  projects.post('/:projectId/members', requireProjectScope(), writeLimiter, projectsController.addMembers);
  projects.delete('/:projectId/members/:memberId', requireProjectScope(), projectsController.removeMember);
  projects.get('/:projectId/board', requireProjectScope(), tasksController.board);
  projects.post('/:projectId/tasks', requireProjectScope(), writeLimiter, tasksController.create);
  projects.get('/:projectId/tasks', requireProjectScope(), tasksController.list);
  projects.get('/:projectId/analytics', requireProjectScope(), projectsController.analytics);
  api.use('/projects', requireAuth, projects);

  /* ── tasks ── */
  const tasks = Router();
  tasks.get('/:taskId', requireTaskScope(), tasksController.get);
  tasks.patch('/:taskId', requireTaskScope(), writeLimiter, tasksController.update);
  tasks.patch('/:taskId/move', requireTaskScope(), writeLimiter, tasksController.move);
  tasks.delete('/:taskId', requireTaskScope(), tasksController.remove);
  tasks.put('/:taskId/labels', requireTaskScope(), tasksController.setLabels);
  tasks.post('/:taskId/labels/toggle', requireTaskScope(), tasksController.toggleLabel);
  tasks.get('/:taskId/comments', requireTaskScope(), tasksController.comments);
  tasks.post('/:taskId/comments', requireTaskScope(), writeLimiter, tasksController.createComment);
  tasks.get('/:taskId/attachments', requireTaskScope(), tasksController.attachments);
  tasks.post('/:taskId/attachments', requireTaskScope(), writeLimiter, tasksController.addAttachment);
  api.use('/tasks', requireAuth, tasks);

  api.patch('/comments/:commentId', requireAuth, requireCommentScope(), writeLimiter, tasksController.updateComment);
  api.delete('/comments/:commentId', requireAuth, requireCommentScope(), tasksController.removeComment);
  api.delete('/attachments/:attachmentId', requireAuth, requireAttachmentScope(), tasksController.removeAttachment);

  /* ── chat ── */
  const channels = Router();
  channels.get('/:channelId/messages', requireChannelScope(), chatController.messages);
  channels.post('/:channelId/messages', requireChannelScope(), messageLimiter, chatController.sendMessage);
  channels.patch('/:channelId', requireChannelScope(), chatController.updateChannel);
  channels.delete('/:channelId', requireChannelScope(), chatController.removeChannel);
  api.use('/channels', requireAuth, channels);

  api.patch('/messages/:messageId', requireAuth, requireMessageScope(), writeLimiter, chatController.updateMessage);
  api.delete('/messages/:messageId', requireAuth, requireMessageScope(), chatController.removeMessage);
  api.post('/channels/:channelId/read', requireAuth, requireChannelScope(), chatController.markRead);

  /* ── notifications ── */
  const notifications = Router();
  notifications.get('/', notificationsController.list);
  notifications.get('/unread-count', notificationsController.unreadCount);
  notifications.put('/read-all', notificationsController.markAllRead);
  notifications.put('/:id/read', notificationsController.markRead);
  notifications.delete('/:id', notificationsController.remove);
  api.use('/notifications', requireAuth, notifications);

  /* ── cross-workspace conveniences (all take ?workspaceId=) ── */
  api.get('/activity', requireAuth, requireWorkspaceScopeFromQuery(), activityController.list);
  api.get('/tasks', requireAuth, tasksController.list);
  api.get('/search', requireAuth, searchController.global);

  return api;
}
