/** Checklist templates crews fill in on a visit: inspections, safety steps, sign-offs. */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Field, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { CardSkeleton, Loading } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { supabase, unwrap } from "@/lib/api";
import { useListAnimation } from "@/lib/motion";
import { useSession } from "@/lib/session";

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
  job_type: string | null;
  items: Item[];
  active: boolean;
}

const TYPES: Array<[Item["type"], string]> = [["check", "Checkbox"], ["text", "Text"], ["number", "Number"], ["choice", "Choice"], ["photo", "Photo"], ["signature", "Signature"]];
const slug = (label: string, taken: string[]) => {
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40) || "item";
  let key = base;
  for (let i = 2; taken.includes(key); i++) key = `${base}_${i}`;
  return key;
};

export function ChecklistSettings() {
  const session = useSession();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const listRef = useListAnimation<HTMLDivElement>();
  const key = ["checklist-templates", session.company.id];
  const templates = useQuery({
    queryKey: key,
    queryFn: async () => unwrap(await supabase().from("checklist_templates").select("id, name, job_type, items, active").eq("company_id", session.company.id).order("name")) as unknown as Template[],
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
          {!templates.data?.length && <EmptyState compact icon="clipboard" title="No checklists yet" />}
        </div>
        <Button icon="plus" loading={create.isPending} onClick={() => create.mutate()}>New checklist</Button>
      </aside>
      <div className="wide">{current ? <TemplateEditor key={current.id} template={current} onDeleted={() => setSelected(null)} /> : null}</div>
    </div>
  );
}

function TemplateEditor({ template, onDeleted }: { template: Template; onDeleted: () => void }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const [t, setT] = useState(template);
  const itemsRef = useListAnimation<HTMLDivElement>();
  const dirty = JSON.stringify(t) !== JSON.stringify(template);
  const save = useMutation({
    meta: { inline: true, success: "Checklist saved" },
    mutationFn: async () => {
      if (!t.name.trim()) throw new Error("Name the checklist.");
      if (!t.items.length) throw new Error("Add at least one item.");
      if (t.items.some((i) => !i.label.trim())) throw new Error("Every item needs a label.");
      if (t.items.some((i) => i.type === "choice" && !(i.options?.filter(Boolean).length ?? 0))) throw new Error("Choice items need at least one option.");
      unwrap(await supabase().from("checklist_templates").update({ name: t.name.trim(), job_type: t.job_type?.trim() || null, items: t.items.map((i) => ({ ...i, label: i.label.trim(), options: i.type === "choice" ? i.options?.filter(Boolean) : undefined })) as never, active: t.active }).eq("id", t.id));
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["checklist-templates", session.company.id] }),
  });
  const remove = useMutation({
    meta: { success: "Checklist deleted" },
    mutationFn: async () => unwrap(await supabase().from("checklist_templates").delete().eq("id", t.id)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["checklist-templates", session.company.id] });
      onDeleted();
    },
  });
  const setItem = (i: number, patch: Partial<Item>) => setT({ ...t, items: t.items.map((item, j) => (j === i ? { ...item, ...patch } : item)) });
  const move = (i: number, dir: -1 | 1) => {
    const items = [...t.items];
    [items[i], items[i + dir]] = [items[i + dir], items[i]];
    setT({ ...t, items });
  };

  return (
    <div className="card card-pad stack">
      <div className="form-grid">
        <Field label="Checklist name"><input className="input" value={t.name} maxLength={120} onChange={(e) => setT({ ...t, name: e.target.value })} /></Field>
        <Field label="Job type" optional><input className="input" value={t.job_type ?? ""} maxLength={60} onChange={(e) => setT({ ...t, job_type: e.target.value })} /></Field>
      </div>
      <label className="switch-row" style={{ fontWeight: 500 }}><input type="checkbox" className="switch" checked={t.active} onChange={(e) => setT({ ...t, active: e.target.checked })} />Crews can use this checklist</label>
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
        <Button size="sm" variant="ghost" icon="plus" style={{ justifySelf: "start" }} disabled={t.items.length >= 60} onClick={() => setT({ ...t, items: [...t.items, { key: slug(`item ${t.items.length + 1}`, t.items.map((x) => x.key)), label: "", type: "check", required: false }] })}>Add item</Button>
      </div>
      <FormError error={save.error} />
      <div className="form-actions">
        <Button variant="danger" icon="trash" onClick={async () => (await confirm({ title: `Delete “${t.name}”?`, body: "Checklists already filled in on visits are kept.", confirmLabel: "Delete", danger: true })) && remove.mutate()}>Delete</Button>
        <span className="spacer" />
        {dirty && <Button onClick={() => setT(template)}>Discard changes</Button>}
        <Button variant="primary" loading={save.isPending} disabled={!dirty} onClick={() => save.mutate()}>Save checklist</Button>
      </div>
    </div>
  );
}
