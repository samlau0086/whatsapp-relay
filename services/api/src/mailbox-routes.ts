import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { authenticate, canAccessAccount } from "./auth.js";
import { config } from "./config.js";
import { pool, transaction } from "./db.js";
import { emailShell, type EmailProviderConfig } from "./email.js";
import { verifyMailbox } from "./mailboxes.js";
import { conversationEmailSchema, mailboxSettingsSchema } from "./schemas.js";
import { decryptAtRest, encryptAtRest } from "./security.js";

const updateSchema=mailboxSettingsSchema.omit({imapPassword:true,smtpPassword:true}).extend({imapPassword:z.string().optional(),smtpPassword:z.string().optional()});

export function registerMailboxRoutes(app:FastifyInstance):void{
  app.get("/api/v1/mailboxes",{preHandler:authenticate},async(request,reply)=>{
    if(request.principal?.kind!=="user")return reply.code(403).send({error:"user_required"});
    const result=await pool.query("SELECT id,account_id,address,display_name,is_primary,enabled,imap_host,imap_port,imap_username,smtp_host,smtp_port,smtp_tls,smtp_username,last_error,last_synced_at,created_at FROM account_email_mailboxes WHERE ($1::uuid[] IS NULL OR account_id=ANY($1)) ORDER BY account_id,is_primary DESC,address",[request.principal.accountIds]);
    return {data:result.rows};
  });
  app.post("/api/v1/admin/mailboxes",{preHandler:authenticate},async(request,reply)=>{
    if(request.principal?.role!=="admin")return reply.code(403).send({error:"admin_required"});
    const parsed=mailboxSettingsSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});
    const value=parsed.data;
    const account=await pool.query("SELECT 1 FROM channel_accounts WHERE id=$1 AND platform='whatsapp'",[value.accountId]);if(!account.rowCount)return reply.code(404).send({error:"account_not_found"});
    try{await verifyMailbox(value);}catch(error){return reply.code(400).send({error:"mailbox_connection_failed",message:String(error)});}
    try{const result=await transaction(async client=>{
      if(value.isPrimary)await client.query("UPDATE account_email_mailboxes SET is_primary=false WHERE account_id=$1",[value.accountId]);
      return client.query("INSERT INTO account_email_mailboxes(account_id,address,display_name,is_primary,enabled,imap_host,imap_port,imap_username,imap_secret_encrypted,smtp_host,smtp_port,smtp_tls,smtp_username,smtp_secret_encrypted,uid_validity,last_uid) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NULL,NULL) RETURNING id",[value.accountId,value.address,value.displayName,value.isPrimary,value.enabled,value.imapHost,value.imapPort,value.imapUsername,encryptAtRest(value.imapPassword,config.DATA_ENCRYPTION_KEY),value.smtpHost,value.smtpPort,value.smtpTls,value.smtpUsername,encryptAtRest(value.smtpPassword,config.DATA_ENCRYPTION_KEY)]);
    });return reply.code(201).send({id:result.rows[0].id});}catch(error){if((error as {code?:string}).code==="23505")return reply.code(409).send({error:"mailbox_exists"});throw error;}
  });
  app.put("/api/v1/admin/mailboxes/:id",{preHandler:authenticate},async(request,reply)=>{
    if(request.principal?.role!=="admin")return reply.code(403).send({error:"admin_required"});
    const {id}=request.params as {id:string},parsed=updateSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});
    const current=await pool.query("SELECT imap_secret_encrypted,smtp_secret_encrypted FROM account_email_mailboxes WHERE id=$1",[id]);if(!current.rowCount)return reply.code(404).send({error:"not_found"});
    const value=parsed.data,imapPassword=value.imapPassword||decryptAtRest(current.rows[0].imap_secret_encrypted,config.DATA_ENCRYPTION_KEY),smtpPassword=value.smtpPassword||decryptAtRest(current.rows[0].smtp_secret_encrypted,config.DATA_ENCRYPTION_KEY);
    const account=await pool.query("SELECT 1 FROM channel_accounts WHERE id=$1 AND platform='whatsapp'",[value.accountId]);if(!account.rowCount)return reply.code(404).send({error:"account_not_found"});
    try{await verifyMailbox({...value,imapPassword,smtpPassword});}catch(error){return reply.code(400).send({error:"mailbox_connection_failed",message:String(error)});}
    try{await transaction(async client=>{
      if(value.isPrimary)await client.query("UPDATE account_email_mailboxes SET is_primary=false WHERE account_id=$1 AND id<>$2",[value.accountId,id]);
      await client.query("UPDATE account_email_mailboxes SET account_id=$2,address=$3,display_name=$4,is_primary=$5,enabled=$6,imap_host=$7,imap_port=$8,imap_username=$9,imap_secret_encrypted=$10,smtp_host=$11,smtp_port=$12,smtp_tls=$13,smtp_username=$14,smtp_secret_encrypted=$15,uid_validity=NULL,last_uid=NULL,next_sync_at=now(),updated_at=now() WHERE id=$1",[id,value.accountId,value.address,value.displayName,value.isPrimary,value.enabled,value.imapHost,value.imapPort,value.imapUsername,encryptAtRest(imapPassword,config.DATA_ENCRYPTION_KEY),value.smtpHost,value.smtpPort,value.smtpTls,value.smtpUsername,encryptAtRest(smtpPassword,config.DATA_ENCRYPTION_KEY)]);
    });return {id};}catch(error){if((error as {code?:string}).code==="23505")return reply.code(409).send({error:"mailbox_exists"});throw error;}
  });
  app.delete("/api/v1/admin/mailboxes/:id",{preHandler:authenticate},async(request,reply)=>{
    if(request.principal?.role!=="admin")return reply.code(403).send({error:"admin_required"});
    const {id}=request.params as {id:string};const result=await pool.query("DELETE FROM account_email_mailboxes WHERE id=$1 RETURNING id",[id]);return result.rowCount?reply.code(204).send():reply.code(404).send({error:"not_found"});
  });
  app.post("/api/v1/admin/mailboxes/:id/test",{preHandler:authenticate},async(request,reply)=>{
    if(request.principal?.role!=="admin")return reply.code(403).send({error:"admin_required"});
    const {id}=request.params as {id:string};const result=await pool.query("SELECT * FROM account_email_mailboxes WHERE id=$1",[id]);if(!result.rowCount)return reply.code(404).send({error:"not_found"});const row=result.rows[0];
    try{return await verifyMailbox({accountId:row.account_id,address:row.address,displayName:row.display_name,isPrimary:row.is_primary,enabled:row.enabled,imapHost:row.imap_host,imapPort:row.imap_port,imapUsername:row.imap_username,imapPassword:decryptAtRest(row.imap_secret_encrypted,config.DATA_ENCRYPTION_KEY),smtpHost:row.smtp_host,smtpPort:row.smtp_port,smtpTls:row.smtp_tls,smtpUsername:row.smtp_username,smtpPassword:decryptAtRest(row.smtp_secret_encrypted,config.DATA_ENCRYPTION_KEY)});}catch(error){return reply.code(400).send({error:"mailbox_connection_failed",message:String(error)});}
  });
  app.post("/api/v1/admin/mailboxes/:id/retry-errors",{preHandler:authenticate},async(request,reply)=>{
    if(request.principal?.role!=="admin")return reply.code(403).send({error:"admin_required"});
    const {id}=request.params as {id:string};const result=await pool.query("UPDATE account_email_mailboxes SET last_uid=LEAST(last_uid,COALESCE((SELECT MIN(uid)-1 FROM email_inbound_receipts WHERE mailbox_id=$1 AND message_id IS NULL AND error IS NOT NULL),last_uid)),next_sync_at=now(),last_error=NULL WHERE id=$1 RETURNING id",[id]);return result.rowCount?{id}:reply.code(404).send({error:"not_found"});
  });
  const send=async(request:FastifyRequest,reply:FastifyReply)=>{
    if(request.principal?.kind!=="user")return reply.code(403).send({error:"user_required"});
    const parsed=conversationEmailSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});
    const value=parsed.data,params=request.params as {id?:string;contactId?:string};
    const contact=await pool.query("SELECT co.id,co.account_id,co.entity_type FROM contacts co WHERE co.id=COALESCE($1::uuid,(SELECT contact_id FROM conversations WHERE id=$2))",[params.contactId??null,params.id??null]);
    if(!contact.rowCount||contact.rows[0].entity_type==="group"||!canAccessAccount(request.principal,contact.rows[0].account_id))return reply.code(404).send({error:"not_found"});
    const accountId=String(contact.rows[0].account_id),contactId=String(contact.rows[0].id);
    const [mailbox,recipient,media,resendProvider]=await Promise.all([
      pool.query("SELECT * FROM account_email_mailboxes WHERE id=$1 AND account_id=$2 AND enabled",[value.mailboxId,accountId]),
      value.recipientEmailId?pool.query("SELECT email FROM contact_emails WHERE id=$1 AND contact_id=$2",[value.recipientEmailId,contactId]):pool.query("SELECT email FROM contact_emails WHERE contact_id=$1 AND lower(email)=lower($2) LIMIT 1",[contactId,value.recipientEmail]),
      pool.query("SELECT id,file_name,mime_type,byte_size FROM media WHERE id=ANY($1::uuid[]) AND account_id=$2 AND status='ready'",[value.attachmentIds,accountId]),
      pool.query("SELECT config,secret_encrypted FROM email_provider_settings WHERE provider='resend' AND enabled AND secret_encrypted IS NOT NULL LIMIT 1"),
    ]);
    if(!mailbox.rowCount||!recipient.rowCount)return reply.code(409).send({error:"email_address_unavailable"});
    if(media.rowCount!==value.attachmentIds.length||media.rows.reduce((sum,row)=>sum+Number(row.byte_size),0)>25*1024*1024||media.rows.some(row=>Number(row.byte_size)>20*1024*1024))return reply.code(413).send({error:"email_attachments_invalid"});
    const row=mailbox.rows[0],resend=resendProvider.rows[0],provider=resend?"resend":"smtp",providerConfig:EmailProviderConfig=resend?{...(resend.config as EmailProviderConfig),fromName:row.display_name||resend.config.fromName||row.address,fromEmail:resend.config.fromEmail||row.address}:{fromName:row.display_name||row.address,fromEmail:row.address,host:row.smtp_host,port:row.smtp_port,tls:row.smtp_tls,username:row.smtp_username},providerSecret=resend?resend.secret_encrypted:row.smtp_secret_encrypted;
    const result=await transaction(async client=>{
      const existing=await client.query("SELECT e.id,e.conversation_id FROM email_messages e WHERE e.client_send_id=$1",[value.clientSendId]);if(existing.rowCount){const belongs=await client.query("SELECT 1 FROM conversations WHERE id=$1 AND contact_id=$2",[existing.rows[0].conversation_id,contactId]);if(!belongs.rowCount)throw Object.assign(new Error("idempotency_conflict"),{statusCode:409});return {emailId:existing.rows[0].id,conversationId:existing.rows[0].conversation_id,deduplicated:true};}
      const conversation=await client.query("INSERT INTO conversations(account_id,contact_id,status) VALUES($1,$2,'open') ON CONFLICT(account_id,contact_id) DO UPDATE SET status='open',closed_at=NULL RETURNING id",[accountId,contactId]);const conversationId=String(conversation.rows[0].id);
      if(params.id&&params.id!==conversationId)throw Object.assign(new Error("conversation_not_found"),{statusCode:404});
      const replyMessage=value.replyToMessageId?await client.query("SELECT d.rfc_message_id,d.references_header,d.subject FROM message_email_details d JOIN messages m ON m.id=d.message_id WHERE m.id=$1 AND m.conversation_id=$2",[value.replyToMessageId,conversationId]):null;
      if(value.replyToMessageId&&!replyMessage?.rowCount)throw Object.assign(new Error("reply_message_not_found"),{statusCode:404});
      const inReplyTo=replyMessage?.rows[0]?.rfc_message_id??null,references=inReplyTo?[replyMessage?.rows[0]?.references_header,inReplyTo].filter(Boolean).join(" "):null;
      const job=await client.query("INSERT INTO email_messages(client_send_id,conversation_id,contact_id,sender_user_id,provider,provider_config,provider_secret_encrypted,recipients,subject,message_body,text_body,html_body,content_type,mailbox_id,in_reply_to,references_header) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$9,$11,'text',$12,$13,$14) RETURNING id",[value.clientSendId,conversationId,contactId,request.principal!.id,provider,JSON.stringify(providerConfig),providerSecret,JSON.stringify([{email:recipient.rows[0].email,label:""}]),value.subject,value.body,emailShell(value.body,""),row.id,inReplyTo,references]);
      const message=await client.query("INSERT INTO messages(conversation_id,account_id,sender_user_id,client_message_id,direction,kind,text_content,status,occurred_at) VALUES($1,$2,$3,$4,'out','text',$5,'queued',now()) RETURNING id",[conversationId,accountId,request.principal!.id,`email:${job.rows[0].id}`,value.body]);
      await client.query("INSERT INTO message_email_details(message_id,mailbox_id,subject,from_email,to_emails,rfc_message_id,in_reply_to,references_header,email_job_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",[message.rows[0].id,row.id,value.subject,row.address,JSON.stringify([recipient.rows[0].email]),`<email-${job.rows[0].id}@relaydesk.local>`,inReplyTo,references,job.rows[0].id]);
      for(const [position,id] of value.attachmentIds.entries()){const item=media.rows.find(entry=>entry.id===id);await client.query("INSERT INTO email_attachments(email_id,media_id,position,file_name,content_id,mime_type,byte_size) VALUES($1,$2,$3,$4,$5,$6,$7)",[job.rows[0].id,id,position,item.file_name||"attachment",`attachment-${position}`,item.mime_type,item.byte_size]);await client.query("INSERT INTO message_email_attachments(message_id,media_id,position,file_name,mime_type,byte_size) VALUES($1,$2,$3,$4,$5,$6)",[message.rows[0].id,id,position,item.file_name||"attachment",item.mime_type,item.byte_size]);}
      return {emailId:job.rows[0].id,conversationId,deduplicated:false};
    });return reply.code(202).send(result);
  };
  app.post("/api/v1/contacts/:contactId/email-sends",{preHandler:authenticate},send);
  app.post("/api/v1/conversations/:id/email-sends/text",{preHandler:authenticate},send);
}
