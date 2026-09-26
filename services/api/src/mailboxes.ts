import { randomBytes, createHash } from "node:crypto";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import { convert } from "html-to-text";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { PoolClient } from "pg";
import { config } from "./config.js";
import { pool, transaction } from "./db.js";
import { decryptAtRest } from "./security.js";

export type MailboxSettings={
  accountId:string;address:string;displayName:string;isPrimary:boolean;enabled:boolean;
  imapHost:string;imapPort:number;imapUsername:string;imapPassword:string;
  smtpHost:string;smtpPort:number;smtpTls:"tls"|"starttls";smtpUsername:string;smtpPassword:string;
};
type MailboxRow={id:string;account_id:string;address:string;display_name:string;imap_host:string;imap_port:number;imap_username:string;imap_secret_encrypted:string;smtp_host:string;smtp_port:number;smtp_username:string;smtp_secret_encrypted:string;smtp_tls:"tls"|"starttls";uid_validity:string|null;last_uid:string|null};

const s3=new S3Client({region:config.S3_REGION,endpoint:config.S3_ENDPOINT,forcePathStyle:true,credentials:{accessKeyId:config.S3_ACCESS_KEY,secretAccessKey:config.S3_SECRET_KEY}});
const MAX_ATTACHMENT=20*1024*1024,MAX_TOTAL=25*1024*1024;

export function latestEmailText(input:string):string{
  const lines=input.replace(/\r\n?/g,"\n").split("\n");
  const kept:string[]=[];
  for(let i=0;i<lines.length;i++){
    const line=lines[i].trim();
    if(/^>/.test(line)||/^On .{8,} wrote:\s*$/i.test(line)||/^在.{4,}写道[:：]\s*$/.test(line)
      ||/^[- ]{2,}Original Message[- ]{2,}$/i.test(line)
      ||/^[- ]{2,}Forwarded message[- ]{2,}$/i.test(line)
      || /^_{8,}$/.test(line)
      || (/^From:\s*.+/i.test(line)&&lines.slice(i+1,i+5).some(value=>/^\s*(Sent|Date|To|Subject):/i.test(value))))break;
    kept.push(lines[i]);
  }
  return kept.join("\n").trim().slice(0,65536);
}

function imapClient(settings:{imap_host:string;imap_port:number;imap_username:string;imap_secret_encrypted:string},password?:string):ImapFlow{
  return new ImapFlow({host:settings.imap_host,port:Number(settings.imap_port),secure:true,auth:{user:settings.imap_username,pass:password??decryptAtRest(settings.imap_secret_encrypted,config.DATA_ENCRYPTION_KEY)},logger:false});
}

export async function verifyMailbox(settings:MailboxSettings):Promise<{uidValidity:string;lastUid:number}>{
  const client=imapClient({imap_host:settings.imapHost,imap_port:settings.imapPort,imap_username:settings.imapUsername,imap_secret_encrypted:""},settings.imapPassword);
  try{
    await client.connect();
    const box=await client.mailboxOpen("INBOX",{readOnly:true});
    const transport=nodemailer.createTransport({host:settings.smtpHost,port:settings.smtpPort,secure:settings.smtpTls==="tls",requireTLS:settings.smtpTls==="starttls",auth:{user:settings.smtpUsername,pass:settings.smtpPassword},connectionTimeout:15000,greetingTimeout:15000,disableFileAccess:true,disableUrlAccess:true});
    await transport.verify();
    return {uidValidity:String(box.uidValidity),lastUid:Math.max(0,Number(box.uidNext)-1)};
  }finally{await client.logout().catch(()=>{});}
}

async function storeAttachment(accountId:string,filename:string,mime:string,content:Buffer){
  const objectKey=`email/${accountId}/${new Date().toISOString().slice(0,10)}/${randomBytes(16).toString("hex")}`;
  await s3.send(new PutObjectCommand({Bucket:config.S3_BUCKET,Key:objectKey,Body:content,ContentType:mime}));
  const result=await pool.query("INSERT INTO media(account_id,object_key,file_name,mime_type,byte_size,sha256) VALUES($1,$2,$3,$4,$5,$6) RETURNING id",[accountId,objectKey,filename.slice(0,255),mime,content.length,createHash("sha256").update(content).digest("hex")]);
  return String(result.rows[0].id);
}

async function archiveInbound(row:MailboxRow,uidValidity:string,uid:number,source:Buffer):Promise<void>{
  const parsed=await simpleParser(source);
  const sender=parsed.from?.value[0]?.address?.trim().toLowerCase();
  if(!sender||sender===row.address.toLowerCase())return;
  const subject=(parsed.subject??"(无主题)").replace(/[\r\n]/g," ").slice(0,200);
  const body=latestEmailText(parsed.text??convert(String(parsed.html||""),{wordwrap:false,selectors:[{selector:"a",options:{ignoreHref:true}},{selector:"img",format:"skip"}]}));
  let total=0,warning="";
  const attachmentCandidates=parsed.attachments.filter(item=>{if(item.size>MAX_ATTACHMENT||total+item.size>MAX_TOTAL){warning="部分附件超过邮件归档大小限制，未保存";return false;}total+=item.size;return true;});
  await transaction(async(client:PoolClient)=>{
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))",[row.account_id,sender]);
    const receipt=await client.query("SELECT message_id FROM email_inbound_receipts WHERE mailbox_id=$1 AND uid_validity=$2 AND uid=$3",[row.id,uidValidity,uid]);
    if(receipt.rows[0]?.message_id)return;
    if(parsed.messageId){const existing=await client.query("SELECT 1 FROM message_email_details WHERE mailbox_id=$1 AND rfc_message_id=$2",[row.id,parsed.messageId]);if(existing.rowCount)return;}
    const found=await client.query("SELECT DISTINCT co.id FROM contacts co JOIN contact_emails e ON e.contact_id=co.id WHERE co.account_id=$1 AND lower(e.email)=$2 AND co.entity_type='person'",[row.account_id,sender]);
    if(found.rowCount&&found.rowCount>1)throw new Error(`ambiguous_contact_email:${sender}`);
    let contactId=found.rows[0]?.id as string|undefined;
    if(!contactId){
      const displayName=(parsed.from?.value[0]?.name||sender).slice(0,240);
      const created=await client.query("INSERT INTO contacts(account_id,provider_user_id,phone_e164,display_name,alias) VALUES($1,NULL,NULL,$2,$2) RETURNING id",[row.account_id,displayName]);
      contactId=String(created.rows[0].id);
      await client.query("INSERT INTO contact_emails(contact_id,label,email,is_primary,position) VALUES($1,'', $2,true,0)",[contactId,sender]);
    }
    const conversation=await client.query("INSERT INTO conversations(account_id,contact_id) VALUES($1,$2) ON CONFLICT(account_id,contact_id) DO UPDATE SET status='open',closed_at=NULL RETURNING id",[row.account_id,contactId]);
    const conversationId=conversation.rows[0].id;
    const attachments:Array<{id:string;name:string;mime:string;size:number}>=[];
    for(const item of attachmentCandidates)try{attachments.push({id:await storeAttachment(row.account_id,item.filename||"附件",item.contentType||"application/octet-stream",item.content),name:item.filename||"附件",mime:item.contentType||"application/octet-stream",size:item.size});}catch{warning="部分附件归档失败，请检查媒体存储";}
    const occurredAt=parsed.date&&Math.abs(Date.now()-parsed.date.getTime())<365*86400000?parsed.date:new Date();
    const message=await client.query("INSERT INTO messages(conversation_id,account_id,sender_contact_id,direction,kind,text_content,status,occurred_at) VALUES($1,$2,$3,'in','text',$4,'received',$5) RETURNING id",[conversationId,row.account_id,contactId,body|| (attachments.length?"[附件]":"[无新正文]"),occurredAt]);
    const messageId=String(message.rows[0].id);
    const toAddresses=(Array.isArray(parsed.to)?parsed.to:[parsed.to]).flatMap(value=>value?.value??[]).map(value=>value.address).filter(Boolean);
    await client.query("INSERT INTO message_email_details(message_id,mailbox_id,subject,from_email,to_emails,rfc_message_id,in_reply_to,references_header,attachment_warning) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",[messageId,row.id,subject,sender,JSON.stringify(toAddresses.length?toAddresses:[row.address]),parsed.messageId??null,parsed.inReplyTo??null,Array.isArray(parsed.references)?parsed.references.join(" "):parsed.references??null,warning||null]);
    for(const [position,item] of attachments.entries())await client.query("INSERT INTO message_email_attachments(message_id,media_id,position,file_name,mime_type,byte_size) VALUES($1,$2,$3,$4,$5,$6)",[messageId,item.id,position,item.name,item.mime,item.size]);
    await client.query("INSERT INTO email_inbound_receipts(mailbox_id,uid_validity,uid,message_id,error) VALUES($1,$2,$3,$4,NULL) ON CONFLICT(mailbox_id,uid_validity,uid) DO UPDATE SET message_id=$4,error=NULL",[row.id,uidValidity,uid,messageId]);
  });
}

export async function syncOneMailbox():Promise<boolean>{
  const claimed=await pool.query(`UPDATE account_email_mailboxes SET claimed_until=now()+interval '2 minutes',next_sync_at=now()+interval '30 seconds' WHERE id=(SELECT id FROM account_email_mailboxes WHERE enabled AND next_sync_at<=now() AND (claimed_until IS NULL OR claimed_until<now()) ORDER BY next_sync_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`);
  if(!claimed.rowCount)return false;
  const row=claimed.rows[0] as MailboxRow,client=imapClient(row);
  try{
    await client.connect();
    const box=await client.mailboxOpen("INBOX",{readOnly:true}),validity=String(box.uidValidity);
    if(row.uid_validity!==validity||row.last_uid===null){
      await pool.query("UPDATE account_email_mailboxes SET uid_validity=$2,last_uid=$3,last_error=NULL,last_synced_at=now() WHERE id=$1",[row.id,validity,Math.max(0,Number(box.uidNext)-1)]);
      return true;
    }
    let lastUid=Number(row.last_uid);const errors:string[]=[];
    if(Number(box.uidNext)>lastUid+1){
      let seen=0;
      for await(const item of client.fetch(`${lastUid+1}:*`,{uid:true,source:true},{uid:true})){
        if(item.uid<=lastUid||!item.source)continue;
        if(++seen>20)break;
        try{
          await archiveInbound(row,validity,item.uid,item.source);
          await pool.query("INSERT INTO email_inbound_receipts(mailbox_id,uid_validity,uid) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",[row.id,validity,item.uid]);
        }catch(error){
          const message=(error instanceof Error?error.message:String(error)).slice(0,1000);errors.push(message);
          await pool.query("INSERT INTO email_inbound_receipts(mailbox_id,uid_validity,uid,error) VALUES($1,$2,$3,$4) ON CONFLICT(mailbox_id,uid_validity,uid) DO UPDATE SET error=$4",[row.id,validity,item.uid,message]);
        }
        lastUid=item.uid;
      }
    }
    await pool.query("UPDATE account_email_mailboxes SET last_uid=$2,last_error=$3,last_synced_at=now() WHERE id=$1",[row.id,lastUid,errors[0]??null]);
  }catch(error){
    await pool.query("UPDATE account_email_mailboxes SET last_error=$2,next_sync_at=now()+interval '2 minutes' WHERE id=$1",[row.id,(error instanceof Error?error.message:String(error)).slice(0,1000)]);
  }finally{
    await client.logout().catch(()=>{});
    await pool.query("UPDATE account_email_mailboxes SET claimed_until=NULL WHERE id=$1",[row.id]);
  }
  return true;
}
