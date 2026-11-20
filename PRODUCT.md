# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

One web app (`apps/web`) that installs like an app on Android and iPhone and keeps working with no
signal. Mobile web, not native.

## Users

Crewtavo is made for **office and field staff equally**, at any size: a one-person operation where
the owner quotes, works and invoices, up to a large company with an office team and many crews.
Neither side is secondary; a screen serves whoever does that job.

- **The office:** owners, general, office and operations managers. Requests, quotes, the schedule,
  invoicing, pay, marketing and reports, mostly at a desk, often on the owner's phone too.
- **The field:** foremen and crew members on a phone at a property: their day, directions, gate
  codes, checklists, photos, materials and the clock. A foreman runs a crew and never sees prices.
- **Subcontractors:** sign in with a link or code, no password, and see only their own jobs, their
  price and their paperwork.
- **The business's clients:** use the Client Hub with no account to approve quotes, pay, see visits,
  request work and message the office; the public reach the business through booking forms on its
  own website.
- **Whoever sets Crewtavo up:** usually a business owner without a developer, deploying on Railway
  or self-hosting with Docker.

## Product Purpose

Free, open-source field service software for trades that quote work, schedule crews, work at a
property and get paid: lawn care, paving, roofing, cleaning, HVAC, snow removal and others.
Requests, quotes, scheduling, crews in the field, invoicing and a client portal in one app the
business owns. Success is a business running its whole operation in Crewtavo, from first call to
paid invoice, on infrastructure it controls.

## Positioning

**You own it.** This claim leads whenever Crewtavo explains why it's different. Every business runs
its own instance: the app, its own database and its own files, in an account the business owns.
Nobody else holds its data, there's no per-seat subscription, and the code is open source
(AGPL-3.0). The maker doesn't host, operate or see any instance.

Supporting claims, in that order of weight: it does what Jobber does, and adds what Jobber lacks (an
SOP knowledge base, equipment maintenance, satellite map measuring, plan sets lined up on the map,
paving takeoffs, roofing packages) plus connections to QuickBooks, Zoho, Claude and ChatGPT.

## Operating Context

- **The office:** a desk browser for long sessions on the schedule, sales board, finance and
  settings; the owner checks Home on a phone between jobs.
- **The field:** a phone in sun, rain or a truck cab, often with poor or no signal; work saves on
  the phone and sends when signal returns. Controls are sized for a thumb, or a glove.
- **Clients:** open a link from a text or email, usually on a phone, once in a while, with no
  account and no training.
- **The lifecycle:** request → quote → job → visits → invoice → payment. Terms the product uses:
  request, quote, job, visit, invoice, Client Hub, My day, the office, the crew, Apps (built-in and
  connected).
- **Setup:** the business pays its host (Railway or its own server) directly and brings its own
  keys for email (Resend or its mailbox), texting (Twilio), payments (Stripe), maps and AI.

## Capabilities and Constraints

- Roles start as General manager, Office manager, Operations manager, Foreman and Employee, renamable,
  plus custom roles and a Subcontractor sign-in. The database enforces every rule, not just the screens.
- Built-in apps can be installed and uninstalled (Marketing, Drive, Team Chat, Careers, trade apps
  such as Paving, Roofing and Snow); uninstalling hides the tab and stops what it sends, deleting
  nothing.
- Light and dark mode both ship.
- Each instance is independent: features that need an outside account (texting, payments, AI,
  Google, Meta) work only once that business connects its own.

## Brand Commitments

- **Name and logo:** "Crewtavo" and its mark (`docs/brand/`: `crewtavo-logo.png`,
  `crewtavo-logo-dark.png`, `crewtavo-logo-tile.png`, `crewtavo-mark.svg`, `crewtavo-mark-512.png`;
  app icons in `apps/web/public/`). The NOTICE file reserves them: modified versions may not use
  them to name or sell themselves.
- **Voice, as shipped** across the README, docs and in-app copy: plain everyday words, short
  sentences, second person, concrete outcomes. It says what happened and what to do next ("Saved on
  this phone. It sends when you have signal."), names what failed and why instead of a generic
  error, and calls people the office, the crew and clients rather than users.

## Evidence on Hand

- Screenshots of the real app with demo data: `docs/images/` (office screens in light and dark,
  phone screens for My day, a visit, Home and the Client Hub).
- Demo data: `npm run seed:demo`; screenshots regenerate with `npm run screenshots`.
- Website crewtavo.com (a 24-second tour, comparisons, owner docs) lives outside this repo.
- **No customer proof.** Never name, quote or cite numbers from businesses running Crewtavo, and
  never invent testimonials, customers, ratings, usage figures or press.

## Product Principles

1. **The business owns everything.** Its data, files and keys stay in its own instance; nothing the
   maker runs ever holds or sees them.
2. **Office and field are equals.** Each gets a surface built for where they actually are: a desk,
   or a phone with poor signal.
3. **Say plainly what happened.** Every outcome, partial failure and next step is stated in the
   business's own terms, never hidden or left to guesswork.
4. **Nothing lost, nothing surprising.** Work survives lost signal, uninstalling deletes nothing,
   and anything that can't be undone or that changes what a client is charged is said first.
5. **Clients need nothing to start.** No account, no app install, no training to approve, pay or book.

## Accessibility & Inclusion

- WCAG 2.1 A and AA, checked with axe-core on each main screen (`e2e/accessibility.spec.ts`).
- Text on the crew's side goes through `t()` and must translate cleanly (`packages/core/src/i18n/es/`).
- Field screens must work outdoors on a phone, with a thumb or a glove, and with no signal.
