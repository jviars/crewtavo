/**
 * Settings → Hosting: what Railway charges for this Crewtavo, read through the owner's Railway
 * connection (GET /api/railway/usage, apps/api/src/services/hosting.ts), and the warnings the daily
 * check sends before the trial, the credit or the card runs out. Dollars throughout.
 *
 * Railway's API can't change a plan or take a payment, so upgrading, buying credit and updating the
 * card open Railway's own pages (`links`). The usage limit Crewtavo can change itself
 * (POST /api/railway/limit).
 */

export type RailwayPlan = "trial" | "free" | "hobby" | "pro";

/** Each plan's monthly price and the usage it includes, in dollars. The trial's is a one-time credit. */
export const RAILWAY_PLANS: Record<RailwayPlan, { name: string; price: number; included: number }> = {
  trial: { name: "Trial", price: 0, included: 5 },
  free: { name: "Free", price: 0, included: 1 },
  hobby: { name: "Hobby", price: 5, included: 5 },
  pro: { name: "Pro", price: 20, included: 20 },
};

/** The template's five services, in words for people who've never heard of Postgres. */
export const RAILWAY_SERVICES: Record<string, string> = {
  crewtavo: "The app",
  db: "Database",
  storage: "Photos and files",
  auth: "Sign-in",
  rest: "Data access",
};

export const serviceLabel = (name: string) => RAILWAY_SERVICES[name] ?? name;

export interface HostingService {
  id: string;
  name: string;
  /** Dollars of usage so far this period. */
  cost: number;
}

export interface HostingDisk {
  service: string;
  usedGb: number;
  sizeGb: number;
}

export interface HostingWarning {
  /** Stays the same while the problem lasts, so the daily check sends each one once. */
  key: string;
  level: "urgent" | "warning";
  title: string;
  body: string;
  /** What fixes it: a Railway page (`links`), or raising the usage limit right in Crewtavo. */
  action: "upgrade" | "billing" | "plans" | "limit" | "project" | null;
}

export interface HostingOverview {
  /** Railway's name for the project Crewtavo runs in. */
  projectName: string | null;
  plan: RailwayPlan | null;
  /** The billing period (or, when Railway doesn't share it, the calendar month so far). */
  period: { start: string; end: string; billing: boolean };
  /** This Crewtavo: usage so far this period, Railway's forecast for all of it, and what each service used. */
  project: { cost: number; forecast: number | null; services: HostingService[] } | null;
  /**
   * The whole Railway account, from its billing: only with the workspace access Login with Railway
   * asks for (a project token can't see it). `others` when other projects share the account's usage.
   */
  account: {
    usage: number;
    forecast: number | null;
    others: boolean;
    /** Credit left, for an account that's on the trial or pays with credits. */
    credit: number | null;
    prepaid: boolean;
    trialDaysLeft: number | null;
    /** Railway stops the account's projects at this much usage a month, and emails at `alertAt`. */
    limit: number | null;
    alertAt: number | null;
    /** Railway couldn't charge the card, or stopped the plan. */
    problem: "past_due" | "unpaid" | "cancelled" | null;
  } | null;
  disks: HostingDisk[];
  /** The last seven days, every few hours, across all the services: memory in GB and CPU in vCPUs. */
  week: Array<{ at: string; memory: number; cpu: number }>;
  warnings: HostingWarning[];
  /** Parts Railway didn't share with this connection. */
  missing: Array<"usage" | "billing" | "charts">;
  /** Railway's pages: usage, billing (card and credit), upgrading from the trial or Free, and changing plans. */
  links: { usage: string; billing: string; upgrade: string; plans: string; project: string | null };
  checkedAt: string;
}
