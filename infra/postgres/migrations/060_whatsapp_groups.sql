ALTER TABLE contacts ADD COLUMN IF NOT EXISTS entity_type text NOT NULL DEFAULT 'person';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='contacts_entity_type_check') THEN
    ALTER TABLE contacts ADD CONSTRAINT contacts_entity_type_check CHECK (entity_type IN ('person','group'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS whatsapp_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES channel_accounts(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL UNIQUE REFERENCES contacts(id) ON DELETE CASCADE,
  group_jid text NOT NULL,
  subject text NOT NULL,
  description text,
  owner_jid text,
  participant_count integer NOT NULL DEFAULT 0 CHECK(participant_count>=0),
  is_announcement boolean NOT NULL DEFAULT false,
  is_community boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  sync_id uuid,
  last_synced_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(account_id,group_jid),
  CHECK(group_jid LIKE '%@g.us')
);

CREATE TABLE IF NOT EXISTS whatsapp_group_participants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES whatsapp_groups(id) ON DELETE CASCADE,
  participant_jid text NOT NULL,
  phone_jid text,
  lid_jid text,
  display_name text,
  role text NOT NULL DEFAULT 'member' CHECK(role IN ('member','admin','superadmin')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(group_id,participant_jid)
);

ALTER TABLE messages ADD COLUMN IF NOT EXISTS sender_provider_user_id text;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS sender_display_name text;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS last_message_sender_provider_user_id text;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS last_message_sender_name text;

CREATE INDEX IF NOT EXISTS contacts_entity_type_idx ON contacts(entity_type,account_id);
CREATE INDEX IF NOT EXISTS whatsapp_groups_account_active_idx ON whatsapp_groups(account_id,active,subject);
CREATE INDEX IF NOT EXISTS whatsapp_group_participants_group_role_idx ON whatsapp_group_participants(group_id,role,display_name);

CREATE OR REPLACE FUNCTION relay_refresh_conversation_summary(target_conversation_id uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE latest messages%ROWTYPE;
BEGIN
  SELECT * INTO latest FROM messages
  WHERE conversation_id=target_conversation_id
  ORDER BY occurred_at DESC,id DESC LIMIT 1;
  UPDATE conversations SET
    last_message_id=latest.id,
    last_message_text=latest.text_content,
    last_message_kind=latest.kind,
    last_message_direction=latest.direction,
    last_message_status=latest.status,
    last_message_sender_provider_user_id=latest.sender_provider_user_id,
    last_message_sender_name=latest.sender_display_name,
    last_message_at=latest.occurred_at,
    summary_updated_at=now()
  WHERE id=target_conversation_id;
END $$;

CREATE OR REPLACE FUNCTION relay_notify_group_conversation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE target_id uuid; target_account uuid;
BEGIN
  SELECT c.id,c.account_id INTO target_id,target_account
  FROM conversations c
  WHERE c.contact_id=CASE WHEN TG_OP='DELETE' THEN OLD.contact_id ELSE NEW.contact_id END;
  IF target_id IS NOT NULL THEN PERFORM relay_publish_conversation_change(target_id,target_account); END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS whatsapp_groups_conversation_notify ON whatsapp_groups;
CREATE TRIGGER whatsapp_groups_conversation_notify AFTER INSERT OR UPDATE OR DELETE ON whatsapp_groups
FOR EACH ROW EXECUTE FUNCTION relay_notify_group_conversation();
