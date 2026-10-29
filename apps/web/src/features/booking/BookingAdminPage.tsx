/** Online booking: public request forms, their questions and service area, and links to share or embed. */
import { formSlug as slugify, normalizeIntakeForm } from "@crewtavo/core/forms";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormChecks, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Menu } from "@/components/ui/Menu";
import { BackLink, PageHeader } from "@/components/ui/PageHeader";
import { CardSkeleton, Loading } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { StatusPill } from "@/components/ui/StatusPill";
import { supabase, unwrap } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { useListAnimation } from "@/lib/motion";
import { can, hasRole, useSession } from "@/lib/session";
import { undoable } from "@/lib/undo";
import { EmbedDialog } from "./EmbedDialog";

const KIND: Record<string, string> = { request: "Request form", assessment: "Book an estimate", booking: "Book a service" };
type QType = "text" | "long_text" | "number" | "yes_no" | "choice" | "multi_choice" | "files" | "photos";
interface Question { key: string; label: string; type: QType | "address"; required: boolean; options?: string[] }
interface FormRow { id: string; slug: string; name: string; kind: string; active: boolean; questions: Question[]; service_area_zips: string[]; lead_time_days: number }
// Files and Photos: what people send go in Plans and files on the request (and on to its quote and job).
const QTYPES: Array<[QType, string]> = [["text", "Short answer"], ["long_text", "Paragraph"], ["number", "Number"], ["yes_no", "Yes / no"], ["choice", "Pick one"], ["multi_choice", "Pick any"], ["files", "Files (plans, PDFs)"], ["photos", "Photos"]];

export function BookingAdminPage() {
  const session = useSession();
  const { company } = session;
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<FormRow | "new" | null>(null);
  const [embedding, setEmbedding] = useState<FormRow | null>(null);
  const canEdit = hasRole(session, "admin", "office") && can(session, "settings");
  const forms = useQuery({
    queryKey: ["intake-forms", company.id],
    queryFn: async () => unwrap(await supabase().from("intake_forms").select("id, slug, name, kind, active, questions, service_area_zips, lead_time_days").eq("company_id", company.id).order("name")) as unknown as FormRow[],
  });
  const counts = useQuery({
    queryKey: ["intake-forms", company.id, "counts"],
    meta: { silent: true },
    queryFn: async () => {
      const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
      const rows = unwrap(await supabase().from("requests").select("intake_form_id").eq("company_id", company.id).not("intake_form_id", "is", null).gte("created_at", since));
      return rows.reduce<Record<string, number>>((m, r) => ({ ...m, [r.intake_form_id!]: (m[r.intake_form_id!] ?? 0) + 1 }), {});
    },
  });
  const toggle = useMutation({
    meta: { success: (_: unknown, v: { active: boolean }) => (v.active ? "Form is live" : "Form turned off") },
    mutationFn: async ({ id, active }: { id: string; active: boolean }) => unwrap(await supabase().from("intake_forms").update({ active }).eq("id", id)),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["intake-forms", company.id] }),
  });
  const remove = useMutation({
    meta: { inline: true },
    mutationFn: async (id: string) => unwrap(await supabase().from("intake_forms").delete().eq("id", id)),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["intake-forms", company.id] }),
  });
  // Gone at once, with Undo; its link keeps working until it's deleted for real. Requests it brought in are kept.
  const deleteForm = (form: FormRow) => {
    const key = ["intake-forms", company.id];
    undoable({
      title: "Form deleted",
      hide: () => {
        void queryClient.cancelQueries({ queryKey: key, exact: true });
        queryClient.setQueryData<FormRow[]>(key, (old) => old?.filter((f) => f.id !== form.id));
      },
      restore: () => queryClient.setQueryData<FormRow[]>(key, (old) => (old && !old.some((f) => f.id === form.id) ? [...old, form].sort((a, b) => a.name.localeCompare(b.name)) : old)),
      commit: () => remove.mutateAsync(form.id),
    });
  };
  const link = (slug: string) => `${window.location.origin}/book/${company.slug}/${slug}`;
  const cards = useListAnimation<HTMLDivElement>();

  return (
    <>
      <BackLink to="/settings">Settings</BackLink>
      <PageHeader title="Online booking" actions={canEdit && <Button variant="primary" icon="plus" onClick={() => setEditing("new")}>New form</Button>} />
      {forms.isPending ? <Loading><div className="grid-cards">{[0, 1, 2].map((i) => <CardSkeleton key={i} lines={3} />)}</div></Loading> : forms.error ? <div className="card"><ErrorState error={forms.error} onRetry={() => forms.refetch()} /></div> : !forms.data?.length ? (
        <div className="card"><EmptyState icon="globe" title="No booking forms yet" action={canEdit && <Button icon="plus" onClick={() => setEditing("new")}>Create a form</Button>} /></div>
      ) : (
        <div className="grid-cards" ref={cards}>
          {forms.data.map((f) => (
            <div key={f.id} className="card card-pad stack-sm" style={{ alignContent: "start" }}>
              <div className="row">
                <strong className="grow">{f.name}</strong>
                <StatusPill label={f.active ? "Live" : "Off"} tone={f.active ? "good" : "muted"} />
                {canEdit && (
                  <Menu
                    triggerClassName="btn btn-sm btn-ghost btn-icon"
                    items={[
                      { label: "Edit form", icon: "edit", onSelect: () => setEditing(f) },
                      { label: f.active ? "Turn off" : "Turn on", icon: f.active ? "pause" : "play", onSelect: () => toggle.mutate({ id: f.id, active: !f.active }) },
                      { separator: true },
                      { label: "Delete form", icon: "trash", danger: true, onSelect: () => deleteForm(f) },
                    ]}
                  />
                )}
              </div>
              <span className="muted text-sm">
                {KIND[f.kind] ?? f.kind} · {f.questions.filter((q) => q.type !== "address").length} questions{f.service_area_zips.length ? ` · ${f.service_area_zips.length} ZIP codes` : " · any area"}
              </span>
              <span className="small"><strong>{counts.data?.[f.id] ?? 0}</strong> <span className="muted">requests in the last 30 days</span></span>
              <code style={{ padding: 8, background: "var(--fill)", borderRadius: "var(--radius-control)", fontSize: 12, overflowWrap: "anywhere" }}>{link(f.slug)}</code>
              <div className="row wrap">
                <Button size="sm" icon="copy" onClick={() => copyText(link(f.slug), "Link copied")}>Copy link</Button>
                <a className="btn btn-sm" href={link(f.slug)} target="_blank" rel="noreferrer"><Icon name="external" size={14} />Open</a>
                <Button size="sm" icon="code" onClick={() => setEmbedding(f)}>Embed</Button>
              </div>
            </div>
          ))}
        </div>
      )}
      {embedding && <EmbedDialog name={embedding.name} url={link(embedding.slug)} onClose={() => setEmbedding(null)} />}
      {editing && <FormEditor form={editing === "new" ? null : editing} taken={forms.data?.map((f) => f.slug) ?? []} onClose={() => setEditing(null)} />}
    </>
  );
}

function FormEditor({ form, taken, onClose }: { form: FormRow | null; taken: string[]; onClose: () => void }) {
  const { company } = useSession();
  const queryClient = useQueryClient();
  const [name, setName] = useState(form?.name ?? "Request a quote");
  const [slug, setSlug] = useState(form?.slug ?? "");
  const [kind, setKind] = useState(form?.kind ?? "request");
  const [zips, setZips] = useState((form?.service_area_zips ?? []).join(", "));
  const [questions, setQuestions] = useState<Question[]>(form?.questions.filter((q) => q.type !== "address") ?? [{ key: "details", label: "What do you need done?", type: "long_text", required: true }]);
  const finalSlug = slug.trim() ? slugify(slug) : slugify(name);
  const clash = taken.filter((s) => s !== form?.slug).includes(finalSlug);
  const zipList = zips.split(/[\s,;]+/).map((z) => z.trim()).filter(Boolean);
  const badZips = zipList.filter((z) => !/^\d{5}$/.test(z));
  const setQ = (i: number, patch: Partial<Question>) => setQuestions(questions.map((q, j) => (j === i ? { ...q, ...patch } : q)));

  const save = useMutation({
    meta: { inline: true, success: form ? "Form saved" : "Form created" },
    mutationFn: async () => {
      // Checked and tidied the way an AI assistant's are too (packages/core/src/forms.ts).
      const clean = normalizeIntakeForm({ name, slug, zips: zipList, questions }, taken.filter((s) => s !== form?.slug));
      const row = { ...clean, kind, questions: clean.questions as never };
      if (form) unwrap(await supabase().from("intake_forms").update(row).eq("id", form.id));
      else unwrap(await supabase().from("intake_forms").insert({ ...row, company_id: company.id }));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["intake-forms", company.id] });
      onClose();
    },
  });

  return (
    <Dialog open onClose={onClose} title={form ? "Edit booking form" : "New booking form"} size="lg">
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
        <div className="form-grid">
          <Field label="Form name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required /></Field>
          <Field label="Type">
            <select className="select" value={kind} onChange={(e) => setKind(e.target.value)}>
              {Object.entries(KIND).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </Field>
        </div>
        <Field label="Link" error={clash ? "Another form uses this link" : null} hint={`${window.location.origin}/book/${company.slug}/${finalSlug}`}>
          <input className="input" value={slug} onChange={(e) => setSlug(e.target.value)} placeholder={slugify(name)} maxLength={50} />
        </Field>
        <Field label="Service area ZIP codes" optional error={badZips.length ? `Not a ZIP code: ${badZips.slice(0, 3).join(", ")}` : null} hint="Leave empty to accept any ZIP code.">
          <textarea className="textarea" style={{ minHeight: 60 }} value={zips} onChange={(e) => setZips(e.target.value)} placeholder="24151, 24065, 24184" />
        </Field>
        <div className="form-section">
          <h3>Questions</h3>
          <p className="muted small" style={{ margin: "-8px 0 0" }}>Name, email, phone and address are always asked. Files people send (plans, photos) show on the request under Plans and files.</p>
          {questions.map((q, i) => (
            <div key={i} className="card" style={{ padding: 12, boxShadow: "none", background: "var(--fill)", display: "grid", gap: 8 }}>
              <div className="row">
                <input className="input input-sm grow" value={q.label} onChange={(e) => setQ(i, { label: e.target.value })} placeholder="Question" maxLength={200} aria-label="Question" />
                <select className="select input-sm" style={{ width: 170 }} value={q.type} onChange={(e) => setQ(i, { type: e.target.value as QType, options: ["choice", "multi_choice"].includes(e.target.value) ? q.options ?? ["Option 1"] : undefined })} aria-label="Answer type">
                  {QTYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </div>
              <div className="row wrap">
                <label className="checkbox small"><input type="checkbox" checked={q.required} onChange={(e) => setQ(i, { required: e.target.checked })} />Required</label>
                {(q.type === "choice" || q.type === "multi_choice") && <input className="input input-sm grow" value={(q.options ?? []).join(", ")} onChange={(e) => setQ(i, { options: e.target.value.split(",") })} placeholder="Options, separated by commas" aria-label="Options" />}
                <span className="grow" />
                <Button size="sm" variant="ghost" icon="chevronUp" aria-label="Move up" disabled={i === 0} onClick={() => { const next = [...questions]; [next[i - 1], next[i]] = [next[i], next[i - 1]]; setQuestions(next); }} />
                <Button size="sm" variant="ghost" icon="chevronDown" aria-label="Move down" disabled={i === questions.length - 1} onClick={() => { const next = [...questions]; [next[i + 1], next[i]] = [next[i], next[i + 1]]; setQuestions(next); }} />
                <Button size="sm" variant="ghost" icon="trash" aria-label="Remove question" onClick={() => setQuestions(questions.filter((_, j) => j !== i))} />
              </div>
            </div>
          ))}
          <Button size="sm" variant="ghost" icon="plus" style={{ justifySelf: "start" }} disabled={questions.length >= 30} onClick={() => setQuestions([...questions, { key: "", label: "", type: "text", required: false }])}>Add question</Button>
        </div>
        <FormError error={save.error} />
        <div className="form-actions">
          <FormChecks />
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={clash || badZips.length > 0}>{form ? "Save form" : "Create form"}</Button>
        </div>
      </form>
    </Dialog>
  );
}
