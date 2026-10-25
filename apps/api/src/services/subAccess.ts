/**
 * Subs' own sign-ins (docs/subcontractors-plan.md, phase B; supabase/migrations/20261025002002_sub_sign_ins.sql):
 * giving a sub a sign-in, a one-time link to sign in with (texted, emailed or copied), where it
 * stands, and taking it away. The office (owners, admins and office staff with the subs area) asks,
 * as itself, so row-level security decides which subs it can reach; the account and the membership
 * are made with the server's key, since from a browser the database lets nobody make a sub's sign-in.
 *
 * A sign-in Crewtavo makes for a sub is always on subLoginEmail(), the sub's stand-in address that
 * nothing ever emails (signing in needs one), marked with subLoginMark() in its app_metadata. The
 * sub's real phone and email stay on the office's record, behind the subs area: codes, links, offers
 * and pay notices go there (services/signInCodes.ts, services/delivery.ts), so the office's
 * corrections reach them, and the team, who see each other's profiles, never see a sub's contacts.
 * A tradesman who subs for two businesses gets a sign-in at each: one business's sub sign-in is never
 * handed to another, whose links and codes would then open the first one's too.
 *
 * Someone on this company's team can't also be its sub. Links go only to an account made here as this
 * sub's sign-in, and only while it isn't also someone's sign-in elsewhere: whoever opens a link gets
 * into the whole account, which isn't this company's to hand out (the same rule as Reset password and
 * invite links). Someone who already has their own Crewtavo account under the sub's email gets access
 * on it but no link, and the office doesn't see when they sign in or change their profile.
 *
 * Removing a sign-in also signs that phone out (public.end_sessions), so giving it back later doesn't
 * bring back an old or lost phone. Not for someone's own account: that would sign them out of their
 * own business too, and their removed membership already reaches nothing here.
 */
import { emailKey, isPlaceholderEmail, isSubLogin, signInLinkMessages, smsLink, SUB_LOGIN_MARK, subLoginEmail, subLoginMark, type SubAccessState } from "@crewtavo/core";
import type { Env } from "../env";
import { emailAuthLink } from "../lib/auth";
import { renderEmail } from "../lib/email";
import { dbError, HttpError, must } from "../lib/http";
import { sendEmail, sendSms, smsConfigured } from "../lib/notify";
import { adminClient, type Db } from "../lib/supabase";
import { logoImage } from "./logo";

/** Who's asking: their client, company and the address links go to. */
export interface SubAccessScope {
  db: Db;
  env: Env;
  companyId: string;
  baseUrl: string;
}

/**
 * Where a sub's sign-in stands. `shared`: they sign in with an account of their own (or one that's
 * also a sign-in for another business), so no link is made for it, and when they last signed in
 * isn't the office's to see.
 */
export interface SubAccess {
  state: SubAccessState;
  user_id: string | null;
  last_sign_in_at: string | null;
  shared: boolean;
}

interface Sub {
  id: string;
  name: string;
  contact_name: string | null;
  phone: string | null;
  email: string | null;
  active: boolean;
}

interface Login {
  user_id: string;
  active: boolean;
}

/** The sub, read as the office person asking: their role and area decide whether it's found at all. */
async function officeSub(s: SubAccessScope, subId: string): Promise<Sub> {
  return must(
    await s.db.from("subcontractors").select("id, name, contact_name, phone, email, active").eq("company_id", s.companyId).eq("id", subId).maybeSingle(),
    "Subcontractor not found.",
  );
}

/** The sub's sign-in at this company, the active one first (one per sub, for now). */
async function subLogin(admin: Db, companyId: string, subId: string): Promise<Login | null> {
  const rows = must(await admin.from("memberships").select("user_id, active").eq("company_id", companyId).eq("subcontractor_id", subId));
  return rows.find((m) => m.active) ?? rows[0] ?? null;
}

/** Whether the person has a sign-in for another business, on or off (an old one can be given back). */
async function signsInElsewhere(admin: Db, companyId: string, userId: string) {
  const { data, error } = await admin.from("memberships").select("company_id").eq("user_id", userId).neq("company_id", companyId).limit(1);
  if (error) throw dbError(error);
  return Boolean(data?.length);
}

async function account(env: Env, userId: string) {
  const { data, error } = await adminClient(env).auth.admin.getUserById(userId);
  if (error || !data.user) {
    console.error("Couldn't look up a sub's account", error);
    throw new HttpError(500, "Couldn't look up their sign-in. Try again in a moment.");
  }
  return data.user;
}

/** The account, and whether it's this sub's own sign-in, made here and nobody else's (links go only to those). */
async function ownLogin(s: SubAccessScope, subId: string, userId: string) {
  const [user, elsewhere] = await Promise.all([account(s.env, userId), signsInElsewhere(adminClient(s.env), s.companyId, userId)]);
  return { user, ours: isSubLogin(user.app_metadata, s.companyId, subId) && !elsewhere };
}

async function accessOf(s: SubAccessScope, sub: Pick<Sub, "id" | "active">, login: Login | null): Promise<SubAccess> {
  // A sub the office turned off can't sign in, whatever their membership says.
  if (!login?.active || !sub.active) return { state: "none", user_id: null, last_sign_in_at: null, shared: false };
  const { user, ours } = await ownLogin(s, sub.id, login.user_id);
  if (!ours) return { state: "active", user_id: null, last_sign_in_at: null, shared: true };
  return { state: user.last_sign_in_at ? "active" : "invited", user_id: login.user_id, last_sign_in_at: user.last_sign_in_at ?? null, shared: false };
}

/** Where one sub's sign-in stands. */
export async function subAccess(s: SubAccessScope, subId: string): Promise<SubAccess> {
  const sub = await officeSub(s, subId);
  return accessOf(s, sub, await subLogin(adminClient(s.env), s.companyId, sub.id));
}

/**
 * Whether the email on the sub's record is also on another of this company's subs' sign-ins, by the
 * same rule as finding whose address it is for a sign-in code by email (public.sub_sign_ins_for_email,
 * services/signInCodes.ts): then a code by email goes to neither, and the Sign-in card says so. A sign-in
 * a sub has of their own, or that's also someone's elsewhere, isn't one the code would go to, so it
 * doesn't count. Nor does one at another business: each business's sign-in gets its own code.
 */
export async function subCodeEmailShared(s: SubAccessScope, subId: string): Promise<{ shared: boolean }> {
  const sub = await officeSub(s, subId);
  const key = emailKey(sub.email);
  if (!key || isPlaceholderEmail(key)) return { shared: false };
  const { data, error } = await adminClient(s.env).rpc("sub_sign_ins_for_email", { p_email: key });
  if (error) throw dbError(error);
  return { shared: (data ?? []).some((r) => r.company_id === s.companyId && r.subcontractor_id !== sub.id) };
}

/** Where every sub's sign-in stands, for the Subs list. Subs that never had one aren't listed. */
export async function subAccessList(s: SubAccessScope): Promise<Array<SubAccess & { subcontractor_id: string }>> {
  // The subs this person can see, and the sign-ins the company has for subs.
  const [subs, logins] = await Promise.all([
    s.db.from("subcontractors").select("id, active").eq("company_id", s.companyId).limit(5000).then((r) => must(r)),
    adminClient(s.env).from("memberships").select("user_id, active, subcontractor_id").eq("company_id", s.companyId).eq("role", "subcontractor").then((r) => must(r)),
  ]);
  const visible = new Map(subs.map((x) => [x.id, x]));
  const bySub = new Map<string, Login>();
  for (const m of logins) if (m.subcontractor_id && visible.has(m.subcontractor_id) && (!bySub.has(m.subcontractor_id) || m.active)) bySub.set(m.subcontractor_id, m);
  return Promise.all([...bySub].map(async ([subId, login]) => ({ subcontractor_id: subId, ...(await accessOf(s, visible.get(subId)!, login)) })));
}

async function userIdForEmail(admin: Db, email: string): Promise<string | null> {
  const { data, error } = await admin.rpc("user_id_for_email", { p_email: email });
  if (error) throw dbError(error);
  return (data as string | null) ?? null;
}

/**
 * Someone's own Crewtavo account under the sub's email (not one Crewtavo made for a sub, here or at
 * another business): the sub signs in with it as they always do. Null when there's none. One
 * membership per person per company: refused when they're already someone here.
 */
async function ownAccountFor(s: SubAccessScope, admin: Db, sub: Sub): Promise<{ userId: string; email: string } | null> {
  const key = emailKey(sub.email);
  if (!key || isPlaceholderEmail(key)) return null;
  const userId = await userIdForEmail(admin, key);
  if (!userId) return null;
  const user = await account(s.env, userId);
  // A sign-in made for a sub is that sub's alone, never handed to another (theirs, or another
  // business's): this sub gets one of its own.
  if (isSubLogin(user.app_metadata)) return null;
  const { data: here, error } = await admin.from("memberships").select("role").eq("company_id", s.companyId).eq("user_id", userId).maybeSingle();
  if (error) throw dbError(error);
  if (here) {
    throw new HttpError(
      409,
      here.role === "subcontractor"
        ? "That email already signs in for another of your subs. Each sub needs their own email, or none."
        : "That email belongs to someone on your team. A sub needs their own email, or none.",
    );
  }
  return { userId, email: user.email ?? key };
}

/**
 * Gives the sub a sign-in, or gives back the one they had: theirs already, their own account under
 * their email (left as they have it: only the membership is added), or this sub's own, on its
 * stand-in address, marked as this sub's and named after them (an earlier one of theirs is used again).
 */
async function giveAccess(s: SubAccessScope, sub: Sub): Promise<{ userId: string; email: string }> {
  if (!sub.active) throw new HttpError(400, "This sub is turned off. Turn them back on to give them a sign-in.");
  const admin = adminClient(s.env);
  const name = (sub.contact_name || sub.name).trim();
  const existing = await subLogin(admin, s.companyId, sub.id);
  if (existing) {
    if (!existing.active) {
      const { error } = await admin.from("memberships").update({ active: true }).eq("company_id", s.companyId).eq("user_id", existing.user_id);
      if (error) throw dbError(error);
    }
    const user = await account(s.env, existing.user_id);
    return { userId: existing.user_id, email: user.email ?? subLoginEmail(sub.id) };
  }

  let login = await ownAccountFor(s, admin, sub);
  if (!login) {
    const email = subLoginEmail(sub.id);
    const earlier = await userIdForEmail(admin, email);
    if (earlier) {
      // This sub's own sign-in from before (its membership was removed): only ever this sub's.
      if (!isSubLogin((await account(s.env, earlier)).app_metadata, s.companyId, sub.id)) throw new HttpError(409, "Couldn't give them a sign-in. Ask your Crewtavo host to look into it.");
      login = { userId: earlier, email };
    } else {
      const { data, error } = await admin.auth.admin.createUser({
        email,
        email_confirm: true,
        user_metadata: { full_name: name },
        app_metadata: { [SUB_LOGIN_MARK]: subLoginMark(s.companyId, sub.id) },
      });
      if (error || !data.user) {
        console.error("Couldn't make a sub's sign-in", error);
        throw new HttpError(500, "Couldn't make their sign-in. Try again in a moment.");
      }
      login = { userId: data.user.id, email };
    }
    // Named after them; their phone and email stay on the office's record, not the profile the team sees.
    const { error: named } = await admin.from("profiles").update({ full_name: name }).eq("user_id", login.userId);
    if (named) throw dbError(named);
  }
  const { error } = await admin.from("memberships").insert({ company_id: s.companyId, user_id: login.userId, role: "subcontractor", subcontractor_id: sub.id, active: true });
  if (error) throw error.code === "23505" ? new HttpError(409, "That email belongs to someone on your team. A sub needs their own email, or none.") : dbError(error);
  return login;
}

/** Subs → the sub → Give a sign-in: access without a link (they may already have their own sign-in). */
export async function grantSubAccess(s: SubAccessScope, subId: string): Promise<SubAccess> {
  const sub = await officeSub(s, subId);
  await giveAccess(s, sub);
  return accessOf(s, sub, await subLogin(adminClient(s.env), s.companyId, sub.id));
}

/**
 * Subs → the sub → Remove sign-in. Their sign-in stops working here at once, and a sign-in made here
 * is signed out on every phone; their records stay. (A clock they left running stops: the database
 * does that as the membership turns off.)
 */
export async function removeSubAccess(s: SubAccessScope, subId: string): Promise<SubAccess> {
  const sub = await officeSub(s, subId);
  const admin = adminClient(s.env);
  const login = await subLogin(admin, s.companyId, sub.id);
  const ours = login ? (await ownLogin(s, sub.id, login.user_id)).ours : false;
  const { error } = await admin.from("memberships").update({ active: false }).eq("company_id", s.companyId).eq("subcontractor_id", sub.id);
  if (error) throw dbError(error);
  if (login && ours) {
    const { error: ended } = await admin.rpc("end_sessions", { p_user: login.user_id });
    if (ended) throw dbError(ended);
  }
  return accessOf(s, sub, await subLogin(admin, s.companyId, sub.id));
}

/**
 * Subs → the sub → Delete. The sub goes, as the office person asking deletes it (row-level security
 * and the database's own rules decide: a sub with pay on record isn't deleted, they're turned off),
 * and their sign-in with them: one Crewtavo made for them is signed out on every phone. The account
 * itself is kept, reaching nothing, as their time and the visits they did are on it; added again, the
 * sub gets a new sign-in. Someone's own account only loses its access here.
 */
export async function deleteSub(s: SubAccessScope, subId: string): Promise<{ deleted: true; signed_out: boolean }> {
  const sub = await officeSub(s, subId);
  const admin = adminClient(s.env);
  const logins = must(await admin.from("memberships").select("user_id").eq("company_id", s.companyId).eq("subcontractor_id", sub.id));
  const ours: string[] = [];
  for (const m of logins) if ((await ownLogin(s, sub.id, m.user_id)).ours) ours.push(m.user_id);
  const gone = must(await s.db.from("subcontractors").delete().eq("company_id", s.companyId).eq("id", sub.id).select("id"));
  if (!gone.length) throw new HttpError(404, "Subcontractor not found.");
  for (const userId of ours) {
    const { error } = await admin.rpc("end_sessions", { p_user: userId });
    if (error) throw dbError(error);
  }
  return { deleted: true, signed_out: ours.length > 0 };
}

export type SignInSend = "text" | "email" | "none";

export interface SignInLinkResult {
  access: SubAccess;
  /** The one-time link, to copy. Null when they sign in their own way (access.shared). */
  link: string | null;
  texted: boolean;
  emailed: boolean;
  /** When Crewtavo can't text it: opens Messages on the office's phone with the text filled in. */
  sms_link: string | null;
  /** What didn't go out, and why, in words for the office. */
  reason: string | null;
}

/**
 * Subs → the sub → Text sign-in link: gives the sub a sign-in if they have none, makes a one-time
 * link that signs them in, and texts it (Crewtavo's own number when texting is set up; otherwise an
 * sms: link for the office's phone) or emails it. The link comes back to copy either way.
 */
export async function sendSignInLink(s: SubAccessScope, subId: string, send: SignInSend): Promise<SignInLinkResult> {
  const sub = await officeSub(s, subId);
  const { email } = await giveAccess(s, sub);
  const admin = adminClient(s.env);
  const out: SignInLinkResult = { access: await accessOf(s, sub, await subLogin(admin, s.companyId, sub.id)), link: null, texted: false, emailed: false, sms_link: null, reason: null };
  const company = must(await s.db.from("companies").select("id, name, email, settings").eq("id", s.companyId).maybeSingle());
  // Only a sign-in made here for this sub, and nobody's own account (accessOf).
  if (out.access.shared) {
    out.reason = `They already have their own Crewtavo sign-in. They sign in as they usually do (or with an email link from the sign-in page) and ${company.name} is there.`;
    return out;
  }

  const { data, error } = await admin.auth.admin.generateLink({ type: "magiclink", email, options: { redirectTo: `${s.baseUrl}/` } });
  if (error || !data.properties?.hashed_token) {
    console.error("Couldn't make a sub's sign-in link", error);
    throw new HttpError(500, "Couldn't make the link. Try again in a moment.");
  }
  out.link = emailAuthLink(s.baseUrl, data.properties.hashed_token, "magiclink");
  const message = signInLinkMessages({ companyName: company.name, subName: sub.name, contactName: sub.contact_name, link: out.link });

  if (send === "text") {
    if (!sub.phone) out.reason = "Add a phone number for this sub first, or copy the link.";
    else if (!smsConfigured(s.env)) out.sms_link = smsLink(sub.phone, message.sms);
    else {
      const sent = await sendSms(s.env, { to: sub.phone, body: message.sms });
      out.texted = sent.sent;
      if (!sent.sent) {
        out.reason = sent.reason ?? "The text didn't go out.";
        out.sms_link = smsLink(sub.phone, message.sms);
      }
    }
  } else if (send === "email") {
    if (!sub.email || isPlaceholderEmail(sub.email)) out.reason = "Add an email address for this sub first, or copy the link.";
    else {
      const sent = await sendEmail(
        s.env,
        { to: sub.email, subject: message.subject, ...renderEmail({ companyName: company.name, logo: logoImage(s.baseUrl, company.id, company.settings), text: message.text }), replyTo: company.email ?? undefined, fromName: company.name },
        s.companyId,
      );
      out.emailed = sent.sent;
      if (!sent.sent) out.reason = sent.reason ?? "The email didn't go out.";
    }
  }
  return out;
}

/**
 * The subs with a sign-in, for putting them on a visit (the people picker on the schedule) and
 * naming them there: their sign-in, business name, contact and trade. `active` is false once their
 * sign-in was removed or the sub turned off: they can't be put on a visit then, but the office still
 * sees them on the visits they were on, and can take them off. For anyone who schedules the whole
 * team, who may not have the subs area, so it's read with the server's key and gives nothing else.
 */
export async function subLogins(env: Env, companyId: string) {
  const admin = adminClient(env);
  const logins = must(await admin.from("memberships").select("user_id, subcontractor_id, active").eq("company_id", companyId).eq("role", "subcontractor"));
  const ids = [...new Set(logins.map((m) => m.subcontractor_id).filter((id): id is string => Boolean(id)))];
  if (!ids.length) return [];
  const subs = must(await admin.from("subcontractors").select("id, name, contact_name, trade, active").eq("company_id", companyId).in("id", ids));
  const byId = new Map(subs.map((x) => [x.id, x]));
  return logins
    .flatMap((m) => {
      const sub = m.subcontractor_id ? byId.get(m.subcontractor_id) : undefined;
      return sub ? [{ user_id: m.user_id, subcontractor_id: sub.id, name: sub.name, contact_name: sub.contact_name, trade: sub.trade, active: Boolean(m.active && sub.active) }] : [];
    })
    .sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
}
