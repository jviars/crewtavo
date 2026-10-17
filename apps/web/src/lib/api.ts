/**
 * Talking to the backend.
 *   - Supabase directly (supabase()) for reads and simple edits; row-level security protects data.
 *   - The Crewtavo API (api.get/post...) for business operations and anything needing a secret.
 * The SPA has no build-time settings: it loads /api/config at startup.
 */
import type { Database } from "@crewtavo/core/database";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { ApiError, friendlyDbError, OFFLINE } from "./errors";
import { startMonitoring, type MonitoringConfig } from "./monitoring";

export { ApiError } from "./errors";

export interface AppConfig {
  supabaseUrl: string;
  supabaseKey: string;
  /** One business per instance: no sign-up; the first person to open it creates the owner account. */
  singleCompany?: boolean;
  mapsBrowserKey: string | null;
  turnstileSiteKey: string | null;
  /** Error reporting (Sentry or GlitchTip), when the deployment sets CREWTAVO_SENTRY_DSN. */
  sentry: MonitoringConfig | null;
  features: { ai: boolean; payments: boolean; email: boolean; sms: boolean; roofInsights: boolean };
}

// Kept across hot reloads in development so modules that re-import this one keep a live client.
let configPromise: Promise<AppConfig> | null = import.meta.hot?.data.configPromise ?? null;
let client: SupabaseClient<Database> | null = import.meta.hot?.data.client ?? null;
let activeCompanyId: string | null = import.meta.hot?.data.activeCompanyId ?? null;
import.meta.hot?.dispose((data) => Object.assign(data, { configPromise, client, activeCompanyId }));

const CONFIG_KEY = "crewtavo.config";

export function loadConfig(): Promise<AppConfig> {
  configPromise ??= fetch("/api/config")
    .then(async (res) => {
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new ApiError(body.error ?? "Couldn't connect to Crewtavo. Try again in a moment.", res.status);
      }
      const config = (await res.json()) as AppConfig;
      try {
        localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
      } catch {
        // Private mode: no offline start, that's all.
      }
      return config;
    })
    .catch((error) => {
      // No signal: start with the settings from last time, so the crew's saved day still opens.
      if (!(error instanceof ApiError)) {
        try {
          const saved = JSON.parse(localStorage.getItem(CONFIG_KEY) ?? "null") as AppConfig | null;
          if (saved) return saved;
        } catch {
          // Nothing saved.
        }
      }
      configPromise = null; // allow a retry
      throw error instanceof ApiError ? error : new ApiError(OFFLINE, 0, "network");
    })
    .then((config) => {
      // A Crewtavo instance serves Supabase from its own address (apps/api/src/lib/stack.ts).
      config.supabaseUrl ||= window.location.origin;
      startMonitoring(config.sentry);
      client ??= createClient<Database>(config.supabaseUrl, config.supabaseKey);
      return config;
    });
  return configPromise;
}

/** The Supabase client. Available once loadConfig() has resolved (SessionProvider waits for it). */
export function supabase(): SupabaseClient<Database> {
  if (!client) throw new Error("Still loading. Try again in a moment.");
  return client;
}

export function setActiveCompany(id: string | null) {
  activeCompanyId = id;
}
export const activeCompany = () => activeCompanyId;

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  const { data } = client ? await client.auth.getSession() : { data: { session: null } };
  if (data.session) headers.Authorization = `Bearer ${data.session.access_token}`;
  if (activeCompanyId) headers["X-Company-Id"] = activeCompanyId;
  if (body !== undefined) headers["Content-Type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(`/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(OFFLINE, 0, "network");
  }
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) {
    const fallback = res.status >= 500 ? "Something went wrong on our end. Try again in a moment." : "Something went wrong. Try again.";
    throw new ApiError(json.error ?? fallback, res.status);
  }
  return json as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body: unknown = {}) => request<T>("POST", path, body),
  patch: <T>(path: string, body: unknown) => request<T>("PATCH", path, body),
  put: <T>(path: string, body: unknown) => request<T>("PUT", path, body),
  delete: <T>(path: string) => request<T>("DELETE", path),
};

type DbResult = { data: unknown; error: { message: string; code?: string; details?: string | null; hint?: string | null } | null };

/** Unwrap a supabase-js result in a react-query function; errors become friendly ApiErrors. */
export function unwrap<R extends DbResult>(result: R): NonNullable<R["data"]> {
  if (result.error) throw friendlyDbError(result.error);
  return result.data as NonNullable<R["data"]>;
}

/** Like unwrap, but a missing row is an error ("not found") rather than null. */
export function unwrapOne<R extends DbResult>(result: R, what = "That record"): NonNullable<R["data"]> {
  if (result.error) throw friendlyDbError(result.error);
  if (result.data == null) throw new ApiError(`${what} wasn't found. It may have been deleted.`, 404, "PGRST116");
  return result.data as NonNullable<R["data"]>;
}

/** Strip characters that break PostgREST filter syntax from free-text search. */
export const searchTerm = (value: string) => value.replace(/[%,()*\\:."'#]/g, " ").replace(/\s+/g, " ").trim();
