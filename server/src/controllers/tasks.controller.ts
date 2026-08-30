import type { Request, Response } from 'express';
import { asyncHandler, ok } from '../utils/async-handler.js';
import { currentUser } from '../middleware/auth.js';
import { tasksService } from '../services/tasks.service.js';
import { commentsService } from '../services/comments.service.js';
import {
  AttachmentCreateSchema,
  CommentCreateSchema,
  CommentUpdateSchema,
  CreateTaskSchema,
  LabelCreateSchema,
  LabelUpdateSchema,
  MoveTaskSchema,
  TaskBoardQuery,
  TaskLabelsSchema,
  TaskListQuery,
  ToggleLabelSchema,
  UpdateTaskSchema,
} from '../validators/task.schema.js';
import { validate } from '../middleware/validate.js';
import { bodyOf, queryOf } from '../validators/common.js';
import { projectsService } from '../services/projects.service.js';
import { workspacesService } from '../services/workspaces.service.js';

export const tasksController = {
  list: [
    validate({ query: TaskListQuery }),
    asyncHandler(async (req: Request, res: Response) => {
      ok(res, await tasksService.list(currentUser(req).id, queryOf(req, TaskListQuery)));
    }),
  ],

  /** Board for a project: columns + labels in one round trip. */
  board: [
    validate({ query: TaskBoardQuery }),
    asyncHandler(async (req: Request, res: Response) => {
      ok(res, await tasksService.board(currentUser(req).id, String(req.params.projectId), queryOf(req, TaskBoardQuery)));
    }),
  ],

  create: [
    validate({ body: CreateTaskSchema }),
    asyncHandler(async (req: Request, res: Response) => {
      ok(res, await tasksService.create(currentUser(req).id, String(req.params.projectId), bodyOf(req, CreateTaskSchema)), 201);
    }),
  ],

  get: asyncHandler(async (req: Request, res: Response) => {
    ok(res, await tasksService.get(currentUser(req).id, String(req.params.taskId)));
  }),

  update: [
    validate({ body: UpdateTaskSchema }),
    asyncHandler(async (req: Request, res: Response) => {
      ok(res, await tasksService.update(currentUser(req).id, String(req.params.taskId), bodyOf(req, UpdateTaskSchema)));
    }),
  ],

  move: [
    validate({ body: MoveTaskSchema }),
    asyncHandler(async (req: Request, res: Response) => {
      ok(res, await tasksService.move(currentUser(req).id, String(req.params.taskId), bodyOf(req, MoveTaskSchema)));
    }),
  ],

  remove: asyncHandler(async (req: Request, res: Response) => {
    ok(res, await tasksService.remove(currentUser(req).id, String(req.params.taskId)));
  }),

  setLabels: [
    validate({ body: TaskLabelsSchema }),
    asyncHandler(async (req: Request, res: Response) => {
      ok(res, await tasksService.setLabels(currentUser(req).id, String(req.params.taskId), (req.body as { labelIds: string[] }).labelIds));
    }),
  ],

  toggleLabel: [
    validate({ body: ToggleLabelSchema }),
    asyncHandler(async (req: Request, res: Response) => {
      const { labelId } = req.body as { labelId: string };
      const task = await tasksService.get(currentUser(req).id, String(req.params.taskId));
      const attached = task.labels.some(label => label.id === labelId);
      ok(res, await tasksService.toggleLabel(currentUser(req).id, String(req.params.taskId), labelId, !attached));
    }),
  ],

  /* ── comments ── */

  comments: asyncHandler(async (req: Request, res: Response) => {
    ok(res, await commentsService.list(currentUser(req).id, String(req.params.taskId)));
  }),

  createComment: [
    validate({ body: CommentCreateSchema }),
    asyncHandler(async (req: Request, res: Response) => {
      ok(res, await commentsService.create(currentUser(req).id, String(req.params.taskId), (req.body as { body: string }).body), 201);
    }),
  ],

  updateComment: [
    validate({ body: CommentUpdateSchema }),
    asyncHandler(async (req: Request, res: Response) => {
      ok(res, await commentsService.update(currentUser(req).id, String(req.params.commentId), (req.body as { body: string }).body));
    }),
  ],

  removeComment: asyncHandler(async (req: Request, res: Response) => {
    ok(res, await commentsService.remove(currentUser(req).id, String(req.params.commentId)));
  }),

  /* ── attachments ── */

  attachments: asyncHandler(async (req: Request, res: Response) => {
    ok(res, await commentsService.listAttachments(currentUser(req).id, String(req.params.taskId)));
  }),

  addAttachment: [
    validate({ body: AttachmentCreateSchema }),
    asyncHandler(async (req: Request, res: Response) => {
      const { label, url } = req.body as { label: string; url: string };
      ok(res, await commentsService.addAttachment(currentUser(req).id, String(req.params.taskId), label, url), 201);
    }),
  ],

  removeAttachment: asyncHandler(async (req: Request, res: Response) => {
    ok(res, await commentsService.removeAttachment(currentUser(req).id, String(req.params.attachmentId)));
  }),

  /* ── labels ── */

  labels: asyncHandler(async (req: Request, res: Response) => {
    ok(res, await tasksService.listLabels(currentUser(req).id, String(req.params.workspaceId)));
  }),

  createLabel: [
    validate({ body: LabelCreateSchema }),
    asyncHandler(async (req: Request, res: Response) => {
      const { name, color } = req.body as { name: string; color: string };
      ok(res, await tasksService.createLabel(currentUser(req).id, String(req.params.workspaceId), name, color), 201);
    }),
  ],

  updateLabel: [
    validate({ body: LabelUpdateSchema }),
    asyncHandler(async (req: Request, res: Response) => {
      ok(res, await tasksService.updateLabel(currentUser(req).id, String(req.params.labelId), bodyOf(req, LabelUpdateSchema)));
    }),
  ],

  removeLabel: asyncHandler(async (req: Request, res: Response) => {
    ok(res, await tasksService.deleteLabel(currentUser(req).id, String(req.params.labelId)));
  }),
};

/** Convenience: workspace-wide board across every project the user can see. */
export const workspaceBoardController = {
  board: [
    validate({ query: TaskBoardQuery }),
    asyncHandler(async (req: Request, res: Response) => {
      const result = await tasksService.workspaceBoard(
        currentUser(req).id,
        String(req.params.workspaceId),
        queryOf(req, TaskBoardQuery),
      );
      ok(res, result);
    }),
  ],
};
