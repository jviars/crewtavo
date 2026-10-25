# Subcontractors in the field app: plan

Proposed 24 October 2026. **Built, 25 October 2026:** phases A to E2 below, in
`supabase/migrations/20261025001001_subcontractors.sql` to `20261025008001_wc_audit_work_days.sql`.
What changed while building it is under [What changed while building it](#what-changed-while-building-it);
the rest reads as it was decided.

## The short version

- A sub gets a new access level, **Subcontractor**, in the field app the crew already uses. They
  see My day for the jobs they took, their own price on each, and their paperwork. Nothing else.
- Every other access level starts from "a member of the company" and is narrowed from there. A sub
  starts with nothing and is let in to a short list. Today about 20 tables, every stored file except
  receipts and chat, and every teammate's profile are readable by any member. For a sub, all of
  that closes without touching those rules one by one, and so does anything added later.
- A sub is a record the office keeps whether or not they ever sign in. Paperwork and pay then work
  for the sub who only answers the phone, too.
- One **job pay** table holds a sub's price on a job and an employee's per-square pay. A sub's pay
  is marked paid and added up by year for the 1099. An employee's goes into their pay period.
- Build order: paperwork first (the most value, and no outside logins), then sign-in and pay side
  by side, then offers, then sign-in codes by text, then by email.

## What the code does today

**Access levels are allow-lists, and field crew is whoever isn't listed.** Policies read
`has_role('{owner,admin,office,estimator,crew_lead}') or (is_member and crew_sees_*)`
(`supabase/migrations/20261017001300_field_crew_scope.sql`). A new enum value would land in the
field crew branch automatically. That includes what any member can read:

- `client_contacts` for every client in the company (`20261016000200_operations.sql:540`, never
  narrowed), and the whole `clients` row, email included, for clients behind their visits.
- Stored files: `files_read` lets any member read everything except receipts and chat
  (`20261019001600_team_chat.sql:303-310`).
- Every teammate's profile, phone and email included (`private.shares_company`).
- Crews, crew members, every visit's assignees, checklist templates, intake forms, equipment and
  its logs, routes, measurements, published guides, roles and the company row with its settings.

**35 API routes check only membership** (`requireCompany()` with no roles, `apps/api/src/lib/auth.ts:38`).
They include `GET /team` (everyone's phone and email), `/ai/rewrite` and `/kb/ask` (which cost the
business money), and chat.

**Prices are already kept out by the database, not just the screen.** That covers job line items,
`job_financials`, the price list and the pay-rate columns. `job_scope()` gives crews quantities
without prices ("24 squares"), which is what a sub's per-square price multiplies against.

**Client contact info is kept out only by the screen.** The visit screen joins
`clients(display_name, phone)` and shows Call and Text (`apps/web/src/features/field/FieldVisitPage.tsx:36-49, 131-132`).

**Start and Complete also clock the person in and out** (`apps/web/src/features/field/fieldActions.ts:50-51`).
The queued action only sees its saved variables, so "don't clock" has to be decided at the tap.

**Offline My day is kept only for crew leads and field crew** (`apps/web/src/lib/session.tsx:222`).

**Pay is hourly only.**

- Every payee is a login. Pay periods are date ranges (`20261019002100_pay_periods.sql`,
  `packages/core/src/pay.ts`).
- There's no per-square, per-job or per-day pay, no 1099, and no vendors.
- "Payouts" already means Stripe deposits: the `payouts` table, `/payouts`, `PayoutsPage`.

**Squares live on the job's line items, not the job.**

- The roof line's `job_line_items.quantity` is the job's squares.
- `measurements.roofing_squares` includes waste.
- The formulas also have `roof_squares` without waste, "for tear-off and labor" (`packages/core/src/roofing.ts`).

**Job costs would count a sub's pay twice on roof jobs.** A roof service's `unit_cost` already
includes an estimated `services.labor_cost` (`20261022004100_material_prices.sql`), and the job page
adds line costs, labor and expenses together (`apps/web/src/features/jobs/JobPage.tsx:70-84`).

**Phone sign-in is switched off, and Crewtavo blocks it.**

- Instances set `GOTRUE_EXTERNAL_PHONE_ENABLED=false` (`docker-compose.yml:52`, `.railway/railway.ts:81`).
- The sign-in guard refuses phone fields (`apps/api/src/lib/signInGuard.ts:84-98`).
- Twilio is wired for the app's own texts: one number per instance, and optional (`apps/api/src/lib/notify.ts:246-266`).

**Nothing has an expiry date.** Equipment maintenance is the template to copy: the
`equipment_due` view plus `emit_equipment_alerts()` in the hourly upkeep
(`20261017001900_equipment.sql:305-376`, `apps/api/src/tasks.ts:233-253`).

**Accepting something in one step already exists.** `approve_hub_quote` locks the quote while
it's open, records the answer and returns false if someone got there first
(`20261018000830_hub_approval.sql`).

## Decisions

### 1. Subs are shut out by default

- **The new level.** Add `subcontractor` to `member_role` in a migration of its own. Each
  migration runs in one transaction (`scripts/migrate.mjs:97`), and Postgres won't use a new enum
  value inside the transaction that added it.
- **"Member" starts meaning staff.** `private.is_member()`, `private.member_companies()` and
  `private.shares_company()` change to every level except Subcontractor.
  - Every rule built on them closes to subs without being edited, and so does every rule written later.
  - Their bodies are pinned in `private.folded_helpers()` (`20261018000990_policy_lookups.sql`), so
    the change updates that list and folds the policies again. `supabase/tests/policy_lookups_test.sql`
    checks the two agree.
- **A second list, `private.worker_companies()`** (staff plus subs), is used only where a sub is
  let back in:

  | What | A sub reaches |
  | --- | --- |
  | Visits | The ones they're on (`visit_assignees`). They can change the status and notes. |
  | Jobs, properties, requests | The ones behind their visits (the existing `crew_*` lists) |
  | Gate and lockbox codes | Same rule as crew: an open visit there today or tomorrow |
  | Checklists, visit photos, crew-visible plans, materials and equipment to bring | On their visits. Photo files by path, `<company>/visit/<visit_id>/…` |
  | Notifications, notification settings, push devices | Their own |
  | Their membership and profile; the company's name, logo, time zone and phone | Their own, and a trimmed `company_basics()` instead of the company row (its `settings` hold maps, assistants, tax and review settings) |
  | Their sub record, paperwork, job pay and offers | Their own sub only |

- **Not let back in:** clients, client contacts, messages, quotes, invoices, the price list, job
  line items, expenses, chat, guides, the team list, crews, the equipment list, routes and
  measurements. Time entries stay closed too, unless the company turns the clock on for that sub.
- **The client's name and contact details come from one function, `visit_contact(visit)`.** It
  always gives the name, and gives the phone and email only when that sub has **Can contact
  clients** on. For a sub, the field app calls it in place of the `clients` join.
- **API routes close to subs by default.** `requireCompany()` with no roles becomes staff only.
  Routes a sub uses opt in with a new `WITH_SUBS` group:
  - `GET /schedule` and `PATCH /visits/:id`
  - push and `/me`
  - the new sub routes

  AI assistants (MCP) refuse subcontractor memberships.
- **Tests that catch whatever we forget:**
  - A database test signs in as a sub and reads every table in `public` and `storage`. It fails on
    any row not on the allow-list, so new tables are covered without anyone remembering.
  - The same sweep covers every function a signed-in user can call.
  - An API test calls every route as a sub and expects 403, except the opt-ins.

### 2. A sub is a business the office keeps; logins are optional

- **A `subcontractors` table** holds:
  - business name, contact name, phone, email, trade and mailing address
  - the W-9's tax classification
  - notes and active
  - **Can contact clients** (off by default) and **Uses the clock** (off by default)
- **Linking logins.** `memberships.subcontractor_id` ties a login to its sub. Role Subcontractor
  if and only if `subcontractor_id` is set. One login per sub to start; the model allows a sub's
  foreman later.
- **No custom roles on this level.** A custom role can't be based on Subcontractor (a check on
  `company_roles.base_role`).
- **A new area, `subs`** ("Subcontractors, their paperwork and pay"), for owner, admin and office.
  It goes in `LEVEL_PERMISSIONS` (`packages/core/src/roles.ts`) and `private.level_permissions()`.

### 3. One job pay table covers sub pay and per-square crew pay

It isn't called "payouts", which already means Stripe deposits.

- **`job_pay`** is one row per payee per job.
  - The payee is either a person (`user_id`, for employee piece pay) or a sub (`subcontractor_id`), never both.
  - Status: draft, offered, accepted, declined, withdrawn or expired; then done, then paid.
  - It also holds `respond_by`, `earned_on`, `paid_at`, `paid_amount`, `method`, `reference` and `paid_by`.
- **`job_pay_lines`** holds a description, the basis (per unit, per job or per day), unit,
  quantity, rate and the `service_id` the quantity is counted from. The amount is computed by a
  trigger, since money math happens in Postgres.
- **A rate card per sub, and per employee on piece pay** (`pay_rates`): a rate per service, per
  job or per day. Offering fills the lines in, and the office can change them before sending.
  - Per service: the rate times that service's quantity on the job ("Architectural shingles, 24 sq × $75").
  - Per day: the rate times the days in the offer.
  - Per job: the rate once.
- **Changing an accepted price sends it back to the sub as a new offer.** The accepted version is kept.
- **Subs don't clock.**
  - Start and Complete stop clocking for them: a `clock` flag on the queued visit-status action
    (`fieldActions.ts:10-20`), with `fieldClock.test.ts` and `offline.test.ts` updated.
  - Their pay is owed once their visits on the job are complete (`earned_on`).
  - The office marks it paid, one at a time or several at once.
- **Employees on per-square pay keep the clock.**
  - In a pay period, their piece pay joins hourly pay in `paySummary()` and `pay_period_lines`.
  - Hours over 40 are still flagged: overtime on piece pay is worked out from total pay ÷ hours,
    which the payroll service does.
  - A paid period locks its job pay the way it locks time.
- **Job costs count sub and piece pay as labor, once.** `job_line_items` keeps `labor_cost`
  separately when a quote becomes a job. A job with actual labor then counts only the materials
  part of each line.
- **Who sees prices:** the office with the `subs` area, and each sub their own. Crew leads and
  field crew never see them.

### 4. Offers

- **The office offers from the job.** Under **Sub and crew pay**, **Add pay** lists subs with their
  paperwork status. The office reviews the filled-in lines, picks which visits, and presses **Send
  offer**, with a reply-by time if it likes. The offer goes out by push, by text when Twilio is set
  up, and by email. After a sub turns one down, **Offer to someone else** starts it again for another sub.
- **Before accepting, a sub sees:** the job title, the town, the dates, the scope (`job_scope()`),
  and their lines and total.
- **After accepting:** the full address, gate codes, notes and checklist, the same My day the crew gets.
- **Accept and decline happen in one step,** modeled on `approve_hub_quote`. The offer is locked
  while it's open.
  - Accepting adds the sub to the offer's visits (`visit_assignees`), so the existing assignment
    notifications fire.
  - Declining takes an optional reason and tells the office.
  - Both need signal.
- **Offers can expire.** The hourly upkeep marks expired offers and tells the office.
- **The office can put a sub straight on a job without asking.** That's recorded as accepted by the office.
- **New activity verbs, `sub_offer.*`,** let automations react. A new notification topic, `subs`,
  means rewriting the check on `notification_prefs` and adding it to `packages/core/src/notifications.ts`.

### 5. Paperwork with expiry reminders

- **`sub_documents`** holds the kind, file path, carrier, policy number, start and expiry dates,
  who verified it and when, and what replaced it.
  - Kinds: W-9, liability certificate, workers' comp certificate, workers' comp exemption, license, other.
- **Files live at `<company>/subs/<sub_id>/…`.** They're left out of the general member read, as
  receipts are. Only the `subs` area and that sub can open them, because W-9s carry tax IDs.
- **Each sub shows a status:** OK, expiring within 30 days, expired, or missing. It shows on the
  Subs list, in the offer picker and on the job.
- **Reminders come from `emit_sub_document_alerts()`** in the hourly upkeep, modeled on
  `emit_equipment_alerts()` and its `alerted_state`.
  - The office hears at 30 days, at 7 days and on expiry.
  - The sub hears too, by push, text or email, with an upload link.
- **Subs upload a new certificate** from the field app (**My paperwork**). A sub without a login
  uses a signed upload link, the booking form's pattern (`apps/api/src/routes/public.ts:587-625`).
  The office then verifies it.
- **Lapsed insurance warns, it doesn't stop.** When the office offers work to a sub whose workers'
  comp or liability certificate has lapsed, is missing, or ends before the job, the offer screen
  says so plainly and the office can still send it. The offer records that the warning was shown,
  so the workers' comp audit report can list work given while uninsured. (Decided 24 October 2026.)
- **A workers' comp audit report** answers the auditor's question. For a policy year it shows each
  sub's pay by date of work, split into covered and not covered by a certificate or exemption on
  file, with the certificates listed.

### 6. Yearly totals for the 1099

- **Totals are per sub per calendar year, by the date paid.**
  - Card and payment-app payments are left out, because the processor reports those on a 1099-K.
  - Corporations are flagged as usually exempt, going by the W-9 classification.
- **The reporting threshold sits in a table by year in `packages/core`:** $600 through 2025, then
  $2,000 for 2026 after the One Big Beautiful Bill Act, adjusted for inflation from 2027.
  - **Still open before release:** check it against the IRS 1099-NEC instructions for 2026 (the
    sources so far are tax software vendors). `NEC_THRESHOLDS` in `packages/core/src/jobPay.ts` carries
    the same note, and the year-end page tells the office which amount it used from 2027 on.
- **The CSV export** has the legal name, address, classification, total, and whether a 1099 is
  needed.
- **Tax ID numbers aren't stored to start.** They stay on the W-9 file, and the bookkeeper copies
  them.
- **Later:** stored tax IDs (encrypted, as OAuth tokens are), and subs sent to QuickBooks or Zoho
  as vendors and bills. `apps/api/src/integrations/accounting.ts` only sends clients, invoices and
  payments today.

### 7. Sign-in without a password

- **First time:** the office presses **Text sign-in link** on the sub.
  - Crewtavo texts the link from the instance's Twilio number when there is one.
  - Without Twilio, the button opens Messages on the office's phone with the link filled in, like
    **Copy invite link** today (`apps/web/src/features/settings/TeamSettings.tsx:265-292`).
  - Tapping the link signs the sub in.
- **They stay signed in.** Instances set no session time limit, only a 1-hour access token
  (`docker-compose.yml:55`), so the refresh token keeps them in until they sign out.
- **On a new phone,** the sign-in page offers **Subcontractor? Get a sign-in code by text**: their
  phone number, then a 6-digit code. It's built in Crewtavo's API, not GoTrue's phone sign-in, so phone stays off in
  GoTrue and the sign-in guard keeps refusing phone passwords.
  - It only texts numbers that belong to an active sub login, and gives the same answer either way.
  - The code is stored as a keyed hash: one use, 10 minutes, 5 tries (the spare keys pattern,
    `20261019001200_spare_keys.sql`).
  - Limits per number and per IP fail closed. `allow()` fails open today (`apps/api/src/lib/limit.ts:13-18`),
    which is wrong for an endpoint that spends money on texts.
  - It texts US and Canadian numbers only, unless the company adds more.
  - A correct code makes a magic link. The browser redeems it as it does email links
    (`apps/api/src/routes/recovery.ts:27-37`, `apps/web/src/lib/session.tsx:85-126`).
- **A sub's sign-in is on a placeholder address.** `generateLink` needs an email, so it's an
  `.invalid` address Crewtavo never sends to. (Built for every sub's sign-in, not only those with
  no email: their real email stays on the office's record. See below.)
- **Without Twilio, codes come by email** (decided 25 October 2026). The sign-in page offers
  **Get a sign-in code by email**: the sub types their email and gets the same kind of 6-digit
  code, sent the way the company's other email goes out. It only goes to the email the office
  keeps on the sub's record, for a sign-in Crewtavo made, with the same limits and the same
  answer whether or not the address has an account. With Twilio, text comes first and email is
  there for a sub with no phone on file. A code beats an emailed link here because on an iPhone
  the link opens in Safari, not the installed app.
- **Twilio registration.** Sending codes is a one-time-password use, so it belongs in the
  company's Twilio A2P registration.

## The field app for a sub

- **Navigation:** My day, **My jobs** (offers, accepted, done and paid, with this year's total),
  **My paperwork**, and their profile.
  - The phone's tab bar gets the same, since `MOBILE_TABS` has no role filter today.
  - `/` opens My day, and any other screen shows nothing.
- **My day** is the crew's, minus:
  - the clock cards and the "You: 1h 05m" time chip
  - **Add a receipt**
  - Call and Text, unless **Can contact clients** is on

  The client's name comes from `visit_contact()`.
- **Offline:** subs join the levels whose My day is kept offline (`session.tsx:222`).
- **Places that list levels by hand** (each needs the new level):
  - Core: `packages/core/src/roles.ts` (every `Record<Role, …>`), `packages/core/src/automations.ts:223`
    and `packages/core/src/assistants.ts:27`.
  - Screens: `SchedulePage.tsx:187` (it checks `!== "field_crew"`, so a sub would count as office),
    `nav.ts:27`, `FieldTodayPage.tsx:129,131`, `ClockCard.tsx:48`, `FieldVisitPage.tsx:311`,
    `FieldPlans.tsx:34`, `chat/Members.tsx:17`, `RulePage.tsx:59`, `kbData.ts:18` and `SopEditorPage.tsx:20`.
  - Database: `team_chat.sql:223,557,573`.
  - Invites: `account.ts:278` and `services/team.ts`.

## Build order

| Phase | Ships | Needs |
| --- | --- | --- |
| A. Subs and paperwork | Subs page and records, documents with expiry, reminders, upload links, the `subs` area | Nothing |
| B. Sub sign-in and My day | The access level, the lock-down and its tests, the sign-in link, the field app for subs | A |
| C. Job pay | Rate cards, pay on jobs, owed and paid, yearly 1099 totals, the workers' comp audit report, job costs, employees' per-square pay | A |
| D. Offers | Offer, accept and decline, expiry, the insurance warning | B and C |
| E. Codes by text | **Subcontractor? Get a sign-in code by text** | B |
| E2. Codes by email | **Get a sign-in code by email**, for a sub without texting or a phone on file | E |

- **B and C can be built at the same time in separate sessions, and so can D and E.**
- **Each phase is one branch,** with database tests (`npm run test:db`), API tests and web tests.
- **Paperwork goes first for three reasons:**
  - It saves real money at the workers' comp audit.
  - It works for subs who never sign in.
  - It brings in no outside logins, so it can ship before the riskier access work is done.

## Decisions on the open questions (24 October 2026)

1. **Lapsed insurance only warns.** The offer goes out with the warning recorded on it.
2. **Which squares to pay on:** each per-unit rate has a setting, **the job's squares** (the job
   line's quantity, what the client pays for, which includes waste on the roof itself) or **roof
   squares without waste** (the measurement's squares with the waste taken back out). It defaults
   to the job's squares, and the quantity can still be changed on each offer.
3. **Per-square pay for a crew is one line per person,** each with their share of the squares.
   Splitting one crew line by percentages can come later.

## What changed while building it

Reviewing the phases together (25 October 2026) changed these:

- **A sub's sign-in is always on their stand-in address.** Crewtavo makes it on `subLoginEmail()`
  (`.invalid`), never on the sub's real email, and doesn't copy their phone onto the profile the team
  can read. The real phone and email stay on the office's record, behind the subs area, and
  everything that reaches the sub goes there: sign-in codes, links, offers, owed and paid notices
  (`public.sub_notice_contacts`), so the office's corrections reach them. A phone the sub adds to
  their own profile comes first for texts. Someone's own Crewtavo account under the sub's email is
  still given access on it, and is told the way it always is.
- **Someone who subs for two businesses has a sign-in at each.** One business never takes over
  another's sub sign-in (its codes and links would then open both). One number or address on both
  gets a code for each in one ask, one message per business, and the code typed signs in to the
  business it was for. Two of one business's subs on the same number or address still get none,
  and the Sign-in card says so. Inviting an email that's another business's sub sign-in to a team is
  refused.
- **Deleting a sub signs their sign-in out** on every phone (the account is kept, reaching nothing,
  as their time and visits are on it); added again, the sub gets a new sign-in.
- **Rules about subs' offers** (`sub_offer.*` triggers) are for people with the subs area only, in
  the database too. They notify only owners, admins and the office, never the crew, and a task they
  make never shows the sub's price or reason, since tasks are on the schedule.
- **Subs on the clock aren't payroll.** Their hours show on Timesheets for the office's records, but
  never in a pay period: they're paid by the job.
- **Cancelling the rest of a sub's visits after the price was agreed** leaves the pay agreed, so the
  office checks the lines before marking the work done.
- **Per-square pay suggests each person's share:** what's already on someone else's pay on the job
  is taken off the suggested squares, flagged, and the job's pay card warns when everyone's squares
  come to more than the job's.
- **The workers' comp audit** takes an exemption with no start date as a year up to its end date (as a
  certificate is), and says the dates were assumed.
- **The workers' comp audit counts work on the day it was done.** Clicking through the finished
  feature showed a job finished today but booked for tomorrow missing from the default "last 12
  months" report. A completed visit now counts on the earlier of its scheduled day and the day it was
  completed, in company time, so work finished early lands on the day it was done and a sub who taps
  Complete the next morning still counts on the day they worked. Timed visits with only a start time,
  left out before, count on their start's day.
- **A sub's year-to-date total** says how much of it counts toward their 1099 when card or app
  payments make it less.
- **Words:** the office **withdraws** an offer; a sub **accepts** or **declines** it.

