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

## Rebuilding the template

1. Stand up a real instance from this repository and check it end to end. In an empty Railway
   project: `cd .railway && npm install && railway link && railway config apply`, set the two
   `preserve()` secrets in the dashboard, generate the crewtavo domain, and open it. (Generate the
   domain before the first deploy, or redeploy `auth` afterwards: it reads the address when it
   starts. A template creates the domain first, so deploys from it don't need this.)
2. In that project, open **Settings → Generate Template from Project**.
3. In the template composer, replace the two secrets with the template functions above
   (`JWT_SECRET` on crewtavo, `POSTGRES_PASSWORD` on db), so every deploy gets its own. Service
   names must stay exactly `crewtavo`, `db`, `auth`, `rest` and `storage`, because the variables
   refer to each other by name.
4. Deploy the template once into a fresh project and go through the owner setup.
5. Publish it and copy its URL, `https://railway.com/deploy/<code>`.

## The button

```html
<a href="https://railway.com/deploy/<code>"><img src="https://railway.com/button.svg" alt="Deploy on Railway"></a>
```

## Updates

How businesses receive new versions depends on how Railway links template deploys to this
repository: check what a deployed instance shows when `main` changes, and whether the business has
to approve the update. Migrations run by themselves on the next start either way.
