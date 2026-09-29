import type {PoolClient} from "pg";
import {escapeHtml,type EmailProviderConfig} from "./email.js";

export type OutreachEmailDestination={mailbox_id:string;from_email:string;to_email:string};

export async function outreachEmailDestination(client:PoolClient,accountId:string,contactId:string):Promise<OutreachEmailDestination|null>{
  const result=await client.query(`SELECT mb.id mailbox_id,mb.address from_email,ce.email to_email
    FROM account_email_mailboxes mb CROSS JOIN contact_emails ce
    WHERE mb.account_id=$1 AND mb.is_primary AND mb.enabled AND ce.contact_id=$2 AND ce.is_primary
    ORDER BY ce.position LIMIT 1`,[accountId,contactId]);
  return result.rows[0]??null;
}

export async function queueProactiveEmail(client:PoolClient,input:{jobId:string;accountId:string;contactId:string;conversationId:string;subject:string;body:string;senderUserId?:string|null}):Promise<string>{
  const {jobId,accountId,contactId,conversationId}=input;
  const state=await client.query(`SELECT co.proactive_email_allowed,co.proactive_suppressed_at,co.provider_user_id,co.phone_e164,co.whatsapp_username,
    s.enabled,s.email_enabled,cv.status,COALESCE(st.mode,'cautious') mode
    FROM contacts co JOIN proactive_outreach_settings s ON s.account_id=co.account_id
    JOIN conversations cv ON cv.id=$2 AND cv.contact_id=co.id
    LEFT JOIN conversation_agent_state st ON st.conversation_id=cv.id WHERE co.id=$1 FOR UPDATE OF co,cv`,[contactId,conversationId]);
  const value=state.rows[0];
  if(!value?.proactive_email_allowed||value.proactive_suppressed_at||!value.enabled||!value.email_enabled||value.status!=="open"||value.mode==="human_paused"||value.provider_user_id||value.phone_e164||value.whatsapp_username)throw new Error("email_outreach_not_permitted");
  const destination=await outreachEmailDestination(client,accountId,contactId);
  if(!destination)throw new Error("primary_email_unavailable");
  const mailbox=await client.query("SELECT * FROM account_email_mailboxes WHERE id=$1 AND enabled AND is_primary",[destination.mailbox_id]);
  if(!mailbox.rowCount)throw new Error("primary_mailbox_unavailable");
  const row=mailbox.rows[0];
  const resend=row.auth_type==="microsoft"?null:(await client.query("SELECT config,secret_encrypted FROM email_provider_settings WHERE provider='resend' AND enabled AND secret_encrypted IS NOT NULL LIMIT 1")).rows[0];
  const useResend=Boolean(resend&&String(resend.config?.fromEmail??"").toLowerCase()===String(row.address).toLowerCase());
  const provider=useResend?"resend":"smtp";
  const config:EmailProviderConfig=useResend?{...resend.config,fromName:row.display_name||row.address,fromEmail:row.address}:{fromName:row.display_name||row.address,fromEmail:row.address,host:row.smtp_host,port:row.smtp_port,tls:row.smtp_tls,username:row.smtp_username};
  if(row.auth_type==="microsoft")config.oauthMailboxId=String(row.id);
  const secret=useResend?resend.secret_encrypted:row.smtp_secret_encrypted;
  if(!secret&&row.auth_type!=="microsoft")throw new Error("mailbox_send_unavailable");
  const previous=await client.query(`SELECT d.rfc_message_id,d.references_header,d.subject,d.message_id FROM message_email_details d
    JOIN messages m ON m.id=d.message_id WHERE m.conversation_id=$1 AND d.mailbox_id=$2 AND d.rfc_message_id IS NOT NULL
    ORDER BY m.occurred_at DESC,m.id DESC LIMIT 1`,[conversationId,destination.mailbox_id]);
  const parent=previous.rows[0],followUp=Boolean(parent?.rfc_message_id);
  const subject=followUp?`RE: ${String(parent.subject).replace(/^(?:(?:re(?:\(\d+\))?|fwd?)\s*:\s*)+/i,"")}`:input.subject;
  const inReplyTo=followUp?String(parent.rfc_message_id):null;
  const references=inReplyTo?[parent.references_header,inReplyTo].filter(Boolean).join(" "):null;
  const body=`${input.body.trim()}\n\n回复“退订”可停止后续触达。`;
  if(!subject.trim()||subject.length>200||body.length>5000)throw new Error("email_outreach_content_invalid");
  const email=await client.query(`INSERT INTO email_messages(client_send_id,conversation_id,contact_id,sender_user_id,provider,provider_config,provider_secret_encrypted,recipients,subject,message_body,text_body,html_body,content_type,mailbox_id,in_reply_to,references_header)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11,'text',$12,$13,$14) RETURNING id`,
    [jobId,conversationId,contactId,input.senderUserId??null,provider,JSON.stringify(config),secret??"",JSON.stringify([{email:destination.to_email,label:""}]),subject,body,`<p>${escapeHtml(body)}</p>`,row.id,inReplyTo,references]);
  const emailId=String(email.rows[0].id);
  const message=await client.query(`INSERT INTO messages(conversation_id,account_id,sender_user_id,client_message_id,direction,kind,text_content,quoted_message_id,status,occurred_at)
    VALUES($1,$2,$3,$4,'out','text',$5,$6,'queued',now()) RETURNING id`,[conversationId,accountId,input.senderUserId??null,`email:${emailId}`,input.body.trim(),parent?.message_id??null]);
  await client.query(`INSERT INTO message_email_details(message_id,mailbox_id,subject,from_email,to_emails,rfc_message_id,in_reply_to,references_header,email_job_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[message.rows[0].id,row.id,subject,config.fromEmail,JSON.stringify([destination.to_email]),`<email-${emailId}@relaydesk.local>`,inReplyTo,references,emailId]);
  await client.query("UPDATE proactive_outreach_jobs SET state='queued',message_id=$2,completed_at=NULL,last_error=NULL,updated_at=now() WHERE id=$1",[jobId,message.rows[0].id]);
  return String(message.rows[0].id);
}
