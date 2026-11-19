# The public demo

crewtavo.com's **Try the demo** opens a Crewtavo instance where nobody signs up. A visitor answers
**"What kind of work do you do?"** (Lawn care, Roofing, Paving, or Something else) and gets their
own sample business in that trade, signed in as its owner. Nobody sees anyone else's business, and
each one is deleted after 24 hours.

It's an ordinary Crewtavo instance with two settings, `CREWTAVO_DEMO=1` and
`CREWTAVO_SINGLE_COMPANY=0`. Everything about the demo is off without both. The code ships in every
release and does nothing in a business's own Crewtavo, even with `CREWTAVO_DEMO` set there by mistake,
because an instance holds one business unless told otherwise.

## What a visitor gets

- **The start screen** (`apps/web/src/features/demo/Demo.tsx`) replaces the sign-in page. Lawn care,
  roofing and paving each have a sample business written for them (`apps/api/src/services/demoStories.ts`):
  - Greenway Lawn Care: a weekly mowing route, a fertilizer program out for approval, seasonal cleanups,
    and snow removal. Crewtavo - Snow is installed, with four snow customers (their triggers, salting
    and storm prices) and last winter's storm in the log, billed by depth. In winter a storm
    tomorrow is already scheduled.
  - Ridgeline Roofing & Exteriors: a storm claim with the roof measured on the aerial, a builder's new roof on today's schedule.
  - Acme Paving: the `npm run seed:demo` company, with its parking lot takeoff.

  **Something else** lists every other trade preset (cleaning, HVAC, plumbing, pest control, pools…).
  Each gets a business made from that trade's own price list.
- **Every business has** a team (owner, crew lead, crew member, office manager), clients and leads,
  requests, quotes (sent, draft, approved), jobs, this week's schedule, invoices (overdue, part paid,
  paid), equipment due for service, guides, a sent campaign and review asks. Dates are counted from
  the day it's made, so the schedule is always this week's.
- **A guided tour** (`apps/web/src/features/demo/Tour.tsx`) opens the first time the owner arrives.
  A card in the corner goes a page at a time: Home, requests, the schedule, a quote, then the
  trade's own part (lawn care's Snow page, roofing's measured roof, paving's takeoff), invoices, the
  crew's phone and the client's view. It rings what it's talking about. It picks up where it was
  after a reload, and the bar's **Tour** button starts it again.
- **The demo bar** above the app:
  - **Crew's phone** signs in as the crew lead (`/field`), and **Owner's view** comes back.
  - **Client's view** opens the client portal for the client with the latest quote.
  - **Start over** deletes the business and goes back to the start screen.
  - **Get Crewtavo free** goes to crewtavo.com/start/.
- **Links from the website** can pick the trade: `https://demo.crewtavo.com/?trade=lawn`, `?trade=roofing`,
  `?trade=paving`, or any preset's id (`?trade=pool_service`). The demo starts as soon as the page
  opens, after the bot check if there is one.

## What stops abuse

Anyone on the internet gets an owner's sign-in, so the demo (`apps/api/src/lib/demoMode.ts`):

- **Sends nothing.** Email and texts look sent in the app and go nowhere, even if the server has keys.
  Push messages aren't sent. AI, payments, postcards and every connection to an outside account
  (Stripe, Twilio, Lob, Claude, ChatGPT, Google, Meta, QuickBooks, Zoho, calendars, email, Drive) are
  refused with "That's turned off in the demo". Background tasks that reach outside (calendar sync,
  social posts, website checks, Google reviews, postcards) don't run.
- **Makes no accounts but its own.** There are no invites, sub sign-ins, sign-in links or second
  businesses. The accounts are `@demo.crewtavo.com` with random passwords nobody keeps. Each one
  carries the business it was made for, where only the server can write it. Switching people and
  starting over go by that, so nobody can sign in to another visitor's business.
- **Limits starting a demo:** 10 an hour and 30 a day from one address, and 300 an hour and 2,000 a
  day in total. Cloudflare Turnstile is added when its keys are set.
- **Limits changes:** each visitor's address may make 1,200 changes every 10 minutes, in the app and
  in the database together, each at most 2 MB. Clicking around makes a few a minute; a script
  filling the database gets stopped.
- **Holds files down:** 25 MB per business, 10 MB per file, and 60 uploads an hour from one address,
  whatever the owner sets in Settings → Storage.
- **Cleans up:** the `demo` task runs every 10 minutes. It deletes every business whose accounts are
  more than 24 hours old, with its rows, files and accounts. It only touches the demo's own accounts.
  A business that can't be deleted is reported to error monitoring, and the rest carry on.

Known limits: anything that asks for the current password (giving someone admin access, changing
your password) can't be done in the demo, since visitors never have one. Looking up addresses and
the weather still uses the free public services every instance uses.

## Setting it up on Railway

1. **Deploy the template** into a new project (Deploy on Railway in the README), named `crewtavo-demo`.
   Wait for it to finish. Don't create an owner account: the demo has none.
2. **Build `crewtavo` from GitHub** instead of the release image. On the **crewtavo** service, open
   **Settings → Source**, disconnect the image, and connect the repository `jviars/crewtavo`.
   - **Branch:** `live-demo` for now, then `main` once the demo is merged.
   - **Wait for CI:** turn it on once the branch is `main`. GitHub runs the checks on pushes to
     `main`, and Railway then deploys only a commit that passed them. CI doesn't run on `live-demo`,
     so leave it off until then.

   Every push to that branch then rebuilds the demo (about 5–10 minutes).
3. **Variables** on the **crewtavo** service: add `CREWTAVO_DEMO` = `1` **and**
   `CREWTAVO_SINGLE_COMPANY` = `0`. Both are needed. Leave email, texting, Stripe, AI and Google keys
   unset. The demo refuses to use them anyway, but there's no reason to have them there.
4. **Optional, recommended:** set up Cloudflare Turnstile.
   - In Cloudflare's dashboard, go to **Turnstile → Add widget**, with the hostname `demo.crewtavo.com`.
   - Add `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` to the **crewtavo** service.
5. **Optional:** set `FILE_SIZE_LIMIT` = `10485760` on the **storage** service, so Storage itself
   refuses files over 10 MB too.
6. **Domain:** on the **crewtavo** service, **Settings → Networking → Custom domain**, add
   `demo.crewtavo.com`. Railway shows a CNAME record; add it in Cloudflare's DNS for crewtavo.com.
   - Leave it **DNS only** (grey cloud). Behind Cloudflare's proxy, every visitor would arrive from
     Cloudflare's addresses, and the per-address limits would count them as one.
   - Don't set `CREWTAVO_VISITOR_IP` to fix that instead: the Railway address can be reached
     without going through Cloudflare, so anyone could send their own `CF-Connecting-IP` and dodge
     the limits.
7. **Spending:** under **Workspace → Usage → Set Usage Limits**, set a **Hard limit**. $10 is
   Railway's lowest. It's per workspace, so keep the demo in a workspace of its own if anything
   else runs in yours.

A quiet demo uses about what an idle instance does (roughly $4–5 a month of Railway usage, inside
Hobby's $5). Each visitor's business is a few hundred rows and is gone the next day.

## Keeping it current

Railway rebuilds the demo whenever its branch changes. Until the demo is merged, the branch is
`live-demo`: rebase it on `main` to bring the demo up to date. Once it's merged, point the service at
`main` and every push to `main` updates the demo. Migrations run as it starts, like any instance.
The sample businesses are made fresh for each visitor, so they always match the current version.

## Trying it locally

Add `CREWTAVO_DEMO=1` and `CREWTAVO_SINGLE_COMPANY=0` to `.env.instance` and run `npm run instance`. Open http://localhost:8080 and
pick a trade.
