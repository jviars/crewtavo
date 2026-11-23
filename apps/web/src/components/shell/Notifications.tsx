/**
 * The bell: notifications for me (from automations such as "a quote was approved") and the
 * company's activity feed. New notifications are checked for every 30 seconds while Crewtavo is open
 * (and whenever it comes back into view), and show as a toast. Opening the bell to "For you" marks
 * what's there as read; the new ones keep their dot until it closes, so it's clear which they were.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase, unwrap } from "@/lib/api";
import { dateIn, formatDateTime, todayIn } from "@/lib/format";
import { hasRole, useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import { Icon, type IconName } from "../ui/Icon";
import { Skeleton } from "../ui/Skeleton";
import { getLocale, intlLocale, t } from "@/lib/i18n";
import { phoneLayout } from "./Help";
import { translateNotice } from "@crewtavo/core/i18n/patterns";

/** A notification as the database or the server wrote it (in English), in the app's language: read by its kind, and left whole in English when it isn't one the app knows. */
const inMyLanguage = <N extends { kind: string; title: string; body: string | null }>(n: N): N => translateNotice(getLocale(), n);

// By notification kind, and by the first word of an activity's verb ("autopay.failed", "payment_method.expiring") or its subject.
const ICONS: Record<string, IconName> = { quote: "quote", invoice: "invoice", request: "requests", job: "job", visit: "calendar", client: "clients", equipment: "truck", subs: "users", jobs: "job", applicant: "user", autopay: "card", payment_method: "card" };

/**
 * A notice's color, read from what it says (in English, as it was written): green for good news, red
 * for something that needs someone, amber for a warning about the server. Most are neither.
 */
export function noticeTone(kind: string, text: string): "good" | "bad" | "warn" | undefined {
  if (/\b(failed|past due|overdue|declined|rejected|bounced|expir(ed|ing|es)|couldn't|could not|paused)\b/i.test(text)) return "bad";
  if (kind === "security") return "bad";
  if (/\b(approved|accepted|paid|signed|booked|completed|done)\b/i.test(text)) return "good";
  if (kind === "hosting") return "warn";
  return undefined;
}

/** When, short as a list's edge shows it: "now", "5m", "2h", then the weekday, then the date. */
export function shortWhen(value: string, now = Date.now()): string {
  const seconds = Math.max(0, (now - new Date(value).getTime()) / 1000);
  const unit = (n: number, u: "minute" | "hour") => new Intl.NumberFormat(intlLocale(), { style: "unit", unit: u, unitDisplay: "narrow" }).format(n);
  if (seconds < 60) return t("just now");
  if (seconds < 3600) return unit(Math.floor(seconds / 60), "minute");
  if (seconds < 86400) return unit(Math.floor(seconds / 3600), "hour");
  if (seconds < 6 * 86400) return new Date(value).toLocaleDateString(intlLocale(), { weekday: "short" });
  return new Date(value).toLocaleDateString(intlLocale(), { month: "short", day: "numeric" });
}

const subjectPath = (type: string, id: string | null) =>
  !id ? null : ({ client: `/clients/${id}`, request: `/requests/${id}`, quote: `/quotes/${id}`, job: `/jobs/${id}`, invoice: `/invoices/${id}`, equipment: `/equipment/${id}` } as Record<string, string>)[type] ?? null;

export function NotificationsButton() {
  const session = useSession();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const id = useId();
  const panel = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"mine" | "activity">("mine");
  /** Marked read while the bell is open: still shown as new until it closes. */
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const key = ["notifications", session.company.id, session.userId];
  const showActivity = hasRole(session, "admin", "office", "estimator");

  const notifications = useQuery({
    queryKey: key,
    meta: { silent: true },
    refetchInterval: 30_000,
    queryFn: async () =>
      unwrap(
        await supabase()
          .from("notifications")
          .select("id, kind, title, body, link, read_at, created_at")
          .eq("company_id", session.company.id)
          .eq("user_id", session.userId)
          .order("created_at", { ascending: false })
          .limit(40),
      ),
  });
  const activity = useQuery({
    queryKey: ["activity", session.company.id],
    enabled: open && tab === "activity",
    meta: { silent: true },
    queryFn: async () =>
      unwrap(
        await supabase()
          .from("activity")
          .select("id, verb, subject_type, subject_id, summary, created_at")
          .eq("company_id", session.company.id)
          .neq("verb", "visit.reminder")
          .order("created_at", { ascending: false })
          .limit(50),
      ),
  });
  const unread = notifications.data?.filter((n) => !n.read_at).length ?? 0;

  // New notifications for me that arrive while Crewtavo is open show as a toast. The first load (and
  // switching company) only marks what's already there as seen.
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    seen.current = null;
  }, [session.userId, session.company.id]);
  useEffect(() => {
    const rows = notifications.data;
    if (!rows) return;
    if (!seen.current) {
      seen.current = new Set(rows.map((n) => n.id));
      return;
    }
    const fresh = rows.filter((n) => !seen.current!.has(n.id));
    fresh.forEach((n) => seen.current!.add(n.id));
    for (const n of fresh.filter((n) => !n.read_at).slice(0, 3).map(inMyLanguage)) {
      toast.info(n.title, { description: n.body && n.body !== n.title ? n.body : undefined, action: n.link ? { label: t("View"), onClick: () => navigate(n.link!) } : undefined });
    }
  }, [notifications.data, navigate]);

  useEffect(() => {
    const p = panel.current;
    if (!p) return;
    const onToggle = (e: Event) => {
      const isOpen = (e as Event & { newState: string }).newState === "open";
      setOpen(isOpen);
      if (!isOpen) setFresh(new Set());
      if (!isOpen) return;
      notifications.refetch();
      // On a phone it's a screen of its own over the page, above the tab bar (base.css).
      if (phoneLayout() || !button.current) {
        p.style.top = p.style.left = "";
        return;
      }
      const r = button.current.getBoundingClientRect();
      p.style.top = `${r.bottom + 8}px`;
      p.style.left = `${Math.max(12, Math.min(window.innerWidth - p.offsetWidth - 12, r.right - p.offsetWidth))}px`;
    };
    p.addEventListener("toggle", onToggle);
    return () => p.removeEventListener("toggle", onToggle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const markRead = useMutation({
    // Marking happens by itself as the bell opens; if it doesn't go through, the dots simply come back.
    meta: { inline: true },
    mutationFn: async (ids: string[]) =>
      unwrap(await supabase().from("notifications").update({ read_at: new Date().toISOString() }).eq("user_id", session.userId).eq("company_id", session.company.id).is("read_at", null).in("id", ids)),
    onMutate: async (ids) => {
      await queryClient.cancelQueries({ queryKey: key });
      const now = new Date().toISOString();
      queryClient.setQueryData<typeof notifications.data>(key, (old) => old?.map((n) => (ids.includes(n.id) ? { ...n, read_at: n.read_at ?? now } : n)));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
  });

  // Seen once they're on screen: as the bell opens to "For you", and any that arrive while it's open.
  useEffect(() => {
    if (!open || tab !== "mine") return;
    const ids = notifications.data?.filter((n) => !n.read_at && !fresh.has(n.id)).map((n) => n.id) ?? [];
    if (!ids.length) return;
    setFresh((shown) => new Set([...shown, ...ids]));
    markRead.mutate(ids);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tab, notifications.data]);

  const openLink = (path: string | null) => {
    panel.current?.hidePopover();
    if (path) navigate(path);
  };

  const mine = notifications.data?.map((n) => ({ ...inMyLanguage(n), tone: noticeTone(n.kind, `${n.title} ${n.body ?? ""}`), isNew: !n.read_at || fresh.has(n.id) }));
  const newCount = mine?.filter((n) => n.isNew).length ?? 0;
  // The dots go, and anything not yet marked (one that came in on the Activity tab) is marked too.
  const markAll = () => {
    const ids = notifications.data?.filter((n) => !n.read_at).map((n) => n.id) ?? [];
    if (ids.length) markRead.mutate(ids);
    setFresh(new Set());
  };
  // On a phone the list is under Today, Yesterday and Earlier.
  const timeZone = session.company.timezone;
  const today = todayIn(timeZone);
  const day = (iso: string) => {
    const d = dateIn(iso, timeZone);
    return d === today ? t("Today") : Date.parse(today) - Date.parse(d) <= 86_400_000 ? t("Yesterday") : t("Earlier");
  };
  let lastDay = "";
  const dayHeading = (iso: string) => {
    const name = day(iso);
    if (name === lastDay) return null;
    lastDay = name;
    return <div className="notif-day" aria-hidden="true">{name}</div>;
  };
  const when = (iso: string) => <time className="n-time" dateTime={iso} title={formatDateTime(iso, timeZone)}>{shortWhen(iso)}</time>;
  const markButton = (className: string) =>
    tab === "mine" && newCount > 0 ? <button type="button" className={`notif-mark ${className}`} onClick={markAll}>{t("Mark all read")}</button> : null;

  return (
    <>
      <button ref={button} type="button" className="icon-btn" aria-label={unread ? t("Notifications, {count} unread", { count: unread }) : t("Notifications")} title={t("Notifications")} popovertarget={id} aria-expanded={open}>
        <Icon name="bell" size={20} />
        {unread > 0 && <span className="notif-dot" aria-hidden="true" />}
      </button>
      <div ref={panel} id={id} className="panel notif-panel" popover="auto" role="dialog" aria-label={t("Notifications")}>
        <div className="notif-head">
          <button type="button" className="notif-back" aria-label={t("Close")} onClick={() => panel.current?.hidePopover()}>
            <Icon name="chevronLeft" size={20} />
          </button>
          <h2>{t("Notifications")}</h2>
          {markButton("notif-mark-top")}
          {showActivity && (
            <div className="segmented notif-seg" role="tablist" aria-label={t("Notifications")}>
              <button type="button" role="tab" aria-selected={tab === "mine"} onClick={() => setTab("mine")}>
                {t("For you")}
                {newCount ? <span className="badge">{newCount}</span> : null}
              </button>
              <button type="button" role="tab" aria-selected={tab === "activity"} onClick={() => setTab("activity")}>{t("Activity")}</button>
            </div>
          )}
        </div>
        <div className="panel-body">
          {tab === "mine" && (
            <>
              {notifications.isPending && <PanelSkeleton />}
              {notifications.data?.length === 0 && (
                <div className="empty-state empty-state-sm">
                  <span className="empty-icon"><Icon name="bell" size={20} /></span>
                  <h3>{t("You're all caught up")}</h3>
                </div>
              )}
              {mine?.map((n) => (
                <div key={n.id} className="notif-item">
                  {dayHeading(n.created_at)}
                  <button type="button" className="notice" data-unread={n.isNew || undefined} onClick={() => openLink(n.link)}>
                    <span className={`n-icon${n.tone ? ` n-${n.tone}` : ""}`}><Icon name={ICONS[n.kind] ?? "bell"} size={14} /></span>
                    <span className="n-main">
                      <span className="n-title">{n.title}</span>
                      {/* A one-line schedule notice is written as both its title and its body: said once. */}
                      {n.body && n.body !== n.title && <span className="n-body">{n.body}</span>}
                    </span>
                    {when(n.created_at)}
                  </button>
                </div>
              ))}
            </>
          )}
          {tab === "activity" && (
            <>
              {activity.isPending && <PanelSkeleton />}
              {activity.data?.length === 0 && (
                <div className="empty-state empty-state-sm">
                  <span className="empty-icon"><Icon name="history" size={20} /></span>
                  <h3>{t("No activity yet")}</h3>
                </div>
              )}
              {activity.data?.map((a) => {
                const tone = noticeTone(a.subject_type, a.verb.replace(/[._]/g, " "));
                return (
                  <div key={a.id} className="notif-item">
                    {dayHeading(a.created_at)}
                    <button type="button" className="notice" onClick={() => openLink(subjectPath(a.subject_type, a.subject_id))}>
                      <span className={`n-icon${tone ? ` n-${tone}` : ""}`}><Icon name={ICONS[a.verb.split(".")[0]] ?? ICONS[a.subject_type] ?? "history"} size={14} /></span>
                      <span className="n-main">
                        <span className="n-body n-summary">{a.summary}</span>
                      </span>
                      {when(a.created_at)}
                    </button>
                  </div>
                );
              })}
            </>
          )}
        </div>
        {markButton("notif-mark-foot")}
      </div>
    </>
  );
}

function PanelSkeleton() {
  return (
    <div className="skeleton-wrap" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <div key={i} className="notice" style={{ pointerEvents: "none" }}>
          <Skeleton width={28} height={28} radius={999} />
          <span style={{ display: "grid", gap: 6 }}>
            <Skeleton width="60%" height={12} />
            <Skeleton width="90%" height={10} />
          </span>
        </div>
      ))}
    </div>
  );
}
