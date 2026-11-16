import type {Pool,PoolClient} from "pg";
import type {EmailProvider,EmailProviderConfig} from "./email.js";

type Database=Pick<Pool|PoolClient,"query">;
export type SelectedEmailProvider={id:string;provider:EmailProvider;config:EmailProviderConfig;secret_encrypted:string;explicit:boolean};
type MailboxTransportRow={id:string;address:string;display_name?:string|null;auth_type?:string;smtp_host?:string;smtp_port?:number;smtp_tls?:EmailProviderConfig["tls"];smtp_username?:string;smtp_secret_encrypted:string};

export async function resolveEmailProvider(db:Database,accountId:string):Promise<SelectedEmailProvider|null>{
  const result=await db.query(`SELECT p.id,p.provider,p.config,p.secret_encrypted,(binding.provider_id IS NOT NULL) explicit
    FROM (SELECT (SELECT provider_id FROM account_email_providers WHERE account_id=$1) provider_id) binding
    JOIN email_provider_instances p ON p.id=binding.provider_id OR (binding.provider_id IS NULL AND p.is_default)
    WHERE p.enabled AND p.secret_encrypted IS NOT NULL LIMIT 1`,[accountId]);
  if(result.rowCount)return result.rows[0] as SelectedEmailProvider;
  const binding=await db.query("SELECT provider_id FROM account_email_providers WHERE account_id=$1",[accountId]);
  if(binding.rowCount)throw Object.assign(new Error("channel_email_provider_unavailable"),{statusCode:409});
  return null;
}

export function mailboxEmailTransport(row:MailboxTransportRow,selected:SelectedEmailProvider|null,strictSender=false){
  // 未绑定的旧渠道保留邮箱自身 SMTP / OAuth 回退；显式绑定必须使用指定实例。
  const useSelected=selected&&(selected.explicit||(!strictSender||row.auth_type!=="microsoft")&&(!strictSender||String(selected.config.fromEmail).toLowerCase()===String(row.address).toLowerCase()));
  if(useSelected)return {provider:selected.provider,config:{...selected.config,replyTo:selected.config.replyTo||row.address},secret:selected.secret_encrypted};
  const config:EmailProviderConfig={fromName:row.display_name||row.address,fromEmail:row.address,host:row.smtp_host,port:row.smtp_port,tls:row.smtp_tls,username:row.smtp_username};
  if(row.auth_type==="microsoft")config.oauthMailboxId=String(row.id);
  return {provider:"smtp" as const,config,secret:row.smtp_secret_encrypted};
}
