import type { Request, Response } from 'express';
import { asyncHandler, ok } from '../utils/async-handler.js';
import { currentUser } from '../middleware/auth.js';
import { workspacesService } from '../services/workspaces.service.js';
import {
  CreateWorkspaceSchema,
  InviteMemberSchema,
  TransferOwnershipSchema,
  UpdateMemberRoleSchema,
  UpdateWorkspaceSchema,
} from '../validators/workspace.schema.js';
import { validate } from '../middleware/validate.js';
import { bodyOf } from '../validators/common.js';

import { z } from 'zod';

const acceptInviteBody = z.object({ token: z.string().min(20) }).strict();

export const workspacesController = {
  list: asyncHandler(async (req: Request, res: Response) => {
    ok(res, await workspacesService.listForUser(currentUser(req).id));
  }),

  get: asyncHandler(async (req: Request, res: Response) => {
    ok(res, await workspacesService.summary(currentUser(req).id, String(req.params.workspaceId)));
  }),

  create: [
    validate({ body: CreateWorkspaceSchema }),
    asyncHandler(async (req: Request, res: Response) => {
      ok(res, await workspacesService.create(currentUser(req).id, bodyOf(req, CreateWorkspaceSchema)), 201);
    }),
  ],

  update: [
    validate({ body: UpdateWorkspaceSchema }),
    asyncHandler(async (req: Request, res: Response) => {
      ok(res, await workspacesService.update(currentUser(req).id, String(req.params.workspaceId), bodyOf(req, UpdateWorkspaceSchema)));
    }),
  ],

  remove: asyncHandler(async (req: Request, res: Response) => {
    ok(res, await workspacesService.delete(currentUser(req).id, String(req.params.workspaceId)));
  }),

  leave: asyncHandler(async (req: Request, res: Response) => {
    ok(res, await workspacesService.leaveWorkspace(currentUser(req).id, String(req.params.workspaceId)));
  }),

  /* ── members ── */

  members: asyncHandler(async (req: Request, res: Response) => {
    ok(res, await workspacesService.listMembers(currentUser(req).id, String(req.params.workspaceId)));
  }),

  removeMember: asyncHandler(async (req: Request, res: Response) => {
    ok(res, await workspacesService.removeMember(currentUser(req).id, String(req.params.workspaceId), String(req.params.memberId)));
  }),

  updateRole: [
    validate({ body: UpdateMemberRoleSchema }),
    asyncHandler(async (req: Request, res: Response) => {
      ok(res, await workspacesService.updateRole(currentUser(req).id, String(req.params.workspaceId), String(req.params.memberId), req.body.role));
    }),
  ],

  transferOwnership: [
    validate({ body: TransferOwnershipSchema }),
    asyncHandler(async (req: Request, res: Response) => {
      ok(res, await workspacesService.transferOwnership(currentUser(req).id, String(req.params.workspaceId), String(req.params.memberId)));
    }),
  ],

  /* ── invitations ── */

  invitations: asyncHandler(async (req: Request, res: Response) => {
    ok(res, await workspacesService.listInvitations(currentUser(req).id, String(req.params.workspaceId)));
  }),

  invite: [
    validate({ body: InviteMemberSchema }),
    asyncHandler(async (req: Request, res: Response) => {
      ok(res, await workspacesService.inviteMember(currentUser(req).id, String(req.params.workspaceId), bodyOf(req, InviteMemberSchema)), 201);
    }),
  ],

  revokeInvitation: asyncHandler(async (req: Request, res: Response) => {
    ok(res, await workspacesService.revokeInvitation(currentUser(req).id, String(req.params.workspaceId), String(req.params.invitationId)));
  }),

  previewInvite: asyncHandler(async (req: Request, res: Response) => {
    const token = String(req.params.token ?? '');
    ok(res, await workspacesService.previewInvitation(token));
  }),

  acceptInvite: [
    validate({ body: acceptInviteBody }),
    asyncHandler(async (req: Request, res: Response) => {
      ok(res, await workspacesService.acceptInvitation(currentUser(req).id, (req.body as { token: string }).token));
    }),
  ],
};
