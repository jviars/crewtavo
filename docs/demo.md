# The public demo

crewtavo.com's **Try the demo** opens a Crewtavo instance where nobody signs up. A visitor answers
**"What kind of work do you do?"** (Lawn care, Roofing, Paving, or Something else) and gets their
own sample business in that trade, signed in as its owner. Nobody sees anyone else's business, and
each one is deleted after 24 hours.

It's an ordinary Crewtavo instance with one setting, `CREWTAVO_DEMO=1`. Everything about the demo
is off without it, so the code ships in every release and does nothing in a business's own Crewtavo.

## What a visitor gets

- **The start screen** (`apps/web/src/features/demo/Demo.tsx`) replaces the sign-in page. Lawn care,
  roofing and paving each have a sample business written for them (`apps/api/src/services/demoStories.ts`):
  - Greenway Lawn Care: a weekly mowing route, a fertilizer program out for approval, seasonal cleanups.
  - Ridgeline Roofing & Exteriors: a storm claim with the roof measured on the aerial, a builder's new roof on today's schedule.
  - Acme Paving: the `npm run seed:demo` company, with its parking lot takeoff.

  **Something else** lists every other trade preset (cleaning, HVAC, plumbing, pest control, pools…).
  Each gets a business made from that trade's own price list.
- **Every business has** a team (owner, crew lead, crew member, office manager), clients and leads,
  requests, quotes (sent, draft, approved), jobs, this week's schedule, invoices (overdue, part paid,
  paid), equipment due for service, guides, a sent campaign and review asks. Dates are counted from
  the day it's made, so the schedule is always this week's.
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
  AI, payments, postcards and every connection to an outside account (Stripe, Twilio, Lob, Claude,
  ChatGPT, Google, Meta, QuickBooks, Zoho, calendars, email, Drive) are refused with "That's turned
  off in the demo". Background tasks that reach outside (calendar sync, social posts, website
  checks, Google reviews, postcards) don't run.
- **Makes no accounts but its own.** There are no invites, sub sign-ins, sign-in links or second
  businesses. The accounts are `@demo.crewtavo.com` with random passwords nobody keeps.
- **Limits starting a demo:** 6 an hour and 20 a day from one address, and 300 an hour and 2,000 a day
  in total. Cloudflare Turnstile is added when its keys are set.
- **Limits changes:** each visitor's address may make 1,200 changes to the database every 10 minutes.
  Clicking around makes a few a minute; a script filling the database gets stopped.
- **Holds files down:** 50 MB per business and 10 MB per file, whatever the owner sets in Settings → Storage.
- **Cleans up:** the `demo` task runs every 10 minutes. It deletes every business whose accounts are
  more than 24 hours old, with its rows, files and accounts. It only touches the demo's own accounts.

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
3. **Variables** on the **crewtavo** service: add `CREWTAVO_DEMO` = `1`. `CREWTAVO_SINGLE_COMPANY`
   then defaults to `0`. Leave email, texting, Stripe, AI and Google keys unset. The demo refuses to
   use them anyway, but there's no reason to have them there.
4. **Optional, recommended:** set up Cloudflare Turnstile.
   - In Cloudflare's dashboard, go to **Turnstile → Add widget**, with the hostname `demo.crewtavo.com`.
   - Add `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` to the **crewtavo** service.
5. **Optional:** set `FILE_SIZE_LIMIT` = `10485760` on the **storage** service, so Storage itself
   refuses files over 10 MB too.
6. **Domain:** on the **crewtavo** service, **Settings → Networking → Custom domain**, add
   `demo.crewtavo.com`. Railway shows a CNAME record; add it in Cloudflare's DNS for crewtavo.com.
   - Leave it **DNS only** (grey cloud). Behind Cloudflare's proxy, every visitor would arrive from
     Cloudflare's addresses, and the per-address limits would count them as one.
   - If you do proxy it, also set `CREWTAVO_VISITOR_IP` = `cf-connecting-ip`.
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

Add `CREWTAVO_DEMO=1` to `.env.instance` and run `npm run instance`. Open http://localhost:8080 and
pick a trade.
