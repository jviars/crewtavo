/**
 * How you hear about Team chat. Each channel's and conversation's bell (in its head) picks "All new
 * messages", "Mentions and replies" or "Nothing"; a channel set to nothing shows dimmed in the list,
 * with a crossed-out bell. The bell in the channel list's head pauses notifications for an hour or
 * until the morning. Quiet hours (Settings → Profile → Notifications, ChatQuietSettings) keep chat
 * notifications on the bell at night or on days off: no push, email or text (routes/chatPrefs.ts).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { nextMorning, quietZone } from "@crewtavo/core/notifications";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Menu } from "@/components/ui/Menu";
import { Section } from "@/components/ui/Section";
import { Skeleton } from "@/components/ui/Skeleton";
import { api } from "@/lib/api";
import { dateLocale } from "@/lib/format";
import { useSession } from "@/lib/session";
import { chatKeys, type ChatChannel, type ChatState } from "./data";
import { channelLabel } from "./ui";
import n from "./notify.module.css";
import { browserOrSpanish, msg, t } from "@/lib/i18n";

export type NotifyLevel = "all" | "mentions" | "nothing";

const LEVELS: Array<{ key: NotifyLevel; label: string; hint: string }> = [
  { key: "all", label: msg("All new messages"), hint: msg("Every message someone else sends") },
  { key: "mentions", label: msg("Mentions and replies"), hint: msg("When you're mentioned or replied to, and threads you follow") },
  { key: "nothing", label: msg("Nothing"), hint: msg("No notifications. It shows dimmed in the list") },
];

/** A channel's level as the server sends it, with the default for its kind. */
export const notifyOf = (channel: Pick<ChatChannel, "kind" | "notify">): NotifyLevel => channel.notify ?? (channel.kind === "direct" ? "all" : "mentions");

const locale = () => browserOrSpanish() ?? dateLocale();
/** "Sat 8:00 AM". */
const when = (iso: string) => new Date(iso).toLocaleString(locale(), { weekday: "short", hour: "numeric", minute: "2-digit" });

/** The bell in a channel's or conversation's head. */
export function ChannelNotifyMenu({ channel }: { channel: ChatChannel }) {
  const { company } = useSession();
  const queryClient = useQueryClient();
  const level = notifyOf(channel);
  const set = useMutation({
    meta: { inline: true },
    mutationFn: (notify: NotifyLevel) => api.put(`/chat/channels/${channel.id}/notify`, { notify }),
    onMutate: (notify) => {
      const before = queryClient.getQueryData<ChatState>(chatKeys.state(company.id));
      queryClient.setQueryData<ChatState>(chatKeys.state(company.id), (state) =>
        state ? { ...state, channels: state.channels.map((c) => (c.id === channel.id ? { ...c, notify } : c)) } : state,
      );
      return { before };
    },
    onError: (_e, _v, ctx) => ctx?.before && queryClient.setQueryData(chatKeys.state(company.id), ctx.before),
  });
  const current = LEVELS.find((l) => l.key === level)!;
  return (
    <Menu
      label={t("Notifications for {channel}: {level}", { channel: channelLabel(channel), level: t(current.label) })}
      title={t("Notify me about {channel}", { channel: channelLabel(channel) })}
      align="end"
      triggerClassName={`btn btn-sm btn-ghost btn-icon ${n.bell}`}
      trigger={<Icon name={level === "nothing" ? "bellOff" : "bell"} size={15} />}
      items={[
        { heading: t("Notify me about") },
        ...LEVELS.map((l) => ({ label: t(l.label), description: t(l.hint), checked: l.key === level, onSelect: () => set.mutate(l.key) })),
      ]}
    />
  );
}

export interface Quiet {
  quiet_on: boolean;
  starts: string;
  ends: string;
  days: number[];
  time_zone: string | null;
  paused_until: string | null;
}

export function useQuiet(enabled = true) {
  const { company } = useSession();
  return useQuery({
    queryKey: [...chatKeys.all(company.id), "quiet"],
    enabled,
    queryFn: () => api.get<{ quiet: Quiet; company_time_zone: string }>("/chat/quiet"),
    staleTime: 60_000,
  });
}

function usePause() {
  const { company } = useSession();
  const queryClient = useQueryClient();
  return useMutation({
    meta: { success: (res: { paused_until: string | null }) => (res.paused_until ? t("Chat notifications paused until {when}", { when: when(res.paused_until) }) : t("Chat notifications are back on")) },
    mutationFn: (until: Date | null) => api.post<{ paused_until: string | null }>("/chat/pause", { until: until?.toISOString() ?? null }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: [...chatKeys.all(company.id), "quiet"] }),
  });
}

/** Whether a pause is on now. Re-checked each minute, so a pause that ran out shows as over. */
function usePaused(quiet: Quiet | undefined) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!quiet?.paused_until) return;
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [quiet?.paused_until]);
  return quiet?.paused_until && Date.parse(quiet.paused_until) > now ? quiet.paused_until : null;
}

/** The bell in the channel list's head: pause for a while, or go to quiet hours. */
export function PauseMenu() {
  const navigate = useNavigate();
  const quiet = useQuiet();
  const pause = usePause();
  const paused = usePaused(quiet.data?.quiet);
  const zone = quietZone(quiet.data?.quiet, quiet.data?.company_time_zone);
  const morning = nextMorning(new Date(), zone);
  return (
    <Menu
      label={paused ? t("Notifications paused until {when}", { when: when(paused) }) : t("Pause notifications")}
      title={t("Team chat notifications")}
      align="end"
      triggerClassName={`${n.headBtn} ${paused ? n.headPaused : ""}`}
      trigger={<Icon name={paused ? "bellOff" : "bell"} size={16} />}
      items={[
        { heading: paused ? t("Paused until {when}", { when: when(paused) }) : t("Pause notifications") },
        { label: t("Resume notifications"), icon: "bell", onSelect: () => pause.mutate(null), hidden: !paused },
        { label: t("For 1 hour"), icon: "clock", onSelect: () => pause.mutate(new Date(Date.now() + 3_600_000)) },
        { label: t("Until tomorrow morning"), icon: "moon", description: when(morning.toISOString()), onSelect: () => pause.mutate(morning) },
        { separator: true },
        { label: t("Quiet hours and notification settings"), icon: "settings", onSelect: () => navigate("/settings?tab=profile#chat-notifications") },
      ]}
    />
  );
}

/** Weekday names, Sunday first, in the reader's language. */
const weekdays = () => [0, 1, 2, 3, 4, 5, 6].map((d) => ({ d, short: new Date(Date.UTC(2026, 10, 29 + d, 12)).toLocaleDateString(locale(), { weekday: "short", timeZone: "UTC" }), long: new Date(Date.UTC(2026, 10, 29 + d, 12)).toLocaleDateString(locale(), { weekday: "long", timeZone: "UTC" }) }));

/** Settings → Profile → Notifications: Team chat's pause and quiet hours. */
export function ChatQuietSettings() {
  const { company } = useSession();
  const queryClient = useQueryClient();
  const quiet = useQuiet();
  const pause = usePause();
  const paused = usePaused(quiet.data?.quiet);
  const [draft, setDraft] = useState<Quiet | null>(null);
  useEffect(() => {
    if (quiet.data) setDraft(quiet.data.quiet);
  }, [quiet.data]);
  const save = useMutation({
    meta: { inline: true },
    mutationFn: (next: Quiet) => api.put<{ quiet: Quiet }>("/chat/quiet", { quiet_on: next.quiet_on, starts: next.starts, ends: next.ends, days: next.days, time_zone: next.time_zone }),
    onSuccess: (res) => queryClient.setQueryData([...chatKeys.all(company.id), "quiet"], (old: { quiet: Quiet; company_time_zone: string } | undefined) => (old ? { ...old, quiet: res.quiet } : old)),
  });
  const change = (patch: Partial<Quiet>) => {
    if (!draft) return;
    const next = { ...draft, ...patch };
    setDraft(next);
    save.mutate(next);
  };
  const device = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const companyZone = quiet.data?.company_time_zone ?? "UTC";
  const zone = draft?.time_zone ?? companyZone;
  const morning = nextMorning(new Date(), quietZone(draft, companyZone));

  return (
    <Section level={3} title={t("Team chat")} id="chat-notifications">
      {!draft ? (
        <Skeleton height={120} radius={8} />
      ) : (
        <div className="set-stack">
          <p className="set-note">{t("Each channel's bell, in its header, chooses whether you hear about every message, only mentions and replies, or nothing.")}</p>
          <div className={n.pauseRow}>
            <span className="grow">
              <span className={n.label}>{paused ? t("Paused until {when}", { when: when(paused) }) : t("Pause notifications")}</span>
              <span className="set-note">{t("Chat notifications stay on the bell while paused, and aren't sent later.")}</span>
            </span>
            {paused ? (
              <Button size="sm" icon="bell" loading={pause.isPending} onClick={() => pause.mutate(null)}>{t("Resume")}</Button>
            ) : (
              <span className="row wrap" style={{ gap: 6 }}>
                <Button size="sm" icon="clock" disabled={pause.isPending} onClick={() => pause.mutate(new Date(Date.now() + 3_600_000))}>{t("For 1 hour")}</Button>
                <Button size="sm" icon="moon" disabled={pause.isPending} onClick={() => pause.mutate(morning)}>{t("Until tomorrow morning")}</Button>
              </span>
            )}
          </div>

          <label className={n.pauseRow}>
            <span className="grow">
              <span className={n.label}>{t("Quiet hours")}</span>
              <span className="set-note">{t("Team chat notifications stay on the bell during these hours: no push, email or text, and they aren't sent later.")}</span>
            </span>
            <input type="checkbox" className="switch" checked={draft.quiet_on} onChange={(e) => change({ quiet_on: e.target.checked })} aria-label={t("Quiet hours")} />
          </label>
          {draft.quiet_on && (
            <div className={n.quiet}>
              <div className={n.times}>
                <label className={n.time}>
                  <span>{t("From", { context: "time" })}</span>
                  <input className="input" type="time" value={draft.starts} required onChange={(e) => e.target.value && change({ starts: e.target.value })} />
                </label>
                <label className={n.time}>
                  <span>{t("To", { context: "time" })}</span>
                  <input className="input" type="time" value={draft.ends} required onChange={(e) => e.target.value && change({ ends: e.target.value })} />
                </label>
              </div>
              <div className={n.days} role="group" aria-label={t("Days")}>
                {weekdays().map(({ d, short, long }) => {
                  const on = draft.days.includes(d);
                  return (
                    <button key={d} type="button" className={n.day} aria-pressed={on} aria-label={long} title={long}
                      onClick={() => change({ days: on ? draft.days.filter((x) => x !== d) : [...draft.days, d].sort() })}>{short}</button>
                  );
                })}
              </div>
              <p className="set-note">
                {draft.starts > draft.ends ? t("Each night's quiet hours end the next morning.") : null}{" "}
                {t("Times are in {zone}.", { zone: zone.replace(/_/g, " ") })}{" "}
                {draft.time_zone && draft.time_zone !== companyZone ? (
                  <button type="button" className={n.link} onClick={() => change({ time_zone: null })}>{t("Use the business's time zone ({zone})", { zone: companyZone.replace(/_/g, " ") })}</button>
                ) : device && device !== zone ? (
                  <button type="button" className={n.link} onClick={() => change({ time_zone: device })}>{t("Use this device's time zone ({zone})", { zone: device.replace(/_/g, " ") })}</button>
                ) : null}
              </p>
              {draft.days.length === 0 && <p className="set-note">{t("Pick at least one day for quiet hours to start on.")}</p>}
            </div>
          )}
          {save.error && <span className="field-error">{(save.error as Error).message}</span>}
        </div>
      )}
    </Section>
  );
}
