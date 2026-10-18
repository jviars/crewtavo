/** Shared helpers for the crew (field) screens. */
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { supabase, unwrap } from "@/lib/api";

export type TimerCategory = "visit" | "assessment" | "drive" | "shop" | "break" | "other";

/**
 * Start or stop the signed-in person's clock for a visit. Only one clock runs at a time. `at` is
 * when it happened, which matters when the tap was made offline and is only being sent now.
 */
export async function clockVisit(companyId: string, userId: string, visit: { id: string; job_id: string | null }, action: "start" | "stop", at = new Date().toISOString()) {
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
    unwrap(await db.from("time_entries").update({ ended_at: now }).eq("id", entry.id));
  }
  if (action === "start") {
    unwrap(await db.from("time_entries").insert({ company_id: companyId, user_id: userId, visit_id: visit.id, job_id: visit.job_id, category: "visit", started_at: now }));
  }
}

/** Start a general timer (driving, shop time, a break), stopping whatever was running. */
export async function startTimer(companyId: string, userId: string, category: TimerCategory) {
  const db = supabase();
  const now = new Date().toISOString();
  unwrap(await db.from("time_entries").update({ ended_at: now }).eq("user_id", userId).eq("company_id", companyId).is("ended_at", null));
  unwrap(await db.from("time_entries").insert({ company_id: companyId, user_id: userId, category, started_at: now }));
}

export async function stopTimers(companyId: string, userId: string) {
  unwrap(await supabase().from("time_entries").update({ ended_at: new Date().toISOString() }).eq("user_id", userId).eq("company_id", companyId).is("ended_at", null));
}

/** The clock currently running for me, if any. */
export function useRunningTimer(companyId: string, userId: string) {
  return useQuery({
    queryKey: ["running-timer", companyId, userId],
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

export function directionsUrl(p: { line1?: string | null; city?: string | null; lat?: number | null; lng?: number | null }) {
  const destination = p.lat != null && p.lng != null ? `${p.lat},${p.lng}` : [p.line1, p.city].filter(Boolean).join(", ");
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}`;
}

export const CATEGORY_LABELS: Record<TimerCategory, string> = { visit: "On a visit", assessment: "Assessment", drive: "Driving", shop: "Shop time", break: "On break", other: "Other work" };
