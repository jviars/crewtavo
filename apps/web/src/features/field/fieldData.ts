/** Shared helpers for the crew (field) screens. */
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { supabase, unwrap } from "@/lib/api";
import { isSub, keepsTime, useSession, type Company, type Session } from "@/lib/session";
import type { VisitStatusChange } from "./fieldActions";

export type TimerCategory = "visit" | "assessment" | "drive" | "shop" | "break" | "other";

/**
 * Where the phone was as a clock started or stopped, or why it couldn't say. Saved with the clock
 * for the office and crew leads; the person's own screens never show it.
 */
export type ClockPlace = { lat: number; lng: number; accuracy: number } | { missing: "denied" | "unavailable" | "timeout" | "unsupported" };

/** Whether the company keeps where people clock in and out (Settings → Company). On unless switched off. */
export const recordsPlaces = (company: Pick<Company, "settings">) => (company.settings?.clock as { record_location?: boolean } | undefined)?.record_location !== false;

/**
 * Where this phone is, for a clock starting or stopping. The first time, the phone asks the person.
 * A "no", or no fix within 10 seconds, is kept as the reason and the clock goes on regardless. Gives
 * up after 20 seconds even while that question is still on screen, so a clock is never held longer.
 */
export function locate(): Promise<ClockPlace> {
  if (typeof navigator === "undefined" || !navigator.geolocation) return Promise.resolve({ missing: "unsupported" });
  return new Promise((resolve) => {
    const stop = setTimeout(() => resolve({ missing: "timeout" }), 20_000);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        clearTimeout(stop);
        // Six places is about 10 cm; more says nothing.
        resolve({ lat: Number(p.coords.latitude.toFixed(6)), lng: Number(p.coords.longitude.toFixed(6)), accuracy: Math.round(p.coords.accuracy) });
      },
      (e) => {
        clearTimeout(stop);
        resolve({ missing: e.code === e.PERMISSION_DENIED ? "denied" : e.code === e.TIMEOUT ? "timeout" : "unavailable" });
      },
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 },
    );
  });
}

/** Where to say this clock tap happened: the phone's place, or nothing when the company doesn't keep them. */
export const clockPlace = (company: Pick<Company, "settings">) => (recordsPlaces(company) ? locate() : Promise.resolve(undefined));

/** Statuses that start or stop the person's clock on a visit (see setVisitStatus). */
export const clocksOn = (status: string) => status === "in_progress" || status === "completed";

/**
 * What a status tap saves, as it was made: the time is when it was tapped, and whether it clocks
 * this person in and out (not a sub without a clock), which stays with it if it has to wait for
 * signal. `locate`: the phone's place goes with it, for a tap that starts or stops the clock where
 * the company keeps where people clock in.
 */
export function statusChange(
  session: Pick<Session, "role" | "subcontractor" | "userId"> & { company: Pick<Company, "id" | "settings"> },
  visit: { id: string; jobId: string | null },
  status: string,
  at = new Date().toISOString(),
): { change: VisitStatusChange; locate: boolean } {
  const clock = keepsTime(session);
  const change: VisitStatusChange = { companyId: session.company.id, userId: session.userId, visitId: visit.id, jobId: visit.jobId, status, at, clock, ...(isSub(session) && { sub: true }) };
  return { change, locate: clock && clocksOn(status) && recordsPlaces(session.company) };
}

/**
 * Status taps on a visit, with where the phone was when the tap starts or stops the clock. Finds
 * the place first (`locating` is the visit it's for, so its button can show it's busy), then saves
 * the tap as statusChange() made it.
 */
export function useStatusTap(send: (change: VisitStatusChange) => void) {
  const session = useSession();
  const [locating, setLocating] = useState<string | null>(null);
  const tap = async (visit: { id: string; jobId: string | null }, status: string) => {
    const { change, locate: withPlace } = statusChange(session, visit, status);
    if (withPlace) {
      setLocating(visit.id);
      change.place = await locate();
      setLocating(null);
    }
    send(change);
  };
  return { tap, locating };
}

/**
 * Start or stop the signed-in person's clock for a visit. Only one clock runs at a time. `at` is
 * when it happened, which matters when the tap was made offline and is only being sent now, and
 * `place` is where the phone was then.
 */
export async function clockVisit(companyId: string, userId: string, visit: { id: string; job_id: string | null }, action: "start" | "stop", at = new Date().toISOString(), place?: ClockPlace) {
  const db = supabase();
  const open = unwrap(await db.from("time_entries").select("id, visit_id, started_at").eq("user_id", userId).eq("company_id", companyId).is("ended_at", null));
  const now = at;
  if (action === "start") {
    if (open.some((entry) => entry.visit_id === visit.id)) return;
    // Their own Start sent again after they finished (the app closed before it heard back): their
    // time for it is already there.
    const recorded = unwrap(await db.from("time_entries").select("id").eq("user_id", userId).eq("company_id", companyId).eq("visit_id", visit.id).lte("started_at", now).gt("ended_at", now).limit(1));
    if (recorded.length) return;
  }
  for (const entry of open) {
    // A clock started after `at` (another queued action ran first) can't end before it began.
    if (entry.started_at >= now) continue;
    unwrap(await db.from("time_entries").update({ ended_at: now, out_place: place }).eq("id", entry.id));
  }
  if (action === "start") {
    unwrap(await db.from("time_entries").insert({ company_id: companyId, user_id: userId, visit_id: visit.id, job_id: visit.job_id, category: "visit", started_at: now, in_place: place }));
  }
}

/** Start a general timer (driving, shop time, a break), stopping whatever was running. */
export async function startTimer(companyId: string, userId: string, category: TimerCategory, place?: ClockPlace) {
  const db = supabase();
  const now = new Date().toISOString();
  unwrap(await db.from("time_entries").update({ ended_at: now, out_place: place }).eq("user_id", userId).eq("company_id", companyId).is("ended_at", null));
  unwrap(await db.from("time_entries").insert({ company_id: companyId, user_id: userId, category, started_at: now, in_place: place }));
}

export async function stopTimers(companyId: string, userId: string, place?: ClockPlace) {
  unwrap(await supabase().from("time_entries").update({ ended_at: new Date().toISOString(), out_place: place }).eq("user_id", userId).eq("company_id", companyId).is("ended_at", null));
}

/** The clock currently running for me, if any. `enabled` is false for someone without a clock (a sub, mostly). */
export function useRunningTimer(companyId: string, userId: string, enabled = true) {
  return useQuery({
    queryKey: ["running-timer", companyId, userId],
    enabled,
    refetchInterval: 60_000,
    queryFn: async () =>
      unwrap(
        await supabase()
          .from("time_entries")
          .select("id, category, started_at, visit:visits(id, title)")
          .eq("company_id", companyId)
          .eq("user_id", userId)
          .is("ended_at", null)
          .order("started_at", { ascending: false })
          .limit(1),
      )[0] ?? null,
  });
}

/** "1h 05m" that ticks every 30 seconds. */
export function useElapsed(since: string | null | undefined) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!since) return;
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [since]);
  if (!since) return "";
  return formatDuration(now - Date.parse(since));
}

export function formatDuration(ms: number) {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}

export const CATEGORY_LABELS: Record<TimerCategory, string> = { visit: "On a visit", assessment: "Assessment", drive: "Driving", shop: "Shop time", break: "On break", other: "Other work" };
