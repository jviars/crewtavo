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

- **Source:** `jviars/crewtavo`, branch `main`. Builds the root `Dockerfile`.
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

- **Source:** `jviars/crewtavo`, **root directory `deploy/postgres`** (its `Dockerfile`: Supabase's
  Postgres image plus the role setup).
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
`jviars's Projects` workspace on Railway). Edit it under **Workspace → Templates → Crewtavo**;
deploys pick up the latest `main` of this repository.

## Rebuilding the template

**Generate Template from Project** refused the reference project ("Service crewtavo does not have a
source that can be used to generate a template"), so the template was built by hand in the
template editor. To do it again:

1. Railway → **Templates → New**.
2. **Add New → GitHub Repo** `https://github.com/jviars/crewtavo` twice, and rename the services
   `crewtavo` and `db`. On `db`, set **Root Directory** to `/deploy/postgres` and attach a volume at
   `/var/lib/postgresql/data` (right-click the service → **Attach Volume**).
3. **Add New → Docker Image** for `auth`, `rest` and `storage` (images above), renamed to exactly
   those names; the variables refer to services by name. Attach a volume to `storage` at
   `/var/lib/storage`.
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

How businesses receive new versions depends on how Railway links template deploys to this
repository: check what a deployed instance shows when `main` changes, and whether the business has
to approve the update. Migrations run by themselves on the next start either way.
