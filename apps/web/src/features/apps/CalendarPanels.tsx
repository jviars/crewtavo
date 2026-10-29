/**
 * Other calendars on the schedule, managed from each calendar app's page and Settings: add one by
 * its ICS link or from a file, pick calendars from a connected Google account, assign a calendar
 * to a crew, and (Google) put visits on a Google calendar.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type CSSProperties, type FormEvent } from "react";
import { Button, Spinner } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Skeleton } from "@/components/ui/Skeleton";
import { ErrorState } from "@/components/ui/States";
import { api, supabase, unwrap } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { timeAgo } from "@/lib/format";
import { useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import { CALENDAR_FILE_TYPES, pickCalendar, readCalendarFiles } from "./calendarFiles";
import { CALENDAR_NOUNS } from "./catalog";

export interface CalendarSource {
  id: string;
  kind: "ics" | "google" | "file";
  app: string;
  name: string;
  color: string | null;
  crew_id: string | null;
  show_details: boolean;
  blocks_time: boolean;
  enabled: boolean;
  host: string | null;
  event_count: number;
  last_synced_at: string | null;
  last_error: string | null;
}

interface GoogleState {
  connected: boolean;
  status: string;
  account_label: string | null;
  last_sync_at: string | null;
  last_error: string | null;
  visits_calendar: { name: string } | null;
}

const COLORS = ["#2563eb", "#7c3aed", "#db2777", "#dc2626", "#ea580c", "#ca8a04", "#16a34a", "#0891b2", "#64748b"];

export function useCalendars(enabled = true) {
  const session = useSession();
  return useQuery({ queryKey: ["calendars", session.company.id], enabled, queryFn: () => api.get<{ calendars: CalendarSource[]; google: GoogleState }>("/calendars") });
}

function useCrews() {
  const session = useSession();
  return useQuery({
    queryKey: ["crews", session.company.id, "calendar-picker"],
    staleTime: 5 * 60_000,
    queryFn: async () => unwrap(await supabase().from("crews").select("id, name").eq("company_id", session.company.id).eq("active", true).order("name")),
  });
}

/** After any change: the calendars, the Apps grid's badges and the schedule. */
function useRefreshCalendars() {
  const queryClient = useQueryClient();
  return () => {
    for (const key of ["calendars", "apps", "google-calendars", "schedule"]) queryClient.invalidateQueries({ queryKey: [key] });
  };
}

// ---------------------------------------------------------------------------------------------
// One calendar
// ---------------------------------------------------------------------------------------------

export function CalendarRow({ source }: { source: CalendarSource }) {
  const crews = useCrews();
  const refresh = useRefreshCalendars();
  const [editing, setEditing] = useState(false);
  const file = source.kind === "file";
  const sync = useMutation({
    meta: { success: (s: CalendarSource) => `${s.name} is up to date` },
    mutationFn: () => api.post<CalendarSource>(`/calendars/${source.id}/refresh`),
    onSettled: refresh,
  });
  // A file calendar changes when its file is uploaded again (a .zip's calendar of the same name).
  const reupload = useMutation({
    meta: { inline: true, success: (s: CalendarSource) => `${s.name} updated · ${s.event_count} ${s.event_count === 1 ? "event" : "events"}` },
    mutationFn: async (chosen: File) => {
      const picked = pickCalendar(await readCalendarFiles(chosen), source.name);
      return api.post<CalendarSource>(`/calendars/${source.id}/file`, { text: picked.text });
    },
    onSettled: refresh,
  });
  const crew = crews.data?.find((c) => c.id === source.crew_id);
  const where = source.kind === "google" ? "Google" : file ? "From a file" : source.host;
  const when = source.last_synced_at ? `${file ? "uploaded" : "updated"} ${timeAgo(source.last_synced_at)}` : null;
  return (
    <div className="cal-source" data-off={!source.enabled || undefined}>
      <span className="cal-swatch" style={{ "--c": source.color ?? "var(--text-4)" } as CSSProperties} aria-hidden="true" />
      <div className="grow stack-sm" style={{ gap: 2, minWidth: 0 }}>
        <strong className="truncate">{source.name}</strong>
        <span className="muted small">
          {!source.enabled
            ? "Off"
            : [crew ? `${crew.name}'s time` : "Whole team", `${source.event_count} ${source.event_count === 1 ? "event" : "events"}`, when, source.show_details ? null : "shown as Busy"]
                .filter(Boolean)
                .join(" · ")}
          {where && <span className="cal-host"> · {where}</span>}
        </span>
        {source.last_error && source.enabled && <span className="small" style={{ color: "var(--danger)", fontWeight: 600 }}><Icon name="alert" size={14} /> {source.last_error}</span>}
        {reupload.error && <FormError error={reupload.error} />}
      </div>
      {file ? (
        <label className="btn btn-ghost btn-sm btn-icon" title="Upload the file again" aria-busy={reupload.isPending || undefined}>
          {reupload.isPending ? <Spinner size={14} /> : <Icon name="upload" size={14} />}
          <span className="sr-only">Upload {source.name} again</span>
          <input
            type="file"
            accept={CALENDAR_FILE_TYPES}
            className="sr-only"
            disabled={reupload.isPending}
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) reupload.mutate(f); }}
          />
        </label>
      ) : source.enabled && <Button size="sm" variant="ghost" icon="refresh" aria-label={`Refresh ${source.name} now`} title="Refresh now" loading={sync.isPending} onClick={() => sync.mutate()} />}
      <Button size="sm" variant="ghost" icon="edit" aria-label={`Change ${source.name}`} title="Change" onClick={() => setEditing(true)} />
      {editing && <EditCalendarDialog source={source} crews={crews.data ?? []} onClose={() => setEditing(false)} />}
    </div>
  );
}

function ColorPicker({ value, onChange }: { value: string | null; onChange: (color: string | null) => void }) {
  return (
    <div className="color-swatches" role="radiogroup" aria-label="Color">
      {COLORS.map((c) => (
        <button key={c} type="button" role="radio" aria-checked={value === c} aria-label={c} className="color-swatch" style={{ "--c": c } as CSSProperties} onClick={() => onChange(c)}>
          {value === c && <Icon name="check" size={14} strokeWidth={2} />}
        </button>
      ))}
    </div>
  );
}

function CrewSelect({ value, onChange, crews }: { value: string; onChange: (crew: string) => void; crews: Array<{ id: string; name: string }> }) {
  return (
    <select className="select" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">The whole team</option>
      {crews.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
    </select>
  );
}

function EditCalendarDialog({ source, crews, onClose }: { source: CalendarSource; crews: Array<{ id: string; name: string }>; onClose: () => void }) {
  const refresh = useRefreshCalendars();
  const [name, setName] = useState(source.name);
  const [color, setColor] = useState(source.color);
  const [crewId, setCrewId] = useState(source.crew_id ?? "");
  const [details, setDetails] = useState(source.show_details);
  const [blocks, setBlocks] = useState(source.blocks_time);
  const [enabled, setEnabled] = useState(source.enabled);
  const save = useMutation({
    meta: { inline: true, success: "Calendar saved" },
    mutationFn: () =>
      api.patch<CalendarSource>(`/calendars/${source.id}`, { name: name.trim(), color, crew_id: crewId || null, show_details: details, blocks_time: blocks, ...(source.kind === "file" ? {} : { enabled }) }),
    onSuccess: () => {
      refresh();
      onClose();
    },
  });
  const remove = useMutation({
    meta: { success: `${source.name} removed` },
    mutationFn: () => api.delete(`/calendars/${source.id}`),
    onSuccess: () => {
      refresh();
      onClose();
    },
  });
  return (
    <Dialog open onClose={onClose} title="Change calendar">
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); if (name.trim()) save.mutate(); }}>
        <Field label="Name"><input className="input" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} required /></Field>
        <Field label="Color"><ColorPicker value={color} onChange={setColor} /></Field>
        <Field label="Whose time is it?" hint="A crew's calendar sits in that crew's lane and only blocks its time.">
          <CrewSelect value={crewId} onChange={setCrewId} crews={crews} />
        </Field>
        <CalendarSwitches details={details} setDetails={setDetails} blocks={blocks} setBlocks={setBlocks} />
        {source.kind === "file" ? (
          details && !source.show_details && <span className="muted small">The names were never kept, so they come back when you upload the file again.</span>
        ) : (
          <label className="switch-row">
            <input type="checkbox" className="switch" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            Show on the schedule
          </label>
        )}
        <FormError error={save.error ?? remove.error} />
        <div className="form-actions" style={{ justifyContent: "space-between" }}>
          <Button
            variant="danger"
            icon="trash"
            loading={remove.isPending}
            onClick={async () => (await confirm({ title: `Remove ${source.name}?`, body: source.kind === "file" ? "Its events come off the schedule. Upload the file again to bring them back." : "Its events come off the schedule. The calendar itself isn't changed.", confirmLabel: "Remove", danger: true })) && remove.mutate()}
          >
            Remove
          </Button>
          <span className="row" style={{ gap: 8 }}>
            <Button onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" loading={save.isPending}>Save</Button>
          </span>
        </div>
      </form>
    </Dialog>
  );
}

function CalendarSwitches({ details, setDetails, blocks, setBlocks }: { details: boolean; setDetails: (v: boolean) => void; blocks: boolean; setBlocks: (v: boolean) => void }) {
  return (
    <div className="stack-sm">
      <label className="switch-row">
        <input type="checkbox" className="switch" checked={details} onChange={(e) => setDetails(e.target.checked)} />
        <span>Show event names and details<span className="muted small" style={{ display: "block" }}>Off shows events as Busy and keeps no names, places or notes. Good for someone's personal calendar.</span></span>
      </label>
      <label className="switch-row">
        <input type="checkbox" className="switch" checked={blocks} onChange={(e) => setBlocks(e.target.checked)} />
        <span>Count as busy in Find a time<span className="muted small" style={{ display: "block" }}>Events marked free in the calendar never count.</span></span>
      </label>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Calendars added by link (Zoho, Outlook, Apple, any ICS link, or Google's secret address)
// ---------------------------------------------------------------------------------------------

/** `addOnPaste`: a pasted link is added at once, so the last step is just pasting. */
export function AddCalendarForm({ app, appName, steps, onAdded, addOnPaste }: { app: string; appName: string; steps?: string[]; onAdded?: () => void; addOnPaste?: boolean }) {
  const crews = useCrews();
  const refresh = useRefreshCalendars();
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [crewId, setCrewId] = useState("");
  const [details, setDetails] = useState(true);
  const [blocks, setBlocks] = useState(true);
  const add = useMutation({
    meta: { inline: true, success: (s: CalendarSource) => (s.last_error ? `${s.name} added, but it couldn't be read yet` : `${s.name} added · ${s.event_count} ${s.event_count === 1 ? "event" : "events"}`) },
    mutationFn: (link: string) => api.post<CalendarSource>("/calendars", { url: link.trim(), app, name: name.trim() || undefined, crew_id: crewId || null, show_details: details, blocks_time: blocks }),
    onSuccess: () => {
      setUrl("");
      setName("");
      refresh();
      onAdded?.();
    },
  });
  return (
    <form className="stack" onSubmit={(e: FormEvent) => { e.preventDefault(); if (url.trim()) add.mutate(url); }} aria-label={`Add ${CALENDAR_NOUNS[app] ?? `a ${appName} calendar`}`}>
      {steps && steps.length > 0 && (
        <ol className="app-steps">
          {steps.map((s) => <li key={s}>{s}</li>)}
          <li>Paste it here.</li>
        </ol>
      )}
      <Field label="Calendar link" hint="Starts with https:// or webcal://. It's kept encrypted and never shown again.">
        <input
          className="input"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder="webcal://… or https://….ics"
          value={url}
          disabled={add.isPending}
          onChange={(e) => { setUrl(e.target.value); add.reset(); }}
          onPaste={(e) => {
            const pasted = e.clipboardData.getData("text").trim();
            // Links, and the calendar IDs people copy by mistake (the server says what to copy instead).
            if (!addOnPaste || !(/^(https?|webcals?):\/\//i.test(pasted) || /^[^\s/]+@[^\s/]+$/.test(pasted))) return;
            e.preventDefault();
            setUrl(pasted);
            add.reset();
            add.mutate(pasted);
          }}
          required
        />
      </Field>
      <div className="form-grid">
        <Field label="Name" optional><input className="input" value={name} maxLength={80} placeholder="Uses the calendar's own name" onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Whose time is it?"><CrewSelect value={crewId} onChange={setCrewId} crews={crews.data ?? []} /></Field>
      </div>
      <CalendarSwitches details={details} setDetails={setDetails} blocks={blocks} setBlocks={setBlocks} />
      <FormError error={add.error} />
      <div><Button type="submit" icon="plus" loading={add.isPending}>{add.isPending ? "Adding…" : "Add calendar"}</Button></div>
    </form>
  );
}

// ---------------------------------------------------------------------------------------------
// Calendars from a file (an .ics, or the .zip Google Calendar's Export downloads)
// ---------------------------------------------------------------------------------------------

interface Uploaded {
  name: string;
  ok: boolean;
  text: string;
}

export function UploadCalendarForm() {
  const crews = useCrews();
  const refresh = useRefreshCalendars();
  const [crewId, setCrewId] = useState("");
  const [details, setDetails] = useState(true);
  const [blocks, setBlocks] = useState(true);
  const [over, setOver] = useState(false);
  const [results, setResults] = useState<Uploaded[]>([]);
  const upload = useMutation({
    meta: { inline: true },
    mutationFn: async (chosen: File) => {
      setResults([]);
      const done: Uploaded[] = [];
      // One calendar at a time: a .zip from Google has one file per calendar.
      for (const file of await readCalendarFiles(chosen)) {
        try {
          const s = await api.post<CalendarSource & { truncated?: boolean }>("/calendars/file", {
            text: file.text,
            file_name: file.fileName,
            crew_id: crewId || null,
            show_details: details,
            blocks_time: blocks,
          });
          done.push({ name: s.name, ok: true, text: `${s.event_count.toLocaleString()} ${s.event_count === 1 ? "event" : "events"}${s.truncated ? " (the earliest; the file has more)" : ""}` });
        } catch (error) {
          done.push({ name: file.name ?? file.fileName, ok: false, text: errorMessage(error) });
        }
      }
      return done;
    },
    onSuccess: (done) => {
      setResults(done);
      const added = done.filter((d) => d.ok).length;
      if (added) toast.success(added === 1 ? `${done.find((d) => d.ok)!.name} is on the schedule` : `${added} calendars are on the schedule`);
    },
    onSettled: refresh,
  });
  const choose = (file: File | undefined) => file && !upload.isPending && upload.mutate(file);
  return (
    <div className="stack">
      <details className="app-details">
        <summary>How to export a calendar</summary>
        <ul className="app-steps" style={{ marginTop: 8 }}>
          <li><strong>Google Calendar</strong>, on a computer: open Settings (the gear), then <strong>Import &amp; export</strong>, then <strong>Export</strong>. Choose the .zip file it downloads here. There's no need to open it.</li>
          <li><strong>Apple Calendar</strong> on a Mac: click the calendar, then <strong>File → Export → Export</strong>.</li>
          <li><strong>Outlook</strong> for Windows: <strong>File → Save Calendar</strong>.</li>
        </ul>
      </details>
      <div className="form-grid">
        <Field label="Whose time is it?"><CrewSelect value={crewId} onChange={setCrewId} crews={crews.data ?? []} /></Field>
      </div>
      <CalendarSwitches details={details} setDetails={setDetails} blocks={blocks} setBlocks={setBlocks} />
      <label
        className="dropzone"
        data-over={over || undefined}
        aria-busy={upload.isPending || undefined}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); choose(e.dataTransfer.files[0]); }}
      >
        {upload.isPending ? <Spinner size={28} /> : <Icon name="upload" size={28} />}
        <strong>{upload.isPending ? "Reading your calendar…" : "Drop a calendar file here, or click to choose"}</strong>
        <span className="small">An .ics file, or the .zip from Google Calendar's Export.</span>
        <input type="file" accept={CALENDAR_FILE_TYPES} className="sr-only" disabled={upload.isPending} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; choose(f); }} />
      </label>
      {results.length > 0 && (
        <ul className="stack-sm" style={{ listStyle: "none", margin: 0, padding: 0 }} aria-label="Upload results">
          {results.map((r, i) => (
            <li key={`${r.name}-${i}`} className="row small" style={{ gap: 8, alignItems: "flex-start", color: r.ok ? undefined : "var(--danger)" }}>
              <Icon name={r.ok ? "check" : "alert"} size={14} />
              <span><strong>{r.name}</strong>: {r.ok ? `added, ${r.text}` : r.text}</span>
            </li>
          ))}
        </ul>
      )}
      <FormError error={upload.error} />
      <span className="muted small">
        A file shows the calendar as it is today, from last month through the next year. It doesn't change when the calendar does: upload it again to catch up, or
        add the calendar by its link to keep it current.
      </span>
    </div>
  );
}

/** A calendar app's calendars and the form to add one. Installing it is adding the first. */
export function LinkCalendarsPanel({ app, appName, steps }: { app: string; appName: string; steps?: string[] }) {
  const calendars = useCalendars();
  const mine = (calendars.data?.calendars ?? []).filter((s) => s.app === app && s.kind !== "google");
  return (
    <>
      {(calendars.isPending || calendars.error || mine.length > 0) && <section className="card" aria-labelledby={`${app}-calendars`}>
        <div className="card-pad stack-sm" style={{ gap: 4 }}>
          <h2 id={`${app}-calendars`} className="section-title" style={{ fontSize: 16 }}>Calendars on your schedule</h2>
          <span className="muted small">Read again every 15 minutes. Changes made here only affect Crewtavo.</span>
        </div>
        {calendars.isPending ? (
          <div className="card-row"><Skeleton height={36} radius={8} style={{ flex: 1 }} /></div>
        ) : calendars.error ? (
          <ErrorState error={calendars.error} onRetry={() => calendars.refetch()} compact />
        ) : (
          mine.map((s) => <div key={s.id} className="card-row"><CalendarRow source={s} /></div>)
        )}
      </section>}
      <section className="card card-pad stack" aria-labelledby={`${app}-add`}>
        <h2 id={`${app}-add`} className="section-title" style={{ fontSize: 16 }}>Add {CALENDAR_NOUNS[app] ?? "a calendar"}</h2>
        <AddCalendarForm app={app} appName={appName} steps={steps} />
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Google Calendar (signed in)
// ---------------------------------------------------------------------------------------------

interface GoogleCalendar {
  id: string;
  name: string;
  color: string | null;
  primary: boolean;
  source_id: string | null;
}

export function GoogleCalendarPanel() {
  const session = useSession();
  const calendars = useCalendars();
  const refresh = useRefreshCalendars();
  const google = calendars.data?.google;
  const list = useQuery({
    queryKey: ["google-calendars", session.company.id],
    enabled: Boolean(google?.connected),
    queryFn: () => api.get<{ calendars: GoogleCalendar[] }>("/calendars/google"),
  });
  const show = useMutation({
    meta: { success: (s: CalendarSource) => `${s.name} is on the schedule` },
    mutationFn: (calendarId: string) => api.post<CalendarSource>("/calendars/google", { calendar_id: calendarId }),
    onSettled: refresh,
  });
  const hide = useMutation({
    meta: { success: "Taken off the schedule" },
    mutationFn: (sourceId: string) => api.delete(`/calendars/${sourceId}`),
    onSettled: refresh,
  });
  const visits = useMutation({
    meta: { inline: true, success: (r: { google: GoogleState }) => (r.google.visits_calendar ? `Visits are going to ${r.google.visits_calendar.name}` : "Visits no longer go to Google Calendar") },
    mutationFn: (enabled: boolean) => api.put<{ google: GoogleState }>("/calendars/google/visits", { enabled }),
    onSettled: refresh,
  });
  const sources = new Map((calendars.data?.calendars ?? []).filter((s) => s.kind === "google").map((s) => [s.id, s]));
  if (!google?.connected) return null;
  const account = google.account_label ?? "your Google account";

  return (
    <>
      <section className="card" aria-labelledby="google-calendars">
        <div className="card-pad stack-sm" style={{ gap: 4 }}>
          <h2 id="google-calendars" className="section-title" style={{ fontSize: 16 }}>Calendars on your schedule</h2>
          <span className="muted small">Pick the calendars in {account} to show next to your visits. Read again every 15 minutes.</span>
        </div>
        {list.isPending ? (
          <div className="card-row"><Skeleton height={36} radius={8} style={{ flex: 1 }} /></div>
        ) : list.error ? (
          <ErrorState error={list.error} onRetry={() => list.refetch()} compact />
        ) : !list.data.calendars.length ? (
          <div className="card-row muted small">No calendars found in this account.</div>
        ) : (
          list.data.calendars.map((cal) => {
            const source = cal.source_id ? sources.get(cal.source_id) : undefined;
            const busy = (show.isPending && show.variables === cal.id) || (hide.isPending && hide.variables === cal.source_id);
            return (
              <div key={cal.id} className="card-row" style={{ alignItems: "flex-start" }}>
                <label className="switch-row" style={{ marginTop: source ? 8 : 0 }}>
                  <input
                    type="checkbox"
                    className="switch"
                    checked={Boolean(cal.source_id)}
                    disabled={busy}
                    aria-label={`Show ${cal.name} on the schedule`}
                    onChange={(e) => (e.target.checked ? show.mutate(cal.id) : cal.source_id && hide.mutate(cal.source_id))}
                  />
                </label>
                {source ? (
                  <div className="grow" style={{ minWidth: 0 }}><CalendarRow source={source} /></div>
                ) : (
                  <span className="grow row" style={{ gap: 8, minWidth: 0 }}>
                    <span className="cal-swatch" style={{ "--c": cal.color ?? "var(--text-4)" } as CSSProperties} aria-hidden="true" />
                    <span className="truncate">{cal.name}</span>
                    {cal.primary && <span className="badge">Main</span>}
                  </span>
                )}
              </div>
            );
          })
        )}
        <FormError error={show.error ?? hide.error} />
      </section>

      <section className="card card-pad stack-sm" aria-labelledby="google-visits">
        <div className="row" style={{ gap: 12, alignItems: "flex-start" }}>
          <div className="grow stack-sm" style={{ gap: 4 }}>
            <h2 id="google-visits" className="section-title" style={{ fontSize: 16 }}>Put visits on Google Calendar</h2>
            <span className="muted small">
              {google.visits_calendar
                ? <>Visits go onto <strong>{google.visits_calendar.name}</strong> in {account}. New, moved and finished visits show up there within a few minutes. Share that calendar in Google to let others see the schedule.</>
                : <>Crewtavo makes a calendar called <strong>{session.company.name} visits</strong> in {account} and keeps every visit on it, from last week through the next six months.</>}
            </span>
            {google.visits_calendar && google.last_sync_at && <span className="muted small">Last change sent {timeAgo(google.last_sync_at)}.</span>}
          </div>
          <input
            type="checkbox"
            className="switch"
            checked={Boolean(google.visits_calendar)}
            disabled={visits.isPending}
            aria-label="Put visits on Google Calendar"
            onChange={async (e) => {
              if (e.target.checked) visits.mutate(true);
              else if (await confirm({ title: "Stop putting visits on Google Calendar?", body: `${google.visits_calendar?.name ?? "The visits calendar"} is removed from ${account}. Your own calendars aren't touched.`, confirmLabel: "Stop", danger: true })) visits.mutate(false);
            }}
          />
        </div>
        <FormError error={visits.error} />
      </section>
    </>
  );
}
