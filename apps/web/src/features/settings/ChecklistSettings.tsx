/** Checklist templates crews fill in on a visit: inspections, safety steps, sign-offs, each step able to open the guide for how it's done. */
import { checklistItemKey as slug, MAX_CHECKLIST_ITEMS, normalizeChecklist } from "@crewtavo/core/forms";
import { isPavingWork, PAVING_WORK, PAVING_WORK_IDS, pavingWorkLabel, type PavingWork } from "@crewtavo/core/paving";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { featureOn } from "@/components/shell/nav";
import { Button, useJustDone } from "@/components/ui/Button";
import { Field, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Menu } from "@/components/ui/Menu";
import { Section } from "@/components/ui/Section";
import { Loading, SectionSkeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { supabase, unwrap } from "@/lib/api";
import { useListAnimation } from "@/lib/motion";
import { useSession } from "@/lib/session";
import { undoable } from "@/lib/undo";
import { useSopIndex } from "../kb/kbData";
import { SaveBar, SettingsActions, SwitchRow } from "./SettingsKit";
import styles from "./settings.module.css";
import { Select } from "@/components/ui/Select";

interface Item {
  key: string;
  label: string;
  type: "check" | "number" | "text" | "choice" | "photo" | "signature";
  required: boolean;
  options?: string[];
  /** The guide crews open from the item on the visit. */
  sop_page_id?: string;
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
  /** It comes up by itself on every job. */
  every_job: boolean;
  /** The kinds of paving calculator work it goes with (PAVING_WORK): jobs priced there have no price list item. */
  work: string[];
}
interface Service { id: string; name: string; category: string | null; active: boolean }

const TYPES: Array<[Item["type"], string]> = [["check", "Checkbox"], ["text", "Text"], ["number", "Number"], ["choice", "Choice"], ["photo", "Photo"], ["signature", "Signature"]];

export function ChecklistSettings() {
  const session = useSession();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const listRef = useListAnimation<HTMLUListElement>();
  const key = ["checklist-templates", session.company.id];
  const templates = useQuery({
    queryKey: key,
    queryFn: async () =>
      unwrap(await supabase().from("checklist_templates").select("id, name, items, active, show_to_client, every_job, work, services:checklist_template_services(service_id)").eq("company_id", session.company.id).order("name")).map(
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

  if (templates.isPending) return <Loading><div className={styles.checklists}><SectionSkeleton rows={3} /><SectionSkeleton rows={6} /></div></Loading>;
  if (templates.error) return <ErrorState error={templates.error} onRetry={() => templates.refetch()} />;
  const current = templates.data?.find((t) => t.id === selected) ?? null;

  return (
    <>
      <SettingsActions><Button icon="plus" loading={create.isPending} onClick={() => create.mutate()}>New checklist</Button></SettingsActions>
      {!templates.data?.length ? (
        <EmptyState inline title="No checklists yet" action={<Button onClick={() => create.mutate()}>Make your first checklist</Button>} />
      ) : (
        <div className={styles.checklists}>
          <nav className={styles.templates} aria-label="Checklists">
            <ul role="list" ref={listRef}>
              {templates.data.map((t) => (
                <li key={t.id}>
                  <button type="button" className={styles.template} aria-current={t.id === selected ? "true" : undefined} onClick={() => setSelected(t.id)}>
                    <span className={styles.templateName}>{t.name}</span>
                    <span className={styles.templateMeta}>{t.items.length} {t.items.length === 1 ? "item" : "items"}{t.active ? "" : " · hidden"}{t.every_job ? " · every job" : ""}</span>
                    {/* On a phone the one being edited is ticked, as a phone's list of choices has it. */}
                    {t.id === selected && <span className={styles.templateCheck} aria-hidden="true"><Icon name="check" size={18} /></span>}
                  </button>
                </li>
              ))}
            </ul>
          </nav>
          <div className={styles.editor}>{current ? <TemplateEditor key={current.id} template={current} services={services.data ?? []} onDelete={() => deleteTemplate(current)} /> : null}</div>
        </div>
      )}
    </>
  );
}

function TemplateEditor({ template, services, onDelete }: { template: Template; services: Service[]; onDelete: () => void }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const [t, setT] = useState(template);
  const itemsRef = useListAnimation<HTMLOListElement>();
  const dirty = JSON.stringify(t) !== JSON.stringify(template);
  const save = useMutation({
    meta: { inline: true },
    mutationFn: async () => {
      // Checked and tidied the way an AI assistant's are too (packages/core/src/forms.ts).
      const clean = normalizeChecklist(t);
      unwrap(await supabase().from("checklist_templates").update({ ...clean, items: clean.items as never, active: t.active, show_to_client: t.show_to_client, every_job: t.every_job, work: t.work }).eq("id", t.id));
      unwrap(await supabase().rpc("set_checklist_services", { p_template: t.id, p_services: t.service_ids }));
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["checklist-templates", session.company.id] }),
  });
  const saved = useJustDone(save);
  const guides = useSopIndex();
  const setItem = (i: number, patch: Partial<Item>) => setT({ ...t, items: t.items.map((item, j) => (j === i ? { ...item, ...patch } : item)) });
  const move = (i: number, dir: -1 | 1) => {
    const items = [...t.items];
    [items[i], items[i + dir]] = [items[i + dir], items[i]];
    setT({ ...t, items });
  };

  return (
    <div className="settings-body">
      <div className={styles.nameRow}>
        <Field label="Checklist name"><input className="input" value={t.name} maxLength={120} onChange={(e) => setT({ ...t, name: e.target.value })} /></Field>
        <Menu label={`More for ${template.name}`} title={template.name} items={[{ label: "Delete checklist", icon: "trash", danger: true, onSelect: onDelete }]} />
      </div>
      <Section level={3} title="When it comes up">
        <div className="set-rows">
          <SwitchRow label="Use on every job" hint="It comes up by itself on every visit, whatever the job has on it." checked={t.every_job} onChange={(on) => setT({ ...t, every_job: on })} />
        </div>
        {!t.every_job && (
          <div className={styles.services}>
            <ServicesPicker
              value={t.service_ids}
              services={services}
              onChange={(service_ids) => setT({ ...t, service_ids })}
              work={t.work.filter(isPavingWork)}
              calculator={featureOn(session.company.settings, "paving_app")}
              onWork={(work) => setT({ ...t, work })}
            />
          </div>
        )}
      </Section>
      <Section level={3} title="Who sees it">
        <div className="set-rows">
          <SwitchRow label="Crews can use this checklist" checked={t.active} onChange={(on) => setT({ ...t, active: on })} />
          <SwitchRow label="Show to client" hint="Finished answers show on their past visit in the Client Hub and print on the invoice. Photos aren't included." checked={t.show_to_client} onChange={(on) => setT({ ...t, show_to_client: on })} />
        </div>
      </Section>
      <Section level={3} title="Items" count={t.items.length} action={<button type="button" disabled={t.items.length >= MAX_CHECKLIST_ITEMS} onClick={() => setT({ ...t, items: [...t.items, { key: slug(`item ${t.items.length + 1}`, t.items.map((x) => x.key)), label: "", type: "check", required: false }] })}><Icon name="plus" size={14} />Add item</button>}>
        <ol className={styles.items} ref={itemsRef}>
          {t.items.map((item, i) => (
            <li key={item.key} className={styles.item}>
              <span className={styles.itemNumber} aria-hidden="true">{i + 1}</span>
              <div className={styles.itemMain}>
                <input className="input input-sm" value={item.label} maxLength={200} placeholder="What should the crew check or record?" onChange={(e) => setItem(i, { label: e.target.value })} aria-label={`Item ${i + 1}`} />
                <Select className="select input-sm" value={item.type} onChange={(e) => setItem(i, { type: e.target.value as Item["type"], options: e.target.value === "choice" ? item.options ?? ["Yes", "No"] : undefined })} aria-label="Item type">
                  {TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </Select>
              </div>
              <div className={styles.itemMore}>
                <label className="checkbox small"><input type="checkbox" checked={item.required} onChange={(e) => setItem(i, { required: e.target.checked })} />Required</label>
                {item.type === "choice" && <input className="input input-sm grow" value={(item.options ?? []).join(", ")} placeholder="Options, separated by commas" onChange={(e) => setItem(i, { options: e.target.value.split(",").map((o) => o.trim()) })} aria-label="Options" />}
                <Select className={`select input-sm ${styles.guide}`} value={item.sop_page_id ?? ""} onChange={(e) => setItem(i, { sop_page_id: e.target.value || undefined })} aria-label="Guide for this item" title="Crews open this guide from the item on their visit">
                  <option value="">No guide</option>
                  {(guides.data?.pages ?? []).map((g) => <option key={g.id} value={g.id}>{g.title}{g.status === "draft" ? " (draft: crews can't see it)" : ""}</option>)}
                  {item.sop_page_id && guides.data && !guides.data.pages.some((g) => g.id === item.sop_page_id) && <option value={item.sop_page_id}>A deleted guide</option>}
                </Select>
                <span className="grow" />
                <Button size="sm" variant="ghost" icon="chevronUp" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)} />
                <Button size="sm" variant="ghost" icon="chevronDown" aria-label="Move down" disabled={i === t.items.length - 1} onClick={() => move(i, 1)} />
                <Button size="sm" variant="ghost" icon="trash" aria-label="Remove item" onClick={() => setT({ ...t, items: t.items.filter((_, j) => j !== i) })} />
              </div>
            </li>
          ))}
        </ol>
        {!t.items.length && <EmptyState inline title="No items yet" />}
      </Section>
      <FormError error={save.error} />
      <SaveBar note={dirty ? "Unsaved changes" : null}>
        <Button variant="primary" loading={save.isPending} done={saved} disabled={!dirty && !saved} onClick={() => save.mutate()}>Save checklist</Button>
        {dirty && <Button variant="ghost" onClick={() => setT(template)}>Discard changes</Button>}
      </SaveBar>
    </div>
  );
}

/** A kind of paving calculator work as the list's value, told apart from a price list item's id. */
const KIND = "calculator:";

/**
 * "Use on jobs with": the price list items a checklist goes with, each removable, and a list to add
 * more. With Paving installed the list also has the kinds of work on jobs priced with the paving
 * calculator (`work`), which have no price list item to go by.
 */
function ServicesPicker({ value, services, onChange, work, calculator, onWork }: { value: string[]; services: Service[]; onChange: (ids: string[]) => void; work: PavingWork[]; calculator: boolean; onWork: (work: PavingWork[]) => void }) {
  const chosen = value.map((id) => services.find((s) => s.id === id)).filter((s): s is Service => Boolean(s));
  const addable = services.filter((s) => s.active && !value.includes(s.id));
  const categories = [...new Set(addable.map((s) => s.category?.trim() || "Other"))];
  const kinds = calculator || work.length ? PAVING_WORK_IDS.filter((w) => !work.includes(w)) : [];
  const add = (picked: string) => {
    const kind = picked.startsWith(KIND) ? picked.slice(KIND.length) : null;
    if (isPavingWork(kind)) onWork([...work, kind]);
    else if (picked) onChange([...value, picked]);
  };
  return (
    <Field label="Use on jobs with" optional hint={value.length || work.length ? "It comes up by itself on visits for jobs with any of these." : "With none, crews can pick it on any job."}>
      {chosen.length + work.length > 0 && (
        <div className={`row wrap ${styles.tags}`}>
          {chosen.map((s) => (
            <span key={s.id} className="tag">
              {s.name}
              <button type="button" aria-label={`Remove ${s.name}`} onClick={() => onChange(value.filter((id) => id !== s.id))}><Icon name="x" size={12} bold /></button>
            </span>
          ))}
          {work.map((w) => (
            <span key={w} className="tag">
              {pavingWorkLabel(w)}
              <button type="button" aria-label={`Remove ${pavingWorkLabel(w)}`} onClick={() => onWork(work.filter((x) => x !== w))}><Icon name="x" size={12} bold /></button>
            </span>
          ))}
        </div>
      )}
      <Select className="select" value="" disabled={!addable.length && !kinds.length} onChange={(e) => add(e.target.value)}>
        <option value="">{services.length ? "Add from your price list…" : "Your price list is empty"}</option>
        {kinds.length > 0 && (
          <optgroup label="Priced with the paving calculator">
            {kinds.map((w) => <option key={w} value={`${KIND}${w}`}>{PAVING_WORK[w]}</option>)}
          </optgroup>
        )}
        {categories.map((c) => (
          <optgroup key={c} label={c}>
            {addable.filter((s) => (s.category?.trim() || "Other") === c).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </optgroup>
        ))}
      </Select>
    </Field>
  );
}
