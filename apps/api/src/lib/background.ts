/** Work that finishes after the response: the promise keeps running in the server process. */
import type { Context } from "hono";
import type { AppEnv } from "../env";
import { processAutomations } from "../services/automations";
import { processCampaigns } from "../services/campaigns";
import { appUrl } from "./http";
import { reportError } from "./monitoring";

export function runInBackground(c: Context<AppEnv>, work: Promise<unknown>) {
  void work.catch((error) => {
    console.error("Background task failed", error);
    reportError(error, { background: true });
  });
}

const lastKick = new Map<string, number>();

/** Process a company's due automation runs soon after something happened. Throttled per company. */
export function kickAutomations(c: Context<AppEnv>, companyId: string) {
  const now = Date.now();
  if (now - (lastKick.get(companyId) ?? 0) < 1500) return;
  lastKick.set(companyId, now);
  runInBackground(c, processAutomations(c.env, { companyId, limit: 25, baseUrl: appUrl(c) }));
}

export function kickCampaign(c: Context<AppEnv>, campaignId: string) {
  runInBackground(c, processCampaigns(c.env, { campaignId, baseUrl: appUrl(c) }));
}
