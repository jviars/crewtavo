/**
 * Settings → Hosting: what Railway charges for this Crewtavo, read through the owner's Railway
 * connection (GET /api/railway/usage, apps/api/src/services/hosting.ts), and the warnings the
 * twice-daily check sends before the trial runs out or the bill goes over the plan. Dollars
 * throughout.
 *
 * The connection reaches this one project, not the Railway account's billing, so the trial is
 * worked out from the project, and plans, credit, the card and the usage limit open Railway's own
 * pages (`links`).
 */

export type RailwayPlan = "trial" | "free" | "hobby" | "pro";

/** Each plan's monthly price and the usage it includes, in dollars. The trial's is a one-time credit. */
export const RAILWAY_PLANS: Record<RailwayPlan, { name: string; price: number; included: number }> = {
  trial: { name: "Trial", price: 0, included: 5 },
  free: { name: "Free", price: 0, included: 1 },
  hobby: { name: "Hobby", price: 5, included: 5 },
  pro: { name: "Pro", price: 20, included: 20 },
};

/** Railway's trial: whichever runs out first. */
export const RAILWAY_TRIAL = { days: 30, credit: 5 };

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
  /** The Railway page (`links`) that fixes it. */
  action: "upgrade" | "project" | null;
}

export interface HostingOverview {
  /** Railway's name for the project Crewtavo runs in. */
  projectName: string | null;
  plan: RailwayPlan | null;
  /** The calendar month so far: Railway doesn't share the billing period with a project's sign-in. */
  period: { start: string; end: string };
  /** Usage so far this month, the last day's rate, a forecast for the month at that rate, and what each service used. */
  project: { cost: number; perDay: number | null; forecast: number | null; services: HostingService[] } | null;
  /**
   * On Railway's trial, counted from when this project was made: right for a Railway account made to
   * run Crewtavo, which is how crewtavo.com/start sets one up. Railway's dashboard has the exact figures.
   */
  trial: { daysLeft: number; creditLeft: number } | null;
  disks: HostingDisk[];
  /** The last seven days, every few hours, across all the services: memory in GB and CPU in vCPUs. */
  week: Array<{ at: string; memory: number; cpu: number }>;
  warnings: HostingWarning[];
  /** Parts Railway didn't share just now. */
  missing: Array<"usage" | "charts">;
  /** Railway's pages: usage (and its limit), billing (card and credit), upgrading from the trial or Free, and changing plans. */
  links: { usage: string; billing: string; upgrade: string; plans: string; project: string | null };
  checkedAt: string;
}
