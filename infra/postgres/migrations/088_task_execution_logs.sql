CREATE TABLE IF NOT EXISTS task_execution_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  outcome text NOT NULL CHECK(outcome IN ('started','succeeded','failed','skipped','cancelled')),
  planned_at timestamptz,
  message text,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS task_execution_logs_task_time_idx ON task_execution_logs(task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS task_execution_logs_outcome_time_idx ON task_execution_logs(outcome, created_at DESC);

ALTER TABLE proactive_outreach_events ADD COLUMN IF NOT EXISTS planned_at timestamptz;
ALTER TABLE proactive_outreach_events ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}';
ALTER TABLE proactive_outreach_events DROP CONSTRAINT IF EXISTS proactive_outreach_events_event_type_check;
ALTER TABLE proactive_outreach_events ADD CONSTRAINT proactive_outreach_events_event_type_check CHECK(event_type IN ('planned','started','sent','skipped','cancelled','suppressed','restored','failed','draft_generation'));
