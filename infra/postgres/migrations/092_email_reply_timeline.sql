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
)
UPDATE messages reply SET occurred_at=reply_parents.parent_time+interval '1 millisecond'
FROM reply_parents WHERE reply.id=reply_parents.id AND reply.occurred_at<=reply_parents.parent_time;
