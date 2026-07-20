CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS agent_provider_settings (
  provider text PRIMARY KEY CHECK(provider IN ('openai','openai_compatible')),
  enabled boolean NOT NULL DEFAULT false,
  api_key_encrypted text,
  base_url text NOT NULL,
  model text NOT NULL,
  embedding_model text NOT NULL DEFAULT 'text-embedding-3-small',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_provider_one_enabled_idx ON agent_provider_settings(enabled) WHERE enabled;

CREATE TABLE IF NOT EXISTS account_agent_settings (
  account_id uuid PRIMARY KEY REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  persona text NOT NULL DEFAULT 'You are a helpful, concise customer service agent.',
  reply_language text NOT NULL DEFAULT 'auto',
  timezone text NOT NULL DEFAULT 'UTC',
  business_days smallint[] NOT NULL DEFAULT ARRAY[1,2,3,4,5],
  business_start time NOT NULL DEFAULT '09:00',
  business_end time NOT NULL DEFAULT '18:00',
  confidence_threshold real NOT NULL DEFAULT 0.8 CHECK(confidence_threshold BETWEEN 0 AND 1),
  followup_enabled boolean NOT NULL DEFAULT true,
  followup_delays_hours integer[] NOT NULL DEFAULT ARRAY[24,72],
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS knowledge_bases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS account_knowledge_bases (
  account_id uuid NOT NULL REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
  knowledge_base_id uuid NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  PRIMARY KEY(account_id,knowledge_base_id)
);

CREATE TABLE IF NOT EXISTS knowledge_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  knowledge_base_id uuid NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  object_key text NOT NULL UNIQUE,
  file_name text NOT NULL,
  mime_type text NOT NULL,
  byte_size bigint NOT NULL CHECK(byte_size>=0),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','indexing','ready','failed')),
  error text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS knowledge_faqs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  knowledge_base_id uuid NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  question text NOT NULL,
  answer text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  knowledge_base_id uuid NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  document_id uuid REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  faq_id uuid REFERENCES knowledge_faqs(id) ON DELETE CASCADE,
  ordinal integer NOT NULL DEFAULT 0,
  content text NOT NULL,
  embedding vector(1536),
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(document_id IS NOT NULL OR faq_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS knowledge_chunks_kb_idx ON knowledge_chunks(knowledge_base_id);
CREATE INDEX IF NOT EXISTS knowledge_chunks_fts_idx ON knowledge_chunks USING gin(to_tsvector('simple',content));
CREATE INDEX IF NOT EXISTS knowledge_chunks_embedding_idx ON knowledge_chunks USING hnsw(embedding vector_cosine_ops) WHERE embedding IS NOT NULL;

CREATE TABLE IF NOT EXISTS conversation_agent_state (
  conversation_id uuid PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  mode text NOT NULL DEFAULT 'human_paused' CHECK(mode IN ('active','human_paused')),
  pause_reason text,
  followup_count integer NOT NULL DEFAULT 0,
  last_customer_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  last_agent_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS conversation_memories (
  conversation_id uuid PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  summary text NOT NULL DEFAULT '',
  source_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS customer_memory_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  fact_key text NOT NULL,
  fact_value text NOT NULL,
  confidence real NOT NULL DEFAULT 1 CHECK(confidence BETWEEN 0 AND 1),
  source_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(conversation_id,fact_key)
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  source_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK(kind IN ('reply','followup','memory')),
  decision text CHECK(decision IN ('auto_reply','draft','handoff','ignore')),
  confidence real,
  citations jsonb NOT NULL DEFAULT '[]',
  response_text text,
  status text NOT NULL DEFAULT 'running' CHECK(status IN ('running','completed','failed','cancelled')),
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

ALTER TABLE messages ADD COLUMN IF NOT EXISTS ai_run_id uuid REFERENCES agent_runs(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS ai_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  text_content text NOT NULL,
  reason text NOT NULL,
  citations jsonb NOT NULL DEFAULT '[]',
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sent','dismissed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ai_drafts_pending_conversation_idx ON ai_drafts(conversation_id) WHERE status='pending';

CREATE TABLE IF NOT EXISTS agent_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid REFERENCES conversations(id) ON DELETE CASCADE,
  document_id uuid REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  source_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK(kind IN ('reply','followup','index_document','index_faq','refresh_memory')),
  payload jsonb NOT NULL DEFAULT '{}',
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','processing','completed','failed','cancelled')),
  attempt integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  completed_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_jobs_ready_idx ON agent_jobs(state,available_at,created_at);
CREATE UNIQUE INDEX IF NOT EXISTS agent_jobs_reply_source_idx ON agent_jobs(kind,source_message_id) WHERE kind='reply' AND source_message_id IS NOT NULL;
