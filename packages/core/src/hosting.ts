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

/**
 * The template's five services, in words for people who've never heard of Postgres, and the bucket
 * photos and files can move to (FILES_BUCKET).
 */
export const RAILWAY_SERVICES: Record<string, string> = {
  crewtavo: "The app",
  db: "Database",
  storage: "Photos and files",
  auth: "Sign-in",
  rest: "Data access",
  files: "Photos and files (bucket)",
};

export const serviceLabel = (name: string) => RAILWAY_SERVICES[name] ?? name;

/**
 * What Railway charges to keep a GB for a month, in dollars (railway.com/pricing): on a volume, and
 * in a bucket (storage buckets, ten times cheaper, with no backups). Sending a GB out of a service
 * costs NETWORK_GB, and Railway counts a file uploaded into a bucket that way, as the storage
 * service's.
 */
export const STORAGE_PRICES = { volume: 0.15, bucket: 0.015, network: 0.05 } as const;

/** Where the template's storage keeps photos and files when they're moved to a bucket (Settings → Hosting). */
export const FILES_BUCKET = "files";

export interface HostingService {
  id: string;
  name: string;
  /** Dollars of usage so far this period. */
  cost: number;
}

export interface HostingDisk {
  /** The service a volume is on, or a bucket's name. */
  service: string;
  /** A volume has a fixed size; a bucket grows as it fills, so it has none (and no "full" warning). */
  kind: "volume" | "bucket";
  usedGb: number;
  sizeGb: number | null;
  /** A bucket's: how many files it holds, and what keeping them costs a month at STORAGE_PRICES.bucket. */
  objects?: number;
  monthly?: number;
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

// ---------------------------------------------------------------------------------------------
// Files storage (Settings → Hosting): moving photos and files from the storage service's volume to
// a Railway bucket and back (GET /api/railway/storage, apps/api/src/services/storageBucket.ts).
// ---------------------------------------------------------------------------------------------

/** Where the storage service keeps files: its volume (the template's), or a Railway bucket. */
export type StorageBackend = "volume" | "bucket";

/**
 * A move's steps: finding or making the bucket, copying, switching storage over (and restarting
 * it), checking files read back, then done. "by_hand" waits for the owner to do a step in Railway
 * that Railway didn't let Crewtavo do.
 */
export type StorageMoveStep = "preparing" | "bucket" | "copying" | "switching" | "checking" | "done" | "failed" | "by_hand";

/** A step in Railway for the owner, when Railway refused Crewtavo's own try. */
export interface StorageByHand {
  title: string;
  steps: string[];
  /** Variables to paste into the storage service's Raw Editor, one per line, when that's the step. */
  lines?: string[];
  /** The Railway page to open. */
  link: string | null;
  /**
   * Crewtavo notices the change by itself and carries on (a variable change or a restart); without
   * it, the owner presses Carry on after doing the step.
   */
  watching: boolean;
}

export interface StorageMove {
  direction: "to_bucket" | "to_volume";
  step: StorageMoveStep;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  /** Files to copy and copied so far (those already in place count as copied), and their sizes in bytes. */
  files: number;
  copied: number;
  bytes: number;
  copiedBytes: number;
  /** Files whose stored copy was already missing, so there was nothing to copy (they don't open now either). */
  missing: number;
  /** The first few files that couldn't be copied, and why. */
  problems: string[];
  /** Files uploaded while storage switched over that didn't make it across (still on the volume). */
  stranded: number;
  /** When storage started reading from the new place. */
  switchedAt: string | null;
  byHand: StorageByHand | null;
  /** What went wrong, in words, when the step is "failed". */
  error: string | null;
}

export interface StorageOverview {
  /** Where files are now; null when Railway didn't share the storage service's settings. */
  backend: StorageBackend | null;
  /** The bucket in use (or the one a move made), with what's in it when Railway shares that. */
  bucket: { id: string; name: string; usedGb: number | null; objects: number | null } | null;
  /** The storage service's volume, kept as it was after a move so files can move back. */
  volume: { usedGb: number; sizeGb: number } | null;
  /** The move in progress, or the last one. */
  move: StorageMove | null;
  /** Why files can't be moved from here, in words; null when they can. */
  unavailable: string | null;
  /** Railway's page for this project. */
  projectUrl: string | null;
}

/** A move that's still going (or waiting on a step in Railway). */
export const storageMoving = (move: StorageMove | null | undefined) => Boolean(move && !["done", "failed"].includes(move.step));
