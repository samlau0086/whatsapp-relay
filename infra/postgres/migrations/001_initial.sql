CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE user_role AS ENUM ('admin','supervisor','agent');
CREATE TYPE agent_status AS ENUM ('pending','online','offline','revoked');
CREATE TYPE wa_account_status AS ENUM ('pairing','online','offline','logged_out','error');
CREATE TYPE conversation_status AS ENUM ('open','closed','archived');
CREATE TYPE message_direction AS ENUM ('in','out');
CREATE TYPE message_kind AS ENUM ('text','image','video','audio','document','location','contact');
CREATE TYPE delivery_status AS ENUM ('received','queued','dispatching','sent','delivered','read','failed','uncertain','revoked');

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  display_name text NOT NULL,
  password_hash text NOT NULL,
  role user_role NOT NULL DEFAULT 'agent',
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE refresh_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  replaced_by uuid REFERENCES refresh_tokens(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_user_idx ON refresh_tokens(user_id,expires_at DESC);

CREATE TABLE agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  credential_hash text UNIQUE,
  enrollment_code_hash text UNIQUE,
  enrollment_expires_at timestamptz,
  version text,
  protocol_version integer,
  platform text,
  status agent_status NOT NULL DEFAULT 'pending',
  last_seen_at timestamptz,
  last_acked_cursor bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE whatsapp_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
  display_name text NOT NULL,
  phone_e164 text UNIQUE,
  wa_jid text UNIQUE,
  status wa_account_status NOT NULL DEFAULT 'offline',
  status_reason text,
  retention_days integer CHECK (retention_days IS NULL OR retention_days >= 1),
  last_connected_at timestamptz,
  last_event_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE account_permissions (
  account_id uuid NOT NULL REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  can_read boolean NOT NULL DEFAULT true,
  can_send boolean NOT NULL DEFAULT false,
  can_manage boolean NOT NULL DEFAULT false,
  PRIMARY KEY (account_id,user_id)
);

CREATE TABLE contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
  wa_jid text NOT NULL,
  phone_e164 text,
  display_name text,
  avatar_url text,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(account_id,wa_jid)
);

CREATE TABLE conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  status conversation_status NOT NULL DEFAULT 'open',
  assigned_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  favorite boolean NOT NULL DEFAULT false,
  unread_count integer NOT NULL DEFAULT 0,
  last_message_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(account_id,contact_id)
);

CREATE TABLE media (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid REFERENCES whatsapp_accounts(id) ON DELETE SET NULL,
  object_key text NOT NULL UNIQUE,
  file_name text,
  mime_type text NOT NULL,
  byte_size bigint NOT NULL CHECK(byte_size >= 0),
  sha256 text NOT NULL,
  status text NOT NULL DEFAULT 'ready',
  delete_after timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
  sender_contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  sender_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  whatsapp_message_id text,
  client_message_id text,
  direction message_direction NOT NULL,
  kind message_kind NOT NULL,
  text_content text,
  media_id uuid REFERENCES media(id) ON DELETE SET NULL,
  quoted_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  status delivery_status NOT NULL,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(account_id,whatsapp_message_id),
  UNIQUE(account_id,client_message_id)
);

CREATE TABLE message_receipts (
  id bigserial PRIMARY KEY,
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  status delivery_status NOT NULL,
  occurred_at timestamptz NOT NULL,
  UNIQUE(message_id,status)
);

CREATE TABLE tags (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL UNIQUE, color text NOT NULL DEFAULT '#DFF5E8');
CREATE TABLE conversation_tags (conversation_id uuid REFERENCES conversations(id) ON DELETE CASCADE, tag_id uuid REFERENCES tags(id) ON DELETE CASCADE, PRIMARY KEY(conversation_id,tag_id));
CREATE TABLE notes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, user_id uuid REFERENCES users(id) ON DELETE SET NULL, body text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE outbound_commands (
  sequence bigserial PRIMARY KEY,
  id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
  account_id uuid NOT NULL REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
  message_id uuid REFERENCES messages(id) ON DELETE CASCADE,
  command text NOT NULL,
  payload jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  attempt integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  completed_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agent_inbox (
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  cursor bigint NOT NULL,
  event_id text NOT NULL,
  event_kind text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(agent_id,cursor),
  UNIQUE(agent_id,event_id)
);

CREATE TABLE api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  key_prefix text NOT NULL,
  secret_hash text NOT NULL UNIQUE,
  scopes text[] NOT NULL DEFAULT '{}',
  account_ids uuid[],
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE webhook_endpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  url text NOT NULL,
  secret_encrypted text NOT NULL,
  event_types text[] NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL,
  aggregate_id uuid,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE webhook_deliveries (
  id bigserial PRIMARY KEY,
  event_id uuid NOT NULL REFERENCES webhook_events(id) ON DELETE CASCADE,
  endpoint_id uuid NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'pending',
  attempt integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  response_status integer,
  response_body text,
  last_error text,
  completed_at timestamptz,
  UNIQUE(event_id,endpoint_id)
);

CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  actor_type text NOT NULL,
  actor_id text,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text,
  metadata jsonb NOT NULL DEFAULT '{}',
  ip inet,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX conversations_inbox_idx ON conversations(status,last_message_at DESC);
CREATE INDEX messages_timeline_idx ON messages(conversation_id,occurred_at DESC,id DESC);
CREATE INDEX outbound_commands_dispatch_idx ON outbound_commands(state,available_at,sequence);
CREATE INDEX webhook_deliveries_retry_idx ON webhook_deliveries(state,available_at);
CREATE INDEX audit_log_target_idx ON audit_log(target_type,target_id,created_at DESC);
