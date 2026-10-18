# Crewtavo backend implementation plan

> [!NOTE]
> This is the original plan, kept for the reasoning behind it. Hosting has changed since: each
> business now runs its own instance (the app plus its own Postgres, Auth and Storage) on Railway
> or with Docker, as described in the [README](../README.md) and [deployment guide](deploy.md).
> Where this plan mentions Cloudflare, Vercel or a hosted Supabase project, read it as that
> per-business instance. Supabase Realtime was dropped to keep instances small: the schedule and
> notifications refresh by polling.

Crewtavo is open-source operations software for service businesses (lawn care, paving, roofing,
cleaning, HVAC and similar trades). It does what Jobber does, plus an SOP knowledge base, map
measuring, and connections to QuickBooks, Zoho, Claude and ChatGPT. This plan covers the backend
and how the existing React frontend connects to it.

---

## 1. Decision: our own backend on Supabase

We're building our own TypeScript backend on Supabase rather than on top of an existing records or
accounting platform:

- **Hosting.** A stateless API plus Supabase runs on Cloudflare or Vercel, with no always-on server,
  queue workers or extra databases to look after.
- **We don't need a general ledger.** Like Jobber, Crewtavo sends invoices and payments to
  QuickBooks, Xero or Zoho, so accounting stays where the bookkeeper already works.
- **We own every screen anyway.** A general-purpose platform would be a database we work around,
  with its own document flow, locked records and required setup (fiscal year, chart of accounts).
- **One language.** TypeScript end to end.
- **Cheaper, simpler installs.** A business can start on free tiers and grow to about $30 a month,
  with a real one-click deploy.

What we give up, and therefore own: permission rules, PDFs, email and SMS delivery, scheduled jobs,
reports and billing edge cases. Section 19 lists the checklists we hold those parts to.

---

## 2. Architecture

```
Browser: React SPA (desktop + phone layouts)
   │  supabase-js: sign-in, simple reads, live schedule updates (row-level security applies)
   │  fetch /api/*: business operations and anything that needs a secret
   ▼
API: Hono (TypeScript), one codebase
   ├─ Cloudflare Workers (static assets + API + cron triggers in one Worker)
   └─ Vercel Functions (Node, Fluid compute) + Vercel CDN + Vercel Cron
   │
   ▼
Supabase: Postgres (all data, RLS per company), Auth (staff sign-in, OAuth server for MCP),
          Storage (photos, receipts, PDFs), Realtime (schedule board), Cron (optional scheduler)

Outbound from the API: QuickBooks Online, Zoho Books, Google Calendar, Stripe, Twilio, Resend,
Google Maps + Solar API, Open-Meteo, Anthropic (Claude)
Inbound to the API: Claude and ChatGPT over MCP at /mcp; Stripe webhooks; public booking forms
```

The browser talks to Supabase directly where row-level security (RLS) fully protects the data, for
example listing clients, reading an SOP or subscribing to schedule changes. It goes through the API
for anything with business rules spanning several tables, third-party secrets, or public access
(converting a quote to a job, connecting QuickBooks, asking an SOP question, public booking forms).
The API also forwards the user's token, so RLS still applies to its queries.

### Repository layout

| Path | What's there |
| --- | --- |
| `apps/web` | React + TypeScript + Vite SPA |
| `apps/api` | Hono API with entry points for Workers (`src/worker.ts`) and Vercel (`src/vercel.ts`) |
| `packages/core` | Shared, platform-free logic: geometry, formulas, recurrence, time zones, trade presets |
| `supabase/migrations` | SQL schema, RLS policies and database functions |
| `supabase/tests` | Database tests (RLS isolation, totals, numbering) |
| `scripts` | Vercel build output, migration runner, database test runner |

---

## 3. Technology choices

| Concern | Choice | Why |
| --- | --- | --- |
| Database | Supabase Postgres | Relational data, RLS for tenant isolation, full-text search, generated types |
| Auth | Supabase Auth | Email/password, magic links, Google sign-in; OAuth 2.1 server for MCP clients |
| API | Hono | Web-standard, runs unchanged on Workers, Vercel, Node and Bun |
| Data access | supabase-js + SQL functions | Works over HTTPS from any runtime (no TCP pooling); multi-table changes run in SQL transactions |
| Files | Supabase Storage | Same RLS model; signed URLs for the Client Hub |
| Live updates | Supabase Realtime | Dispatch board updates when a visit moves |
| Scheduled jobs | Cloudflare Cron Triggers, Vercel Cron, or Supabase Cron | All call the same task code |
| Background work | Postgres outbox table drained by cron | Portable, retryable, visible in SQL |
| Recurrence | `rrule` (RFC 5545) | Standard rules; same format Google Calendar uses |
| SOP editor | TipTap (MIT) | Rich text stored as JSON, rendered to HTML for reading and search |
| Maps | Google Maps JS + Terra Draw + Turf | Google's own drawing library is gone; Terra Draw replaces it |
| Payments | Stripe (Checkout + webhooks) | Card and ACH; Stripe Connect for the hosted version |
| Email / SMS | Resend / Twilio | Simple REST APIs that work from Workers |
| AI | Anthropic SDK (Claude) | Rewrite messages, draft quotes, answer from SOPs |
| Validation | zod | Request bodies and preset files |
| Tests | Vitest (core, API), SQL tests in Docker Postgres | Fast, no cloud needed |

---

## 4. Principles

1. **One app for every trade.** No per-business code. Trade presets (section 5) supply services,
   formulas, checklists, intake questions and SOP categories.
2. **The database is the safety net.** Every table carries `company_id` and RLS. A bug in the API
   or the browser can't leak another company's data.
3. **Money math happens in Postgres.** Quote and invoice totals, balances and numbers are computed
   by triggers, never trusted from the client.
4. **The browser never sees a third-party secret.** OAuth tokens are encrypted at rest (AES-GCM)
   in a table only the API's service key can read.
5. **Portable by default.** Platform-specific code lives in two small entry files.
6. **Phones are first-class.** Crews use the same app in a phone layout.

---

## 5. How one app supports every trade

Each operation in the three kinds of business we researched becomes a generic feature plus preset
data:

- **Lawn and exterior maintenance**: recurring lawn and exterior maintenance, seasonal services,
  commercial grounds plans.
- **Paving**: residential, commercial and municipal paving; subcontracting for general contractors.
- **Roofing and home improvement**: roofing, gutters, siding, decks, windows.

| Real-world need | Generic feature | Where it lives |
|---|---|---|
| Weekly or bi-weekly mowing, season start and end | Recurring jobs: RRULE plus active months; visits generated 60 days ahead | `jobs.recurrence_rule`, `core/recurrence.ts`, recurrence task |
| Rain day: shift Friday to Saturday | Weather check plus a bulk "shift day" action | `api/services/weather.ts`, `POST /api/schedule/shift` |
| Snow events, holiday lights | Bulk-create visits for chosen jobs on a date | `POST /api/schedule/bulk-visits` |
| Commercial plans, multi-site clients | Many properties per client; fixed-schedule billing | `properties`, `jobs.billing_mode` |
| Instant-price online booking | Public intake forms with service-area ZIP checks | `intake_forms`, `/api/public/forms/*` |
| Measured paving estimates, tonnage | Measurements with depth and formula-driven quantities | `measurements`, `core/formulas.ts` |
| Roof squares, pitch, waste | Pitch factor and waste %; Solar API suggests pitch | `core/geo.ts`, `POST /api/roof-insights` |
| Good, better, best; optional add-ons | Option groups and optional line items | `quote_line_items.option_group`, `optional` |
| GC subcontracts with PO and 10% retainage; pay applications | Progress invoices with retainage and pay-app numbers | `jobs.retainage_pct`, `invoices.kind = 'progress'` |
| Municipal program, many sites | Visits carry their own property | `visits.property_id` |
| Permits, warranties | Job fields plus automations | `jobs.permit_number`, `jobs.warranty_until` |
| SOPs and new-hire training | Our own SOP module with acknowledgements | Section 8 |

**Trade presets** (`packages/core/src/presets/*.json`) are chosen during sign-up: General,
Lawn & Exterior Maintenance, Paving & Sitework, Roofing & Exteriors. Applying one inserts services,
checklist templates, intake forms and SOP categories for the new company. Adding a trade means
adding a JSON file.

---

## 6. Data model

All tables live in `public`, carry `company_id`, and have RLS enabled. Child rows reference parents
with composite keys `(company_id, parent_id)`, so a row can never point at another company's data.

| Area | Tables |
| --- | --- |
| Tenancy and people | `companies`, `memberships` (access level, custom role, labor rate), `company_roles`, `profiles`, `crews`, `crew_members` |
| Clients | `clients` (lead/active/archived, tags, custom fields), `client_contacts`, `properties`, `property_access` (gate codes) |
| Intake | `intake_forms`, `requests` |
| Sales | `services` (catalog), `measurements`, `quotes`, `quote_line_items` |
| Work | `jobs`, `job_line_items`, `visits`, `visit_assignees`, `checklist_templates`, `checklist_responses`, `time_entries`, `expenses` |
| Billing | `invoices`, `invoice_line_items`, `payments` |
| Communication | `messages` (SMS, email, notes), `activity` (feed, written by triggers), `notifications` (per person), `attachments` |
| Marketing | `campaigns`, `campaign_recipients`, `review_requests`, `referrals` |
| Knowledge base | `sop_categories`, `sop_pages`, `sop_revisions`, `sop_acknowledgements` |
| Automation | `automation_rules`, `automation_runs` (queue; one row per rule per matching activity event) |
| Integrations | `integrations` (status), `integration_secrets` (encrypted, service key only), `sync_links`, `outbox` |
| Numbering | `number_sequences` with `private.next_number()` |

**Access levels:** owner, admin, office, estimator, crew_lead, field_crew. Row-level security uses the level to decide
which records someone can reach.

**Custom roles** (`company_roles`): a name, an access level and a list of areas (sales, invoices, job costs, reports,
marketing, automations, schedule, timesheets, settings, knowledge base editing, team, apps). Each level allows a fixed
set of areas (`private.level_permissions()`, mirrored in `packages/core/src/roles.ts`); a role can switch any of them
off. Giving someone a role sets their level automatically. Restrictive RLS policies check `private.has_perm()` on the
area's tables (invoices and payments, campaigns, automations, quote writes, price list and settings writes, knowledge
base writes, team management, other people's expenses), and the API and screens hide what a role doesn't include.
Members without a custom role get every area their level allows. New companies start with General manager,
Operations manager, Foreman and Employee.

| Data | Read | Write |
| --- | --- | --- |
| Clients, properties, jobs, visits, SOPs | Any member | Office and up (crew leads can update visits) |
| Quotes, services | Any member | Owner, admin, office, estimator |
| Invoices, payments, expenses | Owner, admin, office | Owner, admin, office |
| Gate codes | Office and up, plus crew assigned to a visit there today | Office and up |
| Time entries | Own entries, plus office and up | Own entries until approved; office approves |
| Integrations | Owner, admin | API only |

Helper functions `private.is_member(company_id)` and `private.has_role(company_id, roles)` are
`security definer`, read `auth.uid()` once per statement, and are indexed by `(user_id)`.

**Database functions** (called with `supabase.rpc`, run as the user so RLS applies):
`create_company`, `convert_quote_to_job`, `create_invoice_for_job`, `dashboard`, `search_sops`.
Triggers keep totals, balances, invoice status, SOP revisions and `updated_at` correct, and queue
accounting sync work in the outbox.

---

## 7. Scheduling

Inspired by Jobber's calendar, built on our own tables:

- A **job** holds the work and billing. A **visit** is one trip to a property, with a time window,
  crew, assignees and status. Assessments, tasks and events are visits without a job.
- **Recurring jobs** store an RRULE (`FREQ=WEEKLY;INTERVAL=2;BYDAY=TU`), optional active months
  (season), and a default start time and duration. A daily task generates visits 60 days ahead with
  a `recurrence_key` (the date), so reruns never duplicate and moved visits stay moved.
- **Anytime visits** have a date but no fixed time; route optimization orders them (nearest
  neighbor plus 2-opt, real road routing as an upgrade).
- **Find a time** looks for gaps in a crew's working hours in the company's time zone.
- **Rain days**: a weather task flags visits whose trade rules are broken (minimum temperature for
  asphalt, dry hours for sealcoat). "Shift day" moves them in one action.
- **Live board**: the web app subscribes to `visits` changes with Supabase Realtime.
- **Other calendars**: any calendar's ICS link (Zoho Calendar, Outlook, iCloud, Google's secret
  address...) or calendars from a connected Google account show on the schedule, read every 15
  minutes. A calendar can belong to a crew; its busy time counts in "Find a time".
- **Google Calendar** (optional): visits go onto a Google calendar Crewtavo makes, through the
  outbox, within a few minutes of each change.

---

## 8. SOP knowledge base

Categories, pages, revisions, search and templates, built into our app:

- `sop_pages` store the editor's content (`body`, `{"type": "html", ...}`), sanitized HTML for reading and
  plain text for search. A generated `tsvector` column weights titles above body text. The web editor is a
  small dependency-free rich-text editor (headings, lists, quotes, links, Markdown shortcuts).
- Every edit bumps `revision` and writes a row to `sop_revisions`, so you can compare or restore.
- **Required SOPs and acknowledgements**: pages can be required for certain roles. Staff confirm
  they've read the current revision; a new revision makes old acknowledgements stale automatically.
- **Ask**: `POST /api/kb/ask` retrieves the best-matching pages with Postgres full-text search, and
  Claude answers only from them, citing pages. Embeddings (pgvector) can be added if search quality
  needs it, but SOP libraries are small enough that full-text search works well.
- **Checklists link to SOPs**: a checklist item can point at a page, so crews open the procedure
  from the visit.
- Images go to Supabase Storage under the company's folder.

---

## 9. Map measuring

1. The estimator opens **Measure** from a request, quote or property. Google Maps loads satellite
   imagery centered on the property.
2. They draw areas (driveway, lawn, roof plane), lines (curb, edging, gutters) and points (drains,
   trees) with Terra Draw. Totals update live using Turf in the browser.
3. On save, `POST /api/measurements` recomputes everything on the server with the same math
   (`packages/core/src/geo.ts`), so stored totals don't depend on the browser.
4. For roofs, `POST /api/roof-insights` asks Google's Solar API for roof segments and suggests a
   pitch; squares = plan area × pitch factor × (1 + waste) ÷ 100.
5. Quote line quantities use preset formulas, for example asphalt tons =
   `area_sqyd * depth_in * 110 / 2000`, evaluated by a small safe parser (no `eval`).

Keys: a **browser key** restricted to your domain and the Maps JavaScript API, and a **server key**
restricted to the Solar API. Swapping in Mapbox or Esri later only changes the map adapter.

---

## 10. Billing and the accounting boundary

- Crewtavo owns **quotes, invoices, payments and balances**: deposits, progress invoices with
  retainage, partial payments, tips, refunds (as negative payments) and tax on taxable lines.
- **Stripe** collects card and ACH payments through Checkout links on invoices and in the Client
  Hub. A webhook records the payment; the payment trigger updates the invoice balance and status.
- **QuickBooks Online, Zoho Books (and later Xero)** are the books. When an invoice is sent or a
  payment recorded, a trigger adds an outbox row; a task pushes the customer, invoice or payment
  and remembers the external ID in `sync_links`.
- No general ledger, chart of accounts or payroll. Timesheets export to payroll tools.

---

## 11. Integrations, the Apps page, Claude and ChatGPT

| App | How it connects | Status in scaffold |
| --- | --- | --- |
| QuickBooks Online | OAuth 2.0; push customers, invoices, payments | Implemented, untested against a live account |
| Zoho Books | OAuth 2.0 with data-center aware URLs | Implemented, untested |
| Google Calendar | OAuth 2.0 | Calendars on the schedule, visits pushed to a Crewtavo calendar; untested against a live account |
| Zoho Calendar, Outlook, Apple, any ICS link | Calendar link (ICS), stored encrypted | Implemented |
| Stripe | Platform keys (env) | Checkout + webhook |
| Twilio, Resend | Platform keys (env) or per-company keys | Send helpers |
| Anthropic / OpenAI | Platform key, or a company's own key | Claude implemented |
| Xero | OAuth 2.0 | Planned |

**Security model**

- OAuth apps are registered once per deployment (client ID and secret in env). Each company
  connects its own QuickBooks or Zoho account through them.
- The connect flow uses a signed, expiring `state` bound to an httpOnly cookie, so a callback can't
  be replayed or forged.
- Tokens are encrypted with AES-GCM (`ENCRYPTION_KEY`) before they reach Postgres, and stored in a
  table with RLS on and no policies, so only the service key can read them.
- Disconnect revokes the token at the provider when it supports revocation, then deletes it.

**Claude and ChatGPT (MCP)**

- Crewtavo serves an MCP endpoint at `/mcp` (JSON-RPC over HTTPS).
- `/.well-known/oauth-protected-resource` names Supabase Auth as the authorization server.
  Supabase's OAuth 2.1 server (PKCE, optional dynamic client registration) handles sign-in.
- Our app hosts the consent screen at `/oauth/consent`.
- Access tokens are Supabase JWTs, so tools run with that user's permissions and RLS.
- Tools: search clients, get a client, list requests, create a request, today's schedule, add a
  note, search SOPs.
- Users add `https://<your-domain>/mcp` as a custom connector in Claude or ChatGPT.

---

## 12. API design

- `GET /api/config`: public settings for the SPA (Supabase URL and publishable key, maps key,
  enabled features). The SPA needs no build-time environment variables, which keeps deploy buttons
  simple.
- Authenticated routes need `Authorization: Bearer <Supabase access token>` and
  `X-Company-Id: <uuid>`. Middleware verifies the token, checks membership and role, and gives each
  handler a Supabase client acting as that user.
- Errors return `{ "error": "message" }` with a meaningful status.
- Route groups: `me`, `companies` (onboarding, presets, invites), `dashboard`, `schedule`,
  `requests`, `quotes`, `jobs`, `invoices`, `measurements`, `kb`, `ai`, `apps`, `hub` (signed client
  links), `public` (booking forms), `webhooks`, `cron`, plus `/mcp`.

---

## 13. Background work

| Task | Schedule | What it does |
| --- | --- | --- |
| `automations` | Every minute (and right after any change in the app) | Claims due `automation_runs`, re-checks conditions against fresh data, performs the actions |
| `campaigns` | Every minute | Sends scheduled and in-progress campaigns in batches |
| `outbox` | Every 5 minutes | Pushes queued accounting changes; exponential backoff, gives up after 8 tries |
| `followups` | Hourly | Marks invoices overdue (by each company's local date) and emits visit reminders for automations |
| `weather` | Every 6 hours | Flags visits whose weather rules fail tomorrow |
| `recurrence` | Daily | Generates visits for recurring jobs 60 days ahead |

On Cloudflare these run from Cron Triggers in the same Worker. On Vercel they're Vercel Cron
requests to `/api/cron/<task>` with `CRON_SECRET`. The Vercel Hobby plan only allows daily crons,
so small installs there can use Supabase Cron (`pg_cron` + `pg_net`) to call the same URLs.

---

## 14. Frontend and mobile web

- The existing React app moves to `apps/web` and keeps its design tokens and shell.
- Sign-in, onboarding (company name plus trade preset) and the OAuth consent page are new.
- Under 900px: bottom tab bar, a More sheet, stacked tables, touch-friendly drawing tools. The map
  and drawing code loads only when Measure opens.
- The Client Hub (`/hub/:token`) and booking forms (`/book/:company/:form`) work without an account.

---

## 15. Deployment

**What a business needs:** a Supabase project, plus Cloudflare or Vercel. Free tiers work for
trying it; a real business should expect roughly Supabase Pro ($25/month) plus Cloudflare Workers
Paid ($5/month) or Vercel Pro.

**One-click options**

1. **Deploy with Vercel.** The button clones the repo, and the Supabase integration creates a
   project and fills in its environment variables. The build applies migrations when it has a
   database URL.
2. **Deploy to Cloudflare.** The button clones the repo into the user's account and deploys it with
   Workers Builds. The user pastes their Supabase URL and keys as secrets.
3. **Self-host.** The API runs on Node (`@hono/node-server`), and Supabase can be self-hosted with
   Docker. This is documented but not one-click.
4. **Hosted version.** We run one deployment with many companies. RLS already isolates them; add
   Stripe billing and Stripe Connect for payouts.

**Migrations** are plain SQL in `supabase/migrations`, applied by the Supabase CLI or
`scripts/migrate.mjs`. The script records them in the same table the CLI uses, so the two are
interchangeable.

- **Railway and Docker:** one container (`Dockerfile`, entry `apps/api/src/server.ts`) serves the web app and API
  and runs the background tasks on an internal once-a-minute scheduler, because Railway cron jobs must exit and
  can't run more often than every 5 minutes. Migrations apply before start (`scripts/migrate.mjs`, or Railway's
  pre-deploy command in `.railway/railway.ts`). Railway's old `railway.json` format is retired on 2026-12-01, so
  the repo uses Infrastructure as Code instead.

---

## 16. Security and privacy

- RLS on every table, composite foreign keys, and SQL tests that prove one company can't read
  another's rows.
- Third-party tokens encrypted at rest; secrets only in platform environment variables.
- Client Hub links are HMAC-signed and expire. They expose only client-facing fields, never costs.
- Public booking forms use Cloudflare Turnstile when configured, plus service-area checks.
- Webhooks verify signatures (Stripe) before doing anything.
- Gate codes are readable only by the office and the crew assigned that day.
- Supabase Auth handles passwords, magic links and optional MFA; we never see passwords.

---

## 17. Delivery phases

**Where things stand (October 16, 2026):**
- Phases 0–3 are built and verified against a local Supabase.
- From phase 4, the QuickBooks and Zoho sync code is written but untested against live accounts.
- Phase 5 is done: the pipeline board, reports (with a revenue goal), route ordering, the message center with
  two-way texting, custom automation rules, marketing campaigns, review requests and referrals.
- Xero and live-account testing of QuickBooks and Zoho remain.

| Phase | Scope | Done when |
| --- | --- | --- |
| 0. Foundation | Monorepo, schema + RLS, auth, onboarding with presets, deploy to both platforms | A new company can sign up on a fresh deploy |
| 1. Core loop | Clients, properties, requests, quotes (with measuring), jobs, visits, schedule board, invoices, Stripe payments | A paving and a lawn company can run a week in it |
| 2. Field | Phone layout for crews, checklists, photos, time tracking, on-my-way texts | Crews stop using paper |
| 3. Knowledge and AI | SOP editor, acknowledgements, Ask, AI quote drafting and rewriting, MCP connector | Claude can read the schedule; SOPs replace binders |
| 4. Accounting | QuickBooks and Zoho sync, Xero, reconciliation views | Books match without re-typing |
| 5. Growth | Pipeline board, automations, reports, marketing (reviews, referrals, campaigns), route optimization | Feature checklist in section 19 complete |

---

## 18. Testing

- `packages/core`: Vitest unit tests (geometry, formulas, recurrence, time zones).
- Database: `scripts/test-db.sh` starts Postgres in Docker, applies stubs for Supabase's `auth` and
  `storage` schemas, runs every migration, then runs `supabase/tests/*.sql`: RLS isolation, totals,
  numbering, SOP revisions, activity events and the automation queue, deposit/progress/per-visit billing and
  final-invoice credits, overdue marking, campaign guards and audiences, referrals, notification and pay-rate
  privacy, file deletion rules, search, and custom roles (levels, switched-off areas, who can manage roles).
- API: Vitest for encryption, signed links (per kind, preview flag), Stripe and Twilio signatures, route guards
  (cron, sign-in, webhooks), email rendering and MCP discovery. Handler tests against a local Supabase are next.
- Web: Vitest for report date ranges and bucketing (time zones) and CSV export.
- CI runs typecheck, tests, the database tests, the web build, a Cloudflare dry-run deploy and the Vercel build.

---

## 19. Checklists for the parts we own

Used as checklists, not dependencies:

- **Billing**: invoice and payment modelling (partial payments, credit notes as negative
  amounts, retainage, payment terms), numbering series, audit trail via `updated_at` and activity,
  role permissions by document type, and timesheets with billing rates.
- **SOPs**: page revisions with restore, page templates, tag-based filtering, a clean reading
  layout, image handling, and search weighting titles above body text.
- **Jobber**: the request to quote to job to invoice workflow, Client Hub actions (approve, pay,
  request work), visits versus jobs, and automated follow-ups. Feature parity tracking uses the
  feature list from the original brief.

---

## 20. Licensing

Decided: the [Crewtavo License](../LICENSE), modeled on Open WebUI's. It is BSD 3-Clause plus:

- **Branding clause.** The Crewtavo name, logo and "Powered by Crewtavo" stay, unless 50 or fewer
  people sign in during any rolling 30 days, the copyright holder gives written permission, or the
  licensee has a commercial license. A business's own name, logo and colors are always allowed.
- **Contributions** come with the right to relicense them, so commercial licenses stay possible.
- **No responsibility for data or use.** Each business runs its own deployment, so it alone is
  responsible for its data, backups, figures, messages, connected services and legal compliance,
  and indemnifies the copyright holder and contributors.
- **Agreed in the app.** Setting up a business requires agreeing to the license
  (`POST /companies` with `terms_version`). Each agreement is a row in `terms_acceptances` (who,
  role, version, when) that nobody can edit. Owners and admins of a business that hasn't agreed to
  `TERMS_VERSION` see a one-time "Before you continue" screen. Settings → License shows the text
  and the history.

No dependency (nothing GPL) constrains this choice.

---

## 21. Risks and open questions

- **Scope.** Billing edge cases and reports are where custom builds slip. Keep accounting in
  QuickBooks, Xero or Zoho, and hold to the phase list.
- **Supabase OAuth server is new.** Its MCP compatibility with every client needs testing. The
  fallback is an OAuth provider in the API (for example Cloudflare's `workers-oauth-provider`).
- **Serverless limits.** Long AI calls should stream. Heavy PDF generation may need a queue or an
  external service.
- **Offline use for crews.** Out of scope for phase 2. A service worker with a local queue is the
  likely path later.
- **Timezones.** All times are stored in UTC and shown in the company's zone; recurrence works on
  local dates.
