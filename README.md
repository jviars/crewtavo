<!-- GitLab ignores <source> and shows the <img>, so that one is on a white tile to read on its light and dark themes -->
<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/crewtavo-logo-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="docs/brand/crewtavo-logo.png">
    <img src="docs/brand/crewtavo-logo-tile.png" alt="Crewtavo" width="300">
  </picture>
</p>

<p align="center">
  <strong>Free, open-source field service software for service businesses.</strong><br>
  Requests, quotes, scheduling, crews in the field, invoicing and a client portal, in one app you own.
</p>

<p align="center">
  <a href="https://railway.com/deploy/crewtavo?referralCode=pQ_v0d"><img src="https://railway.com/button.svg" alt="Deploy on Railway" height="40"></a>
</p>

<p align="center">
  <a href="https://crewtavo.com">Website</a> ·
  <a href="https://crewtavo.com/docs/">Docs</a> ·
  <a href="#deploy-on-railway">Deploy on Railway</a> ·
  <a href="#self-host">Self-host</a> ·
  <a href="#whats-inside">What's inside</a> ·
  <a href="#develop">Develop</a> ·
  <a href="docs/deploy.md">Full deployment guide</a>
</p>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/dashboard-dark.png">
  <img src="docs/images/dashboard.png" alt="Crewtavo's home screen: today's workflow from requests to invoices, today's visits, and money collected this month">
</picture>

Crewtavo is for lawn care, paving, roofing, cleaning, HVAC and any trade that quotes work, schedules
crews, works at a property and gets paid. It does what Jobber does, plus an SOP knowledge base,
equipment maintenance, satellite map measuring, plan sets on jobs (lined up on the map to measure
from), and connections to QuickBooks, Zoho, Claude and ChatGPT.

Every business runs **its own instance**: the app, its own database and its own files, in an
account the business owns. Nobody else holds its data, and there's no per-seat subscription.

The website, [crewtavo.com](https://crewtavo.com), has a 24-second tour, comparisons with
[Jobber](https://crewtavo.com/jobber-alternative/) and other apps, and the [docs](https://crewtavo.com/docs/)
for business owners.

## Deploy on Railway

The quickest way to run Crewtavo, and the one that suits a business without a developer.

1. Press **Deploy on Railway** above. Sign in to Railway, or create an account. Railway's free
   trial is enough to try Crewtavo.
2. Press **Deploy**. Railway creates your instance: the Crewtavo app, a Postgres database, and the
   services behind sign-in, data and file storage. Every password and key is generated for you, so
   there's nothing to fill in.
3. After a few minutes, open the address shown on the **crewtavo** service, create the owner account
   and set up your business. Then invite your team from **Settings → People**.

If something isn't ready yet, that address shows a **Finish setting up** page saying what to do,
instead of an error.

> [!NOTE]
> **Cost.** The business pays Railway directly. A new instance at rest uses about 0.36 GB of
> memory across its five services, roughly $3.60 a month of Railway usage. That fits Railway's
> free trial (30 days, $5 of credit) for trying Crewtavo out, and Railway's Hobby plan ($5 a month,
> including $5 of usage) to keep it running. Busy instances use more; check
> [Railway's pricing](https://railway.com/pricing) for current numbers.

**Your own domain:** when you first sign in, Crewtavo asks to connect to Railway (you're still
signed in there, so it's one press of **Authorize**), which is how it warns you before Railway's
trial runs out. Right after you set up the business, it offers to set up your web address:
- **Need a domain?** Buy one on Railway. Railway sets it up, Crewtavo spots it and switches over,
  and there's nothing to add.
- **Have one already** (like `app.yourbusiness.com`)? Crewtavo adds it in Railway and shows the two
  DNS records to add where your domain is managed. On Cloudflare, it can add them for you. It
  checks the records as they go in and switches over by itself once the new address works.

Links already sent keep working, and the old address forwards to the new one. Skip it, and
**Settings → Web address** does the same later, including the steps by hand.

**Email:** Railway blocks outgoing mail servers (SMTP) on its trial and Hobby plans, so Crewtavo
sends email through [Resend](https://resend.com), which works on every plan: create a free Resend
account and paste its API key under **Settings → Email**. On Railway's Pro plan, or when you
self-host, you can instead connect the business's own mailbox there (Gmail, Google Workspace,
Microsoft 365, Zoho, Yahoo, iCloud or any SMTP server). `RESEND_API_KEY` and `EMAIL_FROM` on the
**crewtavo** service still work too, for any business that hasn't connected its own.

**Backups:** Crewtavo backs up its database every night, on every Railway plan, and keeps the last
week's and month's. They're kept in the same Railway project, so download one from **Settings →
Your data** now and then and keep it somewhere else. Photos and files aren't in a backup.
[Restoring one](docs/deploy.md#restoring-a-backup) into a new instance is a few steps.

> [!IMPORTANT]
> Save `JWT_SECRET` (and `ENCRYPTION_KEY`, if you set one) and `POSTGRES_PASSWORD` somewhere
> outside Railway, such as a password manager. Without `JWT_SECRET`, a restored Crewtavo can't read
> its connected apps, the owner's key file stops working, and links already sent to clients stop
> opening; without `POSTGRES_PASSWORD`, the services can't sign in to a database volume you kept.
> In Railway they're under **Variables**: `JWT_SECRET` and `ENCRYPTION_KEY` on the **crewtavo**
> service, `POSTGRES_PASSWORD` on **db**.

## Self-host

Crewtavo runs anywhere Docker does: your laptop, an office server or a VPS. It's the same five
services the Railway template creates, described in [`docker-compose.yml`](docker-compose.yml).

You need [Docker](https://docs.docker.com/get-docker/) and [Node.js](https://nodejs.org) 20 or newer
(only to generate the secrets and start Docker; nothing to install).

```bash
git clone https://github.com/jviars/crewtavo.git
cd crewtavo
npm run instance
```

The first run writes `.env.instance` with fresh secrets, builds Crewtavo, starts everything and
prints the address: **http://localhost:8080**. Open it and create the owner account.

> [!IMPORTANT]
> Keep `.env.instance`, and save a copy somewhere off this computer. It holds `JWT_SECRET` and
> `POSTGRES_PASSWORD` (and `ENCRYPTION_KEY`, if you set one). Without `JWT_SECRET`, a restored
> Crewtavo can't read its connected apps, the owner's key file stops working, and links already
> sent to clients stop opening; without `POSTGRES_PASSWORD`, the services can't sign in to the
> database volume.

```bash
npm run instance -- logs                           # follow what's happening
npm run instance -- stop                           # stop it; the data stays in Docker volumes
npm run instance                                   # start again, or update after a git pull
docker compose --env-file .env.instance down -v    # delete the instance and all its data
```

<details>
<summary><strong>On a server with your own domain</strong></summary>

**Settings → Web address** walks you through these steps with your domain filled in, and checks each one.

1. Point a DNS record for your domain (say `ops.example.com`) at the server.
2. In `.env.instance`, set `APP_URL=https://ops.example.com`, then run `npm run instance` again.
3. Put a web server with HTTPS in front of port 8080, on the same server. With [Caddy](https://caddyserver.com), this
   whole `Caddyfile` gets a certificate and forwards everything (Caddy passes on each visitor's
   address in `X-Forwarded-For`, which Crewtavo's rate limits go by; see
   [docs/deploy.md](docs/deploy.md#visitors-addresses) for other web servers):

   ```
   ops.example.com {
     reverse_proxy localhost:8080
   }
   ```

Only the `crewtavo` container is published, and only on the server itself (port `CREWTAVO_PORT`,
default 8080, on `CREWTAVO_BIND`, default `127.0.0.1`), so visitors come in through the web server.
It forwards sign-in, data and files to the other containers over Docker's private network.

**Backups:** Crewtavo backs up its database every night; download one from **Settings → Your data**
now and then and keep it on another computer
([restoring one](docs/deploy.md#restoring-a-backup) is `npm run instance -- restore <file>`). The
data itself lives in two Docker volumes, `crewtavo-instance_db-data` (the database) and
`crewtavo-instance_storage-data` (photos and documents). Back up both for the photos too, along
with `.env.instance`.

</details>

<details>
<summary><strong>On Railway, without the template</strong></summary>

[`.railway/railway.ts`](.railway/railway.ts) describes the same instance as Railway Infrastructure
as Code. In an empty Railway project:

```bash
cd .railway && npm install
railway link
railway config apply
```

Then set the two secrets it marks `preserve()` in the dashboard and generate a domain for the
`crewtavo` service. [`deploy/README.md`](deploy/README.md) covers the template itself.

</details>

Optional features (texting, online payments, maps, AI, accounting) each take a key or two. Add them
to the **crewtavo** service's variables on Railway, or to `.env.instance` when self-hosting. See
[Configuration](#configuration).

## What's inside

<table>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/images/schedule.png" alt="The schedule's week view with visits colored by crew">
      <p><strong>Schedule.</strong> Day and week time grids with a lane per crew, a month view,
      drag to move or resize, double-booking warnings, rain-day shifts and route order. The board
      keeps itself up to date as others make changes, and everyone can add their schedule to
      Google, Apple or Outlook Calendar. Calendars from Google, Zoho, Outlook, iCloud or any ICS
      link (or an uploaded calendar file) show alongside the visits, and Find a time steers around
      them.</p>
    </td>
    <td width="50%" valign="top">
      <img src="docs/images/quote.png" alt="A quote with line items from the price list and an optional add-on">
      <p><strong>Quotes.</strong> Line items from your price list, formulas and satellite map
      measurements, optional add-ons, deposits, payment schedules and promo codes. Clients approve
      and sign online. Draft a quote fills one in from a request (with AI if you switch it on, else
      from your price list), you can hear about big quotes as they're sent, approved or sent
      back, and your Google rating and best reviews can show on the quote.</p>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/images/pipeline.png" alt="The sales board from new requests to approved quotes">
      <p><strong>Sales board.</strong> Every request and quote from first call to approval, with
      what's open, won and lost.</p>
    </td>
    <td width="50%" valign="top">
      <img src="docs/images/finance.png" alt="Finance: money collected against the previous period, the revenue goal, and payments, net volume and unpaid invoices">
      <p><strong>Finance.</strong> Collected, net and invoiced against the previous period, every
      payment, unpaid invoices by age, top clients and a yearly revenue goal, plus sales, work, team
      and client reports. Everything exports to CSV.</p>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/images/equipment.png" alt="Equipment with meter readings and maintenance due">
      <p><strong>Equipment.</strong> Trucks, trailers and machines with hour meters and odometers,
      maintenance schedules by date, hours or miles, service history and costs.</p>
    </td>
    <td width="50%" valign="top">
      <img src="docs/images/knowledge-base.png" alt="The knowledge base of standard operating procedures">
      <p><strong>Knowledge base.</strong> Your SOPs, with an editor, revision history and required
      reading for the crew. A guide can be shared by link with people outside the team: only the
      people you add, who prove their email address with a code, or anyone with the link.</p>
    </td>
  </tr>
</table>

<table>
  <tr>
    <td width="33%" valign="top" align="center">
      <img src="docs/images/field.png" alt="My day on a phone: the crew clock and today's visit" width="250">
    </td>
    <td width="33%" valign="top" align="center">
      <img src="docs/images/client-hub.png" alt="The Client Hub on a phone: a quote the client can approve" width="250">
    </td>
    <td width="34%" valign="top">
      <p><strong>In the field.</strong> <em>My day</em> on any phone: on my way, start and finish,
      gate codes, checklists with signatures, photos (draw arrows, circles and notes on them, and
      the original is kept), materials used and a crew clock. The clock
      runs for visits only, or for the whole day with the driving between visits on it: your
      choice. Turn it on and the phone reminds the crew to start and finish a visit as they get to
      the property and leave, or starts their clock there itself and moves it to driving as they
      leave, while Crewtavo is open on the phone. It never takes anyone off the clock by itself: on
      the visits-only clock it asks first. It installs like an app on Android and iPhone, keeps working with no signal and
      catches up when the connection is back.</p>
      <p><strong>For your clients.</strong> The Client Hub, with no account to create: approve
      quotes, pay invoices (with an optional tip), see the next visit, ask for changes, request
      work and message the office. A booking form on your website, or its link, lets people pick a
      time from the openings your schedule really has.</p>
    </td>
  </tr>
</table>

<details>
<summary><strong>More screenshots</strong></summary>

<table>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/images/measure.png" alt="Measure: a parking lot outlined on the aerial with stall rows, ADA stalls and crack seal, and the takeoff's totals">
      <p><strong>Measure.</strong> A paving takeoff drawn on the aerial.</p>
    </td>
    <td width="50%" valign="top">
      <img src="docs/images/paving.png" alt="A paving project: the takeoff sheet, its quantities and the steps from takeoff to invoice">
      <p><strong>Paving.</strong> The takeoff priced into a proposal.</p>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/images/jobs.png" alt="Jobs: active, upcoming and unscheduled jobs with their next visit and value">
      <p><strong>Jobs.</strong> Every job and where it stands.</p>
    </td>
    <td width="50%" valign="top">
      <img src="docs/images/job.png" alt="A job: its visits, line items and job costing">
      <p><strong>A job.</strong> Visits, line items and job costing.</p>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/images/client.png" alt="A client: properties, quotes, jobs, invoices, balance and marketing preferences">
      <p><strong>A client.</strong> Properties, work, balance and contacts.</p>
    </td>
    <td width="50%" valign="top">
      <img src="docs/images/invoices.png" alt="Invoices: awaiting payment, past due and collected, with the open invoices">
      <p><strong>Invoices.</strong> What's owed, past due and collected.</p>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/images/invoice.png" alt="A partly paid invoice with its payment and the printed copy">
      <p><strong>An invoice.</strong> Payments and the printed copy.</p>
    </td>
    <td width="50%" valign="top">
      <img src="docs/images/timesheets.png" alt="Timesheets: each person's hours for the week, approved and pending">
      <p><strong>Timesheets.</strong> The crew's hours, approved for pay.</p>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/images/marketing.png" alt="Marketing: emails sent, review requests and referrals, automated campaigns and a sent campaign">
      <p><strong>Marketing.</strong> Campaigns, review asks and referrals.</p>
    </td>
    <td width="50%" valign="top">
      <img src="docs/images/automations.png" alt="Automations: rules that notify the office and follow up with clients">
      <p><strong>Automations.</strong> Rules that follow up by themselves.</p>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/images/apps.png" alt="Apps: what's built in, and the marketing, calendar and AI apps to connect">
      <p><strong>Apps.</strong> Built-in apps and connections.</p>
    </td>
    <td width="50%" valign="top">
      <img src="docs/images/dashboard-dark.png" alt="Crewtavo's home screen in dark mode">
      <p><strong>Dark mode.</strong> Home after dark.</p>
    </td>
  </tr>
</table>

<table>
  <tr>
    <td width="50%" valign="top" align="center">
      <img src="docs/images/field-visit.png" alt="A visit on a phone: call, text and directions, and the work to do" width="250">
      <p><strong>A visit</strong> on the crew's phone.</p>
    </td>
    <td width="50%" valign="top" align="center">
      <img src="docs/images/dashboard-phone.png" alt="Home on a phone: the day's workflow" width="250">
      <p><strong>Home</strong> on the owner's phone.</p>
    </td>
  </tr>
</table>

</details>

**And also:**

- **Quotes:** a quote can carry a payment schedule: payments, each a percent of the total, an
  amount or the rest, due when the client approves (the deposit), on a date or so many days after
  they approve, when the work starts, when it's done or when you invoice it. The payments have to
  come to the total; the client sees them in the Client Hub and on the PDF, and approving keeps them
  as signed. Templates and copies carry the schedule with each dated payment's day to set again, and
  a quote can't be sent while a payment's day is unset or already past. Draft a quote, on a request, fills in a draft: with
  Claude switched on (Settings → Company; it checks your key first), Claude reads the request and
  your price list and picks lines only from it, at your prices, with quantities when the client gave
  them (the others are 1, flagged to check); without it, the price list items whose names match the
  client's choices. A request from a booking form or the Client Hub can get its draft by itself: the request
  stays as it came in, with a note that a draft is ready, until you send that quote, and when
  nothing on the price list matches no quote is made.
  "Tell me about quotes over" an amount tells owners, admins and the quote's salesperson on the bell
  and their phone when one is sent, approved or sent back for changes. "Show reviews on quotes"
  (Marketing → Reviews) puts your Google rating and up to three reviews you pick (or your newest
  5-star ones) on the quote in the Client Hub, and on its PDF if you tick it, as they are on Google:
  the reviewer's name and words, with a link to your profile on Google Maps. Reviews show only
  while Google Business Profile is syncing: a copy the sync hasn't seen on Google for 30 days is
  removed.
- **Jobs and invoicing:** one-off and recurring jobs, multi-day work, change orders the client
  approves, batch invoicing, payment reminders, deposits, progress billing and retainage. A quote's
  payment schedule carries to its job: each payment becomes a draft invoice when its date comes
  (where you are), when the work starts, or when you press Invoice now, once each, and the office is
  told it's ready to send, or it's sent by itself if you turn that on. Each invoice is for the amount
  the client signed, tax included; the last payment to be invoiced is the job's final invoice, which
  takes off the others and carries the tax, so together they come to the quote's total and nothing
  more needs invoicing. The job shows each payment and where it is. A one-off
  job moves to Requires invoicing when its last visit is finished, and the office is told. Extra
  work on one visit of a recurring job (mulch, an aeration, a storm cleanup) is added to that visit
  by the office or by the crew on site, and billed once with it, without changing the job's price.
  Change prices on the Jobs page raises or lowers many recurring jobs at once, with a preview of
  every line first and an undo. A quote's deposit is invoiced as the client approves it, whether or
  not you take payments online. An invoice can still be edited after it's sent, payments and all,
  and a late fee can be taken off or turned off for one invoice. Invoices go through Stripe for
  card and bank payments; invoices made in Stripe come in too, with the fees and bank deposits
  behind every payment. Refunds (by hand or through Stripe, taken off the invoice or left owing),
  write-offs for invoices that won't be paid, expenses and job costing, timesheets and pay. A job
  costs the same everywhere: on its page, in Finance and to an AI assistant. Set a margin (Settings
  → Company → Job costing) and the people who see job costs are told when a one-off job's profit
  falls below it, once, and the job's page warns while it stays there; after you change the margin,
  the jobs already below it are listed under Below your margin on the Jobs page. Turn on reading
  receipts (Settings → Company → Receipts, with your own Claude or OpenAI key) and a receipt photo or a
  supplier's invoice fills in the expense for you to check, with its tax and lines, suggests the job
  it names and the job's materials its lines match (to log as materials used in the same save), and
  the office can drop a stack at once to check and save one by one. A supplier's invoice logged that
  way counts once: what's logged against the job's estimate through its line items, the rest
  (delivery, anything not on the estimate) as an expense, and a material the crew already logged
  isn't logged twice. A receipt that looks to be in already (the same invoice number, or the same
  vendor, day and total) is asked about before it's saved again, and expenses saved without a job
  are listed on Finance → Profit. Request, quote, job and invoice
  numbers can carry on from the system you're moving from (Settings → Company).
- **Online booking:** request, estimate and booking forms to link to or embed in your website,
  with your own questions, a service area by ZIP or postal code, file and photo uploads and promo
  codes. Turn on "Let clients pick a time" for an estimate or booking form (Settings → Online
  booking) and people choose a day and a time from real openings: your working days and hours,
  around the visits and busy calendar times of the crew the form books (or, with no crew, the
  whole schedule, so nobody is double-booked), after the lead time you set, up to the most a day
  you set, for the next 60 days, in your time zone. A form either books at once (the visit goes on
  the schedule at a fixed time, and two people can't take the same opening) or holds the time for
  your OK, which is one press on the request. The client is told on the page, by email and by text,
  gets a file for their calendar, and can ask to move or cancel the visit from their Client Hub. One
  person holds one upcoming booking a form. Forms that were there before stay plain request forms
  until you turn times on.
- **Plans and files:** plan sets, specs, permits and addenda on requests, quotes, jobs and
  properties, up to 200 MB each. New versions replace old ones (with the history kept), the crew
  sees only current sheets on their phones, and clients can attach plans to a booking request. A
  site plan can go on the measuring map, lined up with the aerial by tapping two spots, to measure
  new paving from it.
- **People and roles:** General manager, Office manager, Operations manager, Foreman and Employee
  to start with, renamable, plus your own. A foreman runs their crew and never sees prices. A
  Subcontractor sign-in sees only their own jobs, their price on each and their paperwork. The
  database enforces every rule, not just the screens.
- **Subcontractors:** a record for each sub, whether or not they sign in, with their W-9,
  insurance certificates and licenses, expiry reminders, and upload links for subs without an
  account. Job offers they accept or decline in the field app (a lapsed certificate warns, and the
  offer records it), what's owed and paid, 1099-NEC totals by year, and a workers' comp audit
  report. Subs sign in with a link or a code by text or email, no password.
- **Communication:** email from your own mailbox, two-way texting through your own Twilio account
  (connected on the Apps page, no server settings), a message center, and notifications in the app,
  by email, by text or as phone push, each person's choice. Clients are told when a visit is
  booked, moved or cancelled, reminded the day before (again for the new day when a visit moves
  after its reminder went) and texted when the crew is on the way; each message is a switch in
  Settings → Client notifications. A booking, move or cancelling goes ten minutes after the
  change, so a visit dragged twice is one message and one put back is none, and a route being
  re-ordered or a recurring job's whole schedule changing messages nobody. (A business that was
  running before these three messages existed has them off until it turns them on.) A client's
  other contacts (a spouse, a property manager) can be ticked to get what the client gets about
  their visits, quotes, invoices and receipts too, a
  quote or invoice can go to several people at once, and a text from a number nobody knows is kept
  in Messages to add to a client.
- **Automations and marketing:** rules like "when a quote is sent, wait 3 days, then email the
  client" or "when a visit is moved, text the client", campaigns, promo codes, Google review
  requests and referrals. A campaign can be a postcard: a job photo (or any picture) on the front,
  a note with the campaign merge fields on the back, previewed at its real size, printed and mailed
  by Lob through the business's own Lob account (Apps → Lob; a test key makes the cards without
  mailing anything) to the clients in the segment with a full mailing address, never archived or
  opted-out ones, with what each card brought in. A finished job or visit becomes a showcase:
  before and after photos (their drawn-on copies, if any) and a few lines about the work (written
  by hand or with AI), on a page in the business's logo and colour with Get a quote to its
  booking form. It never shows the client's name or address (the town only if chosen), asks before
  showing photos nobody marked OK to share, and can't show a client's who asked that their property
  not be posted. Copy its link, post it to Facebook or Instagram, or unpublish it. Marketing →
  Reviews shows how the business compares with up to five nearby competitors on Google (rating
  and number of reviews), found by name or suggested from its trade and town. The figures are
  read from Google in the browser when someone presses Compare now and shown as they are at that
  moment; Crewtavo keeps only each place's Google ID, as Google's terms require, so there's no
  history of them. It's off until an owner or admin turns it on with a Google key that has Places.
- **Crewtavo's own AI, on your key or plan:** the drafts, rewrites, answers from your guides and
  receipt reading run on Claude or OpenAI, whichever you set up under Apps: your own Anthropic key,
  your own OpenAI key (checked with OpenAI before it's saved, with the model picked from the ones
  OpenAI lists for it), or the server's Claude key. With both keys you choose which one is used.
  Each person can also Continue with ChatGPT (Apps → ChatGPT, or Settings → AI assistants once an
  owner or admin lets the team) so their own ChatGPT Plus or Pro plan pays for what they ask
  themselves; everyone else's asks, anything Crewtavo drafts by itself and whatever the plan can't
  take stay on the company's key.
- **Claude and ChatGPT:** a built-in connector, added in Settings → AI assistants, that can look things up or run the business:
  import customers and recurring services (with a preview first, and no duplicates on a second
  run), manage the schedule, quotes, invoices and payments, read the money figures, invite people
  and change roles, approve time and mark people paid. Each person signs in with their own account;
  an assistant only reads until that person chooses what it can change, or gives it full access,
  with or without money (and it never does more than their role allows). Every call is logged.
- **Pay:** Timesheets → Pay sums each person's approved hours at their rate for a week or any
  dates, adds their piece pay (per square, per job or per day, from their rate card), flags
  overtime and unapproved time, downloads for your payroll service, and records who's been paid and
  how. Paid time is locked, and hours are paid once: where periods overlap, a later one owes only
  what the earlier didn't pay. Finishing a visit clocks out everyone still on its clock. On the
  whole-day clock (Settings → Company → Time clock; new businesses start on it) they go on to
  Driving instead, from On my way until Stop for the day: travel is paid time, on no job's costs.
  Subs are paid by the job instead, under Subcontractors. A receipt someone paid with their own
  money is marked to reimburse; with reading on, the one they add from a visit fills itself in for
  them to check. Crewtavo doesn't move the money.
- **Every trade:** trade presets ([`packages/core/src/presets`](packages/core/src/presets)) load
  starter services, quote formulas, checklists, weather rules, booking forms, custom fields and SOP
  categories when a company signs up (a trade's estimate or booking form starts with its visit
  length, lead time and most a day set, and offers times from the first day): plumbing, HVAC, electrical, cleaning, pool and spa, pest
  control, handyman, landscaping, lawn and exterior maintenance, paving and sitework, roofing and
  exteriors, or a general starting point for any other trade. A paving job priced with the paving
  calculator gets the same weather holds and checklists as one priced from the price list, each
  line that works from a depth gets its own (6 inches of stone under 2 of asphalt), and job
  costing counts crew days and load tickets once, against what was estimated. A roofer keeps an
  insurance claim's details on quotes and jobs, and can type in a roof report's measurements
  (EagleView, Hover) instead of tracing the roof.

## How it fits together

```
One instance per business: a Railway project, or docker compose on your own machine

Browser: React app (desktop and phone layouts, works offline in the field)
  └──► crewtavo  (the only public service: apps/api/src/server.ts)
         ├── the web app, and /api/* (Hono), acting as the signed-in user
         │     ├── QuickBooks Online, Zoho Books, Google Calendar (OAuth, tokens encrypted)
         │     ├── other calendars' ICS links (Zoho, Outlook, iCloud...), read every 15 minutes
         │     ├── Stripe, the company's mailbox or Resend, Twilio, Google Maps, Open-Meteo, Claude
         │     └── /mcp ◄── Claude and ChatGPT (OAuth through the instance's own sign-in)
         ├── background tasks: automations, reminders, recurring visits, weather holds
         ├── database migrations, applied on every start
         └── forwards to the instance's own services over the private network:
               /auth/v1     → auth      (Supabase Auth: sign-in, invitations, password resets)
               /rest/v1     → rest      (PostgREST, with row-level security)
               /storage/v1  → storage   (photos, receipts and documents)
                                all backed by db (Postgres)
```

The `crewtavo` service derives every service key from one shared secret and sets up the database
itself, so a new instance needs nothing copied by hand.

## Configuration

Everything an instance needs is generated. These optional settings turn on extra features.
[`.env.example`](.env.example) lists them all.

<details>
<summary><strong>Optional settings</strong></summary>

| Name | Turns on |
| --- | --- |
| `APP_URL` | Your own domain. **Settings → Web address** sets it on Railway. Defaults to the instance's address. |
| `ENCRYPTION_KEY` | A separate key for app tokens and client links (32+ characters). Keep it stable once set: changing it disconnects every app and invalidates links already sent. |
| `ANTHROPIC_API_KEY`, `AI_MODEL` | AI rewriting and answers from your SOPs, with Claude. Companies can also add their own Claude or OpenAI key on the Apps page. |
| `OPENAI_MODEL` | The OpenAI model used with a company's own OpenAI key or a person's ChatGPT plan, instead of the one picked on Apps → ChatGPT. There is no server-wide OpenAI key. |
| `GOOGLE_MAPS_BROWSER_KEY`, `GOOGLE_MAPS_SERVER_KEY` | Optional: Google satellite on the measuring map (Map Tiles API), and roof pitch suggestions (Solar API). Measuring needs no key: it uses free US and state imagery. |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | A Stripe account shared by every company on the server. Usually not needed: each business connects its own Stripe on the Apps page. |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` | A Twilio account shared by every company on the server. Usually not needed: each business connects its own Twilio account on the Apps page. |
| `RESEND_API_KEY`, `EMAIL_FROM` | Email through Resend. Needed on Railway's trial and Hobby plans, which block SMTP; elsewhere, a default sender until the business connects its own mailbox. |
| `QUICKBOOKS_CLIENT_ID`, `QUICKBOOKS_CLIENT_SECRET` | An Intuit app for QuickBooks Online sync. Usually not needed: each business pastes its own Intuit app's keys on the Apps page. |
| `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_ACCOUNTS_URL` | A Zoho app for Zoho Books sync. Usually not needed: each business pastes its own Zoho app's keys on the Apps page. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google Calendar sign-in: its calendars on the schedule, and visits on a Google calendar within minutes. Publish the OAuth app (Testing ends sign-ins after 7 days). Calendars added by ICS link (Zoho, Outlook, iCloud, Google's secret address) or uploaded as a file need nothing. |
| `GOOGLE_PICKER_API_KEY` | Import from Google Drive into Crewtavo's Drive, with `GOOGLE_CLIENT_ID`: Google's file picker, which lets Crewtavo read only the files people pick (`drive.file`, which needs no security review). A browser key for the Picker API, restricted to your domain and `https://docs.google.com/*`; the Picker and Drive APIs on, and your address under the client's JavaScript origins. |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | Bot protection on public booking and referral forms. Forms on the business's own website (Website Forms, Careers) have their own bot check, set on each form in Apps. |
| `CREWTAVO_SENTRY_DSN` | Error reports to Sentry or a self-hosted GlitchTip, with personal data removed. |
| `CREWTAVO_SCHEDULER` | Set to `off` on extra replicas so background tasks run in one place. |

[docs/deploy.md](docs/deploy.md) has the details for each one (webhook addresses, the events to
send, how error reports are scrubbed).

</details>

## Develop

You need Node 20+ and Docker. The quick loop runs the API and the web app on your machine against
a local Supabase:

```bash
npm install
npx supabase start               # local Supabase; applies supabase/migrations
cp .dev.vars.example .dev.vars   # paste the URL and keys that `supabase start` printed
npm run dev:api                  # API on :8787, restarting on changes, with the background tasks
npm run dev                      # web app on :5173, proxying /api to :8787
npm run seed:demo                # optional: a demo paving company with a week of work
```

Open http://localhost:5173 and sign in as `demo@crewtavo.test` (password `crewtavo-demo`), or create
your own account. Email goes to Mailpit at http://localhost:56324; set
`MAILPIT_URL=http://localhost:56324` in `.dev.vars` and the app's own emails and texts land there
too. Supabase Studio is at http://localhost:56323.

```bash
npm run typecheck      # every package
npm test               # core, API and web unit tests
npm run test:db        # migrations and row-level security tests in Docker Postgres
npm run test:e2e       # a job from new client to paid invoice, as four different roles
npm run test:browser   # the core flows clicked through in Chromium, with accessibility checks
npm run db:types       # regenerate database types after changing migrations
npm run screenshots    # retake the images in this README
```

`test:e2e` and `test:browser` need the local stack running and `npm run seed:demo` loaded. CI
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs all of them, and also starts a whole
instance with docker compose to check that it comes up ready for its owner.

### Repository layout

| Path | What's there |
| --- | --- |
| [`apps/web`](apps/web) | The React + TypeScript + Vite web app |
| [`apps/api`](apps/api) | The Hono API. `src/server.ts` serves it with the web app, runs background tasks and migrations, and fronts the instance's services (`src/lib/stack.ts`) |
| [`packages/core`](packages/core) | Shared logic: map geometry, quote formulas, recurrence, time zones, roles, trade presets, database types |
| [`supabase`](supabase) | Migrations (schema, row-level security, database functions) and database tests |
| [`deploy`](deploy) | The instance's Postgres image and the [Railway template guide](deploy/README.md) |
| [`e2e`](e2e) | Playwright browser tests |
| [`scripts`](scripts) | Server build, migrations, `npm run instance`, the dev API, seeding, screenshots |
| [`docs`](docs) | The [deployment guide](docs/deploy.md), the [implementation plan](docs/implementation-plan.md), brand files and these screenshots |

## Status

Crewtavo works end to end: a whole instance starts on its own with docker compose, applies every
migration, and goes from owner setup to a working business. The Railway template is new, so
[report anything](https://github.com/jviars/crewtavo/issues) that goes wrong on a first deploy.
QuickBooks and Zoho sync are written but not yet tested against live accounts.

## License

Crewtavo is free and open source under the [GNU Affero General Public License, version 3](LICENSE)
(AGPL-3.0-only), with the additional terms in [NOTICE](NOTICE): no warranty, no responsibility for
your data or for what you do with Crewtavo, and no rights to the Crewtavo name or logo for modified
versions. If you run a modified Crewtavo for other people, the AGPL asks you to offer them its
source code.

Whoever sets up a business in Crewtavo agrees to the [Crewtavo Terms](TERMS) during setup: the
business runs Crewtavo on its own accounts and is responsible for its data and its customers.

Copyright (C) 2026 Joshua Viars. Commercial licenses are available on request.

## Contributing

Crewtavo doesn't accept contributions: pull requests are closed without review. Bug reports are
welcome as [issues](https://github.com/jviars/crewtavo/issues) and questions in
[Discussions](https://github.com/jviars/crewtavo/discussions/categories/q-a), with no promise of
support. See [CONTRIBUTING.md](CONTRIBUTING.md).
