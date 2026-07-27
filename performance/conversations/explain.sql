\pset format unaligned
\t on
EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON)
SELECT c.id,c.last_message_text FROM conversations c
JOIN contacts co ON co.id=c.contact_id
WHERE c.account_id=perf_uuid('account-1')
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
