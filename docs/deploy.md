# Running Crewtavo

Every business gets its **own Crewtavo instance**: the app plus its own database, sign-in, file
storage, separate from every other business. There are two ways to run one:

- **On Railway**, with one click. This is how most businesses will run it.
- **With Docker** on any computer or server (`npm run instance`), to self-host or to try it out.

Both run the same five services (`docker-compose.yml` with Docker, the Railway template on Railway):

| Service | What it does | Reachable from |
| --- | --- | --- |
| `crewtavo` | The web app, the API, background tasks (reminders, automations, recurring visits...). Also the front door to the services below. | The internet |
| `db` | Postgres, with the roles the services below sign in as (`deploy/postgres`) | Inside the instance |
| `auth` | Sign-in, invitations, password resets, and the sign-in Claude and ChatGPT use (Supabase Auth) | Inside the instance |
| `rest` | The data API the web app reads and writes through, with row-level security (PostgREST) | Inside the instance |
| `storage` | Photos, receipts and documents (Supabase Storage, on a volume) | Inside the instance |

Only `crewtavo` is public. It forwards `/auth/v1`, `/rest/v1` and `/storage/v1` to the others (`apps/api/src/lib/stack.ts`), creates their keys from one shared secret, and applies
database migrations every time it starts (`/api/health` answers once they're done). Nobody has to
copy keys or run commands.

---

## On Railway

**For a business:** press **Deploy on Railway** in the [README](../README.md), sign in to Railway
(or create an account), and press **Deploy** again. After a few minutes, open the address Railway
shows on the **crewtavo** service and create the owner account. Then set up the business and invite
the team from **Settings → People and Roles**.

If something isn't right yet, the address shows a **Crewtavo is starting up** or **Finish setting up
Crewtavo** page that says what to do, instead of an error.

**Cost:** the business pays Railway directly. Measured on a new instance at rest: about 0.36 GB of
memory across the five services (Postgres 136 MB, Storage 124 MB, crewtavo 47 MB, rest 37 MB,
auth 12 MB), roughly $3.60 a month at Railway's $10 per GB-month. Railway's free trial (30 days, $5
of credit) is enough to try Crewtavo; to keep running, an instance needs Railway's Hobby plan ($5 a
month, including $5 of usage). Use grows with data and traffic; check
[Railway's pricing](https://railway.com/pricing).

**Your own domain:** right after setting up the business, the owner sees **Your web address**: four
steps on a timeline, ticked off as they're done, with what to do now opened under the current one.
1. **Log in with Railway.** They're still signed in after deploying, so they pick this project and
   press Allow.
2. **Choose your domain.** "Do you already have a domain?"
   - **Yes, use mine:** the address box starts with `crm.` and they type their domain after it.
   - **No, get me one:** opens Railway's Buy a Domain on the crewtavo service. Railway attaches it and
     runs its DNS, and Crewtavo offers to switch to it as soon as it shows up on the service.
3. **Connect your domain:** the two DNS records, with steps for their DNS provider, or **Email the
   steps** to whoever looks after the domain. A domain bought on Railway skips this.
4. **Crewtavo switches over** by itself.

It can be skipped. **Settings → Web address** shows the same steps any time, and businesses set up
before this see them only there. With Railway connected, Crewtavo adds the address to the crewtavo
service and shows the two DNS records Railway wants, with steps for the domain's DNS provider. On Cloudflare it can add
them itself, from a token used once and never stored. Then it checks the records live. Once Railway has verified the
address and issued its certificate, and the address answers as this instance, Crewtavo does the rest:
- sets `APP_URL`
- redeploys `auth` and `crewtavo`
- tells the admins

Pages on the old address forward to the new one. Client links, calendar feeds, the Twilio webhook and
assistant connectors keep working on both addresses.

Crewtavo keeps its Railway access afterwards, encrypted, so later features don't ask again. A daily
task refreshes it before Railway's sign-in runs out, and **Remove access** in Settings → Web address
ends it. Each instance registers its own client with Railway, so there's no shared app to run. If
Railway won't register it, the screen asks for a project token instead. By hand (under **Can't log
in with Railway?** in step 1), the steps are:
1. In the crewtavo service, **Settings → Networking → Custom Domain**.
2. Change its `APP_URL` variable to `https://your-domain`.
3. Redeploy `crewtavo` and `auth`.

The screen lists these steps with links, and notices when they're done.

**Backups:** Railway's volume backups (open the `db` or `storage` volume, then **Backups**) need
Railway's Pro plan.

**Updates:** Crewtavo keeps itself up to date. When a new version comes out, Railway installs it
within several hours, with no downtime: the new version starts next to the old one, updates the
database, and takes over only once it's working; if something goes wrong, the old one keeps
running. Railway notifies the workspace's admins after each update. The `db` service gets a new
version only when its setup changes, overnight (02:00–06:00 UTC), and is down for about a minute
while it restarts. Every new version installs itself, big ones included. The one exception is a
move to a new major version of Postgres, the database, which has to convert your data first; its
release notes say what to do. To see which version you're running, open
`https://your-address/api/health`. To change when updates install, or to turn them off, open the
service's **Settings → Source → Configure auto updates**. To stay on one version, change the image
there from `ghcr.io/jviars/crewtavo:latest` to that version, such as `ghcr.io/jviars/crewtavo:0.2.0`.

**Locked out?** See [Getting back in](#getting-back-in).

**Making the template** (once, by whoever publishes Crewtavo): see [deploy/README.md](../deploy/README.md).

## With Docker

You need [Docker](https://docs.docker.com/get-docker/) and [Node.js](https://nodejs.org) 20 or newer.

```bash
git clone https://github.com/jviars/crewtavo.git
cd crewtavo
npm run instance
```

The first run writes `.env.instance` with new secrets (keep it: the database is locked with them),
builds Crewtavo, starts the five services and prints the address, http://localhost:8080. Then:

```bash
npm run instance -- logs    # follow what's happening
npm run instance -- stop    # stop it; the data stays in Docker volumes
docker compose --env-file .env.instance down -v   # delete the instance and all its data
```

**On a server:** set `APP_URL=https://your-domain` in `.env.instance`, run `npm run instance` again,
and put a web server with HTTPS in front of port 8080 (`CREWTAVO_PORT`) on the same server, since
the port only answers there. With Caddy, this `Caddyfile` does it:

```
your-domain {
  reverse_proxy localhost:8080
}
```

Caddy adds each visitor's address to `X-Forwarded-For`, which Crewtavo's rate limits go by (see
[Visitors' addresses](#visitors-addresses)). Another web server has to add it the same way (nginx:
`proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`). A Caddyfile with a
`header_up X-Real-IP {remote_host}` line, from earlier versions of these steps, works as it is.

**Updating from an earlier version:** Crewtavo used to go by `X-Real-IP`. A web server that only
sets that one (nginx's `proxy_set_header X-Real-IP $remote_addr;`) needs the `X-Forwarded-For` line
above as well, or `CREWTAVO_VISITOR_IP=x-real-ip` in `.env.instance`. Without either, visitors can
pick their own address, and everyone who doesn't shares the web server's. Port 8080 also used to
answer on every address; now it only answers on the server itself. If your web server runs on
another machine, see [Visitors' addresses](#visitors-addresses).

**Backups:** back up the `crewtavo-instance_db-data` and `crewtavo-instance_storage-data` Docker
volumes, and `.env.instance`.

For working on Crewtavo's code, the faster loop is in the README's **Develop** section.

---

## Optional settings

Everything an instance needs is generated. These turn on extra features; add them to the
**crewtavo** service's **Variables** on Railway, or to `.env.instance` with Docker (`.env.example`
lists them all).

| Name | Turns on |
| --- | --- |
| `APP_URL` | Your own domain (see above; **Settings → Web address** sets it on Railway). Defaults to the instance's address. |
| `ENCRYPTION_KEY` | A separate key for encrypting app tokens and signing client links: 32+ random bytes in base64, or any 32+ characters. Without it, one is derived from the instance's secret. **Keep it stable once set**: changing it disconnects every app and invalidates links already sent to clients. |
| `ANTHROPIC_API_KEY` (optional `AI_MODEL`) | AI rewrite and SOP answers. Companies can also add their own key on the Apps page. |
| `GOOGLE_MAPS_BROWSER_KEY` | Optional. Measure works without any key (free US and state imagery); this adds Google satellite as a choice for every company. Enable the Map Tiles API and restrict the key to it and your domain. Companies can instead add Esri or Google keys themselves in **Settings → Maps**. |
| `GOOGLE_MAPS_SERVER_KEY` | Roof pitch suggestions (Solar API). Restrict it to the Solar API. |
| `QUICKBOOKS_CLIENT_ID`, `QUICKBOOKS_CLIENT_SECRET`, `QUICKBOOKS_ENVIRONMENT` | QuickBooks Online. Create an app at developer.intuit.com; the redirect URI is shown on the Apps page. |
| `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_ACCOUNTS_URL` | Zoho Books. Create a server-based client at api-console.zoho.com. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google Calendar: show a company's Google calendars on the schedule and put visits on a Google calendar Crewtavo makes. In Google Cloud, turn on the Google Calendar API, set up the OAuth consent screen with the scopes `calendar.calendarlist.readonly`, `calendar.events.readonly` and `calendar.app.created`, and create a Web application client whose redirect URI is the one shown on the Google Calendar app page (`https://your-domain/api/apps/google_calendar/callback`). Then, under **Audience**, publish the app (or choose **Internal** on Google Workspace): while it's in **Testing**, Google ends sign-ins after 7 days and Google Calendar disconnects. Optional: without these, Google Calendar works by secret address both ways (the Apps page walks people through it), and calendar files can be uploaded under **Settings → Calendars**. |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Not needed for most businesses: connect Stripe on the **Apps** page instead (see [Connecting Stripe](#connecting-stripe)). These share one Stripe account with every company on the server that hasn't connected its own (so **Bring in your Stripe history** works with it only on a one-company server). Point a webhook at `/api/webhooks/stripe` with API version `2024-06-20` and the events in `STRIPE_EVENTS` (`apps/api/src/integrations/stripe.ts`): `invoice.*` (finalized, paid, payment_failed, voided, marked_uncollectible), `payment_intent.processing`, `charge.refunded`, `charge.dispute.created`, `charge.dispute.closed`, `payout.*` (created, updated, paid, failed, canceled) and `checkout.session.*` (completed, async_payment_succeeded, async_payment_failed). |
| `RESEND_API_KEY`, `EMAIL_FROM` | Email through [Resend](https://resend.com). **Needed on Railway's trial and Hobby plans**, which block outgoing mail servers (SMTP). On Railway Pro or when self-hosting, the business can instead connect its own mailbox under **Settings → Email**, and these only give it a default sender until then. |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` | Text messages. For two-way texting, set the number's **Messaging > A message comes in** webhook to `https://your-domain/api/webhooks/twilio` (HTTP POST). Replies appear in Messages and notify the office. `APP_URL` must match that address exactly, because Twilio signs the full URL. |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | Bot protection on public booking and referral forms. |
| `CREWTAVO_SCHEDULER` | Set to `off` on extra replicas of `crewtavo`, so background tasks run in one place. |
| `CREWTAVO_VISITOR_IP` | Only when something other than Railway's edge or one web server is in front of Crewtavo: where visitors' addresses come from (see [Visitors' addresses](#visitors-addresses)). |
| `CREWTAVO_BIND` | Docker only: the address port 8080 answers on. Defaults to `127.0.0.1`, the computer itself, which is all a web server there needs; read [Visitors' addresses](#visitors-addresses) before changing it. |
| `CREWTAVO_SENTRY_DSN` | Error tracking for the API and the web app (see below). Unset turns it off. |
| `CREWTAVO_SENTRY_WEB_DSN` | Optional: send the web app's errors to a separate project. Defaults to `CREWTAVO_SENTRY_DSN`. |
| `CREWTAVO_SENTRY_ENVIRONMENT` | Optional: the environment shown on each report, such as `staging`. Defaults to `production`. |

### Visitors' addresses

Public pages (booking forms, promo codes, Client Hub payments and messages, sign-in links, the
first-run setup) limit how often each visitor can use them, by address, and a quote approval
records the address it came from. Anyone can send their own `X-Real-IP` or `X-Forwarded-For`
header, so Crewtavo only goes by what the instance's own proxy sets:

- **On Railway:** `X-Real-IP`, which Railway's edge sets on every request in place of anything
  the visitor sent.
- **With Docker or on your own server:** the last `X-Forwarded-For` entry, which the web server in
  front adds, on connections from the same machine or a private network (where that web server
  connects from). Connections from anywhere else count by their own address.

With Docker, port 8080 only answers on the server itself (`CREWTAVO_BIND`, `127.0.0.1` by
default), so the web server there is the only way in. Keep it that way with a web server in front:
Docker hands some outside connections to Crewtavo from its own network address (over IPv6, and on
Docker Desktop or rootless Docker often all of them), and Crewtavo would take them for the web
server's and believe their `X-Forwarded-For`.

- **Web server on another machine:** set `CREWTAVO_BIND` to this server's address on the private
  network between them, not `0.0.0.0`.
- **No web server** (trying Crewtavo from other computers on your network): set
  `CREWTAVO_BIND=0.0.0.0` and `CREWTAVO_VISITOR_IP=connection`. On Docker Desktop, everyone then
  counts as one visitor.
- **Without Docker:** close port 8080 to other computers with the server's firewall.

Sign-in and file storage get the same address from Crewtavo (Auth records it with each sign-in).
With something else in front, set `CREWTAVO_VISITOR_IP`:

| Value | When |
| --- | --- |
| `x-forwarded-for:2` | Two proxies add to `X-Forwarded-For`, such as Cloudflare's proxy in front of Caddy. Caddy keeps Cloudflare's entries only from addresses in its `trusted_proxies` setting, so list Cloudflare's there. The number counts the proxies. |
| `cf-connecting-ip`, `x-real-ip` (or another header) | The proxy in front sets this header to the visitor's address, replacing any the visitor sent (nginx's `proxy_set_header X-Real-IP $remote_addr;` does). |
| `connection` | Nothing is in front: the address each connection comes from. |

Once set, it's believed on every connection, so nothing may reach Crewtavo without going through
those proxies: keep port 8080 on the server (above), and let the web server take connections only
from the proxy in front of it (for Cloudflare, allow only [Cloudflare's addresses](https://www.cloudflare.com/ips/)
in the server's firewall). Caddy with `x-forwarded-for:2` doesn't need the firewall, since it
replaces the `X-Forwarded-For` of anyone outside `trusted_proxies`; nginx adds to it.

### Error tracking

Set `CREWTAVO_SENTRY_DSN` to a project's DSN from [Sentry](https://sentry.io) (Project Settings >
Client Keys). The API reports crashes and unexpected database errors, background tasks report when
they fail, and the web app reports screen crashes and code errors. Nothing is collected until the
variable is set, and the browser only downloads the reporting code when it is.

A self-hosted [GlitchTip](https://glitchtip.com) works the same way: it accepts the Sentry SDK, so
paste its DSN (Project > Settings > DSN) into `CREWTAVO_SENTRY_DSN`. Any other Sentry-compatible
service works too.

Reports are errors only (no performance tracing, session tracking or replays), and personal data is
removed before anything leaves the server or the browser (`packages/core/src/privacy.ts`):

- request bodies, cookies, query strings and headers (except the browser's User-Agent) are never sent;
- no user is attached: no email, IP address or account id;
- email addresses, phone numbers, sign-in tokens and client links (`/hub/...`, `/u/...`) are masked
  in error messages, breadcrumbs and extra data.

The SDK leaves IP addresses out, but you can also turn on **Prevent Storing of IP Addresses** in
the Sentry project's security settings so the server never infers them.

---

## After the first sign-in

- **Settings → Email** (self-hosted, or Railway Pro; Railway's trial and Hobby plans block SMTP, so
  use `RESEND_API_KEY` there): connect the business mailbox (Gmail, Google Workspace, Zoho, Microsoft 365, Yahoo,
  iCloud or any SMTP server) with an app password; the screen links to where each provider makes one.
  Crewtavo signs in and sends you a test before saving. Quotes, invoices, reminders, team invites,
  password resets and team notifications then go out from that address. No DNS changes, no extra
  account, nothing to pay for. (Until it's connected, invites show a link to copy and text instead.)
- **Settings → People and Roles**: invite the team. Starter roles: General manager, Office manager
  (invoices and payroll), Operations manager, Foreman (runs their own crew, no prices) and Employee.
- **Settings → Profile → Notifications** (each person): turn on notifications for their phone and
  choose what also comes by email or text. On an iPhone, add Crewtavo to the Home Screen first
  (Share → Add to Home Screen) and open it from there. Phone notifications are free and need no setup.
  Where the browser offers it (Chrome or Edge, on Android or a computer), **Install the app** is
  there too, and on the crew's Home and My day, where crews in Safari on an iPhone get the Home
  Screen steps instead. Crew updates made with no signal go out once Crewtavo is on the screen with
  signal; on Android, if it's put away or closed by then, a notification says how many are waiting.
- **Company settings**: address (used for route starts and email footers), payment terms, tax rate and brand color.
- **Marketing > Reviews**: paste your Google review link so review requests point at it.
- **Marketing > Referrals**: set the reward you offer, if any.
- **Automations**: the starter rules are on; adjust their wording or delays, or add your own.
- **Reports > Overview**: an admin can set the yearly revenue goal and a target job margin.

## Connecting Stripe

Open **Apps** and paste your Stripe secret key (Stripe: **Developers → API keys**, the one that
starts with `sk_live_`). Crewtavo checks it and adds the webhook it needs to your Stripe account, so
there's nothing else to set up. A test key (`sk_test_`) works the same way, with no real money.
A restricted key works too if it can write customers, invoices, invoice items and webhook
endpoints, and read payouts and balance transactions.

Then:

- **Sending an invoice** also creates it in Stripe, so it shows in your Stripe dashboard. Crewtavo
  emails or texts the client as before; Stripe doesn't. The **Pay** button in the Client Hub opens
  Stripe's page for that invoice. A client can't pay it twice, a bank payment shows as on its way
  until it clears (no reminders meanwhile, and the invoice page says when it started and asks
  before you record another payment, which could have the client pay twice), and a check you
  record replaces the Stripe invoice with one for what's still owed. A few cents left, less than
  Stripe can charge (50¢ in dollars), aren't put in Stripe: collect them another way. A sent
  invoice moved back to draft can be deleted once its Stripe invoice is voided, a few minutes
  later (if Stripe can't be reached to void it, void the invoice instead).
- **Invoices you make in Stripe** (a one-off or a big job you'd rather bill by hand) come into
  Crewtavo on their own, matched to the client by email or added as a new client, and their
  payments are recorded when they're paid. Stripe asks the client for what it billed, so record a
  payment on one in Stripe, not in Crewtavo: mark it paid there when the client paid all of it, or
  issue a credit note there for what they paid when it's part of it, so Stripe asks for only the
  rest. The credit note is recorded here once the invoice is paid in Stripe.
- **Payments** record the fee Stripe kept, and **Invoices → Stripe deposits** shows each payout to
  your bank with the payments in it. Refunds, failed bank payments and disputes show up on their own.
  A client's balance in Stripe goes on their next Stripe invoice: credit they had is recorded on
  that invoice, and money they owed from before as a payment from them that isn't on the invoice
  (a refund or a lost dispute of that charge takes it back too). When credit pays all of an
  invoice and the client adds a tip in the Client Hub, Stripe charges only the tip: that's recorded
  as a payment of just the tip, with its fee and deposit. A credit note you issue in Stripe
  before the invoice is paid is recorded on it, so it isn't asked for again. Tips aren't sent to
  QuickBooks or Zoho Books (they aren't on the invoice there); Reports shows them.
- **Bring in your Stripe history** on the Stripe card imports past invoices, their clients and
  payments, and deposits, from a date you choose. History comes in quietly: no automations,
  reminders or notifications. Running it again only updates what's already there. On the
  server's own Stripe account (`STRIPE_SECRET_KEY`) it only runs when the server has one company,
  since that account is shared.

**Replacing the key** (**Replace key** on Stripe's page in **Apps**) only takes over once Crewtavo has added
the webhook with the new key; if it can't, Stripe stays connected as it was. When the new key is
for another Stripe account, or it's your live key after a test one, Crewtavo stops using the old
account: its open invoices are voided there (any paid meanwhile are recorded), and clients get a
new Stripe invoice in the new account when they pay. **Disconnecting** does the same. A bank
payment still clearing in the old account is left alone, so the client isn't asked to pay twice;
a note on the client reminds you to record it once it clears there.

Stripe only sends webhooks to a public `https` address, so on a local copy the key is saved
without one. Run `stripe listen --forward-to localhost:8787/api/webhooks/stripe` and use the
deployment settings above to try webhooks there.

## Getting back in

"Forgot password?" emails a reset link once the company has connected its mailbox (**Settings →
Email**). Until then, the sign-in page says it can't send email, and there are two other ways in:

- **Someone on the team:**
  - The owner or an admin opens **Settings → People** and chooses **Reset password** under the
    person's name.
  - If email works, the link is emailed. Otherwise they get a link to hand over in person or by
    text. It works once and stops working within a day.
  - Admins can only do this for people below admin, and the owner for everyone but other owners, so
    nobody can take over an account with as much access as their own.
  - People who also use Crewtavo with another business have to reset it themselves.
  - Each link goes in the activity log, and the person gets a notification about it.
- **The owner: their key file.**
  - When the owner creates their account, Crewtavo has them download a key file
    (`crewtavo-key-file.txt`), or print the keys inside it instead. It won't continue until they
    confirm they saved it.
  - The file holds eight one-time spare keys, like two-factor backup codes. Each upload uses the
    next one, so the file works eight times.
  - Locked out: **Forgot password?**, then **I'm the owner: use my key file**, then upload it and
    choose a new password. With a printout instead, **No file? Type a key** takes their email and one
    key.
  - **Settings → Profile** shows how many uses are left and gets a new key file. It asks for the
    password, and the old file stops working.
  - It only works while email isn't set up. Once the company's email is connected, **Forgot
    password?** sends a link instead.
  - Keys are stored only as keyed hashes, and tries are limited per person and per account.
- **The owner lost their key file too:** whoever helps them proves they control the server.
  1. In Railway, open the project, then the **crewtavo** service, then **Variables**. (On your own
     computer: the `.env.instance` file.)
  2. Add `CREWTAVO_RECOVERY_EMAIL` with the owner's email, and `CREWTAVO_RECOVERY_CODE` with a
     phrase you make up, at least 12 characters. Deploy (on your own computer: `npm run instance`).
  3. Within the next hour, the owner opens **I'm the owner: use my key file**, then **No file? Type
     a key**, and types their email and that phrase, then chooses a new password.
  4. Delete both variables.

  The phrase never appears in the logs and works once, even across restarts. It only works in the
  hour after the server starts with it, and wrong guesses are limited. Anyone who can change those
  variables already controls the whole instance, so it opens no new way in.

After any password reset, Crewtavo signs that account out everywhere else.

## Connecting Claude and ChatGPT

Instances come with this turned on. Open **Apps** in Crewtavo and copy the connector address
(`https://your-domain/mcp`):

- **Claude**: Settings > Connectors > Add custom connector.
- **ChatGPT**: Settings > Apps and connectors > Add (developer mode).

Each person signs in to Crewtavo and approves access on `/oauth/consent`. The assistant can then
look up whatever that person can see, but can't add or change anything until they turn on **Allow
changes** for it (Settings > Profile > AI assistants, which everyone has whatever their role; owners
and admins also see it on the Claude and ChatGPT pages under Apps); connections made before that
switch existed only read too. It never gets more than the person's own permissions, and it can't
change their sign-in. The database holds it to reading as well, through PostgREST's pre-request
setting (`pgrst.db_pre_request` on the `authenticator` role, which the migrations set). If the
database role that runs the migrations isn't allowed to change `authenticator`, the update's log
says so (`migrate: warning in 20261019001040_assistant_access.sql`) with the command to run as a
superuser; then run `notify pgrst, 'reload config';` (or restart the Data API).
