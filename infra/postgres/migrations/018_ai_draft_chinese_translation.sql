-- Store a Simplified Chinese reference translation for human review. The
-- original text_content remains the only content sent to the customer.
ALTER TABLE ai_drafts
  ADD COLUMN IF NOT EXISTS reply_zh text;
