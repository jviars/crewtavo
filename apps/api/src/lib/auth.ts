import { isRole, memberPermissions, type Permission, type Role } from "@crewtavo/core";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../env";
import { allowsChanges, ASSISTANT_READ_ONLY, isRead } from "./assistants";
import { dbError, HttpError, uuid } from "./http";
import { userClient } from "./supabase";

export function bearerToken(header: string | undefined): string | null {
  const match = header?.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

/**
 * Verifies the Supabase access token (signature, expiry) and attaches a client that acts as the
 * user. Works for browser sessions and for MCP access tokens from Supabase's OAuth server; an AI
 * assistant's token only reads, unless the person allowed it to change things (lib/assistants.ts).
 */
export const requireUser = createMiddleware<AppEnv>(async (c, next) => {
  const token = bearerToken(c.req.header("authorization"));
  if (!token) throw new HttpError(401, "Sign in to continue.");
  const db = userClient(c.env, token);
  const { data, error } = await db.auth.getClaims(token);
  const sub = data?.claims?.sub;
  if (error || !sub) throw new HttpError(401, "Your session has expired. Sign in again.");
  const client = typeof data.claims.client_id === "string" && data.claims.client_id ? data.claims.client_id : null;
  if (client && !isRead(c.req.method) && !(await allowsChanges(db, client))) throw new HttpError(403, ASSISTANT_READ_ONLY);
  c.set("userId", sub);
  c.set("token", token);
  c.set("db", db);
  await next();
});

/**
 * Requires membership in the company named by the X-Company-Id header, optionally with one of
 * `roles` and a role that includes `permission`. Postgres RLS enforces the same rules; this gives
 * clear errors before any work starts.
 */
export function requireCompany(roles?: readonly Role[], permission?: Permission) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const companyId = c.req.header("x-company-id");
    if (!companyId || !uuid.safeParse(companyId).success) throw new HttpError(400, "Choose a company first.");
    const { data, error } = await c.var.db
      .from("memberships")
      .select("role, role_id")
      .eq("company_id", companyId)
      .eq("user_id", c.var.userId)
      .eq("active", true)
      .maybeSingle();
    if (error) throw dbError(error);
    if (!data || !isRole(data.role)) throw new HttpError(403, "You're not a member of this company.");
    let custom: string[] | null = null;
    if (data.role_id) {
      const role = await c.var.db.from("company_roles").select("permissions").eq("id", data.role_id).maybeSingle();
      if (role.error) throw dbError(role.error);
      custom = role.data?.permissions ?? [];
    }
    const permissions = memberPermissions(data.role, custom);
    if ((roles && !roles.includes(data.role)) || (permission && !permissions.includes(permission))) {
      throw new HttpError(403, "You don't have permission to do that. Ask an admin if you need it.");
    }
    c.set("companyId", companyId);
    c.set("role", data.role);
    c.set("permissions", permissions);
    await next();
  });
}

/**
 * A one-time link from an email (invite, password reset, sign-in) that opens the app, which redeems
 * the token itself (supabase.auth.verifyOtp in apps/web/src/lib/session.tsx). Supabase's own
 * action_link instead bounces through its redirect allow-list and falls back to the project's Site
 * URL (localhost on a new project), so it breaks until someone edits the Supabase dashboard.
 * `welcome` shows the "set your password" screen for a person who was invited but never signed in.
 */
export function emailAuthLink(base: string, tokenHash: string, type: "invite" | "recovery" | "magiclink", welcome = false): string {
  const params = new URLSearchParams({ token_hash: tokenHash, type });
  if (welcome) params.set("welcome", "1");
  return `${base}/?${params}`;
}
