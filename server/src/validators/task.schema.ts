import { TASK_PRIORITIES, TASK_STATUSES } from '@teamflow/shared';
import { dateField, trimmed, uuid, z } from './common.js';

export const TaskStatusSchema = z.enum(TASK_STATUSES);
export const TaskPrioritySchema = z.enum(TASK_PRIORITIES);

export const CreateTaskSchema = z
  .object({
    title: trimmed(2, 160, 'Title'),
    description: z.string().trim().max(8000).optional(),
    status: TaskStatusSchema.default('TODO'),
    priority: TaskPrioritySchema.default('MEDIUM'),
    assigneeId: uuid.nullish(),
    dueDate: dateField,
    estimate: z.coerce.number().int().min(0).max(1000).nullish(),
    labelIds: z.array(uuid).max(25).optional(),
    position: z.coerce.number().int().min(0).optional(),
  })
  .strict();

export const UpdateTaskSchema = z
  .object({
    title: trimmed(2, 160, 'Title').optional(),
    description: z
      .string()
      .trim()
      .max(8000)
      .nullable()
      .optional(),
    status: TaskStatusSchema.optional(),
    priority: TaskPrioritySchema.optional(),
    assigneeId: uuid.nullish(),
    dueDate: dateField,
    estimate: z.coerce.number().int().min(0).max(1000).nullish(),
  })
  .strict()
  .refine(v => Object.keys(v).length > 0, { message: 'Nothing to update' });

/**
 * Kanban move. `position` is the desired 0-based index inside the target column;
 * the service rewrites neighbouring positions so ordering stays contiguous.
 */
export const MoveTaskSchema = z
  .object({
    status: TaskStatusSchema,
    position: z.coerce.number().int().min(0).max(100_000).optional(),
    beforeTaskId: uuid.optional(),
    afterTaskId: uuid.optional(),
    projectId: uuid.optional(),
    /** Client's view of the current status; used to detect stale drags. */
    expectedFromStatus: TaskStatusSchema.optional(),
  })
  .strict()
  .refine(v => !(v.beforeTaskId && v.afterTaskId), { message: 'Use either beforeTaskId or afterTaskId, not both' });

export const TaskLabelsSchema = z.object({ labelIds: z.array(uuid).max(25) }).strict();
export const ToggleLabelSchema = z.object({ labelId: uuid }).strict();

export const TaskListQuery = z.object({
  workspaceId: uuid.optional(),
  projectId: uuid.optional(),
  assigneeId: uuid.or(z.literal('me')).or(z.literal('unassigned')).optional(),
  status: z
    .string()
    .transform(s => s.split(',').map(v => v.trim()))
    .pipe(z.array(TaskStatusSchema).min(1).max(4))
    .optional(),
  priority: z
    .string()
    .transform(s => s.split(',').map(v => v.trim()))
    .pipe(z.array(TaskPrioritySchema).min(1).max(4))
    .optional(),
  labelId: uuid.optional(),
  due: z.enum(['overdue', 'today', 'week', 'none', 'upcoming']).optional(),
  search: z.string().trim().max(120).optional(),
  sort: z.enum(['position', 'dueDate', 'priority', 'created']).default('position'),
  order: z.enum(['asc', 'desc']).default('asc'),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  includeSubtasksArchived: z.boolean().optional(),
});

export const TaskBoardQuery = z.object({
  search: z.string().trim().max(120).optional(),
  assigneeId: uuid.or(z.literal('me')).or(z.literal('unassigned')).optional(),
  priority: z
    .string()
    .transform(s => s.split(',').map(v => v.trim()))
    .pipe(z.array(TaskPrioritySchema).min(1).max(4))
    .optional(),
  labelId: uuid.optional(),
});

export const CommentCreateSchema = z.object({ body: trimmed(1, 5000, 'Comment') }).strict();
export const CommentUpdateSchema = z.object({ body: trimmed(1, 5000, 'Comment') }).strict();
export const AttachmentCreateSchema = z
  .object({ label: trimmed(1, 80, 'Label'), url: z.string().trim().url('Must be a valid URL').max(2000) })
  .strict();

export const LabelCreateSchema = z
  .object({
    name: trimmed(1, 40, 'Label name'),
    color: z.enum(['slate', 'indigo', 'violet', 'sky', 'emerald', 'amber', 'rose', 'teal']).default('slate'),
  })
  .strict();

export const LabelUpdateSchema = z
  .object({
    name: trimmed(1, 40, 'Label name').optional(),
    color: z.enum(['slate', 'indigo', 'violet', 'sky', 'emerald', 'amber', 'rose', 'teal']).optional(),
  })
  .strict()
  .refine(v => Object.keys(v).length > 0, { message: 'Nothing to update' });

export const SearchQuery = z.object({
  workspaceId: uuid.optional(),
  q: z.string().trim().min(1, 'Type at least one character').max(120),
  scope: z.enum(['all', 'tasks', 'projects']).default('all'),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export type CreateTaskInput = z.infer<typeof CreateTaskSchema>;
export type UpdateTaskInput = z.infer<typeof UpdateTaskSchema>;
export type MoveTaskInput = z.infer<typeof MoveTaskSchema>;
export type TaskListQueryInput = z.infer<typeof TaskListQuery>;
export type TaskBoardQueryInput = z.infer<typeof TaskBoardQuery>;
