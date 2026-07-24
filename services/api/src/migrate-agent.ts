import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pool } from "./db.js";

export async function migrateAgentSchema():Promise<void>{
  for(const migration of ["014_ai_agent.sql","015_customer_addresses.sql","016_conversation_ai_takeover.sql","017_conversation_agent_modes.sql","018_ai_draft_chinese_translation.sql","019_contact_aliases.sql","020_order_templates.sql","021_order_template_defaults.sql","022_agent_provider_presets.sql","023_paypal_payment_requests.sql","024_product_pricing_cards.sql","025_currency_management.sql","026_currency_rate_metadata.sql","027_product_description.sql","028_paypal_invoice_templates.sql","029_order_item_sku_snapshot.sql","030_contact_profiles.sql","031_paypal_environment_credentials.sql","032_email_delivery.sql","033_collage_materials.sql","034_task_center.sql","035_whatsapp_cloud_api.sql","036_task_timezone_custom_holidays.sql"]){
    const candidates=[join(process.cwd(),"migrations",migration),join(process.cwd(),"..","..","infra","postgres","migrations",migration),join(process.cwd(),"infra","postgres","migrations",migration)];
    let sql="";
    for(const file of candidates){try{sql=await readFile(file,"utf8");break;}catch{}}
    if(!sql)throw new Error(`agent_schema_migration_missing:${migration}`);
    await pool.query(sql);
  }
}
