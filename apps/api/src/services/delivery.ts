/**
 * Delivers notifications beyond the bell: email, text and phone push, by each person's choices
 * (Settings → Profile → Notifications). Runs every minute, about a minute after each is made so
 * quick changes have folded together; one already read in the app is skipped. One email and one text
 * per person per run, however many notifications there are. A sub on a sign-in Crewtavo made for
 * them is reached at the phone and email the office keeps on their record
 * (public.sub_notice_contacts), so the office's corrections reach them; a phone they put on their own
 * profile comes first for texts. Google reviews of 3 stars or more go by push only (byEmail), and 1 and
 * 2 stars come first.
 *
 * A notification is marked delivered after it has gone, not before
 * (20261112000540_notifications_sent_then_marked.sql). The batch is claimed for five minutes with a
 * token; each person's notifications are started right before sending (the claim renewed, and left
 * alone if another server has them by now), each channel that went is written down as it goes, and
 * at the end each notification is delivered, waits to be tried again (a provider that's down or
 * refusing the company's sign-in: after 2, 4, 8... minutes, 8 tries), or is failed with the reason
 * (an address or number that can't be sent to). A later try sends only by the channels still missing.
 */
import { byEmail, DEFAULT_NOTIFICATION_PREFS, isPlaceholderEmail, notificationTopic, type NotificationChannel, type NotificationTopic } from "@crewtavo/core";
import type { Env } from "../env";
import { renderEmail } from "../lib/email";
import { sendEmail, sendProblem, sendSms, smsConfigured } from "../lib/notify";
import { reportError } from "../lib/monitoring";
import { adminClient } from "../lib/supabase";
import { sendPush } from "../lib/webpush";

/** What has happened by each channel so far; a channel that isn't there is still to do. */
type Outcomes = Partial<Record<NotificationChannel, "sent" | "failed">>;

interface Row {
  id: string;
  company_id: string;
  user_id: string;
  kind: string;
  title: string;
  body: string | null;
  link: string | null;
  read_at: string | null;
  delivery_token: string | null;
}

/** As many as one run claims: each can be an email, a text and a few pushes, and the next run is a minute away. */
const BATCH = 200;

const CHANNEL_NAMES: Record<NotificationChannel, string> = { email: "Email", sms: "Text", push: "Push" };

export async function deliverNotifications(env: Env, options: { minAgeSeconds?: number } = {}) {
  const admin = adminClient(env);
  const { data, error } = await admin.rpc("claim_notification_deliveries", { p_min_age_seconds: options.minAgeSeconds ?? 45, p_limit: BATCH });
  if (error) throw new Error(error.message);
  const claimed = (data ?? []) as Row[];
  const counts = { claimed: claimed.length, email: 0, sms: 0, push: 0, failed: 0 };
  if (!claimed.length) return counts;
  // One token for the whole batch: only what this run still holds is marked with it.
  const token = claimed[0]!.delivery_token!;
  const settle = async (ids: { delivered?: string[]; retry?: string[]; failed?: string[] }, reason: string | null = null) => {
    const { error: settleError } = await admin.rpc("settle_notification_deliveries", {
      p_token: token, p_delivered: ids.delivered ?? [], p_retry: ids.retry ?? [], p_failed: ids.failed ?? [], p_error: reason ?? undefined,
    });
    if (settleError) throw new Error(settleError.message);
  };

  // Read in the app already: there's nothing to send.
  const read = claimed.filter((r) => r.read_at);
  if (read.length) await settle({ delivered: read.map((r) => r.id) });
  const rows = claimed.filter((r) => !r.read_at);
  if (!rows.length) return counts;

  const userIds = [...new Set(rows.map((r) => r.user_id))];
  const companyIds = [...new Set(rows.map((r) => r.company_id))];
  const [prefs, profiles, companies, devices, subContacts] = await Promise.all([
    admin.from("notification_prefs").select("company_id, user_id, email, sms, push").in("user_id", userIds),
    admin.from("profiles").select("user_id, email, phone, full_name").in("user_id", userIds),
    admin.from("companies").select("id, name, email").in("id", companyIds),
    admin.from("push_subscriptions").select("id, user_id, endpoint, p256dh, auth").in("user_id", userIds),
    // A sub's sign-in made by Crewtavo: the phone and email the office keeps for them, as they are now.
    admin.rpc("sub_notice_contacts", { p_users: userIds }),
  ]);
  // Without who they are and how they want to hear, nothing can be sent right. The batch is left as
  // it is, and is claimed again when its five minutes run out.
  const unread = [prefs, profiles, companies, devices].find((r) => r.error)?.error;
  if (unread) throw new Error(`Couldn't read who to notify: ${unread.message}`);
  if (subContacts.error) reportError(new Error(subContacts.error.message), { task: "notify", step: "sub_notice_contacts" });
  const prefsFor = (companyId: string, userId: string): Record<NotificationChannel, string[]> =>
    prefs.data?.find((p) => p.company_id === companyId && p.user_id === userId) ?? DEFAULT_NOTIFICATION_PREFS;
  const base = (env.APP_URL ?? "").replace(/\/$/, "");
  const url = (link: string | null) => (base && link ? `${base}${link}` : base || null);
  // Where several at once lead: a sub's job offers and pay to My jobs, Google reviews to Marketing →
  // Reviews, anything else home.
  const batchLink = (items: Row[]) => (items.every((i) => i.kind === "jobs") ? "/field/jobs" : items.every((i) => notificationTopic(i.kind) === "reviews") ? "/marketing?tab=reviews" : items.every((i) => notificationTopic(i.kind) === "social") ? "/marketing?tab=social" : "/");
  // Low ratings first: those are the reviews to answer before the rest. Otherwise as they came.
  const lowFirst = (items: Row[]) => [...items].sort((a, b) => Number(b.kind === "review_low") - Number(a.kind === "review_low"));

  // Each notice is one paragraph of the email, its title, words and link on their own lines: line
  // breaks typed into a notice (a sub's reason for turning down a job) are run together, so nothing
  // but the app's own link can stand alone as a paragraph and show as a button (lib/email.ts).
  const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

  const groups = new Map<string, Row[]>();
  for (const r of rows) groups.set(`${r.company_id}:${r.user_id}`, [...(groups.get(`${r.company_id}:${r.user_id}`) ?? []), r]);

  // A mailbox or text provider that just failed (refused the sign-in, or didn't answer) isn't asked
  // again for everyone else in this run: theirs wait for the next try, with the same reason.
  const emailDown = new Map<string, string>();
  let smsDown: string | null = null;

  for (const group of groups.values()) {
    const { company_id: companyId, user_id: userId } = group[0]!;
    // Still this run's? A slow batch can outlast its claim, and then another server has them. The
    // answer also says what has gone by each channel on an earlier try.
    const { data: held, error: startError } = await admin.rpc("start_notification_deliveries", { p_token: token, p_ids: group.map((i) => i.id) });
    if (startError) throw new Error(startError.message);
    const state = new Map((held ?? []).map((h) => [h.id, (h.delivery ?? {}) as Outcomes]));
    const items = group.filter((i) => state.has(i.id));
    if (!items.length) continue;

    // Why each didn't go: to try again later, or for good.
    const later = new Map<string, string[]>();
    const never = new Map<string, string[]>();
    const add = (to: Map<string, string[]>, ids: string[], channel: NotificationChannel, reason: string) => {
      for (const id of ids) to.set(id, [...(to.get(id) ?? []), `${CHANNEL_NAMES[channel]}: ${reason}`]);
    };
    // Written down the moment it's known, so a restart right after can't send it a second time.
    const note = async (ids: string[], channel: NotificationChannel, outcome: "sent" | "failed") => {
      const { error: noteError } = await admin.rpc("note_notification_channel", { p_token: token, p_ids: ids, p_channel: channel, p_outcome: outcome });
      if (noteError) throw new Error(noteError.message);
      for (const id of ids) state.set(id, { ...state.get(id), [channel]: outcome });
    };

    try {
      const company = companies.data?.find((c) => c.id === companyId);
      const person = profiles.data?.find((p) => p.user_id === userId);
      if (!company || !person) {
        await settle({ failed: items.map((i) => i.id) }, "Their account or the company is gone.");
        continue;
      }
      // A sub's own sign-in: email to the address on the office's record (its own is a stand-in), and
      // texts to the phone they put on their profile, else the record's. Everyone else: their account's.
      const sub = (subContacts.data ?? []).find((c) => c.company_id === companyId && c.user_id === userId);
      const emailTo = sub ? sub.email : person.email;
      const phoneTo = person.phone || sub?.phone || null;
      const chosen = prefsFor(companyId, userId);
      // What they chose to get by this channel, less what has gone (or been turned down for good) by it.
      const pick = (channel: NotificationChannel) =>
        lowFirst(items.filter((i) => !state.get(i.id)?.[channel] && chosen[channel].includes(notificationTopic(i.kind) as NotificationTopic) && (channel !== "email" || byEmail(i.kind))));

      const forEmail = pick("email");
      // Never to a sub's stand-in address.
      if (forEmail.length && emailTo && !isPlaceholderEmail(emailTo)) {
        const ids = forEmail.map((i) => i.id);
        const down = emailDown.get(companyId);
        if (down) {
          add(later, ids, "email", down);
        } else {
          const text = [
            forEmail.length === 1 ? "" : `${forEmail.length} updates from ${company.name}:`,
            ...forEmail.map((i) => [oneLine(i.title), i.body && i.body !== i.title ? oneLine(i.body) : null, url(i.link)].filter(Boolean).join("\n")),
            `You get these because of your notification settings. Change them in Crewtavo under Settings → Profile${base ? `: ${base}/settings?tab=profile` : "."}`,
          ].filter(Boolean).join("\n\n");
          const result = await sendEmail(
            env,
            { to: emailTo, subject: forEmail.length === 1 ? forEmail[0]!.title : `${forEmail.length} updates from ${company.name}`, ...renderEmail({ companyName: company.name, text }), replyTo: company.email ?? undefined, fromName: company.name },
            companyId,
          );
          const problem = result.sent ? null : sendProblem(result);
          const reason = result.reason ?? "The email didn't go.";
          if (result.sent) {
            counts.email++;
            await note(ids, "email", "sent");
          } else if (problem !== "unset") {
            // (With no email set up at all there's nothing to send with, so nothing to try again.)
            counts.failed++;
            if (problem === "recipient") {
              await note(ids, "email", "failed");
              add(never, ids, "email", reason);
            } else {
              emailDown.set(companyId, reason);
              add(later, ids, "email", reason);
            }
          }
        }
      }

      const forSms = pick("sms");
      if (forSms.length && phoneTo && smsConfigured(env)) {
        const ids = forSms.map((i) => i.id);
        if (smsDown) {
          add(later, ids, "sms", smsDown);
        } else {
          const first = forSms[0]!;
          const more = forSms.length > 1 ? ` (+${forSms.length - 1} more)` : "";
          const link = url(forSms.length > 1 ? batchLink(forSms) : first.link);
          const result = await sendSms(env, { to: phoneTo, body: `${company.name}: ${first.title}${more}${link ? ` ${link}` : ""}` });
          const reason = result.reason ?? "The text didn't go.";
          if (result.sent) {
            counts.sms++;
            await note(ids, "sms", "sent");
          } else {
            counts.failed++;
            if (sendProblem(result) === "recipient") {
              await note(ids, "sms", "failed");
              add(never, ids, "sms", reason);
            } else {
              smsDown = reason;
              add(later, ids, "sms", reason);
            }
          }
        }
      }

      const forPush = pick("push");
      const phones = (devices.data ?? []).filter((d) => d.user_id === userId);
      if (forPush.length && phones.length) {
        const contact = base.startsWith("https://") ? base : `mailto:${company.email || "notifications@crewtavo.invalid"}`;
        // Up to three separately; more than that, one summary.
        const messages = forPush.length <= 3
          ? forPush.map((i) => ({ ids: [i.id], message: { title: i.title, body: i.body && i.body !== i.title ? i.body : company.name, link: i.link ?? "/", tag: i.id } }))
          : [{ ids: forPush.map((i) => i.id), message: { title: `${forPush.length} updates from ${company.name}`, body: forPush.map((i) => i.title).slice(0, 4).join("\n"), link: batchLink(forPush), tag: `batch-${companyId}` } }];
        // A push has gone once one of their devices took it. One that no device took is tried again
        // when a push service was down or busy, and is failed when every device turned it away.
        const went = new Set<number>();
        const stuck = new Map<number, { status: number; again: boolean }>();
        for (const device of phones) {
          for (const [index, { message }] of messages.entries()) {
            const sent = await sendPush(env, device, message, contact);
            if (sent.gone) {
              await admin.from("push_subscriptions").delete().eq("id", device.id);
              break;
            }
            if (sent.ok) {
              counts.push++;
              went.add(index);
            } else {
              counts.failed++;
              const again = sent.status === 0 || sent.status === 429 || sent.status >= 500;
              stuck.set(index, { status: sent.status, again: again || Boolean(stuck.get(index)?.again) });
            }
          }
        }
        await admin.from("push_subscriptions").update({ last_sent_at: new Date().toISOString() }).eq("user_id", userId);
        const pushed = messages.filter((_, index) => went.has(index)).flatMap((m) => m.ids);
        if (pushed.length) await note(pushed, "push", "sent");
        for (const [index, { status, again }] of stuck) {
          if (went.has(index)) continue;
          const ids = messages[index]!.ids;
          if (!again) await note(ids, "push", "failed");
          add(again ? later : never, ids, "push", status ? `Their phone's push service turned it down (${status}).` : "Their phone's push service didn't answer.");
        }
      }
    } catch (err) {
      counts.failed++;
      reportError(err, { task: "notify" });
      // Whatever isn't written down as sent is tried again.
      const reason = err instanceof Error ? err.message : String(err);
      for (const i of items) later.set(i.id, [...(later.get(i.id) ?? []), reason]);
    }

    // One call for each different outcome. Usually everything for a person went, so it's one call.
    const outcomes = new Map<string, { kind: "delivered" | "retry" | "failed"; reason: string | null; ids: string[] }>();
    for (const i of items) {
      const reasons = [...(never.get(i.id) ?? []), ...(later.get(i.id) ?? [])];
      // Turned down for good by one channel on an earlier try: failed, with the reason kept from then.
      const kind = later.has(i.id) ? "retry" : never.has(i.id) || Object.values(state.get(i.id) ?? {}).includes("failed") ? "failed" : "delivered";
      const reason = reasons.length ? reasons.join(" ") : null;
      const key = `${kind}\n${reason ?? ""}`;
      outcomes.set(key, { kind, reason, ids: [...(outcomes.get(key)?.ids ?? []), i.id] });
    }
    for (const { kind, reason, ids } of outcomes.values()) {
      try {
        await settle(kind === "delivered" ? { delivered: ids } : kind === "retry" ? { retry: ids } : { failed: ids }, reason);
      } catch (err) {
        // Not recorded: the claim runs out and they're started again, sending only what's still missing.
        reportError(err, { task: "notify", step: "settle" });
      }
    }
  }
  return counts;
}
