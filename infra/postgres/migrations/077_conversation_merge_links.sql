CREATE TABLE IF NOT EXISTS conversation_merge_links (
  source_conversation_id uuid PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  target_conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE RESTRICT,
  rule_strategy text NOT NULL CHECK(rule_strategy IN ('target','source')),
  merged_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(source_conversation_id<>target_conversation_id)
);

CREATE INDEX IF NOT EXISTS conversation_merge_links_target_idx ON conversation_merge_links(target_conversation_id,created_at DESC);
