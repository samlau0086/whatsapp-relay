-- Distinguish files attached to an email from images embedded in its HTML body.
ALTER TABLE message_email_attachments ADD COLUMN IF NOT EXISTS content_id text;
ALTER TABLE message_email_attachments ADD COLUMN IF NOT EXISTS is_inline boolean NOT NULL DEFAULT false;

-- Restore inline-image metadata for outbound emails already in the timeline.
UPDATE message_email_attachments timeline_attachment
SET content_id=queued_attachment.content_id,
    is_inline=(queued_attachment.content_id IS NOT NULL
      AND position(lower('src="cid:' || queued_attachment.content_id || '"') IN lower(COALESCE(queued_email.html_body,'')))>0)
FROM message_email_details detail, email_attachments queued_attachment, email_messages queued_email
WHERE detail.message_id=timeline_attachment.message_id
  AND queued_attachment.email_id=detail.email_job_id
  AND queued_attachment.media_id=timeline_attachment.media_id
  AND queued_attachment.position=timeline_attachment.position
  AND queued_email.id=queued_attachment.email_id
  AND timeline_attachment.content_id IS NULL;
