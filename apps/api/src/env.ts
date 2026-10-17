import type { Db } from "./lib/supabase";
import type { Permission, Role } from "@crewtavo/core";

/**
 * Configuration, from the server's environment (server.ts). In a Crewtavo instance, lib/stack.ts
 * fills in the Supabase settings from JWT_SECRET; in local development they come from .dev.vars.
 * Either Supabase key style works (publishable/secret or the legacy anon/service_role).
 */
export interface Env {
  SUPABASE_URL: string;
  SUPABASE_PUBLISHABLE_KEY?: string;
  SUPABASE_ANON_KEY?: string; // legacy name
  SUPABASE_SECRET_KEY?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string; // legacy name
  /**
   * Encrypts third-party tokens and signs client links: 32+ random bytes in base64, or any phrase of
   * 32+ characters. Optional: without it, a key is derived from the Supabase secret key.
   */
  ENCRYPTION_KEY?: string;
  /** Public URL of this deployment, e.g. https://ops.example.com. Defaults to the request origin. */
  APP_URL?: string;
  /**
   * Set by server.ts in stack mode (lib/stack.ts): this server is the gateway to the instance's own
   * Supabase services, and the instance belongs to one company (the first person becomes the owner).
   */
  CREWTAVO_GATEWAY?: string;
  CREWTAVO_SINGLE_COMPANY?: string;
  /** Shared secret for /api/cron/* (run a background task by hand, as a bearer token). */
  CRON_SECRET?: string;

  ANTHROPIC_API_KEY?: string;
  AI_MODEL?: string;

  GOOGLE_MAPS_BROWSER_KEY?: string;
  GOOGLE_MAPS_SERVER_KEY?: string;

  QUICKBOOKS_CLIENT_ID?: string;
  QUICKBOOKS_CLIENT_SECRET?: string;
  QUICKBOOKS_ENVIRONMENT?: "sandbox" | "production";
  ZOHO_CLIENT_ID?: string;
  ZOHO_CLIENT_SECRET?: string;
  ZOHO_ACCOUNTS_URL?: string; // https://accounts.zoho.com (or .eu, .in, .com.au ...)
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;

  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  TWILIO_FROM_NUMBER?: string;
  /** Development only: deliver email and texts to a local Mailpit inbox (e.g. http://localhost:56324). */
  MAILPIT_URL?: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;

  /** Error reporting: a Sentry DSN, or a self-hosted GlitchTip DSN. Unset turns reporting off. */
  CREWTAVO_SENTRY_DSN?: string;
  /** Send the web app's errors to a different project (defaults to CREWTAVO_SENTRY_DSN). */
  CREWTAVO_SENTRY_WEB_DSN?: string;
  /** Shown on each report, e.g. "staging". Defaults to "production". */
  CREWTAVO_SENTRY_ENVIRONMENT?: string;
}

export interface Vars {
  userId: string;
  token: string;
  /** Supabase client acting as the signed-in user: RLS applies to everything it does. */
  db: Db;
  companyId: string;
  role: Role;
  /** Areas the member's role includes (see packages/core/src/roles.ts). */
  permissions: Permission[];
}

export type AppEnv = { Bindings: Env; Variables: Vars };

const normalized = new WeakMap<object, Env>();

/**
 * Settings as the app reads them. A blank value counts as unset (an empty line copied from
 * .env.example, or a field left empty in a deploy form), and APP_URL falls back to the address the
 * platform gives the deployment, so emails sent by background tasks have working links.
 */
export function readEnv(source: object): Env {
  const cached = normalized.get(source);
  if (cached) return cached;
  const env: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(source)) {
    if (typeof value === "string" && value.trim() === "") continue;
    env[name] = value;
  }
  env.APP_URL ??= platformUrl(env);
  normalized.set(source, env as unknown as Env);
  return env as unknown as Env;
}

function platformUrl(env: Record<string, unknown>): string | undefined {
  if (typeof env.RAILWAY_PUBLIC_DOMAIN === "string") return `https://${env.RAILWAY_PUBLIC_DOMAIN}`;
  return undefined;
}
