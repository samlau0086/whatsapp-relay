\set ON_ERROR_STOP on
DO $$ BEGIN
  IF current_database()<>'relay_perf' THEN RAISE EXCEPTION 'Refusing to seed non-performance database: %',current_database(); END IF;
END $$;
SET session_replication_role=replica;
TRUNCATE messages,reminders,conversation_tags,tags,conversations,contacts,whatsapp_accounts CASCADE;

INSERT INTO whatsapp_accounts(id,display_name,phone_e164,wa_jid,status,transport)
SELECT md5('account-'||n)::uuid,'Perf Account '||n,'+1555000'||lpad(n::text,3,'0'),'1555000'||lpad(n::text,3,'0')||'@s.whatsapp.net','online','cloud'
FROM generate_series(1,10)n;

INSERT INTO contacts(id,account_id,wa_jid,phone_e164,display_name,alias)
SELECT md5('contact-'||n)::uuid,md5('account-'||(1+(n-1)%10))::uuid,
  '1555'||lpad(n::text,8,'0')||'@s.whatsapp.net','+1555'||lpad(n::text,8,'0'),
  'Contact '||n,CASE WHEN n%7=0 THEN 'Alias '||n END
FROM generate_series(1,100000)n;

INSERT INTO conversations(id,account_id,contact_id,status,assigned_user_id,favorite,unread_count,customer_stage,created_at)
SELECT md5('conversation-'||n)::uuid,md5('account-'||(1+(n-1)%10))::uuid,md5('contact-'||n)::uuid,
  CASE WHEN n%20=0 THEN 'closed'::conversation_status WHEN n%33=0 THEN 'archived'::conversation_status ELSE 'open'::conversation_status END,
  CASE WHEN n%3=0 THEN (SELECT id FROM users ORDER BY created_at LIMIT 1) END,n%11=0,n%5,'new',
  now()-((100000-n)||' minutes')::interval
FROM generate_series(1,100000)n;

DROP INDEX IF EXISTS messages_text_content_trgm_idx;
INSERT INTO messages(id,conversation_id,account_id,whatsapp_message_id,direction,kind,text_content,status,occurred_at)
SELECT md5('message-'||c||'-'||m)::uuid,md5('conversation-'||c)::uuid,md5('account-'||(1+(c-1)%10))::uuid,
  'perf-'||c||'-'||m,CASE WHEN m%2=0 THEN 'in'::message_direction ELSE 'out'::message_direction END,
  'text','summary '||c||' message '||m,CASE WHEN m%2=0 THEN 'received'::delivery_status ELSE 'delivered'::delivery_status END,
  now()-((100000-c)||' minutes')::interval+(m||' seconds')::interval
FROM generate_series(1,100000)c CROSS JOIN generate_series(1,10)m;

UPDATE conversations c SET last_message_id=md5('message-'||n||'-10')::uuid,last_message_text='summary '||n||' message 10',
  last_message_kind='text',last_message_direction='in',last_message_status='received',
  last_message_at=now()-((100000-n)||' minutes')::interval+interval '10 seconds',summary_updated_at=now()
FROM generate_series(1,100000)n WHERE c.id=md5('conversation-'||n)::uuid;

INSERT INTO tags(id,name,color) VALUES(md5('perf-tag')::uuid,'Performance','#DFF5E8');
INSERT INTO conversation_tags(conversation_id,tag_id)
SELECT md5('conversation-'||n)::uuid,md5('perf-tag')::uuid FROM generate_series(100,100000,100)n;
INSERT INTO reminders(conversation_id,user_id,remind_at)
SELECT md5('conversation-'||n)::uuid,(SELECT id FROM users ORDER BY created_at LIMIT 1),now()+(n%120||' minutes')::interval
FROM generate_series(250,100000,250)n;
SET session_replication_role=origin;
ANALYZE;
