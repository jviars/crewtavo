/**
 * One Crewtavo instance as Railway Infrastructure as Code: the same six services the Railway
 * template creates for each business (deploy/README.md explains the template), and the same as
 * docker-compose.yml locally. Use it to stand up an instance from this repo, then turn that project
 * into the template. From this folder:
 *
 *   npm install
 *   railway link              # an empty Railway project
 *   railway config plan       # preview
 *   railway config apply      # create or update the services
 *
 * The four secrets are kept with preserve(): set them once in the dashboard (deploy/README.md lists
 * them); in the template they're generated with ${{secret(...)}}.
 *
 * Only crewtavo is public. It forwards /auth/v1, /rest/v1, /storage/v1 and /realtime/v1 to the
 * others over the private network (apps/api/src/lib/stack.ts).
 */
import { defineRailway, github, group, image, preserve, project, service, volume } from "railway/iac";

// The public repository the template builds from; change it to deploy your own fork.
const REPO = "jviars/crewtavo";

export default defineRailway(() => {
  const dbData = volume("db-data");
  const storageData = volume("storage-data");

  // Supabase's Postgres with the roles the other services sign in as (deploy/postgres).
  const db = service("db", {
    source: github(REPO, { branch: "main" }),
    rootDirectory: "deploy/postgres",
    build: { builder: "DOCKERFILE", dockerfilePath: "Dockerfile", watchPatterns: ["deploy/postgres/**"] },
    volumeMounts: { "/var/lib/postgresql/data": dbData },
    env: {
      POSTGRES_PASSWORD: preserve(),
      POSTGRES_HOST: "/var/run/postgresql",
      POSTGRES_PORT: "5432",
      PGPORT: "5432",
      POSTGRES_DB: "postgres",
    },
  });
  // Railway resolves ${{service.VARIABLE}} inside any value, so connection strings can combine them.
  const dbHost = "${{db.RAILWAY_PRIVATE_DOMAIN}}";
  const dbPassword = "${{db.POSTGRES_PASSWORD}}";

  const app = service("crewtavo", {
    source: github(REPO, { branch: "main" }),
    build: { builder: "DOCKERFILE", dockerfilePath: "Dockerfile", watchPatterns: ["apps/**", "packages/**", "supabase/migrations/**", "scripts/**", "Dockerfile", "package-lock.json"] },
    healthcheck: "/api/health",
    // A new instance waits for its database and services, then sets up the schema.
    healthcheckTimeout: 600,
    // Public networking: generate a *.up.railway.app domain for this service (port 8080) in the dashboard.
    env: {
      PORT: "8080",
      // The address people use. Switching to your own domain means changing just this.
      APP_URL: "https://${{RAILWAY_PUBLIC_DOMAIN}}",
      JWT_SECRET: preserve(),
      SUPABASE_DB_URL: `postgres://postgres:${dbPassword}@${dbHost}:5432/postgres`,
      SUPABASE_AUTH_URL: "http://${{auth.RAILWAY_PRIVATE_DOMAIN}}:9999",
      SUPABASE_REST_URL: "http://${{rest.RAILWAY_PRIVATE_DOMAIN}}:3000",
      SUPABASE_STORAGE_URL: "http://${{storage.RAILWAY_PRIVATE_DOMAIN}}:5000",
      SUPABASE_REALTIME_URL: "http://${{realtime.RAILWAY_PRIVATE_DOMAIN}}:4000",
      // Optional features (email, texting, payments, maps...): add their variables here.
    },
  });
  const publicUrl = "${{crewtavo.APP_URL}}";
  const jwtSecret = "${{crewtavo.JWT_SECRET}}";

  const auth = service("auth", {
    source: image("public.ecr.aws/supabase/gotrue:v2.197.0"),
    env: {
      GOTRUE_API_HOST: "::",
      GOTRUE_API_PORT: "9999",
      API_EXTERNAL_URL: `${publicUrl}/auth/v1`,
      GOTRUE_DB_DRIVER: "postgres",
      GOTRUE_DB_DATABASE_URL: `postgres://supabase_auth_admin:${dbPassword}@${dbHost}:5432/postgres`,
      GOTRUE_SITE_URL: publicUrl,
      GOTRUE_URI_ALLOW_LIST: `${publicUrl}/**`,
      GOTRUE_DISABLE_SIGNUP: "true",
      GOTRUE_EXTERNAL_EMAIL_ENABLED: "true",
      GOTRUE_MAILER_AUTOCONFIRM: "true",
      GOTRUE_MAILER_OTP_EXP: "86400",
      GOTRUE_EXTERNAL_PHONE_ENABLED: "false",
      GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED: "false",
      GOTRUE_JWT_SECRET: jwtSecret,
      GOTRUE_JWT_EXP: "3600",
      GOTRUE_JWT_AUD: "authenticated",
      GOTRUE_JWT_ADMIN_ROLES: "service_role",
      GOTRUE_JWT_DEFAULT_GROUP_NAME: "authenticated",
      GOTRUE_OAUTH_SERVER_ENABLED: "true",
      GOTRUE_OAUTH_SERVER_AUTHORIZATION_PATH: "/oauth/consent",
      GOTRUE_OAUTH_SERVER_ALLOW_DYNAMIC_REGISTRATION: "true",
    },
  });

  const rest = service("rest", {
    source: image("public.ecr.aws/supabase/postgrest:v16.4"),
    env: {
      PGRST_DB_URI: `postgres://authenticator:${dbPassword}@${dbHost}:5432/postgres`,
      PGRST_DB_SCHEMAS: "public,graphql_public",
      PGRST_DB_EXTRA_SEARCH_PATH: "public,extensions",
      PGRST_DB_MAX_ROWS: "1000",
      PGRST_DB_ANON_ROLE: "anon",
      PGRST_DB_USE_LEGACY_GUCS: "false",
      PGRST_JWT_SECRET: jwtSecret,
      PGRST_APP_SETTINGS_JWT_EXP: "3600",
      PGRST_SERVER_HOST: "*",
    },
  });

  const storage = service("storage", {
    source: image("public.ecr.aws/supabase/storage-api:v1.82.1"),
    volumeMounts: { "/var/lib/storage": storageData },
    env: {
      AUTH_JWT_SECRET: jwtSecret,
      DATABASE_URL: `postgres://supabase_storage_admin:${dbPassword}@${dbHost}:5432/postgres`,
      POSTGREST_URL: "http://${{rest.RAILWAY_PRIVATE_DOMAIN}}:3000",
      STORAGE_BACKEND: "file",
      FILE_STORAGE_BACKEND_PATH: "/var/lib/storage",
      FILE_SIZE_LIMIT: "52428800",
      TENANT_ID: "crewtavo",
      REGION: "local",
      GLOBAL_S3_BUCKET: "crewtavo",
      REQUEST_ALLOW_X_FORWARDED_PATH: "true",
      ENABLE_IMAGE_TRANSFORMATION: "false",
      SERVER_HOST: "::",
    },
  });

  const realtime = service("realtime", {
    source: image("public.ecr.aws/supabase/realtime:v2.143.4"),
    env: {
      PORT: "4000",
      DB_HOST: dbHost,
      DB_PORT: "5432",
      DB_USER: "supabase_admin",
      DB_PASSWORD: dbPassword,
      DB_NAME: "postgres",
      DB_AFTER_CONNECT_QUERY: "SET search_path TO _realtime",
      DB_ENC_KEY: preserve(),
      API_JWT_SECRET: jwtSecret,
      METRICS_JWT_SECRET: jwtSecret,
      SECRET_KEY_BASE: preserve(),
      ERL_AFLAGS: "-proto_dist inet6_tcp",
      DNS_NODES: "''",
      RLIMIT_NOFILE: "10000",
      APP_NAME: "realtime",
      SEED_SELF_HOST: "true",
      RUN_JANITOR: "true",
    },
  });

  return project("crewtavo", {
    resources: [...group("Supabase services", [db, auth, rest, storage, realtime, dbData, storageData]), app],
  });
});
