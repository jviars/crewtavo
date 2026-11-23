/**
 * Snow → a visit's service report, to print or save as a PDF: proof of what was done at a property
 * and when, for the customer or for a claim. Where and what, the storm (what fell, what was
 * forecast), when the crew set out, arrived and left, how long they were there, who did it, and the
 * photos from the visit with when each was taken. Every time is as the app recorded it: the crew's
 * clock on the visit, and their taps in the field app. On the same paper as a paving worksheet.
 */
import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { DetailHeader } from "@/components/ui/DetailPage";
import { Icon } from "@/components/ui/Icon";
import { BackLink, useDocumentTitle } from "@/components/ui/PageHeader";
import { DetailSkeleton } from "@/components/ui/Skeleton";
import { PageError } from "@/components/ui/States";
import { EntityStatus } from "@/components/ui/StatusPill";
import { api, supabase, unwrap, unwrapOne } from "@/lib/api";
import { signedUrls } from "@/lib/files";
import { addressLine, formatDate, formatDateTime } from "@/lib/format";
import { useSession } from "@/lib/session";
import { inches, nameOf, type Member } from "./snowData";

const VISIT =
  "id, title, scheduled_on, status, completed_at, completed_by, notes, job:jobs(number, title, client:clients(display_name), property:properties(line1, line2, city, region, postal_code)), crew:crews(name), assignees:visit_assignees(user_id), storm:snow_visits(snow_date, event:snow_events(kind, forecast_in, actual_in, actual_by))";

async function loadReport(visitId: string) {
  const db = supabase();
  const [visit, photos, clock, taps] = await Promise.all([
    db.from("visits").select(VISIT).eq("id", visitId).maybeSingle(),
    db.from("attachments").select("id, path, caption, content_type, created_at, created_by").eq("owner_type", "visit").eq("owner_id", visitId).order("created_at"),
    db.from("time_entries").select("user_id, started_at, ended_at").eq("visit_id", visitId).order("started_at"),
    db.from("activity").select("verb, created_at, actor_id").eq("subject_type", "visit").eq("subject_id", visitId).in("verb", ["visit.en_route", "visit.started", "visit.completed"]).order("created_at"),
  ]);
  const pictures = unwrap(photos).filter((p) => p.content_type?.startsWith("image/"));
  return { visit: unwrapOne(visit, "That visit"), photos: pictures, urls: await signedUrls(pictures.map((p) => p.path)), clock: unwrap(clock), taps: unwrap(taps) };
}

/** "1 hr 25 min" between two instants. */
function lasted(from: string, to: string): string {
  const minutes = Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 60_000));
  return [Math.floor(minutes / 60) && `${Math.floor(minutes / 60)} hr`, `${minutes % 60} min`].filter(Boolean).join(" ");
}

export function SnowReportPage() {
  const { company } = useSession();
  const { visitId = "" } = useParams();
  // The tab's title is the PDF's name when it's saved, so it stays the report's, whoever it's for.
  useDocumentTitle("Snow service report");
  const report = useQuery({ queryKey: ["snow", company.id, "report", visitId], queryFn: () => loadReport(visitId) });
  const team = useQuery({ queryKey: ["team", company.id, "with-subs"], staleTime: 5 * 60_000, queryFn: () => api.get<Member[]>("/team?with_subs=1") });
  if (report.isPending) return <DetailSkeleton />;
  if (report.error || !report.data) return <PageError error={report.error} onRetry={() => report.refetch()} back={<BackLink to="/snow?tab=log">Season</BackLink>} />;
  const { visit, photos, urls, clock, taps } = report.data;
  const who = (userId: string | null | undefined) => (userId ? nameOf((team.data ?? []).find((m) => m.user_id === userId)) : null);
  const tz = company.timezone;
  const at = (time: string | null | undefined) => (time ? formatDateTime(time, tz) : null);
  const tap = (verb: string) => taps.find((t) => t.verb === verb)?.created_at ?? null;
  // The clock on the visit is what says when they were there; their taps in the app, where nobody clocked in.
  const arrived = clock[0]?.started_at ?? tap("visit.started");
  const ended = clock.filter((c) => c.ended_at).map((c) => c.ended_at!).sort().at(-1) ?? null;
  const left = ended ?? visit.completed_at;
  const storm = (Array.isArray(visit.storm) ? visit.storm[0] : visit.storm) ?? null;
  const event = storm ? (Array.isArray(storm.event) ? storm.event[0] : storm.event) : null;
  const people = [...new Set([...clock.map((c) => c.user_id), ...visit.assignees.map((a) => a.user_id), visit.completed_by].filter((u): u is string => Boolean(u)))];
  const rows: Array<[string, string | null]> = [
    ["Customer", visit.job?.client?.display_name ?? null],
    ["Property", addressLine(visit.job?.property) || null],
    ["Service", visit.title],
    ["Date", visit.scheduled_on ? formatDate(visit.scheduled_on) : null],
    ["Storm", event ? [event.actual_in != null && `${inches(Number(event.actual_in))} fell (${event.actual_by ? "as measured" : "the forecast's estimate"})`, event.forecast_in != null && `${inches(Number(event.forecast_in))} was forecast`].filter(Boolean).join(", ") || null : null],
    ["Set out", at(tap("visit.en_route"))],
    ["Arrived", at(arrived)],
    ["Left", visit.status === "completed" || ended ? at(left) : null],
    ["On site", arrived && left && (visit.status === "completed" || ended) ? lasted(arrived, left) : null],
    ["Done by", people.map(who).filter(Boolean).join(", ") || visit.crew?.name || null],
    ["Marked done", visit.completed_at ? [at(visit.completed_at), who(visit.completed_by) && `by ${who(visit.completed_by)}`].filter(Boolean).join(" ") : null],
  ];
  return (
    <>
      <div className="no-print">
        <DetailHeader
          crumb={{ to: "/snow?tab=log", label: "Season" }}
          title="Service report"
          documentTitle="Snow service report"
          // The visit's own status; one that isn't done says what that means for the report just under it.
          status={<EntityStatus kind="visit" status={visit.status} />}
          meta={[visit.job?.client?.display_name, visit.scheduled_on && formatDate(visit.scheduled_on), visit.job && `Job #${visit.job.number}`]}
          actions={<Button variant="primary" icon="printer" onClick={() => window.print()}>Print or save as PDF</Button>}
        >
          {visit.status !== "completed" && (
            <div className="callout callout-warning">
              <Icon name="alert" size={16} />
              <div className="grow">This visit isn't marked done yet, so the report is what's recorded so far.</div>
            </div>
          )}
        </DetailHeader>
      </div>
      <article className="worksheet">
        <header className="worksheet-head">
          <div>
            <div className="worksheet-company">{company.name}</div>
            <h1>Snow service report</h1>
            {visit.job && <div className="worksheet-aside">Job #{visit.job.number} · {visit.job.title}</div>}
          </div>
          {visit.status !== "completed" && <div><span className="worksheet-flag">Not done yet</span></div>}
        </header>
        <section>
          <h2>What was done</h2>
          <table className="worksheet-table">
            <tbody>
              {rows.filter(([, value]) => value).map(([label, value]) => <tr key={label}><td style={{ width: 130, color: "#6b747c" }}>{label}</td><td style={{ fontWeight: 600 }}>{value}</td></tr>)}
            </tbody>
          </table>
        </section>
        {visit.notes && <section><h2>Notes</h2><p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{visit.notes}</p></section>}
        <section>
          <h2>Photos</h2>
          {photos.length === 0 ? (
            <p className="worksheet-aside" style={{ margin: 0 }}>No photos were taken on this visit.</p>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 14 }}>
              {photos.map((p) => (
                <figure key={p.id} style={{ margin: 0, breakInside: "avoid" }}>
                  {urls[p.path] && <img src={urls[p.path]} alt={p.caption ?? "Photo from the visit"} style={{ width: "100%", aspectRatio: "4 / 3", objectFit: "cover", borderRadius: 6, border: "1px solid #e3e6e8" }} />}
                  <figcaption className="worksheet-aside" style={{ marginTop: 4 }}>{[p.caption, at(p.created_at), who(p.created_by)].filter(Boolean).join(" · ")}</figcaption>
                </figure>
              ))}
            </div>
          )}
        </section>
        <p className="worksheet-aside" style={{ margin: "24px 0 0" }}>
          Times are as {company.name} recorded them: the crew's clock on this visit, and when they marked it on the way, started and done. Photo times are when each was added.
        </p>
      </article>
    </>
  );
}
