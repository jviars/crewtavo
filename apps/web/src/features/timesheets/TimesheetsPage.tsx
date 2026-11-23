/**
 * Time for the week: the running clock, hours per person per day, edits, and approval for payroll.
 * Every change to an entry is on record (timeChanges.ts): an edited entry says who changed it, each
 * entry has its History, and time that was deleted stays listed under the person it belonged to.
 */
import { breakPay, isUnpaidBreak, SHORT_BREAK_MINUTES } from "@crewtavo/core/breaks";
import { localDate, localTime } from "@crewtavo/core/time";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent, type ReactNode } from "react";
import { Button, cx } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormChecks, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Menu } from "@/components/ui/Menu";
import { PageHeader } from "@/components/ui/PageHeader";
import { Loading, SectionSkeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { StatusPill } from "@/components/ui/StatusPill";
import { Face } from "@/components/ui/Avatar";
import { Select } from "@/components/ui/Select";
import { supabase, unwrap } from "@/lib/api";
import { downloadCsv, toCsv } from "@/lib/csv";
import { addDaysIso, formatMoney, formatTime, todayIn } from "@/lib/format";
import { useListAnimation } from "@/lib/motion";
import { can, hasRole, useSession } from "@/lib/session";
import { undoable } from "@/lib/undo";
import { ClockCard } from "../field/ClockCard";
import { CATEGORY_LABELS, type TimerCategory } from "../field/fieldData";
import { useMyCrews } from "../schedule/myCrews";
import { useDispatchOptions } from "../schedule/VisitDialog";
import { timeEntryProblem } from "@crewtavo/core/pay";
import { atPropertyNote, describePlace, type EntryPlaces, type StoredPlace } from "./clockPlace";
import { entrySpan } from "./entrySpan";
import { PayPeriods } from "./PayPeriods";
import { DeleteTimeDialog, TimeHistoryDialog } from "./TimeHistory";
import { editNote, sortEdits, spanLabel, type TimeChange } from "./timeChanges";
import { loadWeek, type Entry, type TeamMember, type WeekData } from "./weekData";
import { memberName } from "../subs/memberName";
import { inEnglish, intlLocale, t } from "@/lib/i18n";
import styles from "./Timesheets.module.css";

const hours = (start: string, end: string | null) => ((end ? Date.parse(end) : Date.now()) - Date.parse(start)) / 3_600_000;
const mondayOf = (date: string) => addDaysIso(date, -((new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7));
/** A week as short as a phone's header needs it: "Nov 17 – 23", "Nov 30 – Dec 6" (each language's own way). */
const shortRange = (monday: string) =>
  new Intl.DateTimeFormat(intlLocale(), { month: "short", day: "numeric", timeZone: "UTC" }).formatRange(new Date(`${monday}T12:00:00Z`), new Date(`${addDaysIso(monday, 6)}T12:00:00Z`));

export function TimesheetsPage() {
  const session = useSession();
  const queryClient = useQueryClient();
  const tz = session.company.timezone;
  const isOffice = hasRole(session, "admin", "office") && can(session, "timesheets");
  // Crew leads see their crew's time (the database limits the rows) and approve it with the area.
  const isLead = session.role === "crew_lead";
  const canApprove = isOffice || (isLead && can(session, "timesheets"));
  // Nobody but an owner approves their own time (the database holds to it): it's what they're paid for.
  const approvable = (userId: string) => canApprove && (userId !== session.userId || session.role === "owner");
  // Where people clocked in and out: the office's to see, and a crew lead's for their crew (the
  // database decides which, and never shows someone their own).
  const seesPlaces = isOffice || isLead;
  // Breaks the company doesn't pay for (Settings → Company) are left out of paid hours.
  const pay = breakPay(session.company.settings);
  const [week, setWeek] = useState(mondayOf(todayIn(tz)));
  // Pay (each person's pay for a period, and marking it paid) is for the office with job costs.
  const seesPay = hasRole(session, "admin", "office") && can(session, "job_costs");
  const [view, setView] = useState<"hours" | "pay">("hours");
  const [editing, setEditing] = useState<Entry | "new" | null>(null);
  // The entry whose history is open (one that's deleted has only its record), and the one being deleted.
  const [history, setHistory] = useState<{ id: string; what: string } | null>(null);
  const [deleting, setDeleting] = useState<Entry | null>(null);
  const days = Array.from({ length: 7 }, (_, i) => addDaysIso(week, i));

  const weekKey = ["time", session.company.id, week];
  const data = useQuery({
    queryKey: weekKey,
    queryFn: () => loadWeek({ companyId: session.company.id, week, timeZone: tz, seesPlaces }),
  });
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["time", session.company.id] });
    queryClient.invalidateQueries({ queryKey: ["running-timer"] });
    queryClient.invalidateQueries({ queryKey: ["job"] });
    queryClient.invalidateQueries({ queryKey: ["time-history"] });
  };
  const approve = useMutation({
    meta: { success: (n: number) => t.plural(n, { one: "Approved {count} entry", other: "Approved {count} entries" }) },
    mutationFn: async (userIds: string[]) => {
      let count = 0;
      for (const userId of userIds) {
        const rate = data.data?.team.find((m) => m.user_id === userId)?.labor_rate ?? null;
        const ids = data.data!.rows.filter((r) => r.user_id === userId && r.ended_at && !r.approved_at).map((r) => r.id);
        if (!ids.length) continue;
        unwrap(await supabase().from("time_entries").update({ approved_at: new Date().toISOString(), approved_by: session.userId, labor_rate: rate }).in("id", ids));
        count += ids.length;
      }
      return count;
    },
    onSuccess: refresh,
  });
  const unapprove = useMutation({
    meta: { success: t("Approval removed") },
    mutationFn: async (id: string) => unwrap(await supabase().from("time_entries").update({ approved_at: null, approved_by: null }).eq("id", id)),
    onSuccess: refresh,
  });
  const remove = useMutation({
    meta: { inline: true },
    mutationFn: async (id: string) => unwrap(await supabase().from("time_entries").delete().eq("id", id)),
    onSuccess: refresh,
  });
  // Gone from the week at once with Undo on the toast; deleted for real once the toast leaves.
  const removeLater = (entry: Entry) =>
    undoable({
      title: t("Time entry deleted"),
      hide: () => {
        void queryClient.cancelQueries({ queryKey: weekKey });
        queryClient.setQueryData<WeekData>(weekKey, (d) => d && { ...d, rows: d.rows.filter((r) => r.id !== entry.id) });
      },
      restore: () => queryClient.setQueryData<WeekData>(weekKey, (d) => (d && !d.rows.some((r) => r.id === entry.id) ? { ...d, rows: [...d.rows, entry].sort((a, b) => a.started_at.localeCompare(b.started_at)) } : d)),
      commit: () => remove.mutateAsync(entry.id),
    });

  const name = (id: string) => memberName(data.data?.team.find((m) => m.user_id === id), t("Team member"));
  const color = (id: string) => data.data?.team.find((m) => m.user_id === id)?.profile?.color ?? "var(--text-3)";
  const photo = (id: string) => data.data?.team.find((m) => m.user_id === id)?.profile?.avatar_url;
  const rows = data.data?.rows ?? [];
  // What's on record as edited this week, by entry, and the entries deleted from it.
  const edits = sortEdits(data.data?.changes ?? []);
  const people = [...new Set([...rows.map((r) => r.user_id), ...edits.deleted.map((c) => c.user_id)])].sort((a, b) => name(a).localeCompare(name(b)));
  const dayOf = (iso: string) => localDate(new Date(iso), tz);
  const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz });
  const dayLabel = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString(intlLocale(), { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  /** Which entry a history is of: "Mon, Nov 9 · 8:00 AM – 12:00 PM · Ray Crew". */
  const whatOf = (userId: string, start: string, end: string | null) => `${dayLabel(dayOf(start))} · ${spanLabel(start, end, tz)} · ${name(userId)}`;
  const pendingAll = rows.filter((r) => r.ended_at && !r.approved_at && approvable(r.user_id)).length;
  const isThisWeek = week === mondayOf(todayIn(tz));
  const paidHours = (r: Entry) => (isUnpaidBreak(r, pay) ? 0 : hours(r.started_at, r.ended_at));
  const placeOf = (id: string) => data.data?.places[id];
  const placeCell = (place: StoredPlace | null | undefined, entry: EntryPlaces | undefined) =>
    place ? `${describePlace(place, entry?.site ?? null).text}${place.lat != null ? ` (${place.lat}, ${place.lng})` : ""}` : "";

  // A file for payroll: its dates, times and numbers are written the English way whatever language the screen is in.
  const exportCsv = () =>
    downloadCsv(
      `timesheets-${week}.csv`,
      inEnglish(() => toCsv(
        rows.map((r) => ({
          person: name(r.user_id), date: dayOf(r.started_at), start: fmtTime(r.started_at), end: r.ended_at ? fmtTime(r.ended_at) : "",
          hours: r.ended_at ? hours(r.started_at, r.ended_at).toFixed(2) : "", paid_hours: r.ended_at ? paidHours(r).toFixed(2) : "", category: CATEGORY_LABELS[r.category], work: r.visit?.title ?? r.job?.title ?? "", approved: r.approved_at ? "yes" : "no",
          clock_in: placeCell(placeOf(r.id)?.in_place, placeOf(r.id)), clock_out: placeCell(placeOf(r.id)?.out_place, placeOf(r.id)),
          by_phone: atPropertyNote(r) ?? "",
        })),
        [
          { key: "person", label: t("Person") }, { key: "date", label: t("Date") }, { key: "start", label: t("Start") }, { key: "end", label: t("End") }, { key: "hours", label: t("Hours") }, { key: "paid_hours", label: t("Paid hours") }, { key: "category", label: t("Type") }, { key: "work", label: t("Visit or job") }, { key: "approved", label: t("Approved") }, { key: "by_phone", label: t("At the property") },
          ...(seesPlaces ? [{ key: "clock_in" as const, label: t("Clock-in location") }, { key: "clock_out" as const, label: t("Clock-out location") }] : []),
        ],
      )),
    );

  const tabs = seesPay && (
    <div className="underline-tabs" role="tablist" aria-label={t("Timesheets")}>
      <button type="button" role="tab" aria-selected={view === "hours"} onClick={() => setView("hours")}>{t("Hours")}</button>
      <button type="button" role="tab" aria-selected={view === "pay"} onClick={() => setView("pay")}>{t("Pay")}</button>
    </div>
  );
  if (view === "pay") {
    return (
      <PayPeriods
        header={(actions) => (
          <>
            <PageHeader title={t("Timesheets")} actions={actions} />
            {tabs}
          </>
        )}
      />
    );
  }

  const today = todayIn(tz);
  const weekday = (d: string) => dayLabel(d).split(",")[0];
  return (
    <>
      <PageHeader
        title={t("Timesheets")}
        actions={
          <>
            {isOffice && <Menu title={t("Timesheets")} items={[{ label: t("Download as spreadsheet"), icon: "download", onSelect: exportCsv, disabled: !rows.length }]} />}
            <Button icon="plus" onClick={() => setEditing("new")}>{t("Add time")}</Button>
            {canApprove && pendingAll > 0 && <Button variant="primary" icon="check" loading={approve.isPending} onClick={() => approve.mutate(people.filter(approvable))}>{t("Approve all ({count})", { count: pendingAll })}</Button>}
          </>
        }
      />
      {tabs}
      <div className={cx(styles.list, "m-grouped")}>
        {isThisWeek && <div className={styles.clock}><ClockCard /></div>}

        <div className={styles.week} role="group" aria-label={t("Week")}>
          <Button size="sm" className={styles.prev} icon="chevronLeft" aria-label={t("Previous week")} onClick={() => setWeek(addDaysIso(week, -7))} />
          <Button size="sm" className={cx(styles.thisWeek, isThisWeek && "hide-mobile")} onClick={() => setWeek(mondayOf(todayIn(tz)))}>{t("This week")}</Button>
          <Button size="sm" className={styles.next} icon="chevronRight" aria-label={t("Next week")} onClick={() => setWeek(addDaysIso(week, 7))} />
          <span className={styles.range} aria-live="polite">
            <span className="hide-mobile">{dayLabel(week)} – {dayLabel(addDaysIso(week, 6))}</span>
            {/* A phone has room for "Nov 17 – 23" between the arrows (Mobile-Business, Timesheets). */}
            <span className={styles.rangeShort}>{shortRange(week)}</span>
          </span>
        </div>

        {data.isPending && <Loading><div className={styles.list}>{[0, 1].map((i) => <SectionSkeleton key={i} rows={3} />)}</div></Loading>}
        {data.error && <ErrorState error={data.error} onRetry={() => data.refetch()} />}
        {data.data && people.length === 0 && <div className={styles.empty}><EmptyState icon="clock" title={t("No time recorded this week")} action={<Button icon="plus" onClick={() => setEditing("new")}>{t("Add time")}</Button>} /></div>}

        {people.map((userId) => {
          const mine = rows.filter((r) => r.user_id === userId);
          const total = mine.reduce((s, r) => s + paidHours(r), 0);
          const unpaid = mine.filter((r) => isUnpaidBreak(r, pay)).reduce((s, r) => s + hours(r.started_at, r.ended_at), 0);
          const pending = mine.filter((r) => r.ended_at && !r.approved_at).length;
          const rate = data.data?.team.find((m) => m.user_id === userId)?.labor_rate;
          return (
            <section key={userId} className={styles.person} aria-labelledby={`ts-${userId}`}>
              <div className={styles.head}>
                <span className={cx("avatar", styles.face)} style={{ background: color(userId) }}><Face name={name(userId)} photo={photo(userId)} /></span>
                <h2 className={styles.name} id={`ts-${userId}`}>{name(userId)}</h2>
                <span className={styles.hours}><b>{total.toFixed(2)}</b> h{isOffice && rate ? ` · ${formatMoney(total * Number(rate))}` : null}</span>
                {unpaid > 0 && <span className={styles.quiet}>{t("+ {hours} h unpaid breaks", { hours: unpaid.toFixed(2) })}</span>}
                {total > 40 && <span className={styles.over}>{t("{hours} h over 40", { hours: (total - 40).toFixed(1) })}</span>}
                {approvable(userId) && pending > 0 && <Button size="sm" className={styles.approve} icon="check" loading={approve.isPending && approve.variables?.length === 1 && approve.variables[0] === userId} onClick={() => approve.mutate([userId])}>{t("Approve {count}", { count: pending })}</Button>}
              </div>
              <div className={styles.days}>
                {days.map((d) => {
                  const h = mine.filter((r) => dayOf(r.started_at) === d).reduce((s, r) => s + paidHours(r), 0);
                  return (
                    <div key={d} className={styles.day} data-off={h ? undefined : ""} data-today={d === today ? "" : undefined} title={dayLabel(d)}>
                      {weekday(d)}
                      <b>{h ? h.toFixed(1) : "—"}</b>
                    </div>
                  );
                })}
              </div>
              <EntryRows>
                {mine.map((r) => {
                  const canEdit = isOffice || (!r.approved_at && (r.user_id === session.userId || isLead));
                  const lastEdit = edits.byEntry.get(r.id)?.at(-1);
                  const openHistory = () => setHistory({ id: r.id, what: whatOf(r.user_id, r.started_at, r.ended_at) });
                  const unpaidBreak = isUnpaidBreak(r, pay);
                  const length = hours(r.started_at, r.ended_at).toFixed(2);
                  const what = r.visit?.title ?? r.job?.title ?? t(CATEGORY_LABELS[r.category]);
                  return (
                    <div key={r.id} className={styles.entry}>
                      <span className={styles.when}>
                        <span className={styles.entryDay} title={dayLabel(dayOf(r.started_at))}>{weekday(dayOf(r.started_at))}</span>
                        <span className={styles.time}>{formatTime(r.started_at, tz)} – {r.ended_at ? formatTime(r.ended_at, tz) : t("now")}</span>
                      </span>
                      <span className={styles.what}>
                        <span className={styles.whatTitle}>{what}</span>
                        {(r.notes || placeOf(r.id) || atPropertyNote(r) || unpaidBreak) && (
                          <span className={styles.sub}>
                            {r.notes && <span>{r.notes}</span>}
                            {placeOf(r.id) && <ClockPlaces places={placeOf(r.id)!} userId={r.user_id} name={name} />}
                            {atPropertyNote(r) && (
                              <span className={styles.place} title={t("The phone did this by itself as they got to or left a visit's property, not a tap (Settings → Company → Time clock).")}>
                                <Icon name="clock" size={12} />
                                {atPropertyNote(r)}
                              </span>
                            )}
                            {unpaidBreak && <span title={pay === "unpaid" ? t("Breaks aren't paid time") : t("Breaks over {minutes} minutes aren't paid time", { minutes: SHORT_BREAK_MINUTES })}>{t("{hours} h unpaid", { hours: length })}</span>}
                          </span>
                        )}
                        {lastEdit && (
                          <button type="button" className={styles.edited} onClick={openHistory}>
                            {editNote(lastEdit, session.userId, name)} · {dayLabel(dayOf(lastEdit.changed_at))}
                          </button>
                        )}
                      </span>
                      <span className={styles.entryHours} data-unpaid={unpaidBreak ? "" : undefined}>{length}<span className="sr-only"> h</span></span>
                      <span className={styles.status}>
                        {r.auto_stopped_at && !r.approved_at ? (
                          <span title={t("The clock was left running, so Crewtavo stopped it. Check the end time.")}><StatusPill label={t("Check end time")} tone="danger" /></span>
                        ) : r.approved_at ? (
                          <StatusPill label={t("Approved")} tone="good" />
                        ) : r.ended_at ? (
                          <StatusPill label={t("Pending")} tone="muted" />
                        ) : (
                          <StatusPill label={t("Running")} tone="info" />
                        )}
                      </span>
                      <span className={styles.more}>
                        <Menu
                          triggerClassName="btn btn-sm btn-ghost btn-icon"
                          title={`${weekday(dayOf(r.started_at))} · ${what}`}
                          items={[
                            { label: t("Edit"), icon: "edit", hidden: !canEdit || !r.ended_at, onSelect: () => setEditing(r) },
                            { label: t("History"), icon: "clock", onSelect: openHistory },
                            { label: t("Remove approval"), icon: "undo", hidden: !canEdit || !approvable(r.user_id) || !r.approved_at, onSelect: () => unapprove.mutate(r.id) },
                            { separator: true, hidden: !canEdit },
                            // Their own goes at once, with Undo. Someone else's asks why first, and they're told.
                            { label: t("Delete"), icon: "trash", danger: true, hidden: !canEdit, onSelect: () => (r.user_id === session.userId ? removeLater(r) : setDeleting(r)) },
                          ]}
                        />
                      </span>
                    </div>
                  );
                })}
              </EntryRows>
              {edits.deleted.filter((c) => c.user_id === userId).map((c) => <DeletedRow key={c.entry_id} change={c} what={whatOf(c.user_id, c.old_started_at!, c.old_ended_at)} note={`${editNote(c, session.userId, name)} · ${dayLabel(dayOf(c.changed_at))}`} onHistory={setHistory} />)}
            </section>
          );
        })}
      </div>

      {editing && <TimeEntryDialog entry={editing === "new" ? null : editing} team={data.data?.team ?? []} defaultDate={isThisWeek ? todayIn(tz) : week} onClose={() => setEditing(null)} onSaved={refresh} />}
      {history && <TimeHistoryDialog entryId={history.id} what={history.what} name={name} onClose={() => setHistory(null)} />}
      {deleting && <DeleteTimeDialog entry={deleting} person={name(deleting.user_id)} onClose={() => setDeleting(null)} onDeleted={refresh} />}
    </>
  );
}

/** A person's entries for the week, sliding into place as they're added, deleted or put back. */
function EntryRows({ children }: { children: ReactNode }) {
  const ref = useListAnimation<HTMLDivElement>();
  return <div ref={ref}>{children}</div>;
}

/** Time that was deleted: still listed under the person, struck through, with who deleted it and why. It counts for no hours. */
function DeletedRow({ change, what, note, onHistory }: { change: TimeChange; what: string; note: string; onHistory: (entry: { id: string; what: string }) => void }) {
  const tz = useSession().company.timezone;
  const day = what.split(" · ")[0]!;
  return (
    <div className={cx(styles.entry, styles.gone)}>
      <span className={styles.when}>
        <span className={styles.entryDay} title={day}>{day.split(",")[0]}</span>
        <s className={styles.time}>{spanLabel(change.old_started_at!, change.old_ended_at, tz)}</s>
      </span>
      <span className={styles.what}>
        <span className={styles.sub}>{note}{change.reason ? ` · ${t("Why: {reason}", { reason: change.reason })}` : ""}</span>
      </span>
      <span className={styles.status}><StatusPill label={t("Deleted")} tone="muted" /></span>
      <span className={styles.more}>
        <Button size="sm" variant="ghost" icon="clock" aria-label={t("History")} title={t("History")} onClick={() => onHistory({ id: change.entry_id, what })} />
      </span>
    </div>
  );
}

/** Where the clock started and stopped, for the office and crew leads. Each place opens on a map. */
function ClockPlaces({ places, userId, name }: { places: EntryPlaces; userId: string; name: (id: string) => string }) {
  const ends = [["In", places.in_place], ["Out", places.out_place]] as const;
  return (
    <>
      {ends.map(([label, place]) => {
        if (!place) return null;
        const d = describePlace(place, places.site);
        // A crew lead clocking in the crew sends where their own phone is.
        const text = `${label}: ${d.text}${place.by && place.by !== userId ? ` (${name(place.by)}'s phone)` : ""}`;
        return (
          <span key={label} className={styles.place} data-tone={d.tone === "warning" ? "warning" : undefined}>
            <Icon name="pin" size={12} />
            {d.mapUrl ? <a href={d.mapUrl} target="_blank" rel="noreferrer" title={d.title}>{text}</a> : text}
          </span>
        );
      })}
    </>
  );
}

function TimeEntryDialog({ entry, team, defaultDate, onClose, onSaved }: { entry: Entry | null; team: TeamMember[]; defaultDate: string; onClose: () => void; onSaved: () => void }) {
  const session = useSession();
  const tz = session.company.timezone;
  const isOffice = hasRole(session, "admin", "office", "crew_lead");
  const crew = useCrewmates(session.role === "crew_lead");
  const people = team.filter((m) => m.active && (session.role !== "crew_lead" || crew.has(m.user_id)));
  const [userId, setUserId] = useState(entry?.user_id ?? session.userId);
  const [date, setDate] = useState(entry ? localDate(new Date(entry.started_at), tz) : defaultDate);
  const [start, setStart] = useState(entry ? localTime(new Date(entry.started_at), tz) : "08:00");
  const [end, setEnd] = useState(entry?.ended_at ? localTime(new Date(entry.ended_at), tz) : "16:30");
  const [category, setCategory] = useState<TimerCategory>(entry?.category ?? "other");
  const [notes, setNotes] = useState(entry?.notes ?? "");
  // Why an entry is being changed: kept with the record of the change, where whoever's time it is reads it.
  const [reason, setReason] = useState("");
  const theirs = entry && entry.user_id !== session.userId ? team.find((m) => m.user_id === entry.user_id) : null;
  // Null while the date or a time is cleared (past midnight means the next day).
  const span = entrySpan(date, start, end, tz);
  const length = span ? (span.endAt.getTime() - span.startAt.getTime()) / 3_600_000 : 0;
  const future = Boolean(span && span.startAt.getTime() > Date.now());
  const save = useMutation({
    meta: { inline: true, success: entry ? t("Time entry saved") : t("Time added") },
    mutationFn: async () => {
      if (!span) throw new Error(t("Enter the date and the start and end times."));
      const { startAt, endAt } = span;
      // The same checks AI assistants' time tools make (packages/core/src/pay.ts).
      const problem = timeEntryProblem({ startAt, endAt });
      if (problem) throw new Error(problem);
      // A fixed entry is no longer a guess. change_reason goes to the record of the change, never onto
      // the entry; sent even when empty, so the record knows this was an edit and not a tap on the clock.
      const row = { started_at: startAt.toISOString(), ended_at: endAt.toISOString(), category, notes: notes.trim() || null, ...(entry ? { auto_stopped_at: null, change_reason: reason.trim() } : {}) };
      if (entry) unwrap(await supabase().from("time_entries").update(row).eq("id", entry.id));
      else unwrap(await supabase().from("time_entries").insert({ ...row, company_id: session.company.id, user_id: userId }));
    },
    onSuccess: () => {
      onSaved();
      onClose();
    },
  });
  return (
    <Dialog open onClose={onClose} title={entry ? t("Edit time") : t("Add time")}>
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
        {isOffice && !entry && (
          <Field label={t("Person")}>
            <Select className="select" value={userId} onChange={(e) => setUserId(e.target.value)}>
              {people.map((m) => <option key={m.user_id} value={m.user_id}>{m.profile?.full_name || t("Team member")}</option>)}
            </Select>
          </Field>
        )}
        <Field label={t("Date")}><input className="input" type="date" value={date} max={todayIn(tz)} onChange={(e) => setDate(e.target.value)} required /></Field>
        <div className="form-grid">
          <Field label={t("Start")} error={future ? t("Pick a start time that has passed.") : null}><input className="input" type="time" value={start} onChange={(e) => setStart(e.target.value)} required /></Field>
          <Field label={t("End")} hint={length > 0 ? (end <= start ? t("{hours} hours (ends the next day)", { hours: length.toFixed(2) }) : t("{hours} hours", { hours: length.toFixed(2) })) : undefined}><input className="input" type="time" value={end} onChange={(e) => setEnd(e.target.value)} required /></Field>
        </div>
        <Field label={t("Type")}>
          <Select className="select" value={category} onChange={(e) => setCategory(e.target.value as TimerCategory)}>
            {(Object.keys(CATEGORY_LABELS) as TimerCategory[]).map((c) => <option key={c} value={c}>{t(CATEGORY_LABELS[c])}</option>)}
          </Select>
        </Field>
        <Field label={t("Note")} optional><input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={300} placeholder={t("Forgot to clock in at the Shah job")} /></Field>
        {entry && (
          <Field
            label={t("Why it's changing")}
            optional
            hint={entry.user_id !== session.userId ? t("{name} is told about the change and sees this. The entry's history keeps what it said before.", { name: memberName(theirs ?? undefined, t("Team member")) }) : t("Kept in the entry's history with what it said before.")}
          >
            <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
          </Field>
        )}
        {length > 12 && <div className="callout callout-warning"><Icon name="alert" size={16} /><div className="grow">{t("That's a {hours}-hour entry. Double-check the times.", { hours: length.toFixed(1) })}</div></div>}
        <FormError error={save.error} />
        <div className="form-actions">
          <FormChecks />
          <Button onClick={onClose}>{t("Cancel")}</Button>
          <Button type="submit" variant="primary" loading={save.isPending}>{entry ? t("Save") : t("Add time")}</Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Me and the people on the crews I lead or am on (for a crew lead's "Add time"). */
function useCrewmates(enabled: boolean): Set<string> {
  const session = useSession();
  const crews = useMyCrews(enabled);
  const options = useDispatchOptions();
  const mine = crews.data ?? [];
  return new Set([
    session.userId,
    ...(options.data?.crewMembers ?? []).filter((m) => mine.includes(m.crew_id)).map((m) => m.user_id),
    ...(options.data?.crews ?? []).filter((c) => mine.includes(c.id) && c.lead_user_id).map((c) => c.lead_user_id!),
  ]);
}
