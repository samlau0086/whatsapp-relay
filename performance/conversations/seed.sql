\set ON_ERROR_STOP on
DO $$ BEGIN
  IF current_database()<>'relay_perf' THEN RAISE EXCEPTION 'Refusing to seed non-performance database: %',current_database(); END IF;
END $$;
CREATE OR REPLACE FUNCTION perf_uuid(input_text text) RETURNS uuid
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
AS $$ SELECT overlay(overlay(md5(input_text) placing '4' from 13) placing '8' from 17)::uuid $$;
SET session_replication_role=replica;
TRUNCATE messages,reminders,conversation_tags,tags,conversations,contacts,channel_accounts CASCADE;

INSERT INTO channel_accounts(id,display_name,phone_e164,provider_user_id,status,transport)
SELECT perf_uuid('account-'||n),'Perf Account '||n,'+1555000'||lpad(n::text,3,'0'),'1555000'||lpad(n::text,3,'0')||'@s.whatsapp.net','online','cloud'
FROM generate_series(1,10)n;

INSERT INTO contacts(id,account_id,provider_user_id,phone_e164,display_name,alias)
SELECT perf_uuid('contact-'||n),perf_uuid('account-'||(1+(n-1)%10)),
  '1555'||lpad(n::text,8,'0')||'@s.whatsapp.net','+1555'||lpad(n::text,8,'0'),
  'Contact '||n,CASE WHEN n%7=0 THEN 'Alias '||n END
FROM generate_series(1,100000)n;

INSERT INTO conversations(id,account_id,contact_id,status,assigned_user_id,favorite,unread_count,customer_stage,created_at)
SELECT perf_uuid('conversation-'||n),perf_uuid('account-'||(1+(n-1)%10)),perf_uuid('contact-'||n),
  CASE WHEN n%20=0 THEN 'closed'::conversation_status WHEN n%33=0 THEN 'archived'::conversation_status ELSE 'open'::conversation_status END,
  CASE WHEN n%3=0 THEN (SELECT id FROM users ORDER BY created_at LIMIT 1) END,n%11=0,n%5,'new',
  now()-((100000-n)||' minutes')::interval
FROM generate_series(1,100000)n;

DROP INDEX IF EXISTS messages_text_content_trgm_idx;
INSERT INTO messages(id,conversation_id,account_id,provider_message_id,direction,kind,text_content,status,occurred_at)
SELECT perf_uuid('message-'||c||'-'||m),perf_uuid('conversation-'||c),perf_uuid('account-'||(1+(c-1)%10)),
  'perf-'||c||'-'||m,CASE WHEN m%2=0 THEN 'in'::message_direction ELSE 'out'::message_direction END,
  'text','summary '||c||' message '||m,CASE WHEN m%2=0 THEN 'received'::delivery_status ELSE 'delivered'::delivery_status END,
  now()-((100000-c)||' minutes')::interval+(m||' seconds')::interval
FROM generate_series(1,100000)c CROSS JOIN generate_series(1,10)m;

UPDATE conversations c SET last_message_id=perf_uuid('message-'||n||'-10'),last_message_text='summary '||n||' message 10',
  last_message_kind='text',last_message_direction='in',last_message_status='received',
  last_message_at=now()-((100000-n)||' minutes')::interval+interval '10 seconds',summary_updated_at=now()
FROM generate_series(1,100000)n WHERE c.id=perf_uuid('conversation-'||n);

INSERT INTO tags(id,name,color) VALUES(perf_uuid('perf-tag'),'Performance','#DFF5E8');
INSERT INTO conversation_tags(conversation_id,tag_id)
SELECT perf_uuid('conversation-'||n),perf_uuid('perf-tag') FROM generate_series(100,100000,100)n;
INSERT INTO reminders(conversation_id,user_id,remind_at)
SELECT perf_uuid('conversation-'||n),(SELECT id FROM users ORDER BY created_at LIMIT 1),now()+(n%120||' minutes')::interval
FROM generate_series(250,100000,250)n;
SET session_replication_role=origin;
-- Bulk inserts accumulate entries in GIN pending lists. Flush the contact search
-- indexes so the gate measures steady-state query performance instead of seed
-- maintenance work on the first search requests.
VACUUM (ANALYZE) contacts;
ANALYZE conversations;
