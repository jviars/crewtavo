/**
 * Delivers notifications beyond the bell: email, text and phone push, by each person's choices
 * (Settings → Profile → Notifications). Runs every minute; each notification is claimed once, about
 * a minute after it's made so quick changes have folded together, and skipped if already read.
 * One email and one text per person per run, however many notifications there are.
 */
import { DEFAULT_NOTIFICATION_PREFS, notificationTopic, type NotificationChannel, type NotificationTopic } from "@crewtavo/core";
import type { Env } from "../env";
import { renderEmail } from "../lib/email";
import { sendEmail, sendSms, smsConfigured } from "../lib/notify";
import { reportError } from "../lib/monitoring";
import { adminClient } from "../lib/supabase";
import { sendPush } from "../lib/webpush";

interface Row {
  id: string;
  company_id: string;
  user_id: string;
  kind: string;
  title: string;
  body: string | null;
  link: string | null;
  read_at: string | null;
}

export async function deliverNotifications(env: Env, options: { minAgeSeconds?: number } = {}) {
  const admin = adminClient(env);
  const { data, error } = await admin.rpc("claim_notifications", { p_min_age_seconds: options.minAgeSeconds ?? 45, p_limit: 300 });
  if (error) throw new Error(error.message);
  const rows = ((data ?? []) as Row[]).filter((r) => !r.read_at);
  const counts = { claimed: data?.length ?? 0, email: 0, sms: 0, push: 0, failed: 0 };
  if (!rows.length) return counts;

  const userIds = [...new Set(rows.map((r) => r.user_id))];
  const companyIds = [...new Set(rows.map((r) => r.company_id))];
  const [prefs, profiles, companies, devices] = await Promise.all([
    admin.from("notification_prefs").select("company_id, user_id, email, sms, push").in("user_id", userIds),
    admin.from("profiles").select("user_id, email, phone, full_name").in("user_id", userIds),
    admin.from("companies").select("id, name, email").in("id", companyIds),
    admin.from("push_subscriptions").select("id, user_id, endpoint, p256dh, auth").in("user_id", userIds),
  ]);
  const prefsFor = (companyId: string, userId: string): Record<NotificationChannel, string[]> =>
    prefs.data?.find((p) => p.company_id === companyId && p.user_id === userId) ?? DEFAULT_NOTIFICATION_PREFS;
  const base = (env.APP_URL ?? "").replace(/\/$/, "");
  const url = (link: string | null) => (base && link ? `${base}${link}` : base || null);

  const groups = new Map<string, Row[]>();
  for (const r of rows) groups.set(`${r.company_id}:${r.user_id}`, [...(groups.get(`${r.company_id}:${r.user_id}`) ?? []), r]);

  for (const items of groups.values()) {
    const { company_id: companyId, user_id: userId } = items[0]!;
    const company = companies.data?.find((c) => c.id === companyId);
    const person = profiles.data?.find((p) => p.user_id === userId);
    if (!company || !person) continue;
    const chosen = prefsFor(companyId, userId);
    const pick = (channel: NotificationChannel) => items.filter((i) => chosen[channel].includes(notificationTopic(i.kind) as NotificationTopic));

    try {
      const forEmail = pick("email");
      if (forEmail.length && person.email) {
        const text = [
          forEmail.length === 1 ? "" : `${forEmail.length} updates from ${company.name}:`,
          ...forEmail.map((i) => [i.title, i.body && i.body !== i.title ? i.body : null, url(i.link)].filter(Boolean).join("\n")),
          `You get these because of your notification settings. Change them in Crewtavo under Settings → Profile${base ? `: ${base}/settings?tab=profile` : "."}`,
        ].filter(Boolean).join("\n\n");
        const result = await sendEmail(
          env,
          { to: person.email, subject: forEmail.length === 1 ? forEmail[0]!.title : `${forEmail.length} updates from ${company.name}`, ...renderEmail({ companyName: company.name, text }), replyTo: company.email ?? undefined, fromName: company.name },
          companyId,
        );
        if (result.sent) counts.email++;
        else counts.failed++;
      }

      const forSms = pick("sms");
      if (forSms.length && person.phone && smsConfigured(env)) {
        const first = forSms[0]!;
        const more = forSms.length > 1 ? ` (+${forSms.length - 1} more)` : "";
        const link = url(forSms.length > 1 ? "/" : first.link);
        const result = await sendSms(env, { to: person.phone, body: `${company.name}: ${first.title}${more}${link ? ` ${link}` : ""}` });
        if (result.sent) counts.sms++;
        else counts.failed++;
      }

      const forPush = pick("push");
      const phones = (devices.data ?? []).filter((d) => d.user_id === userId);
      if (forPush.length && phones.length) {
        const contact = base.startsWith("https://") ? base : `mailto:${company.email || "notifications@crewtavo.invalid"}`;
        // Up to three separately; more than that, one summary.
        const messages = forPush.length <= 3
          ? forPush.map((i) => ({ title: i.title, body: i.body && i.body !== i.title ? i.body : company.name, link: i.link ?? "/", tag: i.id }))
          : [{ title: `${forPush.length} updates from ${company.name}`, body: forPush.map((i) => i.title).slice(0, 4).join("\n"), link: "/", tag: `batch-${companyId}` }];
        for (const device of phones) {
          for (const message of messages) {
            const sent = await sendPush(env, device, message, contact);
            if (sent.gone) {
              await admin.from("push_subscriptions").delete().eq("id", device.id);
              break;
            }
            if (sent.ok) counts.push++;
            else counts.failed++;
          }
        }
        await admin.from("push_subscriptions").update({ last_sent_at: new Date().toISOString() }).eq("user_id", userId);
      }
    } catch (err) {
      counts.failed++;
      reportError(err, { task: "notify" });
    }
  }
  return counts;
}
