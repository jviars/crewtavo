/** Public config, the signed-in user, onboarding (company + trade preset), the license and team invites. */
import { ADMINS, getPreset, isRole, memberPermissions, presetSummaries, ROLE_LABELS, ROLES, TERMS_VERSION, type Role, type TradePreset } from "@crewtavo/core";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { emailAuthLink, requireCompany, requireUser } from "../lib/auth";
import { appUrl, asJson, clientIp, dbError, HttpError, must, readJson, uuid } from "../lib/http";
import { renderEmail } from "../lib/email";
import { allow } from "../lib/limit";
import { emailConfigured, loadMailbox, sendEmail, smsConfigured } from "../lib/notify";
import { adminClient, publishableKey, type Db } from "../lib/supabase";

export const account = new Hono<AppEnv>();

/** Everything the SPA needs at startup, so it has no build-time environment variables. */
account.get("/config", (c) =>
  c.json(
    {
      // In a Crewtavo instance this server is the gateway, so the browser uses its own address ("").
      supabaseUrl: c.env.CREWTAVO_GATEWAY ? "" : c.env.SUPABASE_URL,
      supabaseKey: publishableKey(c.env),
      singleCompany: c.env.CREWTAVO_SINGLE_COMPANY === "1",
      // The Crewtavo License version that setting up a business agrees to (packages/core/src/terms.ts).
      termsVersion: TERMS_VERSION,
      mapsBrowserKey: c.env.GOOGLE_MAPS_BROWSER_KEY ?? null,
      turnstileSiteKey: c.env.TURNSTILE_SITE_KEY ?? null,
      // Error reporting for the web app (DSNs are meant to be public).
      sentry:
        c.env.CREWTAVO_SENTRY_WEB_DSN || c.env.CREWTAVO_SENTRY_DSN
          ? { dsn: c.env.CREWTAVO_SENTRY_WEB_DSN || c.env.CREWTAVO_SENTRY_DSN, environment: c.env.CREWTAVO_SENTRY_ENVIRONMENT || "production" }
          : null,
      features: {
        ai: Boolean(c.env.ANTHROPIC_API_KEY),
        payments: Boolean(c.env.STRIPE_SECRET_KEY),
        email: emailConfigured(c.env),
        sms: smsConfigured(c.env),
        devMail: Boolean(c.env.MAILPIT_URL && !c.env.RESEND_API_KEY),
        roofInsights: Boolean(c.env.GOOGLE_MAPS_SERVER_KEY),
      },
    },
    200,
    { "Cache-Control": "public, max-age=300" },
  ),
);

account.get("/health", (c) => c.json({ ok: true }));

account.get("/presets", (c) => c.json(presetSummaries()));

account.get("/me", requireUser, async (c) => {
  const { db, userId } = c.var;
  const [profile, memberships] = await Promise.all([
    db.from("profiles").select("user_id, email, full_name, phone, avatar_url, color").eq("user_id", userId).maybeSingle(),
    db
      .from("memberships")
      .select("role, role_id, company:companies(id, name, slug, trade_preset, timezone, currency, settings)")
      .eq("user_id", userId)
      .eq("active", true),
  ]);
  const rows = must(memberships);
  const roleIds = rows.map((m) => m.role_id).filter((id): id is string => Boolean(id));
  const roles = roleIds.length ? must(await db.from("company_roles").select("id, name, permissions").in("id", roleIds)) : [];
  const byId = new Map(roles.map((r) => [r.id, r]));
  // Which companies send email from their own mailbox (Settings → Email); integrations is admin-only.
  const companyIds = rows.map((m) => (m.company as { id: string } | null)?.id).filter((id): id is string => Boolean(id));
  // ...and which have agreed to the current license (only owners and admins can read agreements).
  const [mailboxes, agreements] = companyIds.length
    ? await Promise.all([
        adminClient(c.env).from("integrations").select("company_id").eq("provider", "email").neq("status", "disconnected").in("company_id", companyIds),
        adminClient(c.env).from("terms_acceptances").select("company_id").eq("version", TERMS_VERSION).in("company_id", companyIds),
      ]).then(([mail, terms]) => [must(mail), must(terms)])
    : [[], []];
  const withMailbox = new Set(mailboxes.map((r) => r.company_id));
  const agreed = new Set(agreements.map((r) => r.company_id));
  return c.json({
    profile: must(profile, "Profile not found."),
    memberships: rows.map((m) => {
      const custom = m.role_id ? byId.get(m.role_id) : undefined;
      return {
        role: m.role,
        company: m.company,
        role_name: custom?.name ?? ROLE_LABELS[m.role as Role],
        permissions: memberPermissions(m.role as Role, custom ? custom.permissions : null),
        email_connected: withMailbox.has((m.company as { id: string } | null)?.id ?? ""),
        terms_accepted: agreed.has((m.company as { id: string } | null)?.id ?? ""),
      };
    }),
  });
});

account.patch("/me", requireUser, async (c) => {
  const body = await readJson(c, z.object({ full_name: z.string().trim().min(1).max(120).optional(), phone: z.string().max(40).nullable().optional() }));
  const { error } = await c.var.db.from("profiles").update(body).eq("user_id", c.var.userId);
  if (error) throw dbError(error);
  return c.json({ ok: true });
});

account.post("/companies", requireUser, async (c) => {
  const body = await readJson(
    c,
    z.object({
      name: z.string().trim().min(1).max(200),
      trade_preset: z.string().default("general"),
      timezone: z.string().default("America/New_York"),
      terms_version: z.string().max(40).optional(),
    }),
  );
  checkTermsVersion(body.terms_version);
  // A Crewtavo instance belongs to one business; everyone after the owner joins it by invite.
  if (c.env.CREWTAVO_SINGLE_COMPANY === "1") {
    const { data: existing } = await adminClient(c.env).from("companies").select("id").limit(1);
    if (existing?.length) throw new HttpError(403, "This Crewtavo already has a business. Ask its owner to invite you.");
  }
  let preset: TradePreset;
  try {
    preset = getPreset(body.trade_preset);
    new Intl.DateTimeFormat("en-US", { timeZone: body.timezone });
  } catch {
    throw new HttpError(400, "Unknown trade preset or time zone.");
  }
  const { db } = c.var;
  const { data: companyId, error } = await db.rpc("create_company", {
    p_name: body.name,
    p_trade_preset: preset.id,
    p_timezone: body.timezone,
  });
  if (error) throw dbError(error);
  await applyPreset(db, companyId as string, preset);
  // The business exists either way; if this fails, the owner is asked to agree again when it opens.
  const agreed = await db.rpc("accept_terms", { p_company: companyId as string, p_version: TERMS_VERSION });
  if (agreed.error) console.error("Couldn't record the license agreement", agreed.error.message);
  return c.json({ id: companyId }, 201);
});

/** The version the person read must be the one in force: an old page may show older terms. */
function checkTermsVersion(version: string | undefined) {
  if (!version) throw new HttpError(400, "Agree to the Crewtavo License to continue.");
  if (version !== TERMS_VERSION) throw new HttpError(409, "The Crewtavo License changed since this page opened. Reload the page, read it and agree again.");
}

/** Agreements to the license for this business, newest first (Settings → License). */
account.get("/terms", requireUser, requireCompany(ADMINS), async (c) => {
  const rows = must(
    await c.var.db
      .from("terms_acceptances")
      .select("id, full_name, email, role, version, accepted_at")
      .eq("company_id", c.var.companyId)
      .order("accepted_at", { ascending: false })
      .limit(50),
  );
  return c.json({ version: TERMS_VERSION, accepted: rows.some((r) => r.version === TERMS_VERSION), agreements: rows });
});

/** An owner or admin agrees to the current license on behalf of the business. */
account.post("/terms", requireUser, requireCompany(ADMINS), async (c) => {
  const body = await readJson(c, z.object({ version: z.string().max(40).optional() }));
  checkTermsVersion(body.version);
  const { error } = await c.var.db.rpc("accept_terms", { p_company: c.var.companyId, p_version: TERMS_VERSION });
  if (error) throw dbError(error);
  return c.json({ ok: true }, 201);
});

/** Load a trade preset into a new company. Runs as the new owner, so RLS still applies. */
async function applyPreset(db: Db, companyId: string, preset: TradePreset) {
  const formulas = new Map(preset.formulas.map((f) => [f.name, f]));
  const steps = [
    db.from("services").insert(
      preset.services.map((s, i) => {
        const formula = s.formula_name ? formulas.get(s.formula_name) : undefined;
        return {
          company_id: companyId,
          name: s.name,
          unit: s.unit,
          unit_price: s.unit_price,
          formula: formula?.formula ?? null,
          formula_target: formula?.sets ?? "quantity",
          sort: i,
        };
      }),
    ),
    db.from("checklist_templates").insert(
      preset.checklists.map((cl) => ({ company_id: companyId, name: cl.name, job_type: cl.job_type ?? null, items: asJson(cl.items) })),
    ),
    db.from("intake_forms").insert(
      preset.intake_forms.map((f) => ({
        company_id: companyId,
        slug: f.slug,
        name: f.name,
        kind: f.kind,
        questions: asJson(f.questions),
        lead_time_days: f.lead_time_days,
        slot_minutes: f.slot_minutes ?? null,
        max_per_day: f.max_per_day ?? null,
        requires_approval: f.requires_approval,
      })),
    ),
    db.from("sop_categories").insert(preset.sop_categories.map((name, i) => ({ company_id: companyId, name, sort: i }))),
    db
      .from("companies")
      .update({ settings: asJson({ job_types: preset.job_types, formulas: preset.formulas, weather_rules: preset.weather_rules, payment_terms_days: 30 }) })
      .eq("id", companyId),
  ];
  for (const result of await Promise.all(steps)) {
    if (result.error) throw dbError(result.error);
  }
}

account.get("/team", requireUser, requireCompany(), async (c) => {
  const { db, companyId } = c.var;
  const members = must(await db.from("memberships").select("user_id, role, role_id, active").eq("company_id", companyId));
  const profiles = must(
    await db.from("profiles").select("user_id, full_name, email, phone, color").in("user_id", members.map((m) => m.user_id)),
  );
  const byId = new Map(profiles.map((p) => [p.user_id, p]));
  // Pay rates are for the office (the column isn't readable by members directly); crews see names and roles.
  const rates = new Map<string, number | null>();
  if (["owner", "admin", "office"].includes(c.var.role)) {
    const rows = must(await adminClient(c.env).from("memberships").select("user_id, labor_rate").eq("company_id", companyId));
    for (const r of rows) rates.set(r.user_id, r.labor_rate);
  }
  return c.json(members.map((m) => ({ ...m, labor_rate: rates.get(m.user_id) ?? null, profile: byId.get(m.user_id) ?? null })));
});

account.post("/team/invite", requireUser, requireCompany(ADMINS, "team"), async (c) => {
  const body = await readJson(
    c,
    z.object({
      email: z.email(),
      full_name: z.string().trim().max(120).optional(),
      role: z.enum(ROLES).default("field_crew"),
      role_id: uuid.nullable().optional(),
    }),
  );
  if (!isRole(body.role)) throw new HttpError(400, "Pick a role.");
  if (body.role_id) must(await c.var.db.from("company_roles").select("id").eq("id", body.role_id).eq("company_id", c.var.companyId).maybeSingle(), "That role no longer exists.");
  const admin = adminClient(c.env);
  const email = body.email.toLowerCase();
  const base = appUrl(c);

  // Existing account? Add them. Otherwise create the account and a one-time link to set a password.
  // The link goes out from the company's own mailbox (Settings → Email), not Supabase's mailer,
  // which on hosted projects only reaches the project's own team.
  // By the email they sign in with: profile emails are only a copy, and `ilike` would treat "_" as a wildcard.
  const { data: existing } = await admin.rpc("user_id_for_email", { p_email: email });
  let userId = existing ?? undefined;
  let link: string | null = null;
  if (!userId) {
    const { data, error } = await admin.auth.admin.generateLink({ type: "invite", email, options: { data: { full_name: body.full_name ?? "" }, redirectTo: `${base}/` } });
    if (error || !data.user) {
      console.error("Invite failed", error);
      throw new HttpError(400, /already|registered/i.test(error?.message ?? "") ? "That email already has an account. Try again in a moment." : "Couldn't create the invite. Check the email address and try again.");
    }
    userId = data.user.id;
    link = emailAuthLink(base, data.properties.hashed_token, "invite");
  } else {
    // Invited before but never signed in (the first link expired, or never arrived): send a fresh
    // set-up link instead of "sign in as usual", since they don't have a password yet. Not when
    // another company has them too: the link sets their password, and it can come back to this admin.
    const { data: account } = await admin.auth.admin.getUserById(userId);
    const { data: elsewhere } = await admin.from("memberships").select("company_id").eq("user_id", userId).eq("active", true).neq("company_id", c.var.companyId).limit(1);
    if (account.user && !account.user.last_sign_in_at && !elsewhere?.length) {
      const { data } = await admin.auth.admin.generateLink({ type: "recovery", email, options: { redirectTo: `${base}/` } });
      if (data.properties?.hashed_token) link = emailAuthLink(base, data.properties.hashed_token, "recovery", true);
    }
  }

  // Inserted as the inviting admin, so RLS checks they may grant this role.
  const { error } = await c.var.db.from("memberships").upsert({ company_id: c.var.companyId, user_id: userId, role: body.role, role_id: body.role_id ?? null, active: true });
  if (error) throw dbError(error);

  const company = must(await c.var.db.from("companies").select("name, email").eq("id", c.var.companyId).maybeSingle());
  const inviter = (await c.var.db.from("profiles").select("full_name").eq("user_id", c.var.userId).maybeSingle()).data?.full_name || "Your team";
  const greeting = body.full_name ? `Hi ${body.full_name.split(/\s+/)[0]},\n\n` : "";
  const text = link
    ? `${greeting}${inviter} invited you to ${company.name} on Crewtavo, where you'll see your schedule, visits and time.\n\nSet up your account here (the link works once; if it has expired, ask for a new invite):\n\n${link}\n\nOn your phone, open it in your browser and use "Add to Home Screen" to keep Crewtavo one tap away.`
    : `${greeting}${inviter} gave you access to ${company.name} on Crewtavo. Sign in with your email and password as usual:\n\n${base}/`;
  const sent = await sendEmail(
    c.env,
    { to: email, subject: link ? `Join ${company.name} on Crewtavo` : `You now have access to ${company.name}`, ...renderEmail({ companyName: company.name, text }), replyTo: company.email ?? undefined, fromName: company.name },
    c.var.companyId,
  );
  // Not sent (email not connected yet): hand the link back so the admin can text it instead.
  return c.json({ user_id: userId, invited: !existing, emailed: sent.sent, reason: sent.sent ? null : sent.reason ?? null, link: sent.sent ? null : link }, 201);
});

/**
 * "Forgot password" and "Email me a sign-in link". The link is sent from the person's company
 * mailbox when it has one (or the install's own email), so it reaches everyone; without either it
 * falls back to Supabase's mailer. Always answers the same way, so it can't reveal who has an account.
 */
account.post("/auth/email-link", async (c) => {
  const body = await readJson(c, z.object({ email: z.email(), kind: z.enum(["recovery", "magiclink"]) }));
  const email = body.email.trim().toLowerCase();
  const ip = clientIp(c);
  if (!(await allow(c.env, `auth-link:ip:${ip}`, 20, 3600)) || !(await allow(c.env, `auth-link:email:${email}`, 4, 900))) {
    throw new HttpError(429, "Too many requests. Wait a few minutes and try again.");
  }
  const admin = adminClient(c.env);
  const redirectTo = `${appUrl(c)}/`;
  const { data: userId } = await admin.rpc("user_id_for_email", { p_email: email });
  if (!userId) return c.json({ sent: true });

  const { data: memberships } = await admin.from("memberships").select("company_id, company:companies(name, email)").eq("user_id", userId).eq("active", true);
  // A company's own mailbox sends the link only when the person belongs to that one company. With
  // several, any of them could have added this person, and whoever runs a mailbox can read the link.
  const only = memberships?.length === 1 ? memberships[0]! : null;
  const onlyCompany = only?.company as unknown as { name: string; email: string | null } | undefined;
  let sender: { id: string | null; name: string; email: string | null } | null = null;
  if (only && onlyCompany && (await loadMailbox(c.env, only.company_id).catch(() => null))) {
    sender = { id: only.company_id, name: onlyCompany.name, email: onlyCompany.email };
  }
  if (!sender && emailConfigured(c.env)) {
    sender = { id: null, name: onlyCompany?.name ?? "Crewtavo", email: onlyCompany?.email ?? null };
  }
  if (!sender) {
    const fallback = body.kind === "recovery"
      ? await admin.auth.resetPasswordForEmail(email, { redirectTo })
      : await admin.auth.signInWithOtp({ email, options: { shouldCreateUser: false, emailRedirectTo: redirectTo } });
    if (fallback.error) console.error("Supabase auth email failed", fallback.error.message);
    return c.json({ sent: true });
  }

  const { data, error } = await admin.auth.admin.generateLink({ type: body.kind, email, options: { redirectTo } });
  if (error || !data.properties?.hashed_token) {
    console.error("Couldn't create an auth link", error);
    return c.json({ sent: true });
  }
  const link = emailAuthLink(appUrl(c), data.properties.hashed_token, body.kind);
  const text = body.kind === "recovery"
    ? `Someone asked to reset the password for your ${sender.name} account on Crewtavo. Choose a new password here:\n\n${link}\n\nIf that wasn't you, ignore this email. Your password stays the same.`
    : `Here's your link to sign in to ${sender.name} on Crewtavo. It works once and expires soon:\n\n${link}\n\nIf you didn't ask for it, ignore this email.`;
  const result = await sendEmail(
    c.env,
    { to: email, subject: body.kind === "recovery" ? `Reset your ${sender.name} password` : `Your ${sender.name} sign-in link`, ...renderEmail({ companyName: sender.name, text }), replyTo: sender.email ?? undefined, fromName: sender.name },
    sender.id,
  );
  if (!result.sent) console.error("Auth email not sent", result.reason);
  return c.json({ sent: true });
});
