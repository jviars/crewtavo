/**
 * "Your schedule in your phone's calendar": a private subscribe link for Google, Apple or Outlook, as a
 * section of Settings → Profile and Calendars (and an app's page). Switching what it shows, a new link
 * and turning it off are in its menu.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Menu, type MenuEntry } from "@/components/ui/Menu";
import { Section } from "@/components/ui/Section";
import { Skeleton } from "@/components/ui/Skeleton";
import { api } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { timeAgo } from "@/lib/format";
import { useSession } from "@/lib/session";
import { t } from "@/lib/i18n";

interface Feed {
  url: string;
  scope: "mine" | "all";
  created_at: string;
  last_used_at: string | null;
}

export function CalendarFeedCard({ title = t("Your schedule in your phone's calendar"), level }: { title?: ReactNode; level?: 2 | 3 }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const key = ["calendar-feed", session.company.id];
  const feed = useQuery({ queryKey: key, queryFn: () => api.get<{ feed: Feed | null; can_see_all: boolean }>("/calendar-feed") });
  const [scope, setScope] = useState<"mine" | "all">("mine");
  // The section changes in place, which says it worked.
  const create = useMutation({
    mutationFn: (s: "mine" | "all") => api.post<{ feed: Feed }>("/calendar-feed", { scope: s }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key }),
  });
  const remove = useMutation({
    mutationFn: () => api.delete("/calendar-feed"),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key }),
  });
  const f = feed.data?.feed;
  const webcal = f?.url.replace(/^https?:/, "webcal:");
  // What else there is to do with a link: in a menu, turning it off last.
  const more: MenuEntry[] | null = f
    ? [
        {
          label: f.scope === "all" ? t("Show only my visits") : t("Show the whole schedule"),
          icon: "calendar",
          hidden: !feed.data?.can_see_all,
          onSelect: async () => (await confirm({ title: t("Switch what it shows?"), body: t("You'll get a new link; add the new one to your calendar."), confirmLabel: t("Switch") })) && create.mutate(f.scope === "all" ? "mine" : "all"),
        },
        { label: t("New link"), icon: "refresh", onSelect: async () => (await confirm({ title: t("Make a new link?"), body: t("The old link stops working. Add the new one to your calendar."), confirmLabel: t("New link") })) && create.mutate(f.scope) },
        { separator: true },
        { label: t("Turn off"), icon: "x", danger: true, onSelect: async () => (await confirm({ title: t("Turn off your calendar link?"), body: t("Your calendar stops getting visits from Crewtavo."), confirmLabel: t("Turn off"), danger: true })) && remove.mutate() },
      ]
    : null;

  return (
    <Section level={level ?? (title === undefined ? 3 : 2)} title={title} action={more && <Menu items={more} label={t("More for your calendar link")} title={t("Your calendar link")} />}>
      <div className="set-stack">
        <p className="set-note">
          {t("Visits show up in Google, Apple or Outlook Calendar and update on their own. Each calendar app checks for changes on its own schedule, from about an hour to a day (Google is the slowest), so for a change made today, look in Crewtavo. Add it to Google on a computer: Google's phone app can't add calendars.")}
        </p>
        {feed.isPending ? (
          <Skeleton height={36} width={360} radius={8} />
        ) : f ? (
          <>
            <div className="row wrap" style={{ gap: 8 }}>
              <a className="btn" href={`https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcal!)}`} target="_blank" rel="noreferrer"><Icon name="calendar" size={16} />{t("Add to Google Calendar")}</a>
              <a className="btn" href={webcal}><Icon name="calendar" size={16} />{t("Apple or Outlook")}</a>
              <Button icon="copy" onClick={() => copyText(f.url, t("Calendar link copied"))}>{t("Copy link")}</Button>
            </div>
            <p className="set-note">
              {f.scope === "all" ? t("Shows the whole schedule.") : t("Shows the visits you're on.")} {f.last_used_at ? t("Last checked {when}.", { when: timeAgo(f.last_used_at) }) : t("Not added to a calendar yet.")} {t("Anyone with this link can see these visits, so keep it to yourself.")}
            </p>
            {(create.isPending || remove.isPending) && <span className="set-note" role="status">{t("Saving…")}</span>}
          </>
        ) : (
          <div className="row wrap" style={{ gap: 8 }}>
            {feed.data?.can_see_all && (
              <div className="segmented" role="group" aria-label={t("What to show")}>
                <button type="button" aria-pressed={scope === "mine"} onClick={() => setScope("mine")}>{t("My visits")}</button>
                <button type="button" aria-pressed={scope === "all"} onClick={() => setScope("all")}>{t("Whole schedule")}</button>
              </div>
            )}
            <Button icon="calendar" loading={create.isPending} onClick={() => create.mutate(scope)}>{t("Get my calendar link")}</Button>
          </div>
        )}
        <FormError error={create.error ?? remove.error} />
      </div>
    </Section>
  );
}
