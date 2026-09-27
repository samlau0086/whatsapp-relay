ALTER TABLE account_email_mailboxes ADD COLUMN IF NOT EXISTS auth_type text NOT NULL DEFAULT 'password' CHECK(auth_type IN ('password','microsoft'));
ALTER TABLE account_email_mailboxes ADD COLUMN IF NOT EXISTS oauth_refresh_encrypted text;
CREATE TABLE IF NOT EXISTS mailbox_oauth_states (
  state_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES channel_accounts(id) ON DELETE CASCADE,
  address text NOT NULL,
  verifier_encrypted text NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT now()+interval '10 minutes'
);
