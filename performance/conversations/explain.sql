\pset format unaligned
\t on
EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON)
SELECT c.id,c.last_message_text FROM conversations c
JOIN contacts co ON co.id=c.contact_id
WHERE c.account_id=perf_uuid('account-1')
ORDER BY COALESCE(c.last_message_at,c.created_at) DESC,c.id DESC LIMIT 40;
EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON)
SELECT c.id,c.last_message_text FROM conversations c
ORDER BY COALESCE(c.last_message_at,c.created_at) DESC,c.id DESC LIMIT 40;
EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON)
SELECT c.id FROM conversations c
WHERE c.id IN (
  SELECT search_conversation.id FROM conversations search_conversation WHERE search_conversation.last_message_text ILIKE '%summary 9999%'
  UNION
  SELECT contact_conversation.id FROM conversations contact_conversation JOIN contacts search_contact ON search_contact.id=contact_conversation.contact_id
  WHERE search_contact.alias ILIKE '%Contact 9999%' OR search_contact.display_name ILIKE '%Contact 9999%' OR search_contact.phone_e164 ILIKE '%Contact 9999%'
)
ORDER BY COALESCE(c.last_message_at,c.created_at) DESC,c.id DESC LIMIT 40;
EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON)
WITH candidates AS MATERIALIZED (
  SELECT c.id,COALESCE(c.last_message_at,c.created_at) sort_at
  FROM conversations c JOIN whatsapp_accounts a ON a.id=c.account_id
  WHERE a.transport='cloud' OR a.agent_id IS NOT NULL
  ORDER BY COALESCE(c.last_message_at,c.created_at) DESC,c.id DESC
  LIMIT 41
)
SELECT c.id,co.display_name,COALESCE(tag_list.tags,'[]'::json) tags,candidates.sort_at
FROM candidates JOIN conversations c ON c.id=candidates.id JOIN contacts co ON co.id=c.contact_id
LEFT JOIN LATERAL (
  SELECT json_agg(json_build_object('id',t.id,'name',t.name,'color',t.color) ORDER BY t.name) tags
  FROM conversation_tags ct JOIN tags t ON t.id=ct.tag_id WHERE ct.conversation_id=c.id
)tag_list ON true
ORDER BY candidates.sort_at DESC,c.id DESC;
