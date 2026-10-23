# Contacts

Contacts put names on numbers: in call history, voicemail, the browser phone while it rings, the
call report email, and the directory on desk phones (the company contacts). Pick where they live
in the setup wizard or in **Settings → Contacts**:

- **Simple**: a phonebook inside SelfPhoneNG. Nothing else to run.
- **Contrack**: [Contrack](https://github.com/arvarik/contrack), a full contact and relationship
  manager, running next to the phone system as its own container.

Everyone has their own contacts, and there are **company contacts** that everyone sees (only
admins change them, in **Admin → Contacts**).

## Simple

- **My Phone → Contacts**: add, edit, search, click a number to call. Calls and voicemails from a
  number that isn't a contact have **Add to contacts**.
- **Import**: one or more `.vcf` files (exported from an iPhone, Android, Google Contacts,
  Outlook or Apple Contacts) or a CSV with a header row (`name, company, email, label1, number1,
  label2, number2, …`). You see what will be added first; contacts already there (same name and
  number) are skipped. Up to 5,000 contacts at a time.
- **Share**: tick contacts, **Share**, pick colleagues or everyone. They get "Shared with you" at
  the top of their Contacts page and on Home, and choose **Accept** (a copy goes into their
  contacts) or **Deny**. Nothing is added to anyone's contacts without their click.

## Contrack

Contrack keeps each person's contacts in their own private Contrack account, and the company's in
a Contrack account of its own. SelfPhoneNG reads them (names on calls, the directory on desk
phones), adds to them ("Add to contacts", accepted shares), and links to them. Editing, importing,
notes and the rest happen in Contrack.

### Set it up

1. Give it a DNS name of its own, such as `contacts.example.com` (Contrack can't live under a
   path of the phone system's name), pointing at this server. Set it in `.env`:

   ```bash
   CONTRACK_HOSTNAME=contacts.example.com
   ```

2. Start it:

   ```bash
   docker compose --env-file .env -f deploy/contrack/compose.yml up -d
   ```

   It listens on `127.0.0.1:3210` only.
3. Put it behind your reverse proxy: with the bundled Caddy, uncomment the Contrack block at the
   end of `deploy/caddy/Caddyfile` and restart Caddy; with your own nginx, see the end of
   `deploy/nginx/selfphoneng.conf.example`.
4. Open `https://contacts.example.com`. The first visit creates the first (admin) account. Then,
   in Contrack's **Settings → Administration → Invitations**, invite each person, and make one
   account for the company, such as `company@example.com`.
5. Signed in to Contrack as the company account: **Settings → Account → API tokens → Create
   token**. Under **Expires** choose **Never** (or 1 year, and replace it before then): the
   default is 90 days, and names stop showing when a token expires. **Read only** is enough;
   **Read and write** lets admins add company contacts from SelfPhoneNG.
6. In SelfPhoneNG, **Settings → Contacts → Contrack**: address `http://127.0.0.1:3210`, the
   address people open (`https://contacts.example.com`), the company token, **Test**, **Save**.
7. Each person: in Contrack, **Settings → Account → API tokens → Create token**, **Read and
   write**, expiring **Never** (or 1 year), then in SelfPhoneNG **My settings → Contacts**, paste
   it, **Connect**. My settings says so when a token stops working.

Names refresh from Contrack every 5 minutes (at once after SelfPhoneNG adds a contact). If
Contrack is down, the last names it gave keep working.

### Privacy

SelfPhoneNG only talks to Contrack on this server or the local network, and keeps the tokens
encrypted. Contrack itself can use AI (cloud providers, or your local Ollama) and look addresses
up on OpenStreetMap: those are Contrack's settings, outside SelfPhoneNG's "nothing leaves the
server" rule. To keep everything here, set `AI_DISABLED` and `GEOCODING_DISABLED` in
`deploy/contrack/compose.yml`, or point Contrack's AI at your local AI in its **Settings →
Administration → AI**.

### Backups

SelfPhoneNG's backup doesn't include Contrack. Contrack makes its own snapshots in its
`contrack-data` volume (its **Settings → Backups**); back up that volume too.

### Going back to Simple

**Settings → Contacts → Simple**. The builtin contacts are still there, and the Contrack tokens
are kept in case you switch back.
