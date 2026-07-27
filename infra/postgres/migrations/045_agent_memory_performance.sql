CREATE INDEX IF NOT EXISTS agent_jobs_conversation_memory_idx
  ON agent_jobs(conversation_id,created_at DESC)
  WHERE kind='refresh_memory';
