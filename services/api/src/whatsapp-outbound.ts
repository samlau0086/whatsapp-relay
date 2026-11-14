import type {PoolClient} from "pg";

export class TemplateRequiredError extends Error {
  readonly code="template_required";
  readonly statusCode=409;
  constructor(readonly serviceWindowExpiresAt:string|null){
    super("Cloud API 账号已超出 24 小时客户服务窗口，请改用已审核模板");
  }
}

export class MessengerReplyWindowClosedError extends Error {
  readonly code="messenger_reply_window_closed";
  readonly statusCode=409;
  constructor(readonly replyWindowExpiresAt:string|null){
    super("Facebook Messenger 24 小时回复窗口已关闭，无法继续发送消息");
  }
}

export type OutboundPayload={
  accountId:string;
  conversationId:string;
  clientMessageId:string;
  type:string;
  messageId:string;
  toJid?:string;
  toUsername?:string;
  destinationId?:string;
  text?:string;
  mediaId?:string;
  template?:unknown;
  quotedMessageId?:string;
  quotedWhatsappMessageId?:string;
  quotedParticipantJid?:string;
  quotedProviderMessageId?:string;
  quotedDirection?:"in"|"out";
  quotedText?:string;
};

export async function queueChannelCommand(
  client:PoolClient,
  input:{accountId:string;conversationId:string;messageId:string;payload:OutboundPayload},
):Promise<{commandId:string;sequence:number;agentId:string|null;transport:"web"|"cloud";platform:"whatsapp"|"messenger"|"livechat"}>{
  const found=await client.query(
    `SELECT a.platform,a.transport,a.agent_id,c.service_window_expires_at
       FROM channel_accounts a
       JOIN conversations c ON c.id=$2 AND c.account_id=a.id
      WHERE a.id=$1
      FOR UPDATE OF c`,
    [input.accountId,input.conversationId],
  );
  if(!found.rowCount)throw Object.assign(new Error("conversation_not_found"),{statusCode:404});
  const row=found.rows[0],transport=String(row.transport??"web") as "web"|"cloud",platform=String(row.platform??"whatsapp") as "whatsapp"|"messenger"|"livechat";
  if(transport==="web"&&!row.agent_id)throw Object.assign(new Error("account_not_bound"),{statusCode:409});
  const payload={...input.payload};
  if(platform==="livechat"){
    if(!["text","image","document"].includes(input.payload.type))throw Object.assign(new Error("livechat_message_type_unsupported"),{statusCode:409});
    if((payload.text?.length??0)>10000)throw Object.assign(new Error("livechat_text_too_long"),{statusCode:400});
    if(payload.type!=="text"){
      const media=await client.query("SELECT mime_type,byte_size FROM media WHERE id=$1 AND (account_id=$2 OR account_id IS NULL) AND status='ready'",[payload.mediaId,input.accountId]);
      const file=media.rows[0],allowed=["image/png","image/jpeg","image/webp","application/pdf","text/plain"];
      if(!file||!allowed.includes(file.mime_type)||Number(file.byte_size)>10*1024*1024||((payload.type==="image")!==String(file.mime_type).startsWith("image/")))throw Object.assign(new Error("livechat_attachment_unsupported"),{statusCode:415});
    }
    const active=await client.query("SELECT 1 FROM livechat_channels WHERE account_id=$1 AND enabled AND archived_at IS NULL",[input.accountId]);
    if(!active.rowCount)throw Object.assign(new Error("livechat_channel_disabled"),{statusCode:409});
  }
  if(platform==="whatsapp"&&transport==="web"&&!payload.toJid){
    // Profile edits in older versions could erase a hidden LID. Only reuse a confirmed target from this conversation.
    const history=await client.query(`SELECT oc.payload->>'toJid' jid FROM outbound_commands oc
      JOIN messages m ON m.id=oc.message_id AND m.account_id=oc.account_id
      WHERE oc.account_id=$1 AND m.conversation_id=$2 AND m.status IN ('sent','delivered','read')
        AND oc.payload->>'toJid' ~ '^[0-9]+@(s[.]whatsapp[.]net|lid)$'
      ORDER BY oc.sequence DESC LIMIT 1`,[input.accountId,input.conversationId]);
    if(history.rowCount){payload.toJid=String(history.rows[0].jid);payload.destinationId=payload.toJid;delete payload.toUsername;}
  }
  if(platform==="messenger"){
    if(input.payload.type==="template")throw Object.assign(new Error("messenger_template_unsupported"),{statusCode:409});
    if(input.payload.type!=="text"&&input.payload.text?.trim())throw Object.assign(new Error("messenger_media_caption_unsupported"),{statusCode:409});
    const expires=row.service_window_expires_at?new Date(row.service_window_expires_at):null;
    if(!expires||expires.getTime()<=Date.now())throw new MessengerReplyWindowClosedError(expires?.toISOString()??null);
  }
  if(platform==="whatsapp"&&transport==="cloud"&&input.payload.type!=="template"){
    const expires=row.service_window_expires_at?new Date(row.service_window_expires_at):null;
    if(!expires||expires.getTime()<=Date.now())throw new TemplateRequiredError(expires?.toISOString()??null);
  }
  if(platform==="whatsapp"&&transport==="cloud"&&input.payload.type==="template"){
    const template=input.payload.template as {name?:string;language?:string}|undefined;
    const approved=template?.name&&template.language?await client.query("SELECT 1 FROM whatsapp_message_templates WHERE account_id=$1 AND name=$2 AND language=$3 AND status='APPROVED'",[input.accountId,template.name,template.language]):null;
    if(!approved?.rowCount)throw Object.assign(new Error("template_not_approved"),{statusCode:409});
    const components=(input.payload.template as {components?:Array<{parameters?:Array<{mediaId?:string}>}>}).components??[];
    const mediaIds=[...new Set(components.flatMap(component=>(component.parameters??[]).map(parameter=>parameter.mediaId).filter((id):id is string=>Boolean(id))))];
    if(mediaIds.length){
      const media=await client.query("SELECT id FROM media WHERE id=ANY($1::uuid[]) AND (account_id=$2 OR account_id IS NULL) AND status='ready'",[mediaIds,input.accountId]);
      if(media.rowCount!==mediaIds.length)throw Object.assign(new Error("template_media_not_found"),{statusCode:404});
    }
  }
  const command=await client.query(
    "INSERT INTO outbound_commands(agent_id,account_id,message_id,command,payload) VALUES($1,$2,$3,'send_message',$4) RETURNING id,sequence",
    [transport==="web"?row.agent_id:null,input.accountId,input.messageId,JSON.stringify(payload)],
  );
  return{commandId:String(command.rows[0].id),sequence:Number(command.rows[0].sequence),agentId:transport==="web"?String(row.agent_id):null,transport,platform};
}

export async function queueGroupCreateCommand(client:PoolClient,input:{accountId:string;subject:string;participantJids:string[]}):Promise<{commandId:string;sequence:number;agentId:string}> {
  const found=await client.query("SELECT platform,transport,agent_id FROM channel_accounts WHERE id=$1 FOR UPDATE",[input.accountId]);
  if(!found.rowCount)throw Object.assign(new Error("account_not_found"),{statusCode:404});
  const row=found.rows[0];
  if(row.platform!=="whatsapp"||row.transport!=="web"||!row.agent_id)throw Object.assign(new Error("agent_required"),{statusCode:409});
  const command=await client.query("INSERT INTO outbound_commands(agent_id,account_id,command,payload) VALUES($1,$2,'create_group',$3) RETURNING id,sequence",[row.agent_id,input.accountId,JSON.stringify({subject:input.subject,participantJids:input.participantJids})]);
  return{commandId:String(command.rows[0].id),sequence:Number(command.rows[0].sequence),agentId:String(row.agent_id)};
}

export async function queueWhatsAppBlockCommand(client:PoolClient,input:{accountId:string;toJid:string;action:"block"|"unblock";actorId:string}):Promise<{commandId:string;sequence:number;agentId:string}> {
  const found=await client.query("SELECT platform,transport,agent_id FROM channel_accounts WHERE id=$1 FOR UPDATE",[input.accountId]);
  if(!found.rowCount)throw Object.assign(new Error("account_not_found"),{statusCode:404});
  const row=found.rows[0];
  if(row.platform!=="whatsapp"||row.transport!=="web"||!row.agent_id)throw Object.assign(new Error("agent_required"),{statusCode:409});
  const command=await client.query("INSERT INTO outbound_commands(agent_id,account_id,command,payload) VALUES($1,$2,$3,$4) RETURNING id,sequence",[row.agent_id,input.accountId,input.action==="block"?"block_contact":"unblock_contact",JSON.stringify({toJid:input.toJid,actorId:input.actorId})]);
  return{commandId:String(command.rows[0].id),sequence:Number(command.rows[0].sequence),agentId:String(row.agent_id)};
}

export function isTemplateRequiredError(error:unknown):error is TemplateRequiredError{
  return error instanceof TemplateRequiredError||Boolean(error&&typeof error==="object"&&(error as {code?:string}).code==="template_required");
}

export function isMessengerReplyWindowClosedError(error:unknown):error is MessengerReplyWindowClosedError{
  return error instanceof MessengerReplyWindowClosedError||Boolean(error&&typeof error==="object"&&(error as {code?:string}).code==="messenger_reply_window_closed");
}

/** @deprecated Use queueChannelCommand. */
export const queueWhatsAppCommand=queueChannelCommand;
