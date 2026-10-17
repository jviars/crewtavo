/**
 * Sends email campaigns in small batches (every minute by cron, and right after Send). Each email
 * is personalized, carries a one-click unsubscribe link and the company's address, and every
 * recipient's outcome is recorded.
 */
import { renderTemplate } from "@crewtavo/core";
import type { Env } from "../env";
import { firstName, renderEmail } from "../lib/email";
import { clientLink } from "../lib/links";
import { emailReady, sendEmail } from "../lib/notify";
import { adminClient, type Db } from "../lib/supabase";
import { companyAddress } from "./automations";

const BATCH = 25;
const SPACING_MS = 550; // stays under typical provider rate limits (about 2 per second)
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function refreshCounts(admin: Db, campaignId: string) {
  const count = async (status: string) =>
    (await admin.from("campaign_recipients").select("id", { count: "exact", head: true }).eq("campaign_id", campaignId).eq("status", status)).count ?? 0;
  const [sent, failed, pending] = await Promise.all([count("sent"), count("failed"), count("pending")]);
  return { sent, failed, pending };
}

export async function processCampaigns(env: Env, options: { campaignId?: string; baseUrl?: string | null } = {}) {
  const admin = adminClient(env);
  const baseUrl = options.baseUrl ?? env.APP_URL ?? null;
  const now = new Date().toISOString();

  // Scheduled campaigns whose time has come start sending.
  let start = admin.from("campaigns").update({ status: "sending", started_at: now }).eq("status", "scheduled").lte("scheduled_at", now);
  if (options.campaignId) start = start.eq("id", options.campaignId);
  await start;

  let query = admin.from("campaigns").select("id, company_id, subject, body, company:companies(name, email, phone, address)").eq("status", "sending").limit(5);
  if (options.campaignId) query = query.eq("id", options.campaignId);
  const { data: campaigns, error } = await query;
  if (error) throw new Error(error.message);

  let sent = 0;
  let failed = 0;
  for (const campaign of campaigns ?? []) {
    const company = campaign.company as unknown as { name: string; email: string | null; phone: string | null; address: Record<string, string> };
    const { data: recipients } = await admin.from("campaign_recipients").select("id, client_id, email, name").eq("campaign_id", campaign.id).eq("status", "pending").order("id").limit(BATCH);

    const canSend = await emailReady(env, campaign.company_id);
    for (const [index, r] of (recipients ?? []).entries()) {
      if (!canSend || !baseUrl) {
        await admin.from("campaign_recipients").update({ status: "failed", error: !baseUrl ? "APP_URL isn't set." : "Email isn't set up." }).eq("id", r.id);
        failed++;
        continue;
      }
      if (index) await sleep(SPACING_MS);
      const vars = { client: { first_name: firstName(r.name), name: r.name ?? "" }, company: { name: company.name, phone: company.phone ?? "" } };
      const unsubscribe = r.client_id ? await clientLink(env, baseUrl, { c: campaign.company_id, t: "unsub", id: r.client_id }) : null;
      const email = renderEmail({
        companyName: company.name,
        text: renderTemplate(campaign.body, vars),
        footer: [company.name, companyAddress(company.address)].filter(Boolean).join(" · "),
        unsubscribeUrl: unsubscribe,
      });
      const result = await sendEmail(env, {
        to: r.email,
        subject: renderTemplate(campaign.subject, vars),
        ...email,
        replyTo: company.email ?? undefined,
        fromName: company.name,
        // One-click unsubscribe (RFC 8058): mail apps POST to the API endpoint directly.
        headers: unsubscribe ? { "List-Unsubscribe": `<${unsubscribe.replace("/u/", "/api/public/unsubscribe/")}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } : undefined,
      }, campaign.company_id);
      if (!result.sent && /\(429/.test(result.reason ?? "")) break; // rate limited: the rest go next run
      await admin
        .from("campaign_recipients")
        .update(result.sent ? { status: "sent", sent_at: new Date().toISOString(), error: null } : { status: "failed", error: result.reason ?? "Not sent" })
        .eq("id", r.id);
      if (result.sent) sent++;
      else failed++;
    }

    const counts = await refreshCounts(admin, campaign.id);
    await admin
      .from("campaigns")
      .update({ sent_count: counts.sent, failed_count: counts.failed, ...(counts.pending === 0 ? { status: "sent", finished_at: new Date().toISOString() } : {}) })
      .eq("id", campaign.id)
      .eq("status", "sending");
  }
  return { campaigns: campaigns?.length ?? 0, sent, failed };
}
