import { booleanFlagDefault, dateField, trimmed, uuid, z } from './common.js';

export const ProjectStatusSchema = z.enum(['PLANNING', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'ARCHIVED']);
export const ProjectColorSchema = z.enum(['indigo', 'violet', 'sky', 'emerald', 'amber', 'rose', 'teal', 'slate']);

export const CreateProjectSchema = z
  .object({
    name: trimmed(2, 80, 'Project name'),
    key: z
      .string()
      .trim()
      .regex(/^[A-Z][A-Z0-9]{1,9}$/, 'Use 2-10 uppercase letters/digits, starting with a letter (e.g. WEB)'),
    description: z.string().trim().max(2000).optional(),
    status: ProjectStatusSchema.optional(),
    color: ProjectColorSchema.optional(),
    startDate: dateField,
    dueDate: dateField,
    memberIds: z.array(uuid).max(200).optional(),
  })
  .strict()
  .refine(
    v => !(v.startDate && v.dueDate && new Date(v.startDate) > new Date(v.dueDate)),
    { message: 'Start date must be before the due date', path: ['dueDate'] },
  );

export const UpdateProjectSchema = z
  .object({
    name: trimmed(2, 80, 'Project name').optional(),
    description: z
      .string()
      .trim()
      .max(2000)
      .nullable()
      .optional(),
    status: ProjectStatusSchema.optional(),
    color: ProjectColorSchema.optional(),
    startDate: dateField,
    dueDate: dateField,
  })
  .strict()
  .refine(v => Object.keys(v).length > 0, { message: 'Nothing to update' });

export const ProjectMembersSchema = z.object({ userIds: z.array(uuid).min(1, 'Pick at least one member').max(200) }).strict();
export const ProjectIdParams = z.object({ projectId: uuid });
export const ProjectListQuery = z.object({
  search: z.string().trim().max(120).optional(),
  status: ProjectStatusSchema.optional(),
  includeArchived: booleanFlagDefault,
  page: z.coerce.number().int().min(1).max(1000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(24),
  sort: z.enum(['recent', 'name', 'dueDate', 'progress']).default('recent'),
});

export type CreateProjectInput = z.infer<typeof CreateProjectSchema>;
export type UpdateProjectInput = z.infer<typeof UpdateProjectSchema>;
export type ProjectListQueryInput = z.infer<typeof ProjectListQuery>;
