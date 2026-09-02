export const PROTOCOL_VERSION = 2;

export type AccountStatus = "pairing" | "online" | "offline" | "logged_out" | "error";
export type MessageKind = "text" | "image" | "video" | "audio" | "document" | "location" | "contact";
export type DeliveryStatus = "queued" | "dispatching" | "sent" | "delivered" | "read" | "failed" | "uncertain";

export interface AdReferral {
  source?: string;
  sourceId?: string;
  sourceUrl?: string;
  headline?: string;
  body?: string;
  mediaType?: string;
  thumbnailUrl?: string;
  mediaUrl?: string;
  ctwaClid?: string;
}

export interface AgentHello {
  type: "hello";
  protocolVersion: number;
  agentId: string;
  agentVersion: string;
  platform: string;
  lastAckedCursor: number;
  capabilities?: string[];
}

export interface AgentHeartbeat {
  type: "heartbeat";
  at: string;
  accounts: Array<{ accountId: string; status: AccountStatus; queueDepth: number }>;
}

export interface NormalizedMessage {
  eventId: string;
  accountId: string;
  whatsappMessageId: string;
  chatJid: string;
  rawChatJid?: string;
  senderJid: string;
  senderName?: string;
  chatType?: "direct" | "group";
  direction: "in" | "out";
  kind: MessageKind;
  text?: string;
  adReferral?: AdReferral;
  quotedWhatsappMessageId?: string;
  occurredAt: string;
  media?: { uploadId: string; mimeType: string; fileName?: string; size: number; sha256: string };
}

export interface GroupSnapshot {
  eventId: string;
  accountId: string;
  syncId?: string;
  groupJid: string;
  subject: string;
  description?: string;
  ownerJid?: string;
  isAnnouncement: boolean;
  isCommunity: boolean;
  participants: Array<{
    jid: string;
    phoneJid?: string;
    lidJid?: string;
    displayName?: string;
    role: "member" | "admin" | "superadmin";
  }>;
  at: string;
}

export interface AgentEventBatch {
  type: "event_batch";
  fromCursor: number;
  toCursor: number;
  events: Array<
    | { cursor:number; kind: "message"; payload: NormalizedMessage }
    | { cursor:number; kind: "message_status"; payload: { accountId: string; whatsappMessageId: string; status: DeliveryStatus; at: string } }
    | { cursor:number; kind: "account_status"; payload: { accountId: string; status: AccountStatus; reason?: string; at: string } }
    | { cursor:number; kind: "contact_identity"; payload: { eventId:string; accountId:string; phoneJid:string; lidJid:string; displayName?:string; at:string } }
    | { cursor:number; kind: "group_snapshot"; payload: GroupSnapshot }
    | { cursor:number; kind: "group_sync_complete"; payload: { eventId:string; accountId:string; syncId:string; at:string } }
  >;
}

export interface AgentCommand {
  type: "command";
  sequence: number;
  commandId: string;
  accountId: string;
  command: "send_message" | "publish_status" | "create_group" | "logout" | "request_snapshot";
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface AgentCommandResult {
  type: "command_result";
  sequence: number;
  commandId: string;
  outcome: "succeeded" | "failed" | "uncertain" | "deferred";
  whatsappMessageId?: string;
  errorCode?: string;
  errorMessage?: string;
  completedAt: string;
}

export type AgentFrame = AgentHello | AgentHeartbeat | AgentEventBatch | AgentCommandResult;
export type ServerFrame = AgentCommand | { type: "ack"; cursor: number } | { type: "incompatible"; supportedVersion: number } | { type: "pong"; at: string } | { type:"attention_cleared"; accountId:string; chatJid:string };

export function retryDelayMs(attempt: number, capMs = 30 * 60_000): number {
  const base = Math.min(capMs, 1_000 * 2 ** Math.max(0, attempt - 1));
  const deterministicJitter = ((attempt * 7919) % 1000) / 1000;
  return Math.round(base * (0.75 + deterministicJitter * 0.5));
}

export function messageDedupeKey(accountId: string, whatsappMessageId: string): string {
  return `${accountId}:${whatsappMessageId}`;
}
