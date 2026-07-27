import pg from "pg";
import {config} from "./config.js";

const db=new pg.Client({connectionString:config.DATABASE_URL,statement_timeout:0});
const batchSize=Math.min(20_000,Math.max(100,Number(process.env.CONVERSATION_BACKFILL_BATCH_SIZE)||5_000));
await db.connect();
try{
  await db.query("SELECT pg_advisory_lock(hashtext('relay_conversation_summary_backfill'))");
  await db.query("SET relay.suppress_conversation_notify='on'");
  let updated=0;
  for(;;){
    const result=await db.query(`WITH targets AS (
      SELECT c.id FROM conversations c
      WHERE c.summary_updated_at IS NULL AND EXISTS(SELECT 1 FROM messages m WHERE m.conversation_id=c.id)
      ORDER BY c.id LIMIT $1 FOR UPDATE SKIP LOCKED
    ),latest AS (
      SELECT DISTINCT ON(m.conversation_id) m.conversation_id,m.id,m.text_content,m.kind,m.direction,m.status,m.occurred_at
      FROM messages m JOIN targets t ON t.id=m.conversation_id
      ORDER BY m.conversation_id,m.occurred_at DESC,m.id DESC
    ) UPDATE conversations c SET last_message_id=l.id,last_message_text=l.text_content,last_message_kind=l.kind,
      last_message_direction=l.direction,last_message_status=l.status,last_message_at=l.occurred_at,summary_updated_at=now()
      FROM latest l WHERE c.id=l.conversation_id RETURNING c.id`,[batchSize]);
    updated+=result.rowCount??0;
    if((result.rowCount??0)<batchSize)break;
  }
  await db.query("UPDATE conversations c SET summary_updated_at=now(),last_message_at=NULL WHERE c.summary_updated_at IS NULL AND NOT EXISTS(SELECT 1 FROM messages m WHERE m.conversation_id=c.id)");
  await db.query("CREATE INDEX CONCURRENTLY IF NOT EXISTS conversations_account_summary_sort_idx ON conversations(account_id,(COALESCE(last_message_at,created_at)) DESC,id DESC)");
  await db.query("CREATE INDEX CONCURRENTLY IF NOT EXISTS conversations_summary_text_trgm_idx ON conversations USING gin(last_message_text gin_trgm_ops)");
  await db.query("DROP INDEX CONCURRENTLY IF EXISTS messages_text_content_trgm_idx");
  const indexes=await db.query(`SELECT count(*)::int count FROM pg_class c JOIN pg_index i ON i.indexrelid=c.oid
    WHERE c.relname=ANY($1::text[]) AND i.indisvalid AND i.indisready`,[["conversations_account_summary_sort_idx","conversations_summary_text_trgm_idx"]]);
  if(Number(indexes.rows[0]?.count)!==2)throw new Error("conversation_summary_indexes_invalid");
  const missing=await db.query("SELECT count(*)::int count FROM conversations WHERE summary_updated_at IS NULL");
  if(Number(missing.rows[0]?.count))throw new Error(`conversation_summary_backfill_incomplete:${missing.rows[0].count}`);
  console.log(JSON.stringify({status:"ok",updated,missing:0}));
}finally{
  await db.query("SELECT pg_advisory_unlock(hashtext('relay_conversation_summary_backfill'))").catch(()=>{});
  await db.end();
}
