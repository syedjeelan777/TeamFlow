import type { Request, Response } from 'express';
import { asyncHandler, ok } from '../utils/async-handler.js';
import { currentUser } from '../middleware/auth.js';
import { channelsService } from '../services/channels.service.js';
import { messagesService } from '../services/messages.service.js';
import {
  CreateChannelSchema,
  CreateMessageSchema,
  MessageListQuery,
  UpdateMessageSchema,
} from '../validators/chat.schema.js';
import { validate } from '../middleware/validate.js';
import { bodyOf } from '../validators/common.js';

export const chatController = {
  channels: asyncHandler(async (req: Request, res: Response) => {
    ok(res, await channelsService.listForUser(currentUser(req).id, String(req.params.workspaceId)));
  }),

  createChannel: [
    validate({ body: CreateChannelSchema }),
    asyncHandler(async (req: Request, res: Response) => {
      ok(res, await channelsService.create(currentUser(req).id, String(req.params.workspaceId), bodyOf(req, CreateChannelSchema)), 201);
    }),
  ],

  updateChannel: asyncHandler(async (req: Request, res: Response) => {
    const topic = typeof req.body?.topic === 'string' ? req.body.topic : null;
    ok(res, await channelsService.update(currentUser(req).id, String(req.params.channelId), { topic }));
  }),

  removeChannel: asyncHandler(async (req: Request, res: Response) => {
    ok(res, await channelsService.remove(currentUser(req).id, String(req.params.channelId)));
  }),

  messages: [
    validate({ query: MessageListQuery }),
    asyncHandler(async (req: Request, res: Response) => {
      const query = req.query as unknown as { limit: number; before?: number };
      const result = await messagesService.list(currentUser(req).id, String(req.params.channelId), {
        limit: query.limit,
        before: query.before,
      });
      ok(res, result);
    }),
  ],

  sendMessage: [
    validate({ body: CreateMessageSchema }),
    asyncHandler(async (req: Request, res: Response) => {
      const body = req.body as { body: string; clientId?: string };
      ok(res, await messagesService.create(currentUser(req).id, String(req.params.channelId), body.body, body.clientId), 201);
    }),
  ],

  updateMessage: [
    validate({ body: UpdateMessageSchema }),
    asyncHandler(async (req: Request, res: Response) => {
      ok(res, await messagesService.update(currentUser(req).id, String(req.params.messageId), (req.body as { body: string }).body));
    }),
  ],

  removeMessage: asyncHandler(async (req: Request, res: Response) => {
    ok(res, await messagesService.remove(currentUser(req).id, String(req.params.messageId)));
  }),

  markRead: asyncHandler(async (req: Request, res: Response) => {
    const { channelId, seq } = req.body as { channelId: string; seq: string };
    ok(res, messagesService.markRead(currentUser(req).id, channelId, seq ?? '0'));
  }),
};
