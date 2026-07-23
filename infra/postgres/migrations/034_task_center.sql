ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS birthday_month smallint CHECK (birthday_month BETWEEN 1 AND 12),
  ADD COLUMN IF NOT EXISTS birthday_day smallint CHECK (birthday_day BETWEEN 1 AND 31),
  ADD COLUMN IF NOT EXISTS birthday_year smallint CHECK (birthday_year BETWEEN 1900 AND 2200);

CREATE TABLE IF NOT EXISTS contact_special_dates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'anniversary' CHECK(kind IN ('anniversary','birthday','custom')),
  label text NOT NULL,
  month smallint NOT NULL CHECK(month BETWEEN 1 AND 12),
  day smallint NOT NULL CHECK(day BETWEEN 1 AND 31),
  year smallint CHECK(year BETWEEN 1900 AND 2200),
  lead_days integer CHECK(lead_days BETWEEN 0 AND 365),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS contact_special_dates_contact_idx ON contact_special_dates(contact_id,month,day);

CREATE TABLE IF NOT EXISTS account_task_settings (
  account_id uuid PRIMARY KEY REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
  holiday_regions text[] NOT NULL DEFAULT ARRAY['global'],
  enabled_holidays text[] NOT NULL DEFAULT ARRAY['new_year','valentines','halloween','christmas'],
  default_lead_days integer NOT NULL DEFAULT 14 CHECK(default_lead_days BETWEEN 0 AND 365),
  draft_lead_hours integer NOT NULL DEFAULT 72 CHECK(draft_lead_hours BETWEEN 0 AND 8760),
  default_send_mode text NOT NULL DEFAULT 'approval' CHECK(default_send_mode IN ('approval','auto')),
  leap_day_policy text NOT NULL DEFAULT 'feb28' CHECK(leap_day_policy IN ('feb28','mar1','leap_year_only')),
  default_tools text[] NOT NULL DEFAULT ARRAY['knowledge_search','contact_profile_read','conversation_memory_read','recent_messages_read','order_summary_read','create_task','generate_draft'],
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS task_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
  contact_id uuid REFERENCES contacts(id) ON DELETE CASCADE,
  source text NOT NULL CHECK(source IN ('birthday','special_date','holiday','custom')),
  source_key text NOT NULL,
  title_template text NOT NULL,
  description text NOT NULL DEFAULT '',
  month smallint CHECK(month BETWEEN 1 AND 12),
  day smallint CHECK(day BETWEEN 1 AND 31),
  start_time time NOT NULL DEFAULT '09:00',
  duration_minutes integer NOT NULL DEFAULT 30 CHECK(duration_minutes BETWEEN 0 AND 525600),
  lead_days integer CHECK(lead_days BETWEEN 0 AND 365),
  send_mode text NOT NULL DEFAULT 'approval' CHECK(send_mode IN ('approval','auto')),
  enabled boolean NOT NULL DEFAULT true,
  recurrence jsonb NOT NULL DEFAULT '{"kind":"yearly","interval":1}',
  tool_overrides text[],
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(account_id,contact_id,source,source_key)
);
CREATE INDEX IF NOT EXISTS task_rules_scan_idx ON task_rules(account_id,enabled,source);

CREATE TABLE IF NOT EXISTS tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
  contact_id uuid REFERENCES contacts(id) ON DELETE RESTRICT,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  assigned_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  rule_id uuid REFERENCES task_rules(id) ON DELETE SET NULL,
  parent_task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
  kind text NOT NULL DEFAULT 'general' CHECK(kind IN ('general','message')),
  source text NOT NULL DEFAULT 'manual' CHECK(source IN ('manual','birthday','special_date','holiday','agent','recurring')),
  source_key text,
  occurrence_date date,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','in_progress','waiting_approval','scheduled','completed','overdue','failed','cancelled')),
  progress smallint NOT NULL DEFAULT 0 CHECK(progress BETWEEN 0 AND 100),
  start_at timestamptz NOT NULL,
  due_at timestamptz NOT NULL,
  send_at timestamptz,
  send_mode text NOT NULL DEFAULT 'approval' CHECK(send_mode IN ('approval','auto')),
  recurrence jsonb,
  persona_override text,
  tool_overrides text[],
  approved_at timestamptz,
  approved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  completed_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(due_at >= start_at),
  CHECK(kind='message' OR send_at IS NULL),
  CHECK(kind='general' OR contact_id IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS tasks_rule_occurrence_unique ON tasks(rule_id,contact_id,occurrence_date) WHERE rule_id IS NOT NULL AND occurrence_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS tasks_account_time_idx ON tasks(account_id,start_at,due_at);
CREATE INDEX IF NOT EXISTS tasks_due_idx ON tasks(status,due_at) WHERE status NOT IN ('completed','cancelled','failed');
CREATE INDEX IF NOT EXISTS tasks_message_dispatch_idx ON tasks(status,send_at) WHERE kind='message';
CREATE INDEX IF NOT EXISTS tasks_contact_active_idx ON tasks(contact_id,status) WHERE contact_id IS NOT NULL AND status NOT IN ('completed','cancelled','failed');

CREATE TABLE IF NOT EXISTS task_dependencies (
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(task_id,depends_on_task_id),
  CHECK(task_id<>depends_on_task_id)
);

CREATE TABLE IF NOT EXISTS task_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  text_content text NOT NULL,
  reply_zh text,
  citations jsonb NOT NULL DEFAULT '[]',
  context_snapshot jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','sent')),
  generated_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS task_drafts_pending_idx ON task_drafts(task_id) WHERE status='pending';

CREATE TABLE IF NOT EXISTS task_agent_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK(kind IN ('plan','draft','dispatch')),
  status text NOT NULL DEFAULT 'running' CHECK(status IN ('running','completed','failed','cancelled')),
  tools_used text[] NOT NULL DEFAULT '{}',
  citations jsonb NOT NULL DEFAULT '[]',
  context_snapshot jsonb NOT NULL DEFAULT '{}',
  response_text text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE IF NOT EXISTS task_tool_audit (
  id bigserial PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES task_agent_runs(id) ON DELETE CASCADE,
  tool text NOT NULL,
  allowed boolean NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO account_task_settings(account_id)
SELECT id FROM whatsapp_accounts ON CONFLICT(account_id) DO NOTHING;
