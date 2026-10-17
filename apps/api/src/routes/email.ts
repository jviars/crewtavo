/**
 * Settings → Email: connect the company's own mailbox (Gmail, Google Workspace, Zoho, Microsoft 365,
 * Yahoo, iCloud or any SMTP server, with an app password) or its Resend key. Saving signs in and
 * sends a test email first, so a connected mailbox is one that works. The password or key is
 * encrypted with ENCRYPTION_KEY and never sent back to the browser.
 */
import { ADMINS, MAIL_PRESETS, mailPreset } from "@crewtavo/core";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import type { AppEnv } from "../env";
import { requireCompany, requireUser } from "../lib/auth";
import { encryptJson } from "../lib/crypto";
import { renderEmail } from "../lib/email";
import { dbError, HttpError, must, readJson } from "../lib/http";
import { emailConfigured, forgetMailbox, loadMailbox, sendEmail, sendWithMailbox, type MailboxSecret, type MailboxSettings } from "../lib/notify";
import { smtpSend, SmtpError } from "../lib/smtp";
import { adminClient } from "../lib/supabase";

export const email = new Hono<AppEnv>();

/** Admins with the Apps or Settings area set up the company's email. */
const emailAdmin = createMiddleware<AppEnv>(async (c, next) => {
  if (c.var.role !== "owner" && !c.var.permissions.some((p) => p === "apps" || p === "settings")) {
    throw new HttpError(403, "Ask an owner to connect the company's email.");
  }
  await next();
});
const requireEmailAdmin = [requireUser, requireCompany(ADMINS), emailAdmin] as const;

const PRESET_IDS = MAIL_PRESETS.map((p) => p.id) as [string, ...string[]];

email.get("/email", ...requireEmailAdmin, async (c) => {
  const { data: row, error } = await adminClient(c.env)
    .from("integrations")
    .select("status, settings, last_error, connected_at")
    .eq("company_id", c.var.companyId)
    .eq("provider", "email")
    .maybeSingle();
  if (error) throw dbError(error);
  return c.json({
    mailbox: row && row.status !== "disconnected" ? { ...(row.settings as unknown as MailboxSettings), status: row.status, last_error: row.last_error, connected_at: row.connected_at } : null,
    // What happens without a mailbox: the install's own Resend account, the dev inbox, or nothing.
    fallback: c.env.RESEND_API_KEY && c.env.EMAIL_FROM ? "server" : c.env.MAILPIT_URL ? "dev" : null,
  });
});

const connectSchema = z.object({
  preset: z.enum(PRESET_IDS),
  host: z.string().trim().toLowerCase().min(3).max(200).regex(/^[a-z0-9.-]+$/, "host").optional(),
  port: z.number().int().min(1).max(65535).optional(),
  security: z.enum(["tls", "starttls"]).optional(),
  username: z.string().trim().max(200).optional(),
  /** Leave out to keep the saved password (changing only the name or from address). */
  password: z.string().max(500).optional(),
  api_key: z.string().trim().max(500).optional(),
  from_email: z.email(),
  from_name: z.string().trim().max(120).nullable().optional(),
});

email.put("/email", ...requireEmailAdmin, async (c) => {
  const body = await readJson(c, connectSchema);
  const preset = mailPreset(body.preset)!;
  const saved = await loadMailbox(c.env, c.var.companyId).catch(() => null);
  const company = must(await c.var.db.from("companies").select("name, email").eq("id", c.var.companyId).maybeSingle());
  const me = must(await c.var.db.from("profiles").select("email").eq("user_id", c.var.userId).maybeSingle());

  let settings: MailboxSettings;
  let secret: MailboxSecret;
  if (preset.kind === "resend") {
    const apiKey = body.api_key || (saved?.settings.kind === "resend" ? saved.secret.api_key : undefined);
    if (!apiKey) throw new HttpError(400, "Paste your Resend API key.");
    settings = { preset: preset.id, kind: "resend", from_email: body.from_email.toLowerCase(), from_name: body.from_name || null };
    secret = { api_key: apiKey };
  } else {
    const host = body.host || preset.host;
    const port = body.port || preset.port;
    const security = body.security || preset.security || "tls";
    if (!host || !port) throw new HttpError(400, "Add the mail server and port.");
    const username = (body.username || body.from_email).trim();
    // Google shows app passwords in groups of four; the spaces aren't part of it.
    const typed = preset.id === "gmail" || preset.id === "google_workspace" ? body.password?.replace(/\s+/g, "") : body.password;
    const password = typed || (saved?.settings.kind === "smtp" && saved.settings.username === username && saved.settings.host === host ? saved.secret.password : undefined);
    if (!password) throw new HttpError(400, `Paste the ${preset.passwordLabel.toLowerCase()}.`);
    settings = { preset: preset.id, kind: "smtp", host, port, security, username, from_email: body.from_email.toLowerCase(), from_name: body.from_name || null };
    secret = { password };
    // Sign in first: a wrong password should say so plainly, before anything is saved.
    try {
      await smtpSend({ host, port, security, username, password }, null);
    } catch (error) {
      throw new HttpError(400, error instanceof SmtpError ? error.message : "Couldn't sign in to the mail server.");
    }
  }

  // Then a real test email to the person setting it up, which proves the whole path works.
  const to = me.email;
  if (to) {
    const result = await sendWithMailbox(settings, secret, {
      to,
      subject: `Email is connected for ${company.name}`,
      ...renderEmail({ companyName: company.name, text: `This is a test from Crewtavo.\n\nQuotes, invoices, reminders and team notifications for ${company.name} will now be sent from ${settings.from_email}. Replies go to ${company.email || settings.from_email}.` }),
      replyTo: company.email ?? undefined,
      fromName: company.name,
    });
    if (!result.sent) throw new HttpError(400, result.reason ?? "The test email wasn't sent.");
  }

  const admin = adminClient(c.env);
  const { error } = await admin.from("integrations").upsert({
    company_id: c.var.companyId,
    provider: "email",
    status: "connected",
    account_label: settings.from_email,
    settings: settings as never,
    connected_by: c.var.userId,
    connected_at: new Date().toISOString(),
    last_error: null,
  });
  if (error) throw dbError(error);
  const { error: secretError } = await admin
    .from("integration_secrets")
    .upsert({ company_id: c.var.companyId, provider: "email", ciphertext: await encryptJson(c.env, secret), updated_at: new Date().toISOString() });
  if (secretError) throw dbError(secretError);
  forgetMailbox(c.var.companyId);
  return c.json({ connected: true, test_sent_to: to ?? null });
});

email.post("/email/test", ...requireEmailAdmin, async (c) => {
  const body = await readJson(c, z.object({ to: z.email().optional() }));
  const me = must(await c.var.db.from("profiles").select("email").eq("user_id", c.var.userId).maybeSingle());
  const company = must(await c.var.db.from("companies").select("name, email").eq("id", c.var.companyId).maybeSingle());
  const to = body.to ?? me.email;
  if (!to) throw new HttpError(400, "Add an address to send the test to.");
  forgetMailbox(c.var.companyId);
  const result = await sendEmail(
    c.env,
    { to, subject: `Test email from ${company.name}`, ...renderEmail({ companyName: company.name, text: "This is a test from Crewtavo. If you can read it, email is working." }), replyTo: company.email ?? undefined, fromName: company.name },
    c.var.companyId,
  );
  if (!result.sent) throw new HttpError(400, result.reason ?? "The test email wasn't sent.");
  return c.json({ sent: true, to });
});

email.delete("/email", ...requireEmailAdmin, async (c) => {
  const { error } = await adminClient(c.env).from("integrations").delete().eq("company_id", c.var.companyId).eq("provider", "email");
  if (error) throw dbError(error);
  forgetMailbox(c.var.companyId);
  return c.json({ connected: false, fallback: emailConfigured(c.env) });
});
