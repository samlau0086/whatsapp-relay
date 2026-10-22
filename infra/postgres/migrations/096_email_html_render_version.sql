ALTER TABLE message_email_details ADD COLUMN IF NOT EXISTS html_render_version smallint NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS message_email_html_backfill_idx ON message_email_details(mailbox_id) WHERE html_render_version=0;
