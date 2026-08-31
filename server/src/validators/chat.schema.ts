import { booleanFlag, trimmed, uuid, z } from './common.js';

export const CreateMessageSchema = z
  .object({
    body: trimmed(1, 4000, 'Message'),
    /** Client-generated id used to reconcile optimistic messages. */
    clientId: z.string().trim().max(64).optional(),
  })
  .strict();

export const UpdateMessageSchema = z.object({ body: trimmed(1, 4000, 'Message') }).strict();

export const MessageListQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    /** Return messages strictly older than this seq (cursor pagination). */
    before: z.coerce.number().int().min(0).optional(),
    channelId: uuid.optional(),
  })
  .strict();

export const ChannelListParams = z.object({ workspaceId: uuid });
export const ChannelIdParams = z.object({ channelId: uuid });
export const MessageIdParams = z.object({ messageId: uuid });

export const CreateChannelSchema = z
  .object({
    name: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9][a-z0-9-]{1,40}$/, 'Use 2-41 lowercase letters, digits or dashes'),
    topic: z.string().trim().max(160).optional(),
    projectId: uuid.optional(),
  })
  .strict();

export const TypingSchema = z
  .object({
    channelId: uuid,
    isTyping: z.boolean(),
  })
  .strict();

export const NotificationListQuery = z.object({
  unreadOnly: booleanFlag.default(false),
  workspaceId: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  before: z.string().datetime().optional(),
});

export const MarkAllReadSchema = z.object({ workspaceId: uuid.optional() }).strict().default({});

export const ActivityListQuery = z.object({
  workspaceId: uuid.optional(),
  projectId: uuid.optional(),
  taskId: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  before: z.string().datetime().optional(),
});

export type CreateMessageInput = z.infer<typeof CreateMessageSchema>;
export type MessageListQueryInput = z.infer<typeof MessageListQuery>;
export type CreateChannelInput = z.infer<typeof CreateChannelSchema>;
