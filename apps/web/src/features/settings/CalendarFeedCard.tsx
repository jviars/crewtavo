/** "Your schedule in your phone's calendar": a private subscribe link for Google, Apple or Outlook. */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Skeleton } from "@/components/ui/Skeleton";
import { api } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { timeAgo } from "@/lib/format";
import { useSession } from "@/lib/session";

interface Feed {
  url: string;
  scope: "mine" | "all";
  created_at: string;
  last_used_at: string | null;
}

export function CalendarFeedCard({ title = "Your schedule in your phone's calendar" }: { title?: ReactNode }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const key = ["calendar-feed", session.company.id];
  const feed = useQuery({ queryKey: key, queryFn: () => api.get<{ feed: Feed | null; can_see_all: boolean }>("/calendar-feed") });
  const [scope, setScope] = useState<"mine" | "all">("mine");
  const create = useMutation({
    meta: { success: "Calendar link ready" },
    mutationFn: (s: "mine" | "all") => api.post<{ feed: Feed }>("/calendar-feed", { scope: s }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key }),
  });
  const remove = useMutation({
    meta: { success: "Calendar link turned off" },
    mutationFn: () => api.delete("/calendar-feed"),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key }),
  });
  const f = feed.data?.feed;
  const webcal = f?.url.replace(/^https?:/, "webcal:");

  return (
    <div className="card card-pad stack-sm">
      <strong>{title}</strong>
      <span className="muted small">
        Visits show up in Google, Apple or Outlook Calendar and update on their own. Each calendar app checks for changes on its own schedule, from about an hour to a day
        (Google is the slowest), so for a change made today, look in Crewtavo. Add it to Google on a computer: Google's phone app can't add calendars.
      </span>
      {feed.isPending ? (
        <Skeleton height={38} radius={8} />
      ) : f ? (
        <>
          <div className="row wrap" style={{ gap: 8 }}>
            <a className="btn btn-primary" href={`https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcal!)}`} target="_blank" rel="noreferrer"><Icon name="calendar" size={16} />Add to Google Calendar</a>
            <a className="btn" href={webcal}><Icon name="calendar" size={16} />Apple or Outlook</a>
            <Button icon="copy" onClick={() => copyText(f.url, "Calendar link copied")}>Copy link</Button>
          </div>
          <span className="muted small">
            {f.scope === "all" ? "Shows the whole schedule." : "Shows the visits you're on."} {f.last_used_at ? `Last checked ${timeAgo(f.last_used_at)}.` : "Not added to a calendar yet."} Anyone with this link can see these visits, so keep it to yourself.
          </span>
          <div className="row wrap" style={{ gap: 8 }}>
            {feed.data?.can_see_all && (
              <Button size="sm" variant="ghost" loading={create.isPending} onClick={async () => (await confirm({ title: "Switch what it shows?", body: "You'll get a new link; add the new one to your calendar.", confirmLabel: "Switch" })) && create.mutate(f.scope === "all" ? "mine" : "all")}>
                {f.scope === "all" ? "Show only my visits" : "Show the whole schedule"}
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={async () => (await confirm({ title: "Make a new link?", body: "The old link stops working. Add the new one to your calendar.", confirmLabel: "New link" })) && create.mutate(f.scope)}>New link</Button>
            <Button size="sm" variant="ghost" loading={remove.isPending} onClick={async () => (await confirm({ title: "Turn off your calendar link?", body: "Your calendar stops getting visits from Crewtavo.", confirmLabel: "Turn off", danger: true })) && remove.mutate()}>Turn off</Button>
          </div>
        </>
      ) : (
        <div className="row wrap" style={{ gap: 8 }}>
          {feed.data?.can_see_all && (
            <div className="segmented" role="group" aria-label="What to show">
              <button type="button" aria-pressed={scope === "mine"} onClick={() => setScope("mine")}>My visits</button>
              <button type="button" aria-pressed={scope === "all"} onClick={() => setScope("all")}>Whole schedule</button>
            </div>
          )}
          <Button variant="primary" icon="calendar" loading={create.isPending} onClick={() => create.mutate(scope)}>Get my calendar link</Button>
        </div>
      )}
      <FormError error={create.error ?? remove.error} />
    </div>
  );
}
