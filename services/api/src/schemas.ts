import { z } from "zod";

export const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });
export const messageSchema = z.object({
  accountId: z.string().uuid(),
  conversationId: z.string().uuid(),
  clientMessageId: z.string().min(8).max(128),
  type: z.enum(["text","image","video","audio","document","location","contact"]),
  text: z.string().max(65536).optional(),
  mediaId: z.string().uuid().optional(),
  quotedMessageId: z.string().uuid().optional(),
}).superRefine((value, ctx) => {
  if (value.type === "text" && !value.text?.trim()) ctx.addIssue({ code:"custom", path:["text"], message:"文本消息不能为空" });
  if (["image","video","audio","document"].includes(value.type) && !value.mediaId) ctx.addIssue({ code:"custom", path:["mediaId"], message:"媒体消息必须提供 mediaId" });
});

export const newConversationSchema = z.object({
  accountId: z.string().uuid(),
  phone: z.string().transform(value=>value.trim().replace(/[\s()+.-]/g,"")).refine(value=>/^[1-9]\d{6,14}$/.test(value),"请输入包含国家代码的有效号码"),
  displayName: z.string().trim().min(1).max(80).optional(),
  firstMessage: z.string().trim().min(1).max(65536),
  clientMessageId: z.string().min(8).max(128),
});

export const enrollmentSchema = z.object({ code: z.string().min(16), name: z.string().min(2).max(80), version: z.string(), platform: z.string() });
