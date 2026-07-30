import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pool } from "./db.js";

export async function migrateAgentSchema():Promise<void>{
  const legacyMigrations=["014_ai_agent.sql","015_customer_addresses.sql","016_conversation_ai_takeover.sql","017_conversation_agent_modes.sql","018_ai_draft_chinese_translation.sql","019_contact_aliases.sql","020_order_templates.sql","021_order_template_defaults.sql","022_agent_provider_presets.sql","023_paypal_payment_requests.sql","024_product_pricing_cards.sql","025_currency_management.sql","026_currency_rate_metadata.sql","027_product_description.sql","028_paypal_invoice_templates.sql","029_order_item_sku_snapshot.sql","030_contact_profiles.sql","031_paypal_environment_credentials.sql","032_email_delivery.sql","033_collage_materials.sql","034_task_center.sql","035_whatsapp_cloud_api.sql","036_task_timezone_custom_holidays.sql","037_account_default_conversation_mode.sql","038_contact_timezone.sql","039_conversation_list_performance.sql","040_conversation_summaries_events.sql","041_product_order_weights.sql","042_payment_methods_profiles.sql","043_pdf_order_templates.sql","044_contact_social_methods.sql","045_agent_memory_performance.sql","046_task_reminder_indexes.sql","047_product_category_brand.sql","048_whatsapp_status_campaigns.sql","049_status_post_translation.sql","050_contact_preferred_language.sql","051_persistent_login.sql","052_contact_names_default_address.sql","053_order_business_status.sql","054_transcription_source_language.sql"];
  const schema=await pool.query("SELECT to_regclass('public.channel_accounts') IS NOT NULL channel_schema");
  const channelMigrations=["055_messenger_channels.sql","056_channel_contact_search.sql","057_messenger_oauth.sql"];
  const migrations=Boolean(schema.rows[0]?.channel_schema)?channelMigrations:[...legacyMigrations,...channelMigrations];
  for(const migration of migrations){
    const candidates=[join(process.cwd(),"migrations",migration),join(process.cwd(),"..","..","infra","postgres","migrations",migration),join(process.cwd(),"infra","postgres","migrations",migration)];
    let sql="";
    for(const file of candidates){try{sql=await readFile(file,"utf8");break;}catch{}}
    if(!sql)throw new Error(`agent_schema_migration_missing:${migration}`);
    await pool.query(sql);
  }
}
