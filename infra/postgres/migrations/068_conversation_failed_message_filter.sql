CREATE INDEX IF NOT EXISTS messages_failed_outgoing_conversation_idx
  ON messages(conversation_id)
  WHERE direction='out' AND status='failed';
