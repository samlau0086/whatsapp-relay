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

export const textToSpeechSchema = z.object({
  accountId: z.string().uuid(),
  text: z.string().trim().min(1).max(4096),
  speed: z.number().min(0.25).max(4).default(1),
  instructions: z.string().trim().max(500).optional(),
});

export const ttsProviderSettingsSchema=z.object({
  enabled:z.boolean().default(false),
  apiKey:z.string().trim().min(1).max(4096).optional(),
  baseUrl:z.string().trim().url().max(2048),
  model:z.string().trim().max(200).default(""),
  voice:z.string().trim().min(1).max(200),
});

const languageCodeSchema=z.string().trim().min(2).max(35).regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/,"invalid BCP 47 language code");

export const translationPreferenceSchema=z.object({
  conversationId:z.string().uuid(),
  enabled:z.boolean(),
  agentLanguage:languageCodeSchema,
  customerLanguage:languageCodeSchema,
});

export const translationPreferenceQuerySchema=z.object({conversationId:z.string().uuid()});

export const translationProviderSettingsSchema=z.object({
  enabled:z.boolean().default(false),
  apiKey:z.string().trim().min(1).max(4096).optional(),
  baseUrl:z.string().trim().url().max(2048),
  model:z.string().trim().min(1).max(200),
  transcriptionModel:z.string().trim().min(1).max(200),
});

export const translationPreviewSchema=z.object({
  text:z.string().trim().min(1).max(65536),
  targetLanguage:languageCodeSchema,
});

export const messageTranslationsSchema=z.object({
  messageIds:z.array(z.string().uuid()).min(1).max(50),
  targetLanguage:languageCodeSchema,
});

export const newConversationSchema = z.object({
  accountId: z.string().uuid(),
  phone: z.string().transform(value=>value.trim().replace(/[\s()+.-]/g,"")).refine(value=>/^[1-9]\d{6,14}$/.test(value),"请输入包含国家代码的有效号码"),
  displayName: z.string().trim().min(1).max(80).optional(),
  firstMessage: z.string().trim().min(1).max(65536),
  clientMessageId: z.string().min(8).max(128),
});

export const enrollmentSchema = z.object({ code: z.string().min(16), name: z.string().min(2).max(80), version: z.string(), platform: z.string() });
