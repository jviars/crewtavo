/** Public config, the signed-in user, onboarding (company + trade preset), the license and team invites. */
import { ADMINS, getPreset, isTimeZoneName, memberPermissions, OFFICE, presetSummaries, ROLE_LABELS, ROLES, TERMS_VERSION, type Role, type TradePreset } from "@crewtavo/core";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { platformOf } from "../lib/address";
import { emailAuthLink, requireCompany, requireUser } from "../lib/auth";
import { appUrl, asJson, dbError, HttpError, must, readJson, uuid } from "../lib/http";
import { renderEmail } from "../lib/email";
import { allow } from "../lib/limit";
import { checkMailbox, emailConfigured, loadMailbox, sendEmail, smsConfigured } from "../lib/notify";
import { adminClient, publishableKey, type Db } from "../lib/supabase";
import { timeRates } from "../services/payRates";
import { removePhoto, setPhoto } from "../services/photos";
import { invitePerson, inviteStatus, sendInvite, welcomeLink, type TeamScope } from "../services/team";
import { clientIp } from "../lib/visitor";
import { railwayNeeded, setRailwaySetup } from "../services/railway";

export const account = new Hono<AppEnv>();

/** The person's client and company, for the team service (services/team.ts). */
const teamScope = (c: Context<AppEnv>): TeamScope => ({ db: c.var.db, env: c.env, companyId: c.var.companyId, userId: c.var.userId, role: c.var.role, baseUrl: appUrl(c) });

/** Everything the SPA needs at startup, so it has no build-time environment variables. */
account.get("/config", (c) =>
  c.json(
    {
      // In a Crewtavo instance this server is the gateway, so the browser uses its own address ("").
      supabaseUrl: c.env.CREWTAVO_GATEWAY ? "" : c.env.SUPABASE_URL,
      supabaseKey: publishableKey(c.env),
      singleCompany: c.env.CREWTAVO_SINGLE_COMPANY === "1",
      // Where the instance runs (railway, compose or server), for setup steps that depend on it.
      platform: platformOf(c.env),
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
  // Which companies send email from their own mailbox (Settings → Email) and which added their own
  // Anthropic or fal.ai key (Apps), so email and AI are on for them; integrations is admin-only.
  const companyIds = rows.map((m) => (m.company as { id: string } | null)?.id).filter((id): id is string => Boolean(id));
  // ...and which have agreed to the current license (only owners and admins can read agreements).
  // ...and, on Railway, whether the owner still has to connect it (services/railway.ts).
  const [connected, agreements, railways] = companyIds.length
    ? await Promise.all([
        adminClient(c.env).from("integrations").select("company_id, provider").in("provider", ["email", "anthropic", "fal"]).neq("status", "disconnected").in("company_id", companyIds),
        adminClient(c.env).from("terms_acceptances").select("company_id").eq("version", TERMS_VERSION).in("company_id", companyIds),
        adminClient(c.env).from("integrations").select("company_id, status").eq("provider", "railway").in("company_id", companyIds),
      ]).then(([apps, terms, railway]) => [must(apps), must(terms), must(railway)] as const)
    : [[], [], []];
  const withMailbox = new Set(connected.filter((r) => r.provider === "email").map((r) => r.company_id));
  const withClaudeKey = new Set(connected.filter((r) => r.provider === "anthropic").map((r) => r.company_id));
  const withFal = new Set(connected.filter((r) => r.provider === "fal").map((r) => r.company_id));
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
        ai_connected: withClaudeKey.has((m.company as { id: string } | null)?.id ?? ""),
        // Apps → fal.ai: Find paving on the measuring map.
        fal_connected: withFal.has((m.company as { id: string } | null)?.id ?? ""),
        terms_accepted: agreed.has((m.company as { id: string } | null)?.id ?? ""),
        // Only the owner is asked to connect Railway at sign-in.
        railway_needed:
          m.role === "owner" &&
          railwayNeeded(c.env, railways.find((r) => r.company_id === (m.company as { id: string } | null)?.id) ?? null, (m.company as { settings?: unknown } | null)?.settings ?? null),
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
  } catch {
    throw new HttpError(400, "Unknown trade preset.");
  }
  if (!isTimeZoneName(body.timezone)) throw new HttpError(400, "Unknown time zone. Pick one from the list, like America/New_York.");
  const { db } = c.var;
  const { data: companyId, error } = await db.rpc("create_company", {
    p_name: body.name,
    p_trade_preset: preset.id,
    p_timezone: body.timezone,
  });
  if (error) throw dbError(error);
  await applyPreset(db, companyId as string, preset);
  // An instance on Railway: the next screen offers to connect Railway and set up a web address.
  if (c.env.CREWTAVO_SINGLE_COMPANY === "1" && platformOf(c.env) === "railway") await setRailwaySetup(adminClient(c.env), companyId as string, "pending");
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
          unit_cost: s.unit_cost ?? null,
          category: s.category ?? null,
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
    await db.from("profiles").select("user_id, full_name, email, phone, color, avatar_url").in("user_id", members.map((m) => m.user_id)),
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

/**
 * The pay rate each time entry is costed at, for job costs and reports: approved time at the rate
 * it was approved at, the rest at the person's current rate. For the time on some jobs, or the time
 * started between two moments. Like members' rates, the column isn't readable by members directly;
 * the office reads it here, with the job costs area.
 */
account.post("/time/rates", requireUser, requireCompany(OFFICE, "job_costs"), async (c) => {
  const body = await readJson(
    c,
    z.object({
      job_ids: z.array(uuid).min(1).max(300).optional(),
      from: z.iso.datetime({ offset: true }).optional(),
      to: z.iso.datetime({ offset: true }).optional(),
    }),
  );
  if (!body.job_ids && !(body.from && body.to)) throw new HttpError(400, "Choose the jobs or the dates.");
  // Approved time at the rate it was approved at, the rest at the person's current rate (services/payRates.ts).
  return c.json(await timeRates(adminClient(c.env), c.var.companyId, body));
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
  // The link comes back either way, so the admin can text it too (or instead, when email isn't connected).
  return c.json(await invitePerson(teamScope(c), body), 201);
});

/** Who on the team hasn't set up their account yet, and when their latest link went out. */
account.get("/team/invites", requireUser, requireCompany(ADMINS, "team"), async (c) => {
  const members = must(await c.var.db.from("memberships").select("user_id").eq("company_id", c.var.companyId).eq("active", true).neq("user_id", c.var.userId));
  const admin = adminClient(c.env);
  // One lookup per person: a team is a handful of people, and only Settings → People asks.
  const accounts = await Promise.all(members.map((m) => admin.auth.admin.getUserById(m.user_id)));
  return c.json(
    accounts.flatMap(({ data }) => {
      const user = data.user;
      if (!user || user.last_sign_in_at) return [];
      const sent = [user.invited_at, user.recovery_sent_at, user.created_at].filter((t): t is string => Boolean(t)).map((t) => new Date(t).getTime());
      return [{ user_id: user.id, sent_at: new Date(Math.max(...sent)).toISOString() }];
    }),
  );
});

/**
 * Someone's photo, shown in place of their initials (services/photos.ts). The browser sends it as a
 * small square JPEG, base64. People set their own; owners and admins who manage the team set anyone's
 * on it, and as with roles, only an owner sets another owner's.
 */
account.put("/team/:userId/photo", requireUser, requireCompany(), async (c) => {
  const targetId = await photoTarget(c);
  const body = await readJson(c, z.object({ photo: z.string().min(100).max(1_400_000).regex(/^[A-Za-z0-9+/]+={0,2}$/) }));
  if (!(await allow(c.env, `photo:${c.var.userId}`, 30, 3600))) throw new HttpError(429, "Too many photo changes. Wait a while and try again.");
  return c.json({ avatar_url: await setPhoto(adminClient(c.env), c.var.companyId, targetId, body.photo) });
});

account.delete("/team/:userId/photo", requireUser, requireCompany(), async (c) => {
  await removePhoto(adminClient(c.env), await photoTarget(c));
  return c.json({ ok: true });
});

/** Whose photo the request changes: the person's own, or a teammate's for those who manage the team. */
async function photoTarget(c: Context<AppEnv>): Promise<string> {
  const parsed = uuid.safeParse(c.req.param("userId"));
  if (!parsed.success) throw new HttpError(404, "That person isn't on your team.");
  const { companyId, userId, role, permissions } = c.var;
  if (parsed.data === userId) return userId;
  if (!ADMINS.includes(role) || !permissions.includes("team")) throw new HttpError(403, "You don't have permission to do that. Ask an admin if you need it.");
  const { data: member, error } = await c.var.db.from("memberships").select("role").eq("company_id", companyId).eq("user_id", parsed.data).maybeSingle();
  if (error) throw dbError(error);
  if (!member) throw new HttpError(404, "That person isn't on your team.");
  if (member.role === "owner" && role !== "owner") throw new HttpError(403, "Only an owner can do that for another owner.");
  return parsed.data;
}

/**
 * A new invite for someone who hasn't set up their account yet (the first link expired, or never
 * arrived): emailed when the company's email works, and the link comes back to copy either way.
 */
account.post("/team/:userId/invite-link", requireUser, requireCompany(ADMINS, "team"), async (c) => {
  const parsed = uuid.safeParse(c.req.param("userId"));
  if (!parsed.success) throw new HttpError(404, "That person isn't on your team.");
  const targetId = parsed.data;
  const { companyId, userId, role } = c.var;
  if (!(await allow(c.env, `invite-link:${userId}`, 20, 3600))) throw new HttpError(429, "Too many invites. Wait a while and try again.");

  const { data: member, error } = await c.var.db.from("memberships").select("role, active").eq("company_id", companyId).eq("user_id", targetId).maybeSingle();
  if (error) throw dbError(error);
  if (!member?.active) throw new HttpError(404, "That person isn't on your team.");
  // As with changing their role, only an owner acts for an owner.
  if (member.role === "owner" && role !== "owner") throw new HttpError(403, "Only an owner can do that for another owner.");
  const invite = await inviteStatus(c.env, companyId, targetId);
  if (invite.status !== "pending") {
    throw invite.status === "joined"
      ? new HttpError(400, "They've already set up their account. If they can't get in, use Reset password.")
      : new HttpError(403, "This person also uses Crewtavo with another business, so they need to use Forgot password on the sign-in screen.");
  }

  const link = await welcomeLink(c.env, appUrl(c), invite.email);
  const profile = (await c.var.db.from("profiles").select("full_name").eq("user_id", targetId).maybeSingle()).data;
  const sent = await sendInvite(teamScope(c), { email: invite.email, name: profile?.full_name }, link);
  return c.json({ emailed: sent.sent, reason: sent.sent ? null : sent.reason ?? null, link });
});

/**
 * "Forgot password" and "Email me a sign-in link". The link is sent from the person's company
 * mailbox when it has a working one (or the install's own email, which also takes over if the
 * mailbox fails), so it reaches everyone; without either it falls back to Supabase's mailer.
 * Always answers the same way, so it can't reveal who has an account.
 */
account.post("/auth/email-link", async (c) => {
  const body = await readJson(c, z.object({ email: z.email(), kind: z.enum(["recovery", "magiclink"]) }));
  const email = body.email.trim().toLowerCase();
  const ip = clientIp(c);
  if (!(await allow(c.env, `auth-link:ip:${ip}`, 20, 3600)) || !(await allow(c.env, `auth-link:email:${email}`, 4, 900))) {
    throw new HttpError(429, "Too many requests. Wait a few minutes and try again.");
  }
  const admin = adminClient(c.env);
  // A one-business instance that can't send email says so instead of pretending a link went out.
  // The answer is the same for every address, so it doesn't reveal who has an account.
  if (c.env.CREWTAVO_SINGLE_COMPANY === "1" && !emailConfigured(c.env)) {
    const { data: mailbox } = await admin.from("integrations").select("company_id").eq("provider", "email").eq("status", "connected").limit(1);
    if (!mailbox?.length) return c.json({ sent: false, reason: "email_off" });
  }
  const redirectTo = `${appUrl(c)}/`;
  const { data: userId } = await admin.rpc("user_id_for_email", { p_email: email });
  if (!userId) return c.json({ sent: true });

  const { data: memberships } = await admin.from("memberships").select("company_id, company:companies(name, email)").eq("user_id", userId).eq("active", true);
  // A company's own mailbox sends the link only when the person belongs to that one company. With
  // several, any of them could have added this person, and whoever runs a mailbox can read the link.
  const only = memberships?.length === 1 ? memberships[0]! : null;
  const onlyCompany = only?.company as unknown as { name: string; email: string | null } | undefined;
  // And only while it works: one whose sign-in failed (a changed or revoked app password, a refused
  // Resend key) would just fail again.
  const mailbox = only ? await loadMailbox(c.env, only.company_id).catch(() => null) : null;
  let sender: { id: string | null; name: string; email: string | null } | null = null;
  if (only && onlyCompany && mailbox && mailbox.status !== "error") {
    // Without the install's own email, only Supabase's mailer could take over from the mailbox, and
    // only before the link is made: making one starts its wait (a minute by default) before it will
    // email that person. So the mailbox has to sign in first.
    if (emailConfigured(c.env) || (await checkMailbox(c.env, only.company_id, mailbox))) {
      sender = { id: only.company_id, name: onlyCompany.name, email: onlyCompany.email };
    }
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
  const message = { to: email, subject: body.kind === "recovery" ? `Reset your ${sender.name} password` : `Your ${sender.name} sign-in link`, ...renderEmail({ companyName: sender.name, text }), replyTo: sender.email ?? undefined, fromName: sender.name };
  let result = await sendEmail(c.env, message, sender.id);
  // The company mailbox didn't take it: the install's own email still can (Supabase's mailer can't
  // now, see above).
  if (!result.sent && sender.id && emailConfigured(c.env)) {
    console.error("Auth email not sent from the company mailbox", result.reason);
    result = await sendEmail(c.env, message, null);
  }
  if (!result.sent) console.error("Auth email not sent", result.reason);
  return c.json({ sent: true });
});
