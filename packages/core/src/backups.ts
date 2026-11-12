/**
 * Database backups (Settings → Your data; apps/api/src/services/backups.ts): every night the server
 * dumps the whole database and keeps the dump in Storage for the owner to download. Here: which
 * dumps are kept, when the night's one is due, and when the owner should hear that backups have
 * stopped. Days and weeks are the company's own, by its time zone.
 */
import { addDays, localDate, zonedTimeToUtc } from "./time";

/** How many are kept: the last of each of the 7 newest days, and of each of the 4 newest weeks. */
export const BACKUP_KEEP = { daily: 7, weekly: 4 } as const;
/** The night's backup is made from this time, where the company is. */
export const BACKUP_HOUR = "02:00";
/** The owner hears when the last good backup is older than this. */
export const BACKUP_STALE_HOURS = 48;
/** A backup that keeps failing, or stays missing, is told about again after this long. */
export const BACKUP_WARN_AGAIN_HOURS = 7 * 24;

export type BackupState = "running" | "ok" | "failed";

/** One run, as the owner's list shows it. */
export interface BackupEntry {
  id: string;
  kind: "nightly" | "manual";
  status: BackupState;
  startedAt: string;
  finishedAt: string | null;
  /** The dump's size, once it's good. */
  bytes: number | null;
  /** Why it failed, in words. */
  error: string | null;
}

/** What Settings → Your data shows before the owner types their password. */
export interface BackupStatus {
  /** False where this Crewtavo can't make backups; `unavailable` says why. */
  available: boolean;
  unavailable: string | null;
  running: boolean;
  /** When the last good backup was made. */
  lastGoodAt: string | null;
  /** The last run that finished, good or not. */
  lastRun: { at: string; ok: boolean; error: string | null } | null;
  /** What the owner was (or is about to be) warned about. */
  warning: BackupWarning | null;
}

export type BackupWarning = "failed" | "stale";

/** Monday of the week a YYYY-MM-DD date is in. */
function weekOf(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const weekday = (new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay() + 6) % 7;
  return addDays(date, -weekday);
}

/**
 * Which good backups stay: the newest of each of the `daily` most recent days that have one, and
 * the newest of each of the `weekly` most recent weeks that have one. Everything else is deleted.
 * Counting days that have a backup, not days on the calendar, means a stretch with none (the server
 * was off) never empties the list.
 */
export function backupsToKeep(backups: Array<{ id: string; startedAt: string }>, timeZone: string, keep: { daily: number; weekly: number } = BACKUP_KEEP): Set<string> {
  const newestFirst = [...backups].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  const days = new Map<string, string>();
  const weeks = new Map<string, string>();
  for (const b of newestFirst) {
    const day = localDate(new Date(b.startedAt), timeZone);
    if (!days.has(day)) days.set(day, b.id);
    const week = weekOf(day);
    if (!weeks.has(week)) weeks.set(week, b.id);
  }
  return new Set([...[...days.values()].slice(0, keep.daily), ...[...weeks.values()].slice(0, keep.weekly)]);
}

/** The start of the night `now` belongs to: the most recent BACKUP_HOUR where the company is. A backup made since then is tonight's. */
export function backupNight(now: Date, timeZone: string): Date {
  const today = localDate(now, timeZone);
  const mark = zonedTimeToUtc(today, BACKUP_HOUR, timeZone);
  return mark.getTime() <= now.getTime() ? mark : zonedTimeToUtc(addDays(today, -1), BACKUP_HOUR, timeZone);
}

/**
 * What's wrong with the backups, if anything: the last run failed, or there's been no good one for
 * BACKUP_STALE_HOURS. `since` is when backups began here (the first run), so a new instance isn't
 * called stale before it has had two nights.
 */
export function backupWarning(state: { lastGoodAt: string | null; lastRun: { ok: boolean } | null; since: string | null }, now: Date): BackupWarning | null {
  if (state.lastRun && !state.lastRun.ok) return "failed";
  const from = state.lastGoodAt ?? state.since;
  if (from && now.getTime() - Date.parse(from) > BACKUP_STALE_HOURS * 3_600_000) return "stale";
  return null;
}
