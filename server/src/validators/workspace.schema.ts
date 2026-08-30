import { z, trimmed, uuid } from './common.js';

export const WorkspaceRoleSchema = z.enum(['OWNER', 'ADMIN', 'MEMBER']);

export const CreateWorkspaceSchema = z
  .object({
    name: trimmed(2, 60, 'Workspace name'),
    description: z.string().trim().max(500).optional(),
    accentColor: z.enum(['indigo', 'violet', 'sky', 'emerald', 'amber', 'rose', 'teal', 'slate']).optional(),
  })
  .strict();

export const UpdateWorkspaceSchema = z
  .object({
    name: trimmed(2, 60, 'Workspace name').optional(),
    description: z
      .string()
      .trim()
      .max(500)
      .nullable()
      .optional(),
    accentColor: z.enum(['indigo', 'violet', 'sky', 'emerald', 'amber', 'rose', 'teal', 'slate']).optional(),
  })
  .strict()
  .refine(v => Object.keys(v).length > 0, { message: 'Nothing to update' });

export const InviteMemberSchema = z
  .object({
    email: z.string().trim().toLowerCase().email('Enter a valid email address'),
    role: WorkspaceRoleSchema.default('MEMBER'),
    message: z.string().trim().max(500).optional(),
  })
  .strict()
  .refine(v => v.role !== 'OWNER', { message: 'Ownership can only be transferred directly', path: ['role'] });

export const UpdateMemberRoleSchema = z
  .object({ role: WorkspaceRoleSchema })
  .strict()
  .refine(v => v.role !== 'OWNER', { message: 'Ownership transfer is a dedicated action', path: ['role'] });

export const TransferOwnershipSchema = z
  .object({ memberUserId: uuid, confirm: z.literal(true, { error: 'Set confirm: true to transfer ownership' }) })
  .strict();

export const WorkspaceIdParams = z.object({ workspaceId: uuid });
export const WorkspaceMemberParams = z.object({ workspaceId: uuid, memberId: uuid });

export type CreateWorkspaceInput = z.infer<typeof CreateWorkspaceSchema>;
export type UpdateWorkspaceInput = z.infer<typeof UpdateWorkspaceSchema>;
export type InviteMemberInput = z.infer<typeof InviteMemberSchema>;
