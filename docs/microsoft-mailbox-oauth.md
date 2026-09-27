# Microsoft personal mailbox OAuth

Supports Outlook.com, Live and Hotmail personal accounts. Mailboxes remain mapped
to WhatsApp accounts. Password mailboxes and the Resend sending provider are unchanged.

## Deployment

1. Register a Microsoft Entra application that supports personal Microsoft accounts.
2. Add a **Web** redirect URI matching the public API origin exactly:
   `https://YOUR_HOST/api/v1/mailboxes/microsoft/callback`.
3. Create a client secret. Set `MICROSOFT_MAIL_CLIENT_ID` and
   `MICROSOFT_MAIL_CLIENT_SECRET` in the API and worker environment. Set
   `PUBLIC_API_URL` to the externally accessible API origin.
4. Enable delegated Exchange permissions `IMAP.AccessAsUser.All` and `SMTP.Send`.
   The authorization request also asks for `offline_access`.
5. Enable IMAP in the mailbox's Outlook settings. Redeploy API and worker;
   startup automatically runs migration `090_mailbox_oauth.sql`.
6. In email settings, add a mailbox, choose Microsoft OAuth, select its WhatsApp
   account and enter the same mailbox address as the Microsoft account you authorize.

For the GitHub VPS deployment, add `MICROSOFT_MAIL_CLIENT_ID` as a production
repository/environment variable and `MICROSOFT_MAIL_CLIENT_SECRET` as a production
secret. The deployment workflow copies both values into the API and mail worker;
no client secret is exposed to the browser.

Refresh tokens are encrypted at rest. One-time OAuth state expires in ten minutes;
the authorization-code exchange uses PKCE. IMAP authorization is verified before
saving. New mailboxes start at the current INBOX UID, so historical mail is not imported.
Existing mailboxes retain their synchronization cursor when reauthorized.

SMTP jobs resolve a fresh OAuth token at send time, not queue time. Resend, if enabled,
remains the preferred sending service and uses the selected mailbox as Reply-To.
Revoked Microsoft consent requires reauthorization. Delete a mailbox to disconnect it;
previously archived messages remain available.

Reference: Microsoft Learn, "Authenticate an IMAP, POP or SMTP connection using OAuth"
and "Microsoft identity platform and OAuth 2.0 authorization code flow".
