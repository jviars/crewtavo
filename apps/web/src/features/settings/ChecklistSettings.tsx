/** Checklist templates crews fill in on a visit: inspections, safety steps, sign-offs. */
import { checklistItemKey as slug, MAX_CHECKLIST_ITEMS, normalizeChecklist } from "@crewtavo/core/forms";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Button, useJustDone } from "@/components/ui/Button";
import { Field, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { CardSkeleton, Loading } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { supabase, unwrap } from "@/lib/api";
import { useListAnimation } from "@/lib/motion";
import { useSession } from "@/lib/session";
import { undoable } from "@/lib/undo";

interface Item {
  key: string;
  label: string;
  type: "check" | "number" | "text" | "choice" | "photo" | "signature";
  required: boolean;
  options?: string[];
}
interface Template {
  id: string;
  name: string;
  items: Item[];
  active: boolean;
  /** Its finished answers show on the client's past visit and print on the job's invoice. */
  show_to_client: boolean;
  /** The price list items it goes with: it comes up by itself on jobs with any of them. None: any job. */
  service_ids: string[];
}
interface Service { id: string; name: string; category: string | null; active: boolean }

const TYPES: Array<[Item["type"], string]> = [["check", "Checkbox"], ["text", "Text"], ["number", "Number"], ["choice", "Choice"], ["photo", "Photo"], ["signature", "Signature"]];

export function ChecklistSettings() {
  const session = useSession();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const listRef = useListAnimation<HTMLDivElement>();
  const key = ["checklist-templates", session.company.id];
  const templates = useQuery({
    queryKey: key,
    queryFn: async () =>
      unwrap(await supabase().from("checklist_templates").select("id, name, items, active, show_to_client, services:checklist_template_services(service_id)").eq("company_id", session.company.id).order("name")).map(
        ({ services, ...t }) => ({ ...t, service_ids: services.map((s) => s.service_id) }) as unknown as Template,
      ),
  });
  const services = useQuery({
    queryKey: ["services", session.company.id, "checklists"],
    queryFn: async () => unwrap(await supabase().from("services").select("id, name, category, active").eq("company_id", session.company.id).order("sort").order("name")) as Service[],
  });
  useEffect(() => {
    if (!selected && templates.data?.length) setSelected(templates.data[0].id);
  }, [templates.data, selected]);
  const create = useMutation({
    meta: { success: "Checklist created" },
    mutationFn: async () => unwrap(await supabase().from("checklist_templates").insert({ company_id: session.company.id, name: "New checklist", items: [{ key: "done", label: "Work completed as described", type: "check", required: true }] as never }).select("id").single()),
    onSuccess: (row) => {
      queryClient.invalidateQueries({ queryKey: key });
      setSelected(row.id);
    },
  });
  const remove = useMutation({
    meta: { inline: true },
    mutationFn: async (id: string) => unwrap(await supabase().from("checklist_templates").delete().eq("id", id)),
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
  });
  // Gone at once, with Undo; deleted for real once the toast leaves. Checklists filled in on visits are kept either way.
  const deleteTemplate = (template: Template) =>
    undoable({
      title: "Checklist deleted",
      hide: () => {
        void queryClient.cancelQueries({ queryKey: key });
        queryClient.setQueryData<Template[]>(key, (rows) => rows?.filter((r) => r.id !== template.id));
        setSelected(null);
      },
      restore: () => {
        queryClient.setQueryData<Template[]>(key, (rows) => (rows && !rows.some((r) => r.id === template.id) ? [...rows, template].sort((a, b) => a.name.localeCompare(b.name)) : rows));
        setSelected(template.id);
      },
      commit: () => remove.mutateAsync(template.id),
    });

  if (templates.isPending) return <Loading><div className="two-col"><div className="narrow"><CardSkeleton lines={4} /></div><div className="wide"><CardSkeleton lines={6} /></div></div></Loading>;
  if (templates.error) return <div className="card"><ErrorState error={templates.error} onRetry={() => templates.refetch()} /></div>;
  const current = templates.data?.find((t) => t.id === selected) ?? null;

  return (
    <div className="two-col">
      <aside className="narrow stack-sm">
        <div className="card" ref={listRef}>
          {templates.data?.map((t) => (
            <button key={t.id} type="button" className="card-row" style={{ background: t.id === selected ? "var(--fill-2)" : undefined }} onClick={() => setSelected(t.id)}>
              <Icon name="clipboard" size={16} />
              <span className="grow"><strong>{t.name}</strong><span className="muted small" style={{ display: "block" }}>{t.items.length} items{t.active ? "" : " · hidden"}</span></span>
            </button>
          ))}
          {!templates.data?.length && <EmptyState inline title="No checklists yet" />}
        </div>
        <Button icon="plus" loading={create.isPending} onClick={() => create.mutate()}>New checklist</Button>
      </aside>
      <div className="wide">{current ? <TemplateEditor key={current.id} template={current} services={services.data ?? []} onDelete={() => deleteTemplate(current)} /> : null}</div>
    </div>
  );
}

function TemplateEditor({ template, services, onDelete }: { template: Template; services: Service[]; onDelete: () => void }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const [t, setT] = useState(template);
  const itemsRef = useListAnimation<HTMLDivElement>();
  const dirty = JSON.stringify(t) !== JSON.stringify(template);
  const save = useMutation({
    meta: { inline: true },
    mutationFn: async () => {
      // Checked and tidied the way an AI assistant's are too (packages/core/src/forms.ts).
      const clean = normalizeChecklist(t);
      unwrap(await supabase().from("checklist_templates").update({ ...clean, items: clean.items as never, active: t.active, show_to_client: t.show_to_client }).eq("id", t.id));
      unwrap(await supabase().rpc("set_checklist_services", { p_template: t.id, p_services: t.service_ids }));
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["checklist-templates", session.company.id] }),
  });
  const saved = useJustDone(save);
  const setItem = (i: number, patch: Partial<Item>) => setT({ ...t, items: t.items.map((item, j) => (j === i ? { ...item, ...patch } : item)) });
  const move = (i: number, dir: -1 | 1) => {
    const items = [...t.items];
    [items[i], items[i + dir]] = [items[i + dir], items[i]];
    setT({ ...t, items });
  };

  return (
    <div className="card card-pad stack">
      <Field label="Checklist name"><input className="input" value={t.name} maxLength={120} onChange={(e) => setT({ ...t, name: e.target.value })} /></Field>
      <ServicesPicker value={t.service_ids} services={services} onChange={(service_ids) => setT({ ...t, service_ids })} />
      <label className="switch-row"><input type="checkbox" className="switch" checked={t.active} onChange={(e) => setT({ ...t, active: e.target.checked })} />Crews can use this checklist</label>
      <label className="switch-row">
        <input type="checkbox" className="switch" checked={t.show_to_client} onChange={(e) => setT({ ...t, show_to_client: e.target.checked })} />
        <span>
          Show to client
          <span className="muted small" style={{ display: "block", fontWeight: 400 }}>Finished answers show on their past visit in the Client Hub and print on the invoice. Photos aren't included.</span>
        </span>
      </label>
      <div className="stack-sm" ref={itemsRef}>
        {t.items.map((item, i) => (
          <div key={item.key} className="card" style={{ padding: 12, boxShadow: "none", background: "var(--fill)", display: "grid", gap: 8 }}>
            <div className="row">
              <span className="muted tabular small" style={{ width: 20 }}>{i + 1}</span>
              <input className="input input-sm grow" value={item.label} maxLength={200} placeholder="What should the crew check or record?" onChange={(e) => setItem(i, { label: e.target.value })} aria-label="Item label" />
              <select className="select input-sm" style={{ width: 130 }} value={item.type} onChange={(e) => setItem(i, { type: e.target.value as Item["type"], options: e.target.value === "choice" ? item.options ?? ["Yes", "No"] : undefined })} aria-label="Item type">
                {TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            <div className="row wrap" style={{ paddingLeft: 28 }}>
              <label className="checkbox small"><input type="checkbox" checked={item.required} onChange={(e) => setItem(i, { required: e.target.checked })} />Required</label>
              {item.type === "choice" && <input className="input input-sm grow" value={(item.options ?? []).join(", ")} placeholder="Options, separated by commas" onChange={(e) => setItem(i, { options: e.target.value.split(",").map((o) => o.trim()) })} aria-label="Options" />}
              <span className="grow" />
              <Button size="sm" variant="ghost" icon="chevronUp" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)} />
              <Button size="sm" variant="ghost" icon="chevronDown" aria-label="Move down" disabled={i === t.items.length - 1} onClick={() => move(i, 1)} />
              <Button size="sm" variant="ghost" icon="trash" aria-label="Remove item" onClick={() => setT({ ...t, items: t.items.filter((_, j) => j !== i) })} />
            </div>
          </div>
        ))}
        <Button size="sm" variant="ghost" icon="plus" style={{ justifySelf: "start" }} disabled={t.items.length >= MAX_CHECKLIST_ITEMS} onClick={() => setT({ ...t, items: [...t.items, { key: slug(`item ${t.items.length + 1}`, t.items.map((x) => x.key)), label: "", type: "check", required: false }] })}>Add item</Button>
      </div>
      <FormError error={save.error} />
      <div className="form-actions">
        <Button variant="danger" icon="trash" onClick={onDelete}>Delete</Button>
        <span className="spacer" />
        {dirty && <Button onClick={() => setT(template)}>Discard changes</Button>}
        <Button variant="primary" loading={save.isPending} done={saved} disabled={!dirty && !saved} onClick={() => save.mutate()}>Save checklist</Button>
      </div>
    </div>
  );
}

/** "Use on jobs with": the price list items a checklist goes with, each removable, and a list to add more. */
function ServicesPicker({ value, services, onChange }: { value: string[]; services: Service[]; onChange: (ids: string[]) => void }) {
  const chosen = value.map((id) => services.find((s) => s.id === id)).filter((s): s is Service => Boolean(s));
  const addable = services.filter((s) => s.active && !value.includes(s.id));
  const categories = [...new Set(addable.map((s) => s.category?.trim() || "Other"))];
  return (
    <Field label="Use on jobs with" optional hint={value.length ? "It comes up by itself on visits for jobs with any of these." : "With none, crews can pick it on any job."}>
      {chosen.length > 0 && (
        <div className="row wrap" style={{ gap: 6 }}>
          {chosen.map((s) => (
            <span key={s.id} className="tag">
              {s.name}
              <button type="button" aria-label={`Remove ${s.name}`} onClick={() => onChange(value.filter((id) => id !== s.id))}><Icon name="x" size={12} strokeWidth={2} /></button>
            </span>
          ))}
        </div>
      )}
      <select className="select" value="" disabled={!addable.length} onChange={(e) => e.target.value && onChange([...value, e.target.value])}>
        <option value="">{services.length ? "Add from your price list…" : "Your price list is empty"}</option>
        {categories.map((c) => (
          <optgroup key={c} label={c}>
            {addable.filter((s) => (s.category?.trim() || "Other") === c).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </optgroup>
        ))}
      </select>
    </Field>
  );
}
