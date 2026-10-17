/**
 * Google review requests: a short message with a tracked link that redirects to the company's
 * review page (settings.review_url). Clicks are recorded so Marketing can show what works.
 */
import { renderTemplate } from "@crewtavo/core";
import type { Env } from "../env";
import { firstName, isEmail, renderEmail } from "../lib/email";
import { clientLink } from "../lib/links";
import { sendEmail, sendSms } from "../lib/notify";
import type { Db } from "../lib/supabase";

export const DEFAULT_REVIEW_MESSAGE =
  "Hi {{client.first_name}}, thank you for choosing {{company.name}}! If you have a minute, would you leave us a quick review? It really helps a small business like ours.\n\n{{link}}";

interface ReviewArgs {
  companyId: string;
  client: { id: string; display_name: string; email: string | null; phone: string | null };
  jobId?: string | null;
  channel: "email" | "sms" | "link";
  baseUrl: string | null;
  /** Automations don't ask the same client twice within this many days. */
  skipIfRecentDays?: number;
  createdBy: string | null;
}

export async function sendReviewRequest(env: Env, admin: Db, args: ReviewArgs): Promise<{ sent: boolean; link: string; detail: string; id: string }> {
  const { data: company } = await admin.from("companies").select("name, phone, email, settings").eq("id", args.companyId).maybeSingle();
  if (!company) throw new Error("Company not found.");
  const settings = (company.settings ?? {}) as { review_url?: string; review_message?: string };
  if (!settings.review_url) throw new Error("Add your Google review link in Marketing → Reviews first.");
  if (!args.baseUrl) throw new Error("APP_URL isn't set, so a review link can't be built.");

  if (args.skipIfRecentDays) {
    const since = new Date(Date.now() - args.skipIfRecentDays * 86_400_000).toISOString();
    // A request that failed to send doesn't count as asking.
    const { count } = await admin.from("review_requests").select("id", { count: "exact", head: true }).eq("client_id", args.client.id).gte("sent_at", since).neq("status", "failed");
    if (count) return { sent: false, link: "", detail: `Skipped: already asked within ${args.skipIfRecentDays} days`, id: "" };
  }

  if (args.channel === "email" && !isEmail(args.client.email)) throw new Error(`${args.client.display_name} has no email address.`);
  if (args.channel === "sms" && !args.client.phone) throw new Error(`${args.client.display_name} has no phone number.`);

  const { data: row, error } = await admin
    .from("review_requests")
    .insert({ company_id: args.companyId, client_id: args.client.id, job_id: args.jobId ?? null, channel: args.channel, created_by: args.createdBy })
    .select("id")
    .single();
  if (error) throw new Error(error.message);

  const link = await clientLink(env, args.baseUrl, { c: args.companyId, t: "review", id: row.id });
  if (args.channel === "link") return { sent: false, link, detail: "Link created", id: row.id };

  const text = renderTemplate(settings.review_message || DEFAULT_REVIEW_MESSAGE, {
    client: { first_name: firstName(args.client.display_name), name: args.client.display_name },
    company: { name: company.name, phone: company.phone ?? "" },
    link,
  });
  const result =
    args.channel === "email"
      ? await sendEmail(env, { to: args.client.email!.trim(), subject: `How did we do? A quick favor from ${company.name}`, ...renderEmail({ companyName: company.name, text }), replyTo: company.email ?? undefined, fromName: company.name }, args.companyId)
      : await sendSms(env, { to: args.client.phone!, body: text });

  if (!result.sent) {
    await admin.from("review_requests").update({ status: "failed", error: result.reason ?? null }).eq("id", row.id);
    throw new Error(result.reason ?? "The review request wasn't sent.");
  }
  await admin.from("messages").insert({
    company_id: args.companyId, client_id: args.client.id, channel: args.channel, direction: "out",
    subject: args.channel === "email" ? "Review request" : null, body: text, related_type: "review", related_id: row.id, sent_by: args.createdBy,
  });
  return { sent: true, link, detail: `Asked for a review by ${args.channel === "sms" ? "text" : "email"}`, id: row.id };
}
