import type {PoolClient} from "pg";

export class TemplateRequiredError extends Error {
  readonly code="template_required";
  readonly statusCode=409;
  constructor(readonly serviceWindowExpiresAt:string|null){
    super("Cloud API 账号已超出 24 小时客户服务窗口，请改用已审核模板");
  }
}

export type OutboundPayload={
  accountId:string;
  conversationId:string;
  clientMessageId:string;
  type:string;
  messageId:string;
  toJid:string;
  text?:string;
  mediaId?:string;
  template?:unknown;
  quotedMessageId?:string;
};

export async function queueWhatsAppCommand(
  client:PoolClient,
  input:{accountId:string;conversationId:string;messageId:string;payload:OutboundPayload},
):Promise<{commandId:string;sequence:number;agentId:string|null;transport:"web"|"cloud"}>{
  const found=await client.query(
    `SELECT a.transport,a.agent_id,c.service_window_expires_at
       FROM whatsapp_accounts a
       JOIN conversations c ON c.id=$2 AND c.account_id=a.id
      WHERE a.id=$1
      FOR UPDATE OF c`,
    [input.accountId,input.conversationId],
  );
  if(!found.rowCount)throw Object.assign(new Error("conversation_not_found"),{statusCode:404});
  const row=found.rows[0],transport=String(row.transport??"web") as "web"|"cloud";
  if(transport==="web"&&!row.agent_id)throw Object.assign(new Error("account_not_bound"),{statusCode:409});
  if(transport==="cloud"&&input.payload.type!=="template"){
    const expires=row.service_window_expires_at?new Date(row.service_window_expires_at):null;
    if(!expires||expires.getTime()<=Date.now())throw new TemplateRequiredError(expires?.toISOString()??null);
  }
  if(transport==="cloud"&&input.payload.type==="template"){
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
    [transport==="web"?row.agent_id:null,input.accountId,input.messageId,JSON.stringify(input.payload)],
  );
  return{commandId:String(command.rows[0].id),sequence:Number(command.rows[0].sequence),agentId:transport==="web"?String(row.agent_id):null,transport};
}

export function isTemplateRequiredError(error:unknown):error is TemplateRequiredError{
  return error instanceof TemplateRequiredError||Boolean(error&&typeof error==="object"&&(error as {code?:string}).code==="template_required");
}
