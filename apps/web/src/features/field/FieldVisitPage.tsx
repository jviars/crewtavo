/** One visit on a phone: where, how to get in, what to do, checklist, photos, receipts and notes. */
import { onlineManager, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type ChangeEvent } from "react";
import { useParams } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { BackLink, useDocumentTitle } from "@/components/ui/PageHeader";
import { DetailSkeleton, Skeleton } from "@/components/ui/Skeleton";
import { PageError } from "@/components/ui/States";
import { StatusPill, statusLabel, visitTone } from "@/components/ui/StatusPill";
import { supabase, unwrap, unwrapOne } from "@/lib/api";
import { signedUrls, uploadFile } from "@/lib/files";
import { addressLine, formatDateTime, timeAgo } from "@/lib/format";
import { hasRole, useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import { ExpenseDialog } from "../jobs/ExpensesCard";
import { MaterialsCard } from "../jobs/JobMaterials";
import { ScopeOfWork } from "../jobs/ScopeOfWork";
import { pendingVisitStatus, saveChecklist, saveVisitNotes, setVisitStatus, showVisitStatus, type ChecklistSave, type VisitStatusChange } from "./fieldActions";
import { directionsUrl, formatDuration } from "./fieldData";
import { FIELD_SCOPE } from "@/lib/offline";
import { SignaturePad } from "./SignaturePad";

interface ChecklistItem { key: string; label: string; type: "check" | "number" | "text" | "choice" | "photo" | "signature"; required: boolean; options?: string[] }

export function FieldVisitPage() {
  const { id = "" } = useParams();
  const session = useSession();
  const queryClient = useQueryClient();
  const [expense, setExpense] = useState(false);

  const visit = useQuery({
    queryKey: ["field-visit", id],
    queryFn: async () => {
      const row = unwrapOne(
        await supabase()
          .from("visits")
          .select("id, title, kind, status, starts_at, ends_at, scheduled_on, notes, hold_reason, completed_at, series_day, series_total, equipment:visit_equipment(equipment:equipment(id, name, kind)), job:jobs(id, number, title, instructions, client:clients(display_name, phone)), request:requests(id, title, details, client:clients(display_name, phone)), property:properties(id, line1, city, region, postal_code, lat, lng, notes)")
          .eq("id", id)
          .maybeSingle(),
        "This visit",
      );
      return { ...row, status: pendingVisitStatus(queryClient, id) ?? row.status };
    },
  });
  const v = visit.data;
  useDocumentTitle(v?.title ?? "Visit");
  const access = useQuery({
    queryKey: ["field-visit", id, "access"],
    enabled: Boolean(v?.property),
    meta: { silent: true },
    queryFn: async () => unwrap(await supabase().from("property_access").select("gate_code, lockbox_code, alarm_code, instructions").eq("property_id", v!.property!.id))[0] ?? null,
  });
  const myTime = useQuery({
    queryKey: ["field-visit", id, "time"],
    queryFn: async () => unwrap(await supabase().from("time_entries").select("started_at, ended_at").eq("visit_id", id).eq("user_id", session.userId)),
  });
  const refresh = () => {
    for (const k of [["field-visit", id], ["field"], ["schedule"], ["running-timer"], ["dashboard"], ["checklist", id]]) queryClient.invalidateQueries({ queryKey: k });
  };
  // These work offline: saved on the phone and sent, in order, when there's signal.
  const queued = () => !onlineManager.isOnline() && toast.info("Saved on this phone. It'll send when you have signal.");
  const statusMutation = useMutation({
    mutationKey: ["visit-status"],
    scope: FIELD_SCOPE,
    meta: { success: (_: unknown, change: VisitStatusChange) => (change.status === "en_route" ? "On your way" : change.status === "in_progress" ? "Visit started. Your clock is running." : "Visit complete. Nice work!") },
    mutationFn: setVisitStatus,
    onMutate: (change: VisitStatusChange) => {
      queued();
      showVisitStatus(queryClient, change);
    },
    onSettled: refresh,
  });
  const setStatus = {
    mutate: (status: string) => statusMutation.mutate({ companyId: session.company.id, userId: session.userId, visitId: id, jobId: v?.job?.id ?? null, status, at: new Date().toISOString() }),
    isPending: statusMutation.isPending && !statusMutation.isPaused,
  };
  const [notes, setNotes] = useState("");
  useEffect(() => setNotes(v?.notes ?? ""), [v?.notes]);
  const saveNotes = useMutation({
    mutationKey: ["visit-notes"],
    scope: FIELD_SCOPE,
    meta: { success: "Notes saved" },
    mutationFn: saveVisitNotes,
    onMutate: (change: { visitId: string; notes: string | null }) => {
      queued();
      queryClient.setQueryData<typeof visit.data>(["field-visit", id], (old) => old && { ...old, notes: change.notes });
    },
    onSettled: refresh,
  });
  const checklistState = queryClient.getQueryData<{ incomplete: boolean }>(["checklist-state", id]);

  if (visit.isPending) return <DetailSkeleton />;
  if (visit.error || !v) return <PageError error={visit.error} onRetry={() => visit.refetch()} back={<BackLink to="/field">My day</BackLink>} />;

  const client = (v.job?.client ?? v.request?.client) as { display_name: string; phone: string | null } | null;
  const codes = access.data;
  const minutes = (myTime.data ?? []).reduce((s, t) => s + ((t.ended_at ? Date.parse(t.ended_at) : Date.now()) - Date.parse(t.started_at)), 0);
  const complete = async () => {
    if (checklistState?.incomplete && !(await confirm({ title: "The checklist isn't done", body: "Complete the visit anyway? The office will see the checklist is unfinished.", confirmLabel: "Complete anyway" }))) return;
    setStatus.mutate("completed");
  };
  const primary =
    v.status === "scheduled" ? { label: "On my way", icon: "navigation" as const, run: () => setStatus.mutate("en_route"), variant: "secondary" as const }
    : v.status === "en_route" ? { label: "Start visit", icon: "play" as const, run: () => setStatus.mutate("in_progress"), variant: "primary" as const }
    : v.status === "in_progress" ? { label: "Complete visit", icon: "check" as const, run: complete, variant: "primary" as const }
    : null;

  return (
    <>
      <BackLink to="/field">My day</BackLink>
      <div className="stack-sm">
        <h1 className="page-title">{v.title}</h1>
        <div className="row wrap">
          <StatusPill label={statusLabel(v.status)} tone={visitTone(v.status)} />
          <span className="muted">{v.starts_at ? formatDateTime(v.starts_at) : v.scheduled_on ? "Anytime today" : "Not scheduled"}</span>
          {v.series_total && v.series_total > 1 && <span className="chip chip-blue">Day {v.series_day} of {v.series_total}</span>}
          {minutes > 0 && <span className="chip"><Icon name="clock" size={12} />You: {formatDuration(minutes)}</span>}
        </div>
      </div>
      {v.status === "completed" && v.completed_at && <div className="callout callout-good"><Icon name="check" size={18} /><div className="grow">Completed {timeAgo(v.completed_at)}.</div></div>}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 8 }}>
        {primary && <Button variant={primary.variant} icon={primary.icon} className="big-action" loading={setStatus.isPending} onClick={primary.run}>{primary.label}</Button>}
        {v.status === "scheduled" && <Button variant="primary" icon="play" className="big-action" loading={setStatus.isPending} onClick={() => setStatus.mutate("in_progress")}>Start visit</Button>}
        {client?.phone && <a className="btn big-action" href={`tel:${client.phone}`}><Icon name="phone" size={18} />Call</a>}
        {client?.phone && <a className="btn big-action" href={`sms:${client.phone}`}><Icon name="messages" size={18} />Text</a>}
        {v.property && <a className="btn big-action" href={directionsUrl(v.property)} target="_blank" rel="noreferrer"><Icon name="navigation" size={18} />Directions</a>}
      </div>

      <section className="card card-pad stack-sm">
        <strong style={{ fontSize: 16 }}>{client?.display_name ?? "Site"}</strong>
        {v.property && <span>{addressLine(v.property)}</span>}
        {access.isPending && v.property ? <Skeleton width="40%" /> : (
          <>
            {codes?.gate_code && <span style={{ fontSize: 18 }}><Icon name="lock" size={16} /> Gate code <strong>{codes.gate_code}</strong></span>}
            {codes?.lockbox_code && <span><Icon name="lock" size={14} /> Lockbox <strong>{codes.lockbox_code}</strong></span>}
            {codes?.alarm_code && <span><Icon name="lock" size={14} /> Alarm <strong>{codes.alarm_code}</strong></span>}
            {codes?.instructions && <span className="muted pre-wrap">{codes.instructions}</span>}
          </>
        )}
        {v.property?.notes && <span className="muted pre-wrap">{v.property.notes}</span>}
        {v.hold_reason && <span style={{ color: "var(--warning)", fontWeight: 700 }}><Icon name="cloud" size={14} /> Weather: {v.hold_reason}</span>}
      </section>

      {(v.job?.instructions || v.request?.details || v.notes) && (
        <section className="card card-pad stack-sm" style={{ background: "var(--note)", borderColor: "var(--note-border)" }}>
          <strong>Instructions</strong>
          {v.job?.instructions && <p className="pre-wrap" style={{ margin: 0 }}>{v.job.instructions}</p>}
          {v.request?.details && <p className="pre-wrap" style={{ margin: 0 }}>{v.request.details}</p>}
        </section>
      )}
      {v.job && <section className="card card-pad"><ScopeOfWork jobId={v.job.id} title="The work" bare /></section>}
      {v.equipment.length > 0 && (
        <section className="card card-pad stack-sm">
          <strong>Bring</strong>
          <div className="row wrap" style={{ gap: 6 }}>
            {v.equipment.map((e) => e.equipment && <span key={e.equipment.id} className="chip"><Icon name="truck" size={12} />{e.equipment.name}</span>)}
          </div>
        </section>
      )}

      <Checklist visitId={v.id} />
      {v.job && <MaterialsCard jobId={v.job.id} visitId={v.id} compact />}
      <Photos visitId={v.id} />

      <section className="card card-pad stack-sm">
        <label htmlFor="visit-notes"><strong>Notes for the office</strong></label>
        <textarea id="visit-notes" className="textarea" value={notes} maxLength={5000} onChange={(e) => setNotes(e.target.value)} placeholder="Extra work they asked about, damage you noticed, materials used…" />
        <div className="row-between">
          {v.job && <Button size="sm" variant="ghost" icon="receipt" onClick={() => setExpense(true)}>Add a receipt</Button>}
          <Button size="sm" loading={saveNotes.isPending && !saveNotes.isPaused} disabled={notes === (v.notes ?? "")} onClick={() => saveNotes.mutate({ visitId: id, notes: notes.trim() || null })}>Save notes</Button>
        </div>
      </section>

      {expense && v.job && <ExpenseDialog jobId={v.job.id} expense={null} onClose={() => setExpense(false)} onSaved={() => toast.success("Receipt sent to the office")} />}
    </>
  );
}

function Checklist({ visitId }: { visitId: string }) {
  const session = useSession();
  const { company } = session;
  const queryClient = useQueryClient();
  const data = useQuery({
    queryKey: ["checklist", visitId],
    queryFn: async () => {
      const [templates, responses] = await Promise.all([
        supabase().from("checklist_templates").select("id, name, items").eq("company_id", company.id).eq("active", true).order("name"),
        supabase().from("checklist_responses").select("id, template_id, answers, completed_at, completed_by").eq("visit_id", visitId).limit(1),
      ]);
      return { templates: unwrap(templates), response: unwrap(responses)[0] ?? null };
    },
  });
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [templateId, setTemplateId] = useState("");
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (data.data?.response) {
      setAnswers((data.data.response.answers ?? {}) as Record<string, unknown>);
      setTemplateId(data.data.response.template_id ?? "");
    } else if (data.data?.templates.length === 1) setTemplateId(data.data.templates[0].id);
  }, [data.data]);
  const template = data.data?.templates.find((t) => t.id === templateId);
  const items = (template?.items ?? []) as unknown as ChecklistItem[];
  const answered = (i: ChecklistItem) => {
    const a = answers[i.key];
    if (i.type === "photo") return true;
    // A signature needs the drawing (older checklists stored a typed name).
    if (i.type === "signature" && a && typeof a === "object") return Boolean((a as { image?: string }).image);
    return !(a === undefined || a === null || a === "" || a === false);
  };
  const missing = items.filter((i) => i.required && !answered(i));
  const doneCount = items.filter((i) => i.type !== "photo" && answered(i)).length;
  const countable = items.filter((i) => i.type !== "photo").length;
  const done = Boolean(data.data?.response?.completed_at);
  // Let the page warn before completing a visit with an unfinished checklist.
  useEffect(() => {
    queryClient.setQueryData(["checklist-state", visitId], { incomplete: Boolean(template) && !done });
  }, [template, done, visitId, queryClient]);

  // Made here so saving twice with no signal updates one checklist instead of adding two.
  const [newId] = useState(() => crypto.randomUUID());
  const saveMutation = useMutation({
    mutationKey: ["checklist-save"],
    scope: FIELD_SCOPE,
    meta: { success: (_: unknown, v: ChecklistSave) => (v.completedAt ? "Checklist done" : "Checklist saved") },
    mutationFn: saveChecklist,
    onMutate: (v: ChecklistSave) => {
      if (!onlineManager.isOnline()) toast.info("Saved on this phone. It'll send when you have signal.");
      setDirty(false);
      queryClient.setQueryData<typeof data.data>(["checklist", visitId], (old) =>
        old && { ...old, response: { id: v.responseId, template_id: v.templateId, answers: v.answers as never, completed_at: v.completedAt, completed_by: null } },
      );
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["checklist", visitId] }),
  });
  const save = {
    mutate: (complete: boolean) => {
      if (complete && missing.length) return toast.error(`Still needed: ${missing.map((m) => m.label).join(", ")}`);
      saveMutation.mutate({ companyId: company.id, visitId, responseId: data.data?.response?.id ?? newId, templateId: templateId || null, answers, completedAt: complete ? new Date().toISOString() : null });
    },
    isPending: saveMutation.isPending && !saveMutation.isPaused,
    variables: saveMutation.variables ? Boolean(saveMutation.variables.completedAt) : undefined,
    error: saveMutation.error,
  };
  const reopen = useMutation({
    mutationFn: async () => unwrap(await supabase().from("checklist_responses").update({ completed_at: null }).eq("id", data.data!.response!.id)),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["checklist", visitId] }),
  });
  const set = (key: string, value: unknown) => {
    setAnswers({ ...answers, [key]: value });
    setDirty(true);
  };

  if (data.isPending) return <section className="card card-pad"><Skeleton width="30%" /><div style={{ height: 10 }} /><Skeleton height={80} /></section>;
  if (!data.data?.templates.length) return null;
  return (
    <section className="card card-pad stack-sm">
      <div className="row-between">
        <strong>Checklist</strong>
        {done ? <StatusPill label="Done" tone="good" /> : template && <span className="muted small tabular">{doneCount} of {countable}</span>}
      </div>
      {template && !done && <div className="progress"><span style={{ width: `${countable ? (doneCount / countable) * 100 : 0}%` }} /></div>}
      {(!data.data.response || !done) && data.data.templates.length > 1 && (
        <select className="select" value={templateId} onChange={(e) => { setTemplateId(e.target.value); setDirty(true); }} aria-label="Choose a checklist" disabled={done}>
          <option value="">Choose a checklist…</option>
          {data.data.templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      )}
      <div>
        {items.map((item) => (
          <div key={item.key} className="check-row">
            {item.type === "check" ? (
              <label className="checkbox" style={{ fontSize: 15, flex: 1 }}>
                <input type="checkbox" style={{ width: 22, height: 22 }} checked={Boolean(answers[item.key])} disabled={done} onChange={(e) => set(item.key, e.target.checked)} />
                <span>{item.label}{item.required && <span className="text-danger"> *</span>}</span>
              </label>
            ) : item.type === "photo" ? (
              <span className="muted" style={{ flex: 1 }}><Icon name="camera" size={15} /> {item.label}: add it under Photos below.</span>
            ) : item.type === "choice" ? (
              <label className="field" style={{ flex: 1 }}><span>{item.label}{item.required && <span className="text-danger"> *</span>}</span>
                <select className="select" value={String(answers[item.key] ?? "")} disabled={done} onChange={(e) => set(item.key, e.target.value)}>
                  <option value="">Choose…</option>
                  {item.options?.map((o) => <option key={o}>{o}</option>)}
                </select>
              </label>
            ) : item.type === "signature" ? (
              <SignatureAnswer label={item.label} required={item.required} value={answers[item.key]} disabled={done} onChange={(next) => set(item.key, next)} />
            ) : (
              <label className="field" style={{ flex: 1 }}><span>{item.label}{item.required && <span className="text-danger"> *</span>}</span>
                <input className="input" inputMode={item.type === "number" ? "decimal" : undefined} value={String(answers[item.key] ?? "")} disabled={done} onChange={(e) => set(item.key, item.type === "number" ? e.target.value.replace(/[^0-9.\-]/g, "") : e.target.value)} />
              </label>
            )}
          </div>
        ))}
      </div>
      <FormError error={save.error} />
      {template && !done && (
        <div className="form-actions">
          <Button loading={save.isPending && save.variables === false} disabled={!dirty} onClick={() => save.mutate(false)}>Save</Button>
          <Button variant="primary" icon="check" loading={save.isPending && save.variables === true} disabled={missing.length > 0} title={missing.length ? `Still needed: ${missing.map((m) => m.label).join(", ")}` : undefined} onClick={() => save.mutate(true)}>Mark done</Button>
        </div>
      )}
      {done && hasRole(session, "admin", "office", "crew_lead") && <Button size="sm" variant="ghost" icon="undo" style={{ justifySelf: "start" }} loading={reopen.isPending} onClick={() => reopen.mutate()}>Reopen checklist</Button>}
    </section>
  );
}

function Photos({ visitId }: { visitId: string }) {
  const { company } = useSession();
  const queryClient = useQueryClient();
  const [uploading, setUploading] = useState(0);
  const photos = useQuery({
    queryKey: ["photos", visitId],
    queryFn: async () => {
      const rows = unwrap(await supabase().from("attachments").select("id, path, file_name, caption, created_at, created_by").eq("owner_type", "visit").eq("owner_id", visitId).order("created_at"));
      const urls = await signedUrls(rows.map((r) => r.path)).catch(() => ({}) as Record<string, string>);
      return rows.map((r) => ({ ...r, url: urls[r.path] ?? null }));
    },
  });
  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      setUploading(files.length);
      let failed = 0;
      for (const file of files) {
        try {
          const path = await uploadFile(company.id, `visit/${visitId}`, file);
          unwrap(await supabase().from("attachments").insert({ company_id: company.id, owner_type: "visit", owner_id: visitId, path, file_name: file.name.slice(0, 200), content_type: file.type || "image/jpeg", size_bytes: file.size }));
        } catch (error) {
          failed++;
          toast.error(`${file.name}: ${(error as Error).message}`);
        } finally {
          setUploading((n) => n - 1);
          queryClient.invalidateQueries({ queryKey: ["photos", visitId] });
        }
      }
      return { saved: files.length - failed };
    },
    onSuccess: (r) => r.saved && toast.success(`${r.saved} ${r.saved === 1 ? "photo" : "photos"} added`),
    onSettled: () => setUploading(0),
  });
  const remove = useMutation({
    meta: { success: "Photo removed" },
    mutationFn: async (p: { id: string; path: string }) => {
      unwrap(await supabase().from("attachments").delete().eq("id", p.id));
      await supabase().storage.from("files").remove([p.path]);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["photos", visitId] }),
  });
  return (
    <section className="card card-pad stack-sm">
      <div className="row-between"><strong>Photos</strong>{!!photos.data?.length && <span className="muted small">{photos.data.length}</span>}</div>
      <div className="thumbs">
        {photos.isPending && [0, 1, 2].map((i) => <Skeleton key={i} height={96} radius={10} />)}
        {photos.data?.map((p) => (
          <div key={p.id} className="thumb">
            {p.url ? <a href={p.url} target="_blank" rel="noreferrer"><img src={p.url} alt={p.caption ?? p.file_name} loading="lazy" /></a> : <span className="muted small">Unavailable</span>}
            <button type="button" className="thumb-x" aria-label="Remove photo" onClick={async () => (await confirm({ title: "Remove this photo?", confirmLabel: "Remove", danger: true })) && remove.mutate(p)}><Icon name="x" size={12} strokeWidth={3} /></button>
          </div>
        ))}
        {Array.from({ length: uploading }, (_, i) => <div key={`u${i}`} className="thumb" style={{ display: "grid", placeItems: "center" }}><span className="spinner" style={{ width: 20, height: 20, color: "var(--text-3)" }} /></div>)}
      </div>
      <label className="btn" style={{ justifySelf: "start" }}>
        <Icon name="camera" size={16} />{upload.isPending ? "Uploading…" : "Add photos"}
        <input type="file" accept="image/*" capture="environment" multiple hidden onChange={(e: ChangeEvent<HTMLInputElement>) => { const files = [...(e.target.files ?? [])]; e.target.value = ""; if (files.length) upload.mutate(files); }} />
      </label>
    </section>
  );
}

/** A signature on a checklist: the person signs on the screen and prints their name. */
function SignatureAnswer({ label, required, value, disabled, onChange }: { label: string; required: boolean; value: unknown; disabled: boolean; onChange: (next: { name: string; image: string | null } | null) => void }) {
  // Older checklists stored a typed name.
  const legacy = typeof value === "string" ? value : null;
  const current = value && typeof value === "object" ? (value as { name?: string; image?: string | null }) : null;
  return (
    <div className="field" style={{ flex: 1 }}>
      <span>{label}{required && <span className="text-danger"> *</span>}</span>
      {legacy ? (
        <span style={{ fontFamily: "'Brush Script MT', cursive", fontSize: 22 }}>{legacy}</span>
      ) : (
        <>
          <SignaturePad value={current?.image ?? null} disabled={disabled} label="Sign with your finger" onChange={(image) => onChange(image || current?.name ? { name: current?.name ?? "", image } : null)} />
          <input className="input" aria-label="Printed name" placeholder="Printed name" value={current?.name ?? ""} disabled={disabled} maxLength={120} onChange={(e) => onChange({ name: e.target.value, image: current?.image ?? null })} />
        </>
      )}
    </div>
  );
}
