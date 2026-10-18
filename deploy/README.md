# The Crewtavo Railway template

The **Deploy on Railway** button opens a Railway template that creates a complete Crewtavo
instance in the business's own Railway account. This page is for whoever maintains that template:
what it contains, how to rebuild it, and the button. For running an instance, see
[docs/deploy.md](../docs/deploy.md).

The same instance is described three ways, which should stay in step:

- [`docker-compose.yml`](../docker-compose.yml): with Docker (`npm run instance`). This is the
  tested reference, and CI starts it on every push.
- [`.railway/railway.ts`](../.railway/railway.ts): Railway Infrastructure as Code, for standing up a
  real instance from this repository.
- The template itself, in the Railway dashboard (below).

## What the template contains

Five services, which fits Railway's free trial (5 services per project) as well as the paid
plans. Only `crewtavo` gets a public domain. Secrets use Railway's template functions, so
every deploy generates its own and the person deploying fills in nothing.

### crewtavo

- **Source:** Docker image `ghcr.io/jviars/crewtavo:latest`, which always points at the newest
  release (built from the root `Dockerfile`; see [Updates](#updates)). **Auto updates:** on, as
  soon as ready.
- **Networking:** public HTTP on port **8080**; a generated `*.up.railway.app` domain.
- **Deploy:** healthcheck path `/api/health`, healthcheck timeout **600** seconds (a brand-new
  instance waits for its database and services, then sets up the schema).
- **Variables:**

| Name | Value |
| --- | --- |
| `PORT` | `8080` |
| `APP_URL` | `https://${{RAILWAY_PUBLIC_DOMAIN}}` |
| `JWT_SECRET` | `${{secret(64, "abcdef0123456789")}}` |
| `SUPABASE_DB_URL` | `postgres://postgres:${{db.POSTGRES_PASSWORD}}@${{db.RAILWAY_PRIVATE_DOMAIN}}:5432/postgres` |
| `SUPABASE_AUTH_URL` | `http://${{auth.RAILWAY_PRIVATE_DOMAIN}}:9999` |
| `SUPABASE_REST_URL` | `http://${{rest.RAILWAY_PRIVATE_DOMAIN}}:3000` |
| `SUPABASE_STORAGE_URL` | `http://${{storage.RAILWAY_PRIVATE_DOMAIN}}:5000` |
| `RAILWAY_HEALTHCHECK_TIMEOUT_SEC` | `600` |

- **Visitors' addresses:** nothing to set. On Railway, rate limits and quote approvals go by the
  `X-Real-IP` header Railway's edge sets on every request (`apps/api/src/lib/visitor.ts`), and the
  gateway passes the same address on to `auth` and `storage`. `CREWTAVO_VISITOR_IP` is for other
  proxies in front ([docs/deploy.md](../docs/deploy.md#visitors-addresses)); leave it out of the
  template.

### db

- **Source:** Docker image `ghcr.io/jviars/crewtavo-db:pg17`, which always points at the newest
  database image for Postgres 17 (built from `deploy/postgres/Dockerfile`: Supabase's Postgres
  image plus the role setup). **Auto updates:** on, overnight.
- **Volume:** mounted at `/var/lib/postgresql/data`.
- **Variables:** `POSTGRES_PASSWORD` = `${{secret(32, "abcdef0123456789")}}`, `POSTGRES_HOST` =
  `/var/run/postgresql`, `POSTGRES_PORT` = `5432`, `PGPORT` = `5432`, `POSTGRES_DB` = `postgres`.

### auth, rest, storage

Docker images, with the variables in `.railway/railway.ts` (every `${{...}}` there is a Railway
reference and works as written):

| Service | Image | Also |
| --- | --- | --- |
| `auth` | `public.ecr.aws/supabase/gotrue:v2.197.0` | |
| `rest` | `public.ecr.aws/supabase/postgrest:v16.4` | |
| `storage` | `public.ecr.aws/supabase/storage-api:v1.82.1` | Volume mounted at `/var/lib/storage`; `PORT` = `5000` (Railway otherwise sets `PORT` and Storage listens there) |

Keep these versions in step with `docker-compose.yml`, and test a version change there first.

`docker-compose.yml` takes the same images from Docker Hub (`supabase/gotrue`,
`postgrest/postgrest`, `supabase/storage-api`; the digests match), because anonymous pulls from
`public.ecr.aws` fail on GitHub's runners with "Data limit exceeded". The template stays on
`public.ecr.aws` for now: Railway pulls from its own network and hasn't hit that limit. If it ever
does, switch these three services to the Docker Hub names in the template and `.railway/railway.ts`.
Make sure their auto updates are off when you do: Railway can watch Docker Hub, and would otherwise
move them to versions nobody tested here.

## The live template

**https://railway.com/deploy/crewtavo?referralCode=pQ_v0d** (template code `crewtavo`, in the
`jviars's Projects` workspace on Railway; publishing it to the marketplace changed the code from
`Chzzxj`, and links with the old code no longer deploy). Edit it under **Workspace → Templates → Crewtavo**. The
template names the moving tags, so a release doesn't need a template change. The exception is a new
Postgres major version: point `db` at its new tag (`pg18`) so new deploys start on it.

## Rebuilding the template

**Generate Template from Project** refused the reference project ("Service crewtavo does not have a
source that can be used to generate a template"), so the template was built by hand in the
template editor. To do it again:

1. Railway → **Templates → New**.
2. **Add New → Docker Image** for each service (images above), renamed to exactly `crewtavo`, `db`,
   `auth`, `rest` and `storage`; the variables refer to services by name. Attach a volume to `db`
   at `/var/lib/postgresql/data` and to `storage` at `/var/lib/storage` (right-click the service →
   **Attach Volume**).
3. On `crewtavo` and `db`: **Settings → Source → Configure auto updates**, as listed above. (A
   tag that isn't a version number has no patch or minor choice: Railway redeploys whenever a new
   image is pushed to it.)
4. Paste each service's variables into its **Variables → Raw Editor**: the tables above, and
   `.railway/railway.ts` for auth, rest and storage, with `${{secret(...)}}` for `JWT_SECRET` and
   `POSTGRES_PASSWORD` so every deploy gets its own.
5. On `crewtavo`: **Settings → Networking → HTTP Proxy** on port `8080`, healthcheck path
   `/api/health`, and the variable `RAILWAY_HEALTHCHECK_TIMEOUT_SEC` = `600` (the editor has no
   timeout field).
6. **Apply** the changes, set the name, icon and description under the template's settings, and
   copy the URL from **Share**.
7. Deploy it once into a fresh project and check that `/api/setup` answers `"ready":true`.

A Railway trial account runs one instance at a time: its resource cap counts every project, so
delete an earlier test project before deploying the template again.

## The button

```html
<a href="https://railway.com/deploy/crewtavo?referralCode=pQ_v0d"><img src="https://railway.com/button.svg" alt="Deploy on Railway"></a>
```

## Updates

Instances update themselves to every release, whatever its number. `crewtavo` and `db` run images
that [`.github/workflows/release.yml`](../.github/workflows/release.yml) publishes to GitHub's
container registry when a version tag is pushed. Each image gets its version tag (`0.2.0`) and, when
it's the highest version so far, a moving tag the template points at: `crewtavo:latest`, and
`crewtavo-db:pg17` for the database. The template turns on Railway's
[image auto updates](https://docs.railway.com/deployments/image-auto-updates) for both, and for a
tag that isn't a version number Railway redeploys whenever a new image is pushed to it. It can take
several hours to notice (it caches what it finds in the registry), then it redeploys the service
and notifies the workspace's admins. The business does nothing, and nothing is paid for: the images
are public, and GitHub Actions and the registry are free for public repositories.

- **crewtavo** updates as soon as Railway sees a release. There's no downtime: the new version
  applies migrations as it starts and only takes traffic once `/api/health` answers, so a failed
  update leaves the previous version serving.
- **db** gets a new image only when `deploy/postgres` changed since the previous release, so most
  releases don't touch it. It updates overnight (02:00–06:00 UTC) and is down for about a minute
  while Postgres restarts. Its tag names the Postgres major version because that's the one change
  an instance can't take unattended: Postgres 18 can't open Postgres 17's data until it's upgraded.
  A release that moves to a new major publishes `pg18`, instances stay on `pg17` until their owner
  upgrades, and the release notes say how.
- **auth, rest and storage** stay on the versions the template pins: Railway can't watch their
  registry (`public.ecr.aws`). Changing one of them reaches new instances only.
- **Opting out:** an owner can turn updates off, or change when they install, under the service's
  **Settings → Source → Configure auto updates**. To stay on one version, they set the image to its
  version tag there (`ghcr.io/jviars/crewtavo:0.2.0`), which then takes only that version's patch
  updates, or none with auto updates off.

`https://<instance>/api/health` shows the version an instance runs, for example
`{"ok":true,"version":"0.1.1"}`; Railway itself only shows the tag, `latest`. The service's
**Deployments** list shows each update with the reason "autoupdate". In the first test (on version
tags, before the moving tags), an instance moved from 0.1.0 to 0.1.1 by itself 4 hours 16 minutes
after the release was published.

### Releasing

On a commit of `main` whose CI passed:

```bash
git tag v0.1.2
git push origin v0.1.2
```

The workflow publishes `ghcr.io/jviars/crewtavo:0.1.2` (and `crewtavo-db:0.1.2` when
`deploy/postgres` changed) in about five minutes, moves the moving tags to it, and instances pick it
up over the next several hours. Write release notes on GitHub for anything an owner should know.

The number is up to you (`0.1.2`, `0.2.0`, `1.0.0` all install the same way), but every release
reaches every instance unattended, so it has to work without anyone doing anything:

- **Migrations:** the previous version keeps serving while the new one migrates, so a migration has
  to leave the database usable by the previous version (add first, remove in a later release).
- **Settings:** a new variable needs a default. If the new version can't start without it, every
  instance stays on the previous version until its owner adds it.
- **Fixing a bad release:** release a fix as a new version. Moving `latest` back to an older image
  would run old code against a database the newer one has already migrated.

To publish a fix for owners who stayed on an older version, tag it from that version's code
(`v0.1.9` after `v0.2.0`). It gets its version tag only: the moving tags stay on the highest
version.

### Switching to the moving tags

Done on 2026-10-18: release `v0.1.3` created `crewtavo:latest` and `crewtavo-db:pg17`, the template
was switched to them, and so was the test instance (`pure-prosperity`).

Instances deployed before then run version tags with patch updates (`0.1.x`), and keep that setting
until their owner changes the image in each service's **Settings → Source** to the same tags.

Still to check: that an instance takes the next release by itself (`/api/health` shows the new
version). People have reported Railway missing a moved tag on GitHub's registry, so don't rely on it
before then.

### Why images

The template used to build `crewtavo` and `db` from this repository. A deploy like that is pinned to
the commit it started from: a business's Railway account can't deploy on pushes to someone else's
repository, and Railway's template updates only show **Update available** after someone presses
**Check for updates** in a service's settings, then ask for a confirmation per service. Every commit
counted as an update, a docs change included, and the database rebuilt and restarted with each one.

An instance deployed that way moves over in each service's **Settings → Source**: disconnect the
repository, connect the image `ghcr.io/jviars/crewtavo:latest` (or `crewtavo-db:pg17` on `db`),
and configure auto updates as above.
