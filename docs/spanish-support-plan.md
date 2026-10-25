# Spanish support plan

Goal: anyone at a business can use Crewtavo in Spanish, and a business can work with its clients
in Spanish. A crew member picks Español and gets their whole day in Spanish: My day, the clock,
visits, chat, the knowledge base, notifications and texts. A Spanish-speaking client gets their
quote, invoice, Client Hub, booking form, emails and texts in Spanish, while the owner keeps
working in English. Business content stays as the business typed it: service names, checklist
items, SOPs and notes.

Nothing here is built yet. This is the plan.

---

## 1. Where things stand

There's no translation layer. Every string is English, typed inline:

| Where | What's there |
|---|---|
| `apps/web/src` (202 `.tsx`, 53k lines) | About 5,000–6,000 strings, typed inline as JSX text, `label=` / `title=` / `aria-label=` / `placeholder=` props, 212 `meta.success` toasts, 104 `toast.*` calls, 73 `confirm()` calls, 75 empty states |
| `apps/api/src` | About 323 `HttpError` sentences shown to people as they are; all email, SMS and push text is English template literals |
| `packages/core/src` | A few hundred labels and validator messages used by both the web app and the API; about 270 strings in `presets/*.json` |
| `supabase/migrations` | About 100 distinct `raise exception` sentences shown to people as they are. Notification titles and bodies, activity summaries and some invoice lines are stored as finished English, with `to_char` dates in English |
| Formatting | `lib/format.ts` hard-codes `en-US`. 57 more `"en-US"` calls bypass it, and about 18 calls use the browser's locale |

Things that make this harder than wrapping strings:

- **Sentences built in code.** About 120 `n === 1 ? "x" : "y"` plurals, a `plural()` helper that
  adds an English "s", a/an choices, `${name}'s` possessives, 19 `label.toLowerCase()` calls that
  drop a label into a sentence (which breaks Spanish gender agreement), and about 115 sentences
  split around `<strong>`/`<Link>`.
- **Strings evaluated at import time.** Lists like `components/shell/nav.ts`,
  `settings/sections.ts`, `ROLE_LABELS` and status maps are module-level constants.
- **English names used as lookup keys.** These break when the text is translated:
  - `addMissingServices` matches services by name (`apps/api/src/services/presetServices.ts:13`)
  - roof packages refer to services by name (`services/roofPackages.ts:55`)
  - `weather_rules.applies_to` is a service name
  - `SITE_ADJUSTMENT_NAME = "Price adjustment"` (`core/estimates.ts:184`)
  - `where name = 'Change order discount'` in SQL
  - a role update matches `name = 'Foreman'` (`crew_leads.sql:196`)
  - roof section kinds `"Area"` / `"Length"`
- **`statusLabel()`** in `components/ui/StatusPill.tsx:32` builds labels from status codes
  ("in_progress" becomes "In progress"), so every status needs a real label.
- **`describeRule()`** uses `rrule.toText()`, which only speaks English (`core/recurrence.ts:121`).

What helps:

- Statuses are stored as codes.
- `activity` already stores `verb` and `data`.
- `lib/format.ts` is already the main formatting path.
- `lib/theme.ts` shows how to keep a per-device setting, and how to tell client pages apart
  (`CLIENT_FACING`).

---

## 2. Decisions

### Spanish variety and formatting

- **Latin American / US Spanish**, one catalog called `es`.
- **Format with `es-US`, never plain `es`.** Checked in Node 22:

  | Locale | Money | Date | Time |
  |---|---|---|---|
  | `en-US` | $1,234.50 | Thu, Oct 15 | 9:20 AM |
  | `es-US` | $1,234.50 | jue, 15 de oct | 9:20 a.m. |
  | `es` (Spain) | 1234,50 US$ | — | 9:20 (24-hour) |

  Plain `es` would give US businesses Spain-style numbers.
- **Tone:** `tú` in the app, `usted` toward clients (emails, the Client Hub, documents). See open
  question 1.

### How strings get translated: a small layer of our own in `@crewtavo/core/i18n`

There's no library to add. The layer is the same code in the browser, the API (for emails, SMS and
push) and core (for validators), and it needs no Babel or esbuild plugin. That suits a repo that
pins few dependencies and writes its own `money.ts`.

```ts
t("Client created")                                   // the English text is the key
t("Quote #{number} sent to {client}", { number, client })
t.plural(n, { one: "# visit", other: "# visits" })    // Intl.PluralRules; Spanish "many" falls back to "other"
t("Open", { context: "verb" })                        // same English, different Spanish ("Abrir" / "Abierto")
msg("Schedule")                                       // marks a module-level constant; translated where it's shown
<T text="Read the <link>terms</link> first" link={(s) => <Link to="/license">{s}</Link>} />
```

- **English is the key**, so changing English copy flags its Spanish line as missing, which is
  the behavior we want. A missing translation falls back to English at runtime and fails the
  catalog test in CI.
- **Catalog:** `packages/core/src/i18n/es/*.ts`, split by area (`common`, `field`, `hub`, `office`,
  `server`, `db`) so translators work in context.
  - The web app lazy-loads it as one Vite chunk, only for Spanish.
  - The API imports all of it.
  - The chunk sits under `/assets/`, so `sw.js` caches it. Add it to the `cache-assets` list so
    crews who go offline still have Spanish.
- **Browser:** the current locale lives in a small store like `theme.ts`. Changing the language
  saves and reloads the page. That keeps constants and caches from showing a mix of languages,
  and it's rare enough not to matter.
- **Server:** no global locale, since requests overlap. Each request or recipient gets its own
  translator: `const t = translator(locale)`.
- **Considered and passed over:** Lingui, which fits the "English is the key" approach. It needs
  macros wired into Vite, esbuild and vitest, and gives us little we wouldn't write in about 200
  lines.

### Who sees which language

| Surface | Language, in order of preference |
|---|---|
| Staff app, signed in | `profiles.locale` → device setting → `navigator.languages` → `en` |
| Sign-in, onboarding, setup (no profile yet) | device setting → `navigator.languages` → `en` |
| Client pages (`/hub`, `/book`, `/u`, `/refer`) and the iPad roofing visit, sign and signed pages | `clients.locale` → business default → browser (booking only) → `en`, with an **English / Español** switch on the page |
| Email, SMS and push to staff | the recipient's `profiles.locale` |
| Email and SMS to clients, printed and Hub documents, Stripe | `clients.locale` → business default |
| Text the database generates for a client (invoice lines) | `clients.locale` → business default |
| MCP tool descriptions, logs, Sentry | stay English. The assistant answers the person in their own language anyway |

The business default is `companies.settings.locale`. It's used for clients with no preference,
for new businesses' starter content, and as the suggested language for invites.

### What doesn't get translated

These stay as typed: service and price-list names, line items, checklist items, SOPs, notes,
chat, custom role names, booking-form questions, campaign text.

Two exceptions:

- Message templates (automations, review request, quote and invoice send intros) can have a
  Spanish version (section 5).
- Starter content for a new business is created in its chosen language.

**Legal text** (`TERMS`, `LICENSE`, `NOTICE`) stays English and binding. In Spanish, the license
page explains in Spanish what it is and that the English text controls.

---

## 3. Data model (one migration, e.g. `20261025000100_languages.sql`)

- **`public.profiles`:** add `locale text check (locale in ('en','es'))`, null meaning "follow
  the device".
  - Add `grant update (locale)`.
  - Read `raw_user_meta_data->>'locale'` in `private.handle_new_user`, so invites can set it.
  - In `routes/account.ts`, add `locale` to the `/me` select and to the PATCH schema at :116.
  - Add it to the `Session.profile` type.
- **`public.clients`:** add `locale` with the same check.
  - Add a "Preferred language" field to `ClientForm.tsx`.
  - Client import maps a Language / Idioma column.
  - The Hub's language switch saves it through the Hub token.
- **`public.companies`:** use `settings.locale` (no new column).
  - Add it to the AI-assistant guard's allowed settings keys
    (`20261019001900_assistant_areas.sql:102`), or assistant edits to it will raise an error.
- **`public.notifications`:** add `data jsonb`, holding `{ key, params }` (section 6).
- **`LOCALES = ["en", "es"] as const`** in core, kept in step with the check constraints by a test.
- Regenerate `database.types.ts` with `npm run db:types`.

---

## 4. Phases

Each phase ships on its own. Untranslated text falls back to English, so Español can be offered
as soon as the crew screens are done, marked **(beta)** until phase 3.

### Phase 0: Groundwork (nothing changes for users)

1. **`@crewtavo/core/i18n`:** `t`, `msg`, `t.plural`, interpolation, contexts, a `<T>` component
   for the web app, the locale store, and lazy loading.
2. **Move formatting into core** (`@crewtavo/core/format`) and take a locale, so the web app and
   the API format the same way.
   - `en` maps to `en-US`, `es` to `es-US`.
   - Cache formatters per locale.
   - `timeAgo`'s literal "just now" goes through `t`.
   - Keep `en-CA` for ISO dates and the `en-US` parts formatters in `core/time.ts`. Those are
     internal.
   - Replace the 57 direct `"en-US"` calls and the ~18 browser-locale calls with these helpers.
   - Add helpers for the things now built by hand: weekday and month names
     (`schedule/SchedulePage.tsx:534`, `jobs/RecurrenceEditor.tsx:18`), hour labels
     (`schedule/TimeGrid.tsx:80`), durations (`field/fieldData.ts:142`), and the
     `AnimatedNumber` locale.
3. **Language on the page:**
   - Set `<html lang>` at boot from the saved locale, in the inline script that already sets the
     theme in `index.html`.
   - Keep it current when the language changes.
   - Add `lang` to emails in `renderEmail`.
4. **The data model** (section 3), and passing the locale on every API call (an
   `X-Crewtavo-Locale` header from `lib/api.ts`, read by middleware into `c.var.locale`).
5. **Stop matching by English name** (section 1's list), before any Spanish starter content
   exists:
   - Give preset-created rows a stable key (`services.preset_key`, and the same for roof packages
     and weather rules).
   - Mark the price-adjustment and change-order-discount lines by a kind or flag, not by name.
   - Change the `Foreman` data fix to go by role id.
6. **Checks** (vitest):
   - *Catalog test:* scan `apps/web/src`, `apps/api/src` and `packages/core/src` for
     `t()`/`msg()`/`<T>` strings. Fail if one has no Spanish line, if a Spanish line is no longer
     used, if the `{placeholders}` differ, or if a plural is missing a form.
   - *Raw-text ratchet:* a TypeScript-API check for JSX text and literal
     `label`/`title`/`placeholder`/`aria-label`/`hint` props outside `t()`. It runs over a list of
     folders that only grows as phases finish, so translated areas can't slip back.
   - *Pseudo-locale (dev only):* turns "Client created" into "[Ćĺíéñţ ćŕéåţéð ~~~~]". It shows
     untranslated text and roughly 30% longer strings without waiting for real Spanish.
7. **Wrapping codemod** (`scripts/i18n-wrap.mjs`, TypeScript compiler API, already a dependency).
   - Run it per folder. It wraps JSX text, the props above, `meta.success`, `toast.*`,
     `confirm({...})` and `EmptyState` strings.
   - It lists template literals, ternaries and split sentences for a person to rewrite.
   - The mechanical part of 5,000 strings shouldn't be done by hand.
8. **Glossary** (`packages/core/src/i18n/GLOSSARY.md`), written before any translating (section 8).

### Phase 1: Crews

The people most likely to need Spanish, and the smallest part of the app.

- **Shell:**
  - nav, mobile tabs, command palette (search keywords in both languages, so "horario" finds
    Schedule)
  - the notifications bell
  - `PageHeader` titles, the install card, offline notes
- **Shared UI defaults:**
  - `Confirm.tsx`, `States.tsx`, `Dialog.tsx`, `Skeleton.tsx`, `TagInput.tsx`, the rich-text
    toolbar
  - `StatusPill`: replace `statusLabel()` with real label maps for every status
  - `lib/errors.ts`, `lib/queryClient.ts` toasts, `lib/push.ts`
- **Field:**
  - `FieldTodayPage`, `FieldVisitPage`, `ClockCard`, `CrewClockCard`
  - `fieldActions.ts` toasts, `CATEGORY_LABELS`
  - `ScopeOfWork`, `JobMaterials`, `ExpensesCard`, `FieldPlans`, `CrewEquipmentCard`,
    `SignaturePad`
- **Crew-facing pages:**
  - Timesheets (own week and crew lead view), `clockPlace.ts`
  - Schedule (as crews see it), Chat, reading and asking in the KB
  - Profile and notification settings, with the **Language** card next to Appearance in
    `ProfileSettings.tsx`, plus "idioma language español" in `sections.ts` keywords
- **Notifications** become structured (section 6). Push, email digest and SMS go out in the
  recipient's language (`services/delivery.ts` already loads `profiles` per recipient).
- **Invites:**
  - The inviter picks the invitee's language, defaulting to the business's.
  - It goes into user metadata, and the invite email (`services/team.ts`) is sent in it.
  - Password-reset and sign-in emails (`routes/account.ts:381-447`, `routes/recovery.ts`) use
    `profiles.locale`.
- **`sw.js` background-sync notification:** the page posts the locale and the two strings to the
  worker, which can't see app state.
- **AI:** KB Ask (`routes/apps.ts:378`) answers in the person's language, and its no-match reply
  goes through `t`.
- **Ship:** "Español (beta)" in Profile.

### Phase 2: Clients

- **Client pages:**
  - Client Hub (`hub/HubPage.tsx`, `ClientPortal.tsx`, `document.ts`)
  - booking form and embed, unsubscribe, referral
  - the iPad roofing `visit`, `sign` and `signed` pages, in the homeowner's language with the
    switch
- **Documents:**
  - `documents/build.ts`, `EstimateDocument.tsx`, `hub/document.ts`
  - the unit words map, and price text in "por" form, replacing a/an ("$95 por hoja")
  - CSS `@page` "Page X of Y", via a CSS variable
  - Spanish `DEFAULT_TERMS` in `core/documents.ts`
  - Documents use the client's language, and the office preview has a "Preview in English"
    switch.
  - Don't add an English "s" to units people typed (`MaterialPicker.tsx:91`,
    `RoofMaterials.tsx:148`). Show "3 × bundle".
- **Email and SMS to clients:**
  - quote and invoice sends and overdue reminders (`services/sales.ts`)
  - the signed copy (`services/signing.ts`)
  - review requests (`services/reviews.ts`)
  - campaign footers and unsubscribe (`services/campaigns.ts`, `lib/email.ts` button labels)
  - Hub `.ics` text
- **Bilingual message templates:**
  - Automation email and SMS actions, `settings.review_message`, and the default send intros
    hold `{ en, es }`. Each send picks the client's language and falls back to the other.
  - The rule editor gets English / Español tabs on message actions.
  - Template variables (`{{date}}`, `{{time}}`, `{{total}}`, `{{status}}`, the "there" greeting
    fallback, the literal " at ", "to" in price ranges) format in the client's language
    (`services/automations.ts:65-175`, `core/automations.ts:60,174,253`).
  - New businesses get Spanish versions of the starter rules.
  - Existing businesses get an **Add Spanish versions** button, so their own wording is never
    overwritten.
- **Invoice text the database writes:**
  - "Deposit for …", "Progress billing", "Visit on Oct 15, 2026", "Discount", "Promo code …",
    "ea"
  - Pick it from a small `private.phrases (key, locale, text)` table by the client's language,
    and write dates as ISO or with a Spanish month list (not `to_char` month names).
  - This needs the name-matching fix from phase 0 first.
- **Stripe:**
  - Set `preferred_locales: ['es']` on the Stripe customer for Spanish clients
    (`integrations/stripe.ts:403`).
  - Translate the line labels ("Discount", "Tax (x%)", "Already paid", "Tip for the crew",
    "Rounding", `services/stripe.ts:255-276`).
- **AI:** "Rewrite" (`routes/apps.ts:356`) keeps the message's language, and campaign drafting
  (`routes/marketing.ts:110`) takes a target language.

### Phase 3: The office, and dropping "beta"

- **Everything left in the web app,** largest first:
  - roofing (7.4k lines), settings (4.8k), apps (3.2k), schedule, chat admin, quotes, clients,
    jobs, marketing, finance, invoices, equipment, pipeline, requests, metrics, automations
    editor, measure (mostly geometry, few strings)
  - sign-in, onboarding and setup
- **Activity feed:** draw it from `verb` + `data` (section 6), falling back to the stored
  `summary`.
- **Every API `HttpError` and `must(…, "X not found.")`** goes through the request's translator.
  So do the zod messages: `friendlyIssue` and `FIELD_NAMES` in `lib/http.ts` are the one place
  to do it. So do core validators (`core/automations.ts`, `forms.ts`, `pay.ts`, `money.ts`),
  which take a `t`.
- **Database errors:** the full pattern table (section 6).
- **Recurrence text:** replace `rrule.toText()` with our own `describeRule()` for the patterns
  `RecurrenceEditor` can make, through `t`.
- **CSV:**
  - Exports get translated headers. Values stay plain: ISO dates, plain numbers.
  - Client import also accepts Spanish headers (Nombre, Teléfono, Correo, Dirección).
- **Starter content in Spanish for new businesses:**
  - presets (`presets/*.json`: services, checklists, intake forms, SOP categories, job types),
    default roles
  - chat channels and topics: make `chat_slug` turn "Peña" into `pena`, not `pe-a`
  - equipment plan presets, roof packages
- **KB search in Spanish** (section 7).
- **Measure takeoff sheet:** the canvas text in `measure/takeoffSheet.ts`.
- **Legal page:** the Spanish explanation on the license page.
- **Ship:** drop "(beta)", and add the Spanish ratchet to every folder.

### Phase 4: Outside the app (separate work)

- `crewtavo-website` (the docs and marketing site, its own repo): Spanish docs, at least for crew
  and client topics. In-app help links (18 `crewtavo.com` links) go to `/es/` pages when they
  exist.
- README: a line saying the app speaks Spanish.
- Supabase Auth's own emails: only used when no mailer is set up. They stay English unless we add
  a send-email hook.
- `npm run screenshots -- --locale es` for Spanish screenshots.

---

## 5. Message templates in two languages

Automation actions, the review message and the send intros change from `{ subject, body }` to:

```ts
{ subject, body, es?: { subject, body } }   // English stays where it is, so nothing old breaks
```

When sending, use the client's language if that version exists, otherwise the other one. The
editor shows both side by side, with a **Translate** button when AI is connected. The button fills
the Spanish version for the business to review, and is never applied silently. No migration of
existing data is needed.

---

## 6. Text the database writes

Different kinds need different fixes, because some are stored and some are only shown once:

- **`raise exception` (about 100 messages, shown once, never stored):**
  - Translate in one place both the web app (`lib/errors.ts`) and the API (`lib/http.ts`
    `dbError`) use: `core/i18n/dbErrors.ts`.
  - Each entry is the English `format()` text with `%` as a capture, plus the Spanish:
    `"That code expired on %."` → `"Ese código venció el %."`.
  - A test parses the latest definition of every function in `supabase/migrations` and fails if
    a message has no entry.
  - The few that put English dates in the message (`to_char 'FMMonth'`, promo codes) switch to
    ISO dates, which the app formats.
  - This avoids rewriting about 60 functions. Moving to error codes in `HINT` can come later if
    the table gets awkward.
- **Notifications (stored, delivered later, include dates):**
  - Writers (6 SQL triggers and the TS inserts) also fill `data = { key, params }`, with
    timestamps as ISO.
  - The bell, push, email and SMS render title and body from the key in the reader's language.
  - `title`/`body` stay as the English copy, so old rows and DB tests still work.
  - `private.visit_when`'s `to_char` text becomes a parameter.
- **Activity (stored, `verb` + `data` already there):**
  - Add the parameters the summary needs (number, client, amount) to `data` in the ~27
    `private.emit` calls.
  - Render by `verb`, falling back to `summary` for old rows.
- **Invoice lines, and search titles in `global_search`:** see phase 2. The search titles become
  a kind plus a number, so the app adds "Factura #".

---

## 7. Knowledge base search

Today `sop_pages.search` uses `to_tsvector('english', …)`. For a Spanish page, "cortando" won't
find "cortar". Spanish stopwords (de, la, que) become required words in the default "all words"
search and match almost every page in Ask's "any word" mode. Without `unaccent`, "cesped" won't
find "césped".

The fix:

- **Add `sop_pages.language regconfig not null default 'english'`.** It's set from the author's
  language, and can be changed on the page. The generated column becomes
  `to_tsvector(language, extensions.f_unaccent(…))`, using an IMMUTABLE wrapper around
  `unaccent`. A generated column can read its own row but not `companies`, which is why the
  column goes on the page.
- **Search with both configs ORed together**, so a question in either language finds pages in its
  own language.
- **Cross-language Ask** (a Spanish question about English SOPs): when AI is connected, translate
  the question into the KB's main language before searching, then answer in the person's
  language. When AI isn't connected, say so.
- **Tests:** update `supabase/tests/kb_ask_search_test.sql` and `search_everything_test.sql`, and
  add Spanish cases.

---

## 8. Translating well

- **Write the glossary first.** Write it with someone who works in the trades. Field service
  Spanish in the US mixes in English trade words, and some obvious choices collide:

  | English | Spanish | Note |
  |---|---|---|
  | Quote | Cotización | |
  | Estimate | Estimado | Both exist in the app and must stay distinct |
  | Invoice | Factura | |
  | Visit | Visita | |
  | Job | Trabajo | |
  | Request | Solicitud | |
  | Crew | Cuadrilla | |
  | Foreman / crew lead | Capataz / Jefe de cuadrilla | |
  | Team | Personal / Equipo | |
  | Equipment | Maquinaria y herramientas | Not "Equipo", which also means team |
  | Clock in / out | Marcar entrada / salida | |
  | Timesheet | Hoja de horas | |
  | On my way | En camino | |
  | Deposit | Anticipo | |
  | Balance due | Saldo pendiente | |
  | Change order | Orden de cambio | |
  | Retainage | Retención | |
  | Roofing square | Cuadro (100 pies²) | |
  | Shingles | Tejas (shingles) | |

- **Who translates:**
  - Claude drafts one area at a time, with the glossary and the screen's code as context.
  - A native speaker reviews phase 1 and phase 2 text before "beta" comes off, on a phone, at
    the real screen.
- **Whole sentences only:** no `label.toLowerCase()` dropped into a sentence, no joined
  fragments. Spanish needs gender and number to agree ("1 visita programada", "2 facturas
  vencidas").
- **The ongoing cost:** after phase 3 the catalog test makes every new English string need its
  Spanish in the same change. That's the price of "full" support. It's small per feature, but it
  never stops.

---

## 9. Testing

- **Unit tests:**
  - Keep the ~330 English assertions as the `en` run.
  - Add `es` cases for the formatters, documents (`documents`, `hubDocument`, `roofingFlow`,
    `roofVisit`), automation variables, notification rendering and DB-error patterns.
- **DB tests:** English `summary`/`title` stay, so existing tests pass. Add tests for the new
  `data` keys, `private.phrases`, and Spanish KB search.
- **E2E:**
  - `playwright.config.ts` pins `locale: "en-US"`, so the existing specs stay English.
  - Add one `es-US` project with a Spanish crew day (`field.spec.ts` flow) and a Spanish client
    approving and paying in the Hub.
- **Layout:**
  - Spanish runs about 20–30% longer. Check the pseudo-locale and real Spanish at 375px on the
    field screens, mobile tabs, status pills, buttons and dialogs.
  - Print estimates and invoices on an iPad too: one-page documents already spill there, and
    longer text makes it worse.
- **Accessibility:** `lang` is set, so screen readers read Spanish correctly. Run the axe check
  (`@axe-core/playwright`) on the Spanish project too.

---

## 10. Open questions

1. **Tone:** `tú` in the app and `usted` toward clients. Or `usted` everywhere?
2. **Business content:** Is bilingual message templates (section 5) enough? Should quotes also
   carry a Spanish name per service, or is "line items stay as typed" fine?
3. **Reviewer:** Is there a native-speaking foreman or office person who can review phase 1 and
   phase 2 text?
4. **Order:** Crews first (this plan), or client-facing first if Spanish-speaking customers are
   the bigger draw?
