import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Menu } from "@/components/ui/Menu";
import { BackLink, PageHeader } from "@/components/ui/PageHeader";
import { DetailSkeleton } from "@/components/ui/Skeleton";
import { EmptyState, PageError } from "@/components/ui/States";
import { EntityStatus, StatusPill, statusLabel, visitTone } from "@/components/ui/StatusPill";
import { api, supabase, unwrap, unwrapOne } from "@/lib/api";
import { addressLine, formatDate, formatDateTime, formatMoney } from "@/lib/format";
import { useRememberRecent } from "@/lib/recent";
import { can, hasRole, useSession } from "@/lib/session";
import { ContactLine } from "../clients/ContactsCard";
import { PropertySelect } from "../clients/ClientForm";
import { VisitDialog, type VisitInput } from "../schedule/VisitDialog";
import { REQUEST_SOURCES } from "./RequestsPage";

export function RequestPage() {
  const { id = "" } = useParams();
  const session = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [visit, setVisit] = useState<VisitInput | null>(null);
  const [editing, setEditing] = useState(false);
  const canSell = hasRole(session, "admin", "office", "estimator") && can(session, "sales");

  const request = useQuery({
    queryKey: ["request", id],
    queryFn: async () =>
      unwrapOne(
        await supabase()
          .from("requests")
          .select("id, number, title, details, status, source, answers, promo_code, created_at, client:clients(id, display_name, email, phone), property:properties(id, line1, city, region, postal_code, lat, lng), form:intake_forms(name, questions), visits(id, title, kind, status, scheduled_on, starts_at, ends_at, crew_id, notes, assignees:visit_assignees(user_id)), quotes(id, number, title, status, total)")
          .eq("id", id)
          .maybeSingle(),
        "This request",
      ),
  });
  const r = request.data;
  useRememberRecent(session.company.id, r ? { kind: "request", id: r.id, title: r.title, subtitle: `Request #${r.number} · ${r.client?.display_name ?? ""}`, path: `/requests/${r.id}` } : null);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["request", id] });
    queryClient.invalidateQueries({ queryKey: ["requests", session.company.id] });
  };
  const toQuote = useMutation({
    meta: { success: "Quote started from this request" },
    mutationFn: () => api.post<{ id: string }>(`/requests/${id}/quote`),
    onSuccess: (q) => {
      refresh();
      navigate(`/quotes/${q.id}`);
    },
  });
  const toJob = useMutation({
    meta: { success: "Job created" },
    mutationFn: async () => {
      const job = unwrap(
        await supabase().from("jobs").insert({ company_id: session.company.id, client_id: r!.client!.id, property_id: r!.property?.id ?? null, title: r!.title, instructions: r!.details }).select("id").single(),
      );
      unwrap(await supabase().from("requests").update({ status: "converted" }).eq("id", id));
      return job.id;
    },
    onSuccess: (jobId) => {
      refresh();
      navigate(`/jobs/${jobId}`);
    },
  });
  const setStatus = useMutation({
    meta: { success: (_: unknown, s: string) => (s === "archived" ? "Request archived" : s === "assessment_complete" ? "Assessment marked done" : "Request updated") },
    mutationFn: async (status: "new" | "assessment_complete" | "archived") => unwrap(await supabase().from("requests").update({ status }).eq("id", id)),
    onSuccess: refresh,
  });
  const remove = useMutation({
    meta: { success: "Request deleted" },
    mutationFn: async () => unwrap(await supabase().from("requests").delete().eq("id", id)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["requests", session.company.id] });
      navigate("/requests", { replace: true });
    },
  });

  if (request.isPending) return <DetailSkeleton />;
  if (request.error || !r) return <PageError error={request.error} onRetry={() => request.refetch()} back={<BackLink to="/requests">Requests</BackLink>} />;

  const answers = Object.entries((r.answers ?? {}) as Record<string, unknown>).filter(([, v]) => v !== "" && v != null && !(Array.isArray(v) && !v.length));
  const questions = ((r.form?.questions ?? []) as Array<{ key: string; label: string }>).reduce<Record<string, string>>((m, q) => ({ ...m, [q.key]: q.label }), {});
  const open = !["converted", "archived"].includes(r.status);
  const assessment = (): VisitInput => ({ request_id: r.id, property_id: r.property?.id ?? null, title: `Assessment: ${r.title}`, kind: "assessment", context: { label: `Request #${r.number} · ${r.client?.display_name ?? ""}`, to: `/requests/${r.id}` } });

  return (
    <>
      <BackLink to="/requests">Requests</BackLink>
      <PageHeader
        title={r.title}
        actions={
          canSell && (
            <>
              {open && <Button icon="calendar" onClick={() => setVisit(assessment())}>Schedule assessment</Button>}
              {open && <Button variant="primary" icon="quote" loading={toQuote.isPending} onClick={() => toQuote.mutate()}>Create quote</Button>}
              <Menu
                items={[
                  { label: "Edit request", icon: "edit", onSelect: () => setEditing(true) },
                  { label: "Measure on the map", icon: "area", hidden: !r.property, onSelect: () => navigate(`/measure?request=${r.id}&property=${r.property!.id}${r.property!.lat != null ? `&lat=${r.property!.lat}&lng=${r.property!.lng}` : ""}`) },
                  { label: "Convert straight to a job", icon: "job", hidden: !open, onSelect: () => toJob.mutate() },
                  { separator: true },
                  { label: r.status === "archived" ? "Reopen request" : "Archive request", icon: r.status === "archived" ? "undo" : "archive", onSelect: () => setStatus.mutate(r.status === "archived" ? "new" : "archived") },
                  {
                    label: "Delete request",
                    icon: "trash",
                    danger: true,
                    hidden: r.quotes.length > 0,
                    onSelect: async () => {
                      if (await confirm({ title: "Delete this request?", body: "Its assessments are deleted too. This can't be undone.", confirmLabel: "Delete", danger: true })) remove.mutate();
                    },
                  },
                ]}
              />
            </>
          )
        }
      />
      <div className="page-meta">
        <span className="muted">Request #{r.number}</span>
        <EntityStatus kind="request" status={r.status} />
        <span className="chip">{REQUEST_SOURCES[r.source] ?? r.source}</span>
      </div>

      {r.status === "new" && Date.now() - Date.parse(r.created_at) > 2 * 86_400_000 && (
        <div className="callout callout-warning"><Icon name="clock" size={18} /><div className="grow">Waiting over two days.</div></div>
      )}

      <div className="two-col">
        <div className="wide stack-lg">
          <section className="card card-pad stack-sm">
            <strong>What they asked for</strong>
            <p className="pre-wrap" style={{ margin: 0 }}>{r.details || <span className="muted">No details given.</span>}</p>
            {answers.length > 0 && (
              <dl className="kv" style={{ marginTop: 8 }}>
                {answers.map(([key, value]) => (
                  <div key={key} style={{ display: "contents" }}>
                    <dt>{questions[key] ?? statusLabel(key)}</dt>
                    <dd>{Array.isArray(value) ? value.join(", ") : typeof value === "boolean" ? (value ? "Yes" : "No") : String(value)}</dd>
                  </div>
                ))}
              </dl>
            )}
          </section>

          <section className="stack">
            <div className="section-head">
              <h2 className="section-title">Assessments</h2>
              {canSell && open && <Button size="sm" icon="plus" onClick={() => setVisit(assessment())}>Schedule</Button>}
            </div>
            <div className="card">
              {r.visits.length === 0 && <EmptyState compact icon="calendar" title="No site visit scheduled" />}
              {r.visits.map((v) => (
                <button key={v.id} type="button" className="card-row" onClick={() => canSell && setVisit({ ...v, request_id: r.id, property_id: r.property?.id ?? null, assignee_ids: v.assignees.map((a) => a.user_id) })}>
                  <Icon name="calendar" size={18} />
                  <span className="grow">
                    <strong>{v.title}</strong>
                    <span className="muted text-sm" style={{ display: "block" }}>{v.starts_at ? formatDateTime(v.starts_at, session.company.timezone) : v.scheduled_on ? `${formatDate(v.scheduled_on)} · anytime` : "Not scheduled"}</span>
                  </span>
                  <StatusPill label={statusLabel(v.status)} tone={visitTone(v.status)} />
                </button>
              ))}
            </div>
            {canSell && r.status === "assessment_scheduled" && (
              <Button icon="check" style={{ justifySelf: "start" }} loading={setStatus.isPending} onClick={() => setStatus.mutate("assessment_complete")}>Mark assessment done</Button>
            )}
          </section>

          {r.quotes.length > 0 && (
            <section className="stack">
              <h2 className="section-title">Quotes</h2>
              <div className="card">
                {r.quotes.map((q) => (
                  <Link key={q.id} to={`/quotes/${q.id}`} className="card-row">
                    <span className="muted tabular">#{q.number}</span>
                    <strong className="grow ellipsis">{q.title}</strong>
                    <span className="tabular">{formatMoney(q.total)}</span>
                    <EntityStatus kind="quote" status={q.status} />
                  </Link>
                ))}
              </div>
            </section>
          )}
        </div>

        <aside className="narrow stack">
          <div className="card card-pad stack-sm">
            <strong>Client</strong>
            {r.client && <Link to={`/clients/${r.client.id}`} className="strong" style={{ fontSize: 16 }}>{r.client.display_name}</Link>}
            {r.client?.email && <ContactLine icon="mail" href={`mailto:${r.client.email}`}>{r.client.email}</ContactLine>}
            {r.client?.phone && <ContactLine icon="phone" href={`tel:${r.client.phone}`}>{r.client.phone}</ContactLine>}
            <dl className="kv" style={{ marginTop: 8 }}>
              <dt>Property</dt><dd>{r.property ? addressLine(r.property) : "—"}</dd>
              <dt>Received</dt><dd>{formatDateTime(r.created_at)}{r.form ? ` via ${r.form.name}` : ""}</dd>
              {r.promo_code && <><dt>Promo code</dt><dd><span className="promo-code">{r.promo_code}</span></dd></>}
            </dl>
          </div>
        </aside>
      </div>

      {visit && <VisitDialog visit={visit} onClose={() => setVisit(null)} onSaved={refresh} />}
      {editing && <EditRequestDialog request={{ id: r.id, title: r.title, details: r.details, client_id: r.client?.id ?? null, property_id: r.property?.id ?? null }} onClose={() => setEditing(false)} onSaved={refresh} />}
    </>
  );
}

function EditRequestDialog({ request, onClose, onSaved }: { request: { id: string; title: string; details: string | null; client_id: string | null; property_id: string | null }; onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState(request.title);
  const [details, setDetails] = useState(request.details ?? "");
  const [propertyId, setPropertyId] = useState<string | null>(request.property_id);
  const save = useMutation({
    meta: { inline: true, success: "Request saved" },
    mutationFn: async () => unwrap(await supabase().from("requests").update({ title: title.trim(), details: details.trim() || null, property_id: propertyId }).eq("id", request.id)),
    onSuccess: () => {
      onSaved();
      onClose();
    },
  });
  return (
    <Dialog open onClose={onClose} title="Edit request">
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
        <Field label="Title"><input className="input" value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} /></Field>
        {request.client_id && <Field label="Property"><PropertySelect clientId={request.client_id} value={propertyId} onChange={setPropertyId} /></Field>}
        <Field label="Details" optional><textarea className="textarea" value={details} onChange={(e) => setDetails(e.target.value)} maxLength={4000} /></Field>
        <FormError error={save.error} />
        <div className="form-actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!title.trim()}>Save</Button>
        </div>
      </form>
    </Dialog>
  );
}
