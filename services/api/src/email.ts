import nodemailer from "nodemailer";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { PoolClient } from "pg";
import { config } from "./config.js";
import { pool, transaction } from "./db.js";
import { decryptAtRest } from "./security.js";

export type EmailProvider="smtp"|"resend";
export type EmailProviderConfig={fromName:string;fromEmail:string;replyTo?:string;host?:string;port?:number;tls?:"tls"|"starttls";username?:string};
type EmailJob={id:string;provider:EmailProvider;provider_config:EmailProviderConfig;provider_secret_encrypted:string;recipients:Array<{email:string;label:string}>;subject:string;text_body:string;html_body:string;attempt:number};

const s3=new S3Client({region:config.S3_REGION,endpoint:config.S3_ENDPOINT,forcePathStyle:true,credentials:{accessKeyId:config.S3_ACCESS_KEY,secretAccessKey:config.S3_SECRET_KEY}});
const RETRY_MINUTES=[1,5,30,120];

export async function ensureEmailTables():Promise<void>{
  await pool.query(`CREATE TABLE IF NOT EXISTS email_provider_settings(provider text PRIMARY KEY CHECK(provider IN ('smtp','resend')),enabled boolean NOT NULL DEFAULT false,config jsonb NOT NULL DEFAULT '{}'::jsonb,secret_encrypted text,updated_by uuid REFERENCES users(id) ON DELETE SET NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now())`);
  await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS email_provider_one_enabled_idx ON email_provider_settings ((enabled)) WHERE enabled");
  await pool.query(`CREATE TABLE IF NOT EXISTS email_messages(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),client_send_id uuid UNIQUE NOT NULL,conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,sender_user_id uuid REFERENCES users(id) ON DELETE SET NULL,provider text NOT NULL CHECK(provider IN ('smtp','resend')),provider_config jsonb NOT NULL,provider_secret_encrypted text NOT NULL,recipients jsonb NOT NULL,subject text NOT NULL CHECK(char_length(subject) BETWEEN 1 AND 200),message_body text NOT NULL CHECK(char_length(message_body)<=5000),text_body text NOT NULL,html_body text NOT NULL,content_type text NOT NULL CHECK(content_type IN ('order_text','order_image','product_cards')),order_id uuid REFERENCES orders(id) ON DELETE SET NULL,product_ids jsonb,status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','sending','retrying','accepted','failed')),attempt smallint NOT NULL DEFAULT 0 CHECK(attempt BETWEEN 0 AND 5),available_at timestamptz NOT NULL DEFAULT now(),provider_message_id text,last_error text,accepted_at timestamptz,completed_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now())`);
  await pool.query("CREATE INDEX IF NOT EXISTS email_messages_claim_idx ON email_messages(available_at,created_at) WHERE status IN ('queued','retrying')");
  await pool.query("CREATE INDEX IF NOT EXISTS email_messages_conversation_idx ON email_messages(conversation_id,created_at DESC)");
  await pool.query(`CREATE TABLE IF NOT EXISTS email_attachments(email_id uuid NOT NULL REFERENCES email_messages(id) ON DELETE CASCADE,media_id uuid NOT NULL REFERENCES media(id) ON DELETE RESTRICT,position smallint NOT NULL,file_name text NOT NULL,content_id text NOT NULL,mime_type text NOT NULL DEFAULT 'image/png',byte_size bigint NOT NULL CHECK(byte_size>=0),PRIMARY KEY(email_id,position),UNIQUE(email_id,content_id))`);
}

export async function processOneEmail():Promise<boolean>{
  const job=await transaction(async client=>claimEmail(client));
  if(!job)return false;
  try{
    const attachments=await loadAttachments(job.id);
    const messageId=job.provider==="smtp"?await sendSmtp(job,attachments):await sendResend(job,attachments);
    await pool.query("UPDATE email_messages SET status='accepted',provider_message_id=$2,accepted_at=now(),completed_at=now(),updated_at=now(),last_error=NULL WHERE id=$1",[job.id,messageId]);
  }catch(error){await failOrRetry(job,error);}
  return true;
}

async function claimEmail(client:PoolClient):Promise<EmailJob|null>{
  await client.query("UPDATE email_messages SET status='retrying',available_at=now(),last_error='Worker restarted before provider response',updated_at=now() WHERE status='sending' AND updated_at<now()-interval '2 minutes' AND attempt<5");
  await client.query("UPDATE email_messages SET status='failed',last_error='Worker stopped before provider response; retry limit reached',completed_at=now(),updated_at=now() WHERE status='sending' AND updated_at<now()-interval '2 minutes' AND attempt>=5");
  const result=await client.query("SELECT id,provider,provider_config,provider_secret_encrypted,recipients,subject,text_body,html_body,attempt FROM email_messages WHERE status IN ('queued','retrying') AND available_at<=now() ORDER BY available_at,created_at FOR UPDATE SKIP LOCKED LIMIT 1");
  if(!result.rowCount)return null;
  await client.query("UPDATE email_messages SET status='sending',attempt=attempt+1,updated_at=now() WHERE id=$1",[result.rows[0].id]);
  return{...result.rows[0],attempt:Number(result.rows[0].attempt)+1} as EmailJob;
}

async function loadAttachments(emailId:string){
  const result=await pool.query("SELECT a.file_name,a.content_id,a.mime_type,m.object_key FROM email_attachments a JOIN media m ON m.id=a.media_id WHERE a.email_id=$1 ORDER BY a.position",[emailId]);
  return Promise.all(result.rows.map(async row=>{const object=await s3.send(new GetObjectCommand({Bucket:config.S3_BUCKET,Key:row.object_key}));if(!object.Body)throw new Error("email_attachment_missing");return{filename:String(row.file_name),cid:String(row.content_id),contentType:String(row.mime_type),content:Buffer.from(await object.Body.transformToByteArray())};}));
}

async function sendSmtp(job:EmailJob,attachments:Awaited<ReturnType<typeof loadAttachments>>):Promise<string>{
  const cfg=job.provider_config,secret=decryptAtRest(job.provider_secret_encrypted,config.DATA_ENCRYPTION_KEY);
  const transport=nodemailer.createTransport({host:cfg.host,port:cfg.port,secure:cfg.tls==="tls",requireTLS:cfg.tls==="starttls",auth:cfg.username?{user:cfg.username,pass:secret}:undefined,connectionTimeout:15_000,greetingTimeout:15_000,socketTimeout:30_000,disableFileAccess:true,disableUrlAccess:true});
  const info=await transport.sendMail({from:{name:cfg.fromName,address:cfg.fromEmail},replyTo:cfg.replyTo||undefined,to:job.recipients.map(item=>item.email),subject:job.subject,text:job.text_body,html:job.html_body,messageId:`<email-${job.id}@relaydesk.local>`,attachments:attachments.map(item=>({...item,contentDisposition:"inline" as const}))});
  return info.messageId;
}

async function sendResend(job:EmailJob,attachments:Awaited<ReturnType<typeof loadAttachments>>):Promise<string>{
  const cfg=job.provider_config,apiKey=decryptAtRest(job.provider_secret_encrypted,config.DATA_ENCRYPTION_KEY);
  const response=await fetch("https://api.resend.com/emails",{method:"POST",headers:{authorization:`Bearer ${apiKey}`,"content-type":"application/json","idempotency-key":`relaydesk/email/${job.id}`},body:JSON.stringify({from:`${cfg.fromName} <${cfg.fromEmail}>`,to:job.recipients.map(item=>item.email),reply_to:cfg.replyTo||undefined,subject:job.subject,text:job.text_body,html:job.html_body,attachments:attachments.map(item=>({filename:item.filename,content:item.content.toString("base64"),content_type:item.contentType,content_disposition:"inline",content_id:item.cid}))})});
  const body=await response.json().catch(()=>({})) as {id?:string;message?:string};
  if(!response.ok)throw Object.assign(new Error(body.message||`resend_http_${response.status}`),{status:response.status});
  return body.id??"accepted";
}

async function failOrRetry(job:EmailJob,error:unknown):Promise<void>{
  const status=Number((error as {status?:number;responseCode?:number}).status??(error as {responseCode?:number}).responseCode??0),message=(error instanceof Error?error.message:String(error)).slice(0,2000);
  const temporary=job.provider==="smtp"?(!status||(status>=400&&status<500)):(!status||status===408||status===409||status===429||status>=500);
  if(temporary&&job.attempt<5){const minutes=RETRY_MINUTES[Math.min(job.attempt-1,RETRY_MINUTES.length-1)];await pool.query("UPDATE email_messages SET status='retrying',available_at=now()+($2||' minutes')::interval,last_error=$3,updated_at=now() WHERE id=$1",[job.id,String(minutes),message]);}
  else await pool.query("UPDATE email_messages SET status='failed',last_error=$2,completed_at=now(),updated_at=now() WHERE id=$1",[job.id,message]);
}

export async function verifySmtp(setting:EmailProviderConfig,secret:string):Promise<void>{
  const transport=nodemailer.createTransport({host:setting.host,port:setting.port,secure:setting.tls==="tls",requireTLS:setting.tls==="starttls",auth:setting.username?{user:setting.username,pass:secret}:undefined,connectionTimeout:15_000,greetingTimeout:15_000,disableFileAccess:true,disableUrlAccess:true});
  await transport.verify();
}

export async function sendProviderTest(provider:EmailProvider,setting:EmailProviderConfig,secret:string,recipient:string):Promise<string>{
  const subject="RelayDesk email provider test",text="Your RelayDesk email provider is configured correctly.",html="<p>Your RelayDesk email provider is configured correctly.</p>";
  if(provider==="smtp"){
    const transport=nodemailer.createTransport({host:setting.host,port:setting.port,secure:setting.tls==="tls",requireTLS:setting.tls==="starttls",auth:setting.username?{user:setting.username,pass:secret}:undefined,connectionTimeout:15_000,greetingTimeout:15_000,disableFileAccess:true,disableUrlAccess:true});
    const info=await transport.sendMail({from:{name:setting.fromName,address:setting.fromEmail},replyTo:setting.replyTo||undefined,to:recipient,subject,text,html});return info.messageId;
  }
  const response=await fetch("https://api.resend.com/emails",{method:"POST",headers:{authorization:`Bearer ${secret}`,"content-type":"application/json","idempotency-key":`relaydesk/test/${crypto.randomUUID()}`},body:JSON.stringify({from:`${setting.fromName} <${setting.fromEmail}>`,to:[recipient],reply_to:setting.replyTo||undefined,subject,text,html})});
  const body=await response.json().catch(()=>({})) as {id?:string;message?:string};if(!response.ok)throw new Error(body.message||`resend_http_${response.status}`);return body.id??"accepted";
}

export function escapeHtml(value:string):string{return value.replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]!)).replace(/\n/g,"<br>");}
export function emailShell(messageBody:string,contentHtml:string):string{return`<!doctype html><html><body style="margin:0;background:#f3f7f5;font-family:Arial,sans-serif;color:#203129"><div style="max-width:720px;margin:24px auto;padding:24px;background:#fff;border-radius:14px"><p style="white-space:normal;line-height:1.6">${escapeHtml(messageBody)}</p>${contentHtml}</div></body></html>`;}
