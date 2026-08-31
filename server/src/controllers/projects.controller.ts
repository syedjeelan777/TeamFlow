import type { Request, Response } from 'express';
import { asyncHandler, ok } from '../utils/async-handler.js';
import { currentUser } from '../middleware/auth.js';
import { projectsService } from '../services/projects.service.js';
import { CreateProjectSchema, ProjectListQuery, ProjectMembersSchema, UpdateProjectSchema } from '../validators/project.schema.js';
import { validate } from '../middleware/validate.js';
import { bodyOf, queryOf } from '../validators/common.js';
import { analyticsService } from '../services/analytics.service.js';

export const projectsController = {
  list: [
    validate({ query: ProjectListQuery }),
    asyncHandler(async (req: Request, res: Response) => {
      ok(res, await projectsService.list(currentUser(req).id, String(req.params.workspaceId), queryOf(req, ProjectListQuery)));
    }),
  ],

  get: asyncHandler(async (req: Request, res: Response) => {
    ok(res, await projectsService.get(currentUser(req).id, String(req.params.projectId)));
  }),

  create: [
    validate({ body: CreateProjectSchema }),
    asyncHandler(async (req: Request, res: Response) => {
      ok(res, await projectsService.create(currentUser(req).id, String(req.params.workspaceId), bodyOf(req, CreateProjectSchema)), 201);
    }),
  ],

  update: [
    validate({ body: UpdateProjectSchema }),
    asyncHandler(async (req: Request, res: Response) => {
      ok(res, await projectsService.update(currentUser(req).id, String(req.params.projectId), bodyOf(req, UpdateProjectSchema)));
    }),
  ],

  archive: asyncHandler(async (req: Request, res: Response) => {
    const archived = req.body?.archived !== false;
    ok(res, await projectsService.archive(currentUser(req).id, String(req.params.projectId), archived));
  }),

  remove: asyncHandler(async (req: Request, res: Response) => {
    ok(res, await projectsService.remove(currentUser(req).id, String(req.params.projectId)));
  }),

  members: asyncHandler(async (req: Request, res: Response) => {
    ok(res, await projectsService.listMembers(currentUser(req).id, String(req.params.projectId)));
  }),

  addMembers: [
    validate({ body: ProjectMembersSchema }),
    asyncHandler(async (req: Request, res: Response) => {
      ok(res, await projectsService.addMembers(currentUser(req).id, String(req.params.projectId), (req.body as { userIds: string[] }).userIds), 201);
    }),
  ],

  removeMember: asyncHandler(async (req: Request, res: Response) => {
    ok(res, await projectsService.removeMember(currentUser(req).id, String(req.params.projectId), String(req.params.memberId)));
  }),

  analytics: asyncHandler(async (req: Request, res: Response) => {
    ok(res, await analyticsService.project(currentUser(req).id, String(req.params.projectId)));
  }),
};
