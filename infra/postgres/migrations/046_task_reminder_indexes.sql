CREATE INDEX IF NOT EXISTS tasks_assignee_conversation_due_idx
ON tasks(assigned_user_id,conversation_id,due_at)
WHERE conversation_id IS NOT NULL AND status NOT IN ('completed','cancelled','failed');

CREATE INDEX IF NOT EXISTS tasks_assignee_contact_due_idx
ON tasks(assigned_user_id,contact_id,due_at)
WHERE contact_id IS NOT NULL AND status NOT IN ('completed','cancelled','failed');
