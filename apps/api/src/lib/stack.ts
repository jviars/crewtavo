/**
 * One Crewtavo instance per business: the app plus its own Supabase services (Auth, REST, Storage)
 * and database, in one Railway project or one docker compose file (deploy/README.md).
 *
 * This container is the only public address. It forwards /auth/v1, /rest/v1 and /storage/v1 to the
 * services over the private network, the way Supabase's API gateway does
 * (apps/api/src/server.ts), and it mints the anon and service keys from the shared JWT_SECRET, so the
 * template generates every secret and nobody copies keys around.
 *
 * Stack mode is on when JWT_SECRET is set. Without it, SUPABASE_URL and keys point at a Supabase
 * project as before (local development with `supabase start`).
 */
import { createHmac } from "node:crypto";

export interface Stack {
  auth: string;
  rest: string;
  storage: string;
}

type Vars = Record<string, string | undefined>;

export function stackServices(vars: Vars): Stack | null {
  if (!vars.JWT_SECRET) return null;
  return {
    // Docker compose service names; the Railway template sets the private addresses.
    auth: vars.SUPABASE_AUTH_URL || "http://auth:9999",
    rest: vars.SUPABASE_REST_URL || "http://rest:3000",
    storage: vars.SUPABASE_STORAGE_URL || "http://storage:5000",
  };
}

const base64url = (data: string | Buffer) => Buffer.from(data).toString("base64url");

/**
 * An API key for a Postgres role, as Supabase's self-hosting setup makes them: an HS256 JWT signed
 * with JWT_SECRET. Fixed dates, so the keys stay the same across restarts.
 */
export function apiKey(secret: string, role: "anon" | "service_role"): string {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ role, iss: "supabase", iat: 1_760_000_000, exp: 2_075_000_000 }));
  const signature = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

/**
 * The settings the rest of the app reads, filled in for stack mode: server-side Supabase clients go
 * through this server's own gateway, and the keys come from JWT_SECRET. Also turns on single-company
 * mode (one business per instance: the first person to open it becomes the owner).
 */
export function withStack(vars: Vars, port: number): Vars {
  if (!vars.JWT_SECRET) return vars;
  return {
    ...vars,
    SUPABASE_URL: `http://127.0.0.1:${port}`,
    SUPABASE_ANON_KEY: apiKey(vars.JWT_SECRET, "anon"),
    SUPABASE_SERVICE_ROLE_KEY: apiKey(vars.JWT_SECRET, "service_role"),
    SUPABASE_PUBLISHABLE_KEY: undefined,
    SUPABASE_SECRET_KEY: undefined,
    CREWTAVO_GATEWAY: "1",
    CREWTAVO_SINGLE_COMPANY: vars.CREWTAVO_SINGLE_COMPANY ?? "1",
  };
}
