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

- **Source:** Docker image `ghcr.io/jviars/crewtavo:<version>`, the latest release (built from the
  root `Dockerfile`; see [Updates](#updates)). **Auto updates:** update to the latest tag, as soon
  as ready.
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

### db

- **Source:** Docker image `ghcr.io/jviars/crewtavo-db:<version>`, its latest release (built from
  `deploy/postgres/Dockerfile`: Supabase's Postgres image plus the role setup). **Auto updates:**
  update to the latest tag, overnight.
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

## The live template

**https://railway.com/deploy/Chzzxj?referralCode=pQ_v0d** (template code `Chzzxj`, in the
`jviars's Projects` workspace on Railway). Edit it under **Workspace → Templates → Crewtavo**. A
deploy starts from the image versions the template names and then updates itself, so the template
only needs a new version when a release needs something the old one can't upgrade from.

## Rebuilding the template

**Generate Template from Project** refused the reference project ("Service crewtavo does not have a
source that can be used to generate a template"), so the template was built by hand in the
template editor. To do it again:

1. Railway → **Templates → New**.
2. **Add New → Docker Image** for each service (images above), renamed to exactly `crewtavo`, `db`,
   `auth`, `rest` and `storage`; the variables refer to services by name. Attach a volume to `db`
   at `/var/lib/postgresql/data` and to `storage` at `/var/lib/storage` (right-click the service →
   **Attach Volume**).
3. On `crewtavo` and `db`: **Settings → Source → Configure auto updates**, as listed above. (The
   editor saves "Update to the latest tag" as patch updates; it doesn't offer minor ones.)
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
<a href="https://railway.com/deploy/Chzzxj?referralCode=pQ_v0d"><img src="https://railway.com/button.svg" alt="Deploy on Railway"></a>
```

## Updates

Instances update themselves. `crewtavo` and `db` run images that
[`.github/workflows/release.yml`](../.github/workflows/release.yml) publishes to GitHub's container
registry when a version tag is pushed, and the template turns on Railway's
[image auto updates](https://docs.railway.com/deployments/image-auto-updates) for both. Railway
checks the registry (it can take several hours to notice a new tag), moves the service to the next
patch version (`0.1.1` → `0.1.2`, never `0.2.0`) and redeploys it, then notifies the workspace's
admins. The business does nothing, and nothing is paid for: the images are public, and GitHub
Actions and the registry are free for public repositories.

- **crewtavo** updates as soon as Railway sees a release. There's no downtime: the new version
  applies migrations as it starts and only takes traffic once `/api/health` answers, so a failed
  update leaves the previous version serving.
- **db** gets a new image only when `deploy/postgres` changed since the previous release, so most
  releases don't touch it. It updates overnight (02:00–06:00 UTC) and is down for about a minute
  while Postgres restarts.
- **auth, rest and storage** stay on the versions the template pins: Railway can't watch their
  registry (`public.ecr.aws`). Changing one of them reaches new instances only.
- A new **minor or major version** (`0.2.0`, `1.0.0`) doesn't install itself: the template only
  sets up patch updates, and an instance keeps the setting it was deployed with. The owner moves to
  it by changing the image tag under **Settings → Source**, after reading the release notes.

`https://<instance>/api/health` shows the version an instance runs, for example
`{"ok":true,"version":"0.1.1"}`. In the first test, an instance moved from 0.1.0 to 0.1.1 by itself
4 hours 16 minutes after the release was published; the service's **Deployments** list shows it
with the reason "autoupdate".

### Releasing

On a commit of `main` whose CI passed:

```bash
git tag v0.1.1
git push origin v0.1.1
```

The workflow publishes `ghcr.io/jviars/crewtavo:0.1.1` (and `crewtavo-db:0.1.1` when
`deploy/postgres` changed) in about five minutes, and instances pick it up over the next several
hours. Write release notes on GitHub for anything an
owner should know. Pick the number by whether an instance can take it unattended:

- **Patch** (`0.1.1`, `0.1.2`...): every release that can, features and migrations included. The
  previous version keeps serving while the new one migrates, so a migration has to leave the
  database usable by the previous version (add first, remove in a later release).
- **Minor or major** (`0.2.0`, `1.0.0`): only for what the owner has to do by hand, such as a new
  required variable or a new Postgres major version (which needs its data upgraded). Say what to do
  in the release notes.

### Why images

The template used to build `crewtavo` and `db` from this repository. A deploy like that is pinned to
the commit it started from: a business's Railway account can't deploy on pushes to someone else's
repository, and Railway's template updates only show **Update available** after someone presses
**Check for updates** in a service's settings, then ask for a confirmation per service. Every commit
counted as an update, a docs change included, and the database rebuilt and restarted with each one.

An instance deployed that way moves over in each service's **Settings → Source**: disconnect the
repository, connect the image `ghcr.io/jviars/crewtavo:<version>` (or `crewtavo-db` on `db`), and
configure auto updates as above.
