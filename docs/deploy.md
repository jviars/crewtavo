# Running Crewtavo

Every business gets its **own Crewtavo instance**: the app plus its own database, sign-in, file
storage and live updates, separate from every other business. There are two ways to run one:

- **On Railway**, with one click. This is how most businesses will run it.
- **With Docker** on any computer or server (`npm run instance`), to self-host or to try it out.

Both run the same six services (`docker-compose.yml` with Docker, the Railway template on Railway):

| Service | What it does | Reachable from |
| --- | --- | --- |
| `crewtavo` | The web app, the API, background tasks (reminders, automations, recurring visits...). Also the front door to the services below. | The internet |
| `db` | Postgres, with the roles the services below sign in as (`deploy/postgres`) | Inside the instance |
| `auth` | Sign-in, invitations, password resets, and the sign-in Claude and ChatGPT use (Supabase Auth) | Inside the instance |
| `rest` | The data API the web app reads and writes through, with row-level security (PostgREST) | Inside the instance |
| `storage` | Photos, receipts and documents (Supabase Storage, on a volume) | Inside the instance |
| `realtime` | Live updates, such as the schedule changing on other screens (Supabase Realtime) | Inside the instance |

Only `crewtavo` is public. It forwards `/auth/v1`, `/rest/v1`, `/storage/v1` and `/realtime/v1` to
the others (`apps/api/src/lib/stack.ts`), creates their keys from one shared secret, and applies
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

**Cost:** the business pays Railway directly. An idle instance uses about 0.5 GB of memory across
its six services, which fits within Railway's Hobby plan ($5 a month, including $5 of usage) for a
small company. Heavy use costs more; check [Railway's pricing](https://railway.com/pricing).

**Your own domain:** in the crewtavo service, **Settings → Networking → Custom Domain**. Then change
its `APP_URL` variable to `https://your-domain` and redeploy `crewtavo` and `auth`.

**Backups:** Railway's volume backups (open the `db` or `storage` volume, then **Backups**) need
Railway's Pro plan.

**Updates:** migrations run by themselves when a new version starts, so updating is a redeploy.

**Making the template** (once, by whoever publishes Crewtavo): see [deploy/README.md](../deploy/README.md).

## With Docker

You need [Docker](https://docs.docker.com/get-docker/) and [Node.js](https://nodejs.org) 20 or newer.

```bash
git clone https://github.com/jviars/crewtavo.git
cd crewtavo
npm run instance
```

The first run writes `.env.instance` with new secrets (keep it: the database is locked with them),
builds Crewtavo, starts the six services and prints the address, http://localhost:8080. Then:

```bash
npm run instance -- logs    # follow what's happening
npm run instance -- stop    # stop it; the data stays in Docker volumes
docker compose --env-file .env.instance down -v   # delete the instance and all its data
```

**On a server:** set `APP_URL=https://your-domain` in `.env.instance`, run `npm run instance` again,
and put a web server with HTTPS in front of port 8080 (`CREWTAVO_PORT`). With Caddy, a two-line
`Caddyfile` does it:

```
your-domain {
  reverse_proxy localhost:8080
}
```

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
| `APP_URL` | Your own domain (see above). Defaults to the instance's address. |
| `ENCRYPTION_KEY` | A separate key for encrypting app tokens and signing client links: 32+ random bytes in base64, or any 32+ characters. Without it, one is derived from the instance's secret. **Keep it stable once set**: changing it disconnects every app and invalidates links already sent to clients. |
| `ANTHROPIC_API_KEY` (optional `AI_MODEL`) | AI rewrite and SOP answers. Companies can also add their own key on the Apps page. |
| `GOOGLE_MAPS_BROWSER_KEY` | Measuring on satellite imagery. Restrict it to your domain and the Maps JavaScript API. |
| `GOOGLE_MAPS_SERVER_KEY` | Roof pitch suggestions (Solar API). Restrict it to the Solar API. |
| `QUICKBOOKS_CLIENT_ID`, `QUICKBOOKS_CLIENT_SECRET`, `QUICKBOOKS_ENVIRONMENT` | QuickBooks Online. Create an app at developer.intuit.com; the redirect URI is shown on the Apps page. |
| `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_ACCOUNTS_URL` | Zoho Books. Create a server-based client at api-console.zoho.com. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google Calendar. |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Online invoice payments (card and US bank). Point a webhook at `/api/webhooks/stripe` with these events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed` and `charge.refunded`. |
| `RESEND_API_KEY`, `EMAIL_FROM` | Optional. Each company sends from its own mailbox, connected in the app under **Settings → Email** (Gmail, Google Workspace, Zoho, Microsoft 365, Yahoo, iCloud or any SMTP server, with an app password), so nothing is needed here. Set these only to give every company a default sender until it connects one. |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` | Text messages. For two-way texting, set the number's **Messaging > A message comes in** webhook to `https://your-domain/api/webhooks/twilio` (HTTP POST). Replies appear in Messages and notify the office. `APP_URL` must match that address exactly, because Twilio signs the full URL. |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | Bot protection on public booking and referral forms. |
| `CREWTAVO_SCHEDULER` | Set to `off` on extra replicas of `crewtavo`, so background tasks run in one place. |
| `CREWTAVO_SENTRY_DSN` | Error tracking for the API and the web app (see below). Unset turns it off. |
| `CREWTAVO_SENTRY_WEB_DSN` | Optional: send the web app's errors to a separate project. Defaults to `CREWTAVO_SENTRY_DSN`. |
| `CREWTAVO_SENTRY_ENVIRONMENT` | Optional: the environment shown on each report, such as `staging`. Defaults to `production`. |

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

- **Settings → Email**: connect the business mailbox (Gmail, Google Workspace, Zoho, Microsoft 365, Yahoo,
  iCloud or any SMTP server) with an app password; the screen links to where each provider makes one.
  Crewtavo signs in and sends you a test before saving. Quotes, invoices, reminders, team invites,
  password resets and team notifications then go out from that address. No DNS changes, no extra
  account, nothing to pay for. (Until it's connected, invites show a link to copy and text instead.)
- **Settings → People and Roles**: invite the team. Starter roles: General manager, Office manager
  (invoices and payroll), Operations manager, Foreman (runs their own crew, no prices) and Employee.
- **Settings → Profile → Notifications** (each person): turn on notifications for their phone and
  choose what also comes by email or text. On an iPhone, add Crewtavo to the Home Screen first
  (Share → Add to Home Screen) and open it from there. Phone notifications are free and need no setup.
- **Company settings**: address (used for route starts and email footers), payment terms, tax rate and brand color.
- **Marketing > Reviews**: paste your Google review link so review requests point at it.
- **Marketing > Referrals**: set the reward you offer, if any.
- **Automations**: the starter rules are on; adjust their wording or delays, or add your own.
- **Reports > Overview**: an admin can set the yearly revenue goal and a target job margin.

## Connecting Claude and ChatGPT

Instances come with this turned on. Open **Apps** in Crewtavo and copy the connector address
(`https://your-domain/mcp`):

- **Claude**: Settings > Connectors > Add custom connector.
- **ChatGPT**: Settings > Apps and connectors > Add (developer mode).

Each person signs in to Crewtavo and approves access on `/oauth/consent`. The assistant then has
exactly that person's permissions.
