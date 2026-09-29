-- Mail clients may put an earlier Date header on a reply than on the original.
-- Correct only replies whose RFC message references resolve in the same conversation.
WITH reply_parents AS (
  SELECT reply.id, max(parent.occurred_at) AS parent_time
  FROM messages reply
  JOIN message_email_details detail ON detail.message_id=reply.id
  JOIN messages parent ON parent.conversation_id=reply.conversation_id AND parent.id<>reply.id
  JOIN message_email_details parent_detail ON parent_detail.message_id=parent.id
  WHERE reply.direction='in'
    AND parent_detail.rfc_message_id IS NOT NULL
    AND (detail.in_reply_to=parent_detail.rfc_message_id
      OR (detail.in_reply_to IS NULL AND parent_detail.rfc_message_id=ANY(regexp_split_to_array(btrim(detail.references_header),'[[:space:]]+'))))
    AND reply.occurred_at<=parent.occurred_at
  GROUP BY reply.id
), quoted_reply_parents AS (
  SELECT reply.id, max(parent.occurred_at) AS parent_time
  FROM messages reply
  JOIN message_email_details detail ON detail.message_id=reply.id
  JOIN messages parent ON parent.conversation_id=reply.conversation_id AND parent.id<>reply.id AND parent.direction='out'
  JOIN message_email_details parent_detail ON parent_detail.message_id=parent.id
  WHERE reply.direction='in'
    AND NOT EXISTS (SELECT 1 FROM reply_parents known WHERE known.id=reply.id)
    AND lower(regexp_replace(detail.subject,'^(?:(?:re(?:\([0-9]+\))?|fwd?|aw|sv)\s*:\s*)+','','i'))=lower(regexp_replace(parent_detail.subject,'^(?:(?:re(?:\([0-9]+\))?|fwd?|aw|sv)\s*:\s*)+','','i'))
    AND length(btrim(COALESCE(parent.text_content,'')))>0
    AND position(lower(parent.text_content) IN lower(COALESCE(detail.quoted_body,'')))>0
    AND reply.occurred_at<=parent.occurred_at
  GROUP BY reply.id
  HAVING count(DISTINCT parent.id)=1
), all_reply_parents AS (
  SELECT * FROM reply_parents
  UNION ALL
  SELECT * FROM quoted_reply_parents
)
UPDATE messages reply SET occurred_at=all_reply_parents.parent_time+interval '1 millisecond'
FROM all_reply_parents WHERE reply.id=all_reply_parents.id AND reply.occurred_at<=all_reply_parents.parent_time;
