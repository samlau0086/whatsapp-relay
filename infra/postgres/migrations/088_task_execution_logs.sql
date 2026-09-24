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
