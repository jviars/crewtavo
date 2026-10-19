/**
 * The Plans and files card on a quote, a job and a client: add files (drop them on the card or pick
 * them), open or save them, put a plan sheet on the Measure map, upload a new version, and choose
 * whether the crew sees each one. Files on the property from earlier work show under "At this
 * property", so next year's restripe has last year's striping plan.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState, type DragEvent, type FormEvent, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Menu, type MenuEntry } from "@/components/ui/Menu";
import { Skeleton } from "@/components/ui/Skeleton";
import { supabase, unwrap } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { hasRole, useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import {
  canMap, fileSize, isAbort, isImage, isPdf, PLAN_FIELDS, planEntries, planMeta, titleFromFileName, TooLargeError, uploadPlanFile, usePlanLinks,
  type PlanEntry, type PlanFile, type Upload,
} from "./plans";
import styles from "./plans.module.css";
import { useTooLarge } from "./UploadLimit";

export type PlansScope =
  | { kind: "request"; id: string; propertyId: string | null }
  | { kind: "quote"; id: string; propertyId: string | null }
  | { kind: "job"; id: string; propertyId: string | null }
  | { kind: "client"; properties: Array<{ id: string; label: string }> };

/** Where a new file goes: the request, quote or job (the database adds the property), or a property. */
type Target = { request_id?: string; quote_id?: string; job_id?: string; property_id?: string };
const COLUMN = { request: "request_id", quote: "quote_id", job: "job_id" } as const;

interface Sending {
  key: string;
  name: string;
  size: number;
  progress: number;
  abort: () => void;
}

const scopeKey = (scope: PlansScope) => (scope.kind === "client" ? ["client", scope.properties.map((p) => p.id).join(",")] : [scope.kind, scope.id, scope.propertyId ?? ""]);

export function usePlanFiles(scope: PlansScope) {
  return useQuery({
    queryKey: ["plans", ...scopeKey(scope)],
    queryFn: async () => {
      let query = supabase().from("plan_files").select(PLAN_FIELDS).order("created_at", { ascending: false }).limit(400);
      if (scope.kind === "client") {
        if (!scope.properties.length) return [] as PlanFile[];
        query = query.in("property_id", scope.properties.map((p) => p.id));
      } else {
        const column = COLUMN[scope.kind];
        query = query.or([`${column}.eq.${scope.id}`, scope.propertyId && `property_id.eq.${scope.propertyId}`].filter(Boolean).join(","));
      }
      return unwrap(await query) as PlanFile[];
    },
  });
}

export function PlansCard({ scope }: { scope: PlansScope }) {
  const session = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const isOffice = hasRole(session, "admin", "office", "estimator");
  const canAdd = isOffice || hasRole(session, "crew_lead");
  const files = usePlanFiles(scope);
  const rows = files.data ?? [];
  const entries = planEntries(rows);
  const links = usePlanLinks(rows);
  const [showArchived, setShowArchived] = useState(false);
  const [sending, setSending] = useState<Sending[]>([]);
  const [editing, setEditing] = useState<PlanFile | null>(null);
  const [dropOn, setDropOn] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const pickFor = useRef<{ target: Target; replaces: PlanFile | null } | null>(null);
  const tooLarge = useTooLarge();

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["plans"] });

  // ----- Adding files -------------------------------------------------------------------------
  async function send(list: File[], target: Target, replaces: PlanFile | null = null) {
    let added = 0;
    let lastId: string | null = null;
    for (const file of list) {
      const key = crypto.randomUUID();
      const upload: Upload = uploadPlanFile(session.company.id, file, (progress) => setSending((s) => s.map((u) => (u.key === key ? { ...u, progress } : u))));
      setSending((s) => [...s, { key, name: file.name, size: file.size, progress: 0, abort: upload.abort }]);
      try {
        const path = await upload.promise;
        const { data, error } = await supabase()
          .from("plan_files")
          .insert({
            company_id: session.company.id,
            ...target,
            replaces_id: replaces?.id ?? null,
            title: replaces?.title ?? titleFromFileName(file.name),
            path,
            file_name: file.name.slice(0, 255),
            content_type: (file.type || null)?.slice(0, 150) ?? null,
            size_bytes: file.size,
            crew_visible: replaces?.crew_visible ?? true,
          })
          .select("id")
          .single();
        if (error) {
          void supabase().storage.from("files").remove([path]);
          throw new Error(error.message);
        }
        added++;
        lastId = data.id;
      } catch (error) {
        if (isAbort(error)) continue;
        if (error instanceof TooLargeError) tooLarge.report(error);
        else toast.error(`${file.name}: ${error instanceof Error ? error.message : "Couldn't add it."}`);
      } finally {
        setSending((s) => s.filter((u) => u.key !== key));
      }
    }
    refresh();
    if (!added) return;
    if (replaces) {
      const id = lastId;
      toast.success(`New version of ${replaces.title} added`, {
        description: "It's the current one now. The crew only sees this version.",
        action: id ? { label: "Add a label", onClick: () => openEditor(id) } : undefined,
      });
    } else toast.success(added === 1 ? "File added" : `${added} files added`);
  }

  async function openEditor(id: string) {
    const row = unwrap(await supabase().from("plan_files").select(PLAN_FIELDS).eq("id", id).maybeSingle()) as PlanFile | null;
    if (row) setEditing(row);
  }

  const pick = (target: Target, replaces: PlanFile | null = null) => {
    pickFor.current = { target, replaces };
    picker.current?.click();
  };
  const defaultTarget = (propertyId?: string): Target | null =>
    scope.kind !== "client" ? { [COLUMN[scope.kind]]: scope.id } : propertyId ? { property_id: propertyId } : scope.properties.length === 1 ? { property_id: scope.properties[0].id } : null;

  const dropProps = (zone: string, target: Target | null) =>
    canAdd && target
      ? {
          onDragOver: (e: DragEvent) => {
            if (!e.dataTransfer.types.includes("Files")) return;
            e.preventDefault();
            setDropOn(zone);
          },
          onDragLeave: (e: DragEvent) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropOn(null);
          },
          onDrop: (e: DragEvent) => {
            e.preventDefault();
            setDropOn(null);
            const list = [...e.dataTransfer.files];
            if (list.length) void send(list, target);
          },
        }
      : {};

  // ----- Changing files -----------------------------------------------------------------------
  const update = useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: Partial<Pick<PlanFile, "crew_visible" | "archived">> }) => {
      unwrap(await supabase().from("plan_files").update(patch).eq("id", id).select("id").single());
      return patch;
    },
    meta: {
      success: (patch: Partial<Pick<PlanFile, "crew_visible" | "archived">>) =>
        patch.archived === true ? "Archived. The crew no longer sees it." : patch.archived === false ? "Restored" : patch.crew_visible ? "The crew can see it now" : "Office only now. Crews don't see it.",
    },
    onSuccess: refresh,
  });
  const remove = useMutation({
    meta: { success: "File deleted" },
    mutationFn: async (file: PlanFile) => {
      const gone = unwrap(await supabase().from("plan_files").delete().eq("id", file.id).select("id"));
      if (!gone.length) throw new Error("You can only delete files you added. Ask the office to remove this one.");
      await supabase().storage.from("files").remove([file.path]);
    },
    onSuccess: refresh,
  });
  const askDelete = async (entry: PlanEntry) => {
    const f = entry.file;
    const body = entry.older.length
      ? `This deletes version ${entry.version}. Version ${entry.version - 1} becomes the current one again.`
      : "It's deleted for everyone. This can't be undone.";
    if (await confirm({ title: `Delete ${f.title}?`, body, confirmLabel: "Delete", danger: true })) remove.mutate(f);
  };

  const mapUrl = (f: PlanFile) => {
    const params = new URLSearchParams({ plan: f.id });
    if (f.property_id) params.set("property", f.property_id);
    if (scope.kind === "quote") params.set("quote", scope.id);
    if (scope.kind === "request") params.set("request", scope.id);
    return `/measure?${params}`;
  };

  // ----- Rows ---------------------------------------------------------------------------------
  const row = (entry: PlanEntry) => {
    const f = entry.file;
    const open = links.data?.open[f.path];
    const save = links.data?.save[f.path];
    const mine = f.created_by === session.userId;
    const items: MenuEntry[] = [
      { label: "Open", icon: "eye", disabled: !open, onSelect: () => open && window.open(open, "_blank", "noopener") },
      { label: "Download", icon: "download", disabled: !save, onSelect: () => save && (window.location.href = save) },
      { label: "Put on the map", icon: "map", hidden: !canAdd || !canMap(f) || f.archived, onSelect: () => navigate(mapUrl(f)) },
      { separator: true, hidden: !canAdd },
      { label: "Upload a new version", icon: "upload", hidden: !canAdd || f.archived, onSelect: () => pick({}, f) },
      { label: "Edit details", icon: "edit", hidden: !canAdd, onSelect: () => setEditing(f) },
      { label: f.crew_visible ? "Make it office only" : "Show it to the crew", icon: f.crew_visible ? "lock" : "users", hidden: !isOffice, onSelect: () => update.mutate({ id: f.id, patch: { crew_visible: !f.crew_visible } }) },
      { label: f.archived ? "Restore" : "Archive", icon: f.archived ? "undo" : "archive", hidden: !isOffice, onSelect: () => update.mutate({ id: f.id, patch: { archived: !f.archived } }) },
      { separator: true, hidden: !(isOffice || mine) },
      { label: "Delete", icon: "trash", danger: true, hidden: !(isOffice || mine), onSelect: () => void askDelete(entry) },
    ];
    return <PlanRow key={f.id} entry={entry} open={open} save={save} links={links.data} menu={items} />;
  };

  const visible = entries.filter((e) => showArchived || !e.file.archived);
  const archivedCount = entries.filter((e) => e.file.archived).length;
  const groups: Array<{ key: string; label: string | null; entries: PlanEntry[]; target: Target | null; empty?: ReactNode }> =
    scope.kind === "client"
      ? scope.properties.map((p) => ({
          key: p.id,
          label: scope.properties.length > 1 ? p.label : null,
          entries: visible.filter((e) => e.file.property_id === p.id),
          target: { property_id: p.id },
        }))
      : (() => {
          const column = COLUMN[scope.kind];
          const here = visible.filter((e) => e.file[column] === scope.id);
          const elsewhere = visible.filter((e) => e.file[column] !== scope.id);
          return [
            { key: "here", label: elsewhere.length ? `On this ${scope.kind}` : null, entries: here, target: defaultTarget() },
            { key: "property", label: "At this property", entries: elsewhere, target: null },
          ];
        })();

  const emptyText =
    scope.kind === "request"
      ? "Plans, photos or specs for this request. Files the client sent with a booking form show up here, and go on the quote you make from it."
      : scope.kind === "quote"
      ? "Add the plans that came with this bid: site plans, specs, addenda. They go on the job when the quote does."
      : scope.kind === "job"
        ? "Add plan sheets, specs or permits. The crew sees them on their visits, and you can put a plan on the map to measure from it."
        : scope.properties.length
          ? "Plans and files for this client's properties show up here."
          : "Add a property first. Plans and files are kept with the property.";
  const addTargets = scope.kind === "client" && scope.properties.length > 1 ? scope.properties : null;
  const single = defaultTarget();

  return (
    <section className="stack" aria-labelledby={`plans-${scopeKey(scope).join("-")}`}>
      <div className="section-head">
        <h2 id={`plans-${scopeKey(scope).join("-")}`} className="section-title">Plans and files</h2>
        {canAdd && single && <Button size="sm" icon="upload" onClick={() => pick(single)}>Add files</Button>}
        {canAdd && addTargets && (
          <Menu
            label="Add files for a property"
            triggerClassName="btn btn-sm"
            trigger={<><Icon name="upload" size={14} />Add files</>}
            items={[{ heading: "For which property?" }, ...addTargets.map((p) => ({ label: p.label, icon: "pin" as const, onSelect: () => pick({ property_id: p.id }) }))]}
          />
        )}
      </div>
      <div className={`card card-pad ${dropOn === "card" ? styles.dropping : ""}`} {...dropProps("card", single)}>
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            const list = [...(e.target.files ?? [])];
            e.target.value = "";
            const ask = pickFor.current;
            if (!list.length || !ask) return;
            void send(ask.replaces ? list.slice(0, 1) : list, ask.target, ask.replaces);
          }}
        />
        {files.isPending && <div className="stack-sm"><Skeleton width="60%" /><Skeleton width="40%" /></div>}
        {files.error && <span className="field-error">Couldn't load the files. <button type="button" className="link-btn" onClick={() => files.refetch()}>Try again</button></span>}
        {sending.length > 0 && (
          <div className={styles.list}>
            {sending.map((u) => (
              <div key={u.key} className={styles.upload} role="status">
                <div className={styles.uploadHead}>
                  <span title={u.name}>{u.name}</span>
                  <span className="muted small tabular">{u.progress >= 1 ? "Saving…" : `${Math.round(u.progress * 100)}% of ${fileSize(u.size)}`}</span>
                  {u.progress < 1 && <Button size="sm" variant="ghost" icon="x" aria-label={`Stop uploading ${u.name}`} onClick={u.abort} />}
                </div>
                <div className="progress" aria-hidden="true"><span style={{ width: `${Math.round(u.progress * 100)}%` }} /></div>
              </div>
            ))}
          </div>
        )}
        {files.data && !visible.length && !sending.length && (
          <div className="stack-sm">
            <span className="muted small">{emptyText}</span>
            {canAdd && single && <span className={styles.dropHint}>PDFs, pictures or any other file, up to {fileSize(200 * 1024 * 1024)} each. You can also drop them here.</span>}
          </div>
        )}
        {files.data &&
          groups.map((g) =>
            g.entries.length ? (
              <div key={g.key} {...dropProps(g.key, g.target)} className={dropOn === g.key ? styles.dropping : undefined}>
                {g.label && <h3 className={styles.group}>{g.label}</h3>}
                <div className={styles.list}>{g.entries.map(row)}</div>
              </div>
            ) : null,
          )}
        {isOffice && archivedCount > 0 && (
          <button type="button" className={styles.olderToggle} style={{ marginTop: 10 }} onClick={() => setShowArchived(!showArchived)}>
            {showArchived ? "Hide archived files" : `Show ${archivedCount} archived ${archivedCount === 1 ? "file" : "files"}`}
          </button>
        )}
      </div>
      {editing && <PlanDetailsDialog file={editing} canChangeCrew={isOffice} onClose={() => setEditing(null)} onSaved={refresh} />}
      {tooLarge.dialog}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// One file
// ---------------------------------------------------------------------------------------------

export function PlanIcon({ file }: { file: Pick<PlanFile, "content_type" | "file_name"> }) {
  const kind = isPdf(file) ? "pdf" : isImage(file) ? "image" : "file";
  return (
    <span className={styles.icon} data-kind={kind} aria-hidden="true">
      <Icon name={kind === "image" ? "image" : kind === "pdf" ? "quote" : "file"} size={18} />
    </span>
  );
}

function PlanRow({ entry, open, save, links, menu }: { entry: PlanEntry; open?: string; save?: string; links?: { open: Record<string, string>; save: Record<string, string> }; menu: MenuEntry[] }) {
  const [history, setHistory] = useState(false);
  const f = entry.file;
  return (
    <div className={styles.row}>
      <PlanIcon file={f} />
      <div className={styles.body}>
        {open ? <a className={styles.title} href={open} target="_blank" rel="noreferrer">{f.title}</a> : <span className={styles.title}>{f.title}</span>}
        <span className={styles.meta}>{planMeta(entry)}</span>
        {(!f.crew_visible || f.archived) && (
          <div className={styles.chips}>
            {!f.crew_visible && <span className="chip chip-amber"><Icon name="lock" size={11} />Office only</span>}
            {f.archived && <span className="chip">Archived</span>}
          </div>
        )}
        {f.notes && <p className={styles.notes}>{f.notes}</p>}
        {entry.older.length > 0 && (
          <>
            <button type="button" className={styles.olderToggle} aria-expanded={history} onClick={() => setHistory(!history)}>
              <Icon name={history ? "chevronUp" : "chevronDown"} size={12} /> {entry.older.length} older {entry.older.length === 1 ? "version" : "versions"}
            </button>
            {history && (
              <div className={styles.older}>
                {entry.older.map((o, i) => (
                  <div key={o.id} className={styles.olderRow}>
                    <span>
                      Version {entry.version - 1 - i}{o.revision ? ` · ${o.revision}` : ""} · added {formatDate(o.created_at)}{o.superseded_at ? `, replaced ${formatDate(o.superseded_at)}` : ""}
                    </span>
                    {links?.open[o.path] && <a href={links.open[o.path]} target="_blank" rel="noreferrer">Open</a>}
                    {links?.save[o.path] && <a href={links.save[o.path]}>Download</a>}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
      <div className={styles.actions}>
        {save && <a className="btn btn-sm btn-ghost btn-icon" href={save} aria-label={`Download ${f.title}`} title="Download"><Icon name="download" size={15} /></a>}
        <Menu triggerClassName="btn btn-sm btn-ghost btn-icon" label={`Actions for ${f.title}`} items={menu} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Name, label, notes and who sees it
// ---------------------------------------------------------------------------------------------

function PlanDetailsDialog({ file, canChangeCrew, onClose, onSaved }: { file: PlanFile; canChangeCrew: boolean; onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState(file.title);
  const [revision, setRevision] = useState(file.revision ?? "");
  const [notes, setNotes] = useState(file.notes ?? "");
  const [crew, setCrew] = useState(file.crew_visible);
  const save = useMutation({
    meta: { inline: true, success: "Saved" },
    mutationFn: async () => {
      if (!title.trim()) throw new Error("Give it a name.");
      unwrap(
        await supabase()
          .from("plan_files")
          .update({ title: title.trim(), revision: revision.trim() || null, notes: notes.trim() || null, ...(canChangeCrew ? { crew_visible: crew } : {}) })
          .eq("id", file.id)
          .select("id")
          .single(),
      );
    },
    onSuccess: () => {
      onSaved();
      onClose();
    },
  });
  return (
    <Dialog open onClose={onClose} title="File details" description={file.file_name} size="sm">
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Field label="Name"><input className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} placeholder="Site plan" autoFocus /></Field>
        <Field label="Revision" optional hint="As it's marked on the plans, so everyone knows which set they're looking at.">
          <input className="input" value={revision} onChange={(e) => setRevision(e.target.value)} maxLength={60} placeholder="Rev B, Addendum 2, Issued for construction" />
        </Field>
        <Field label="Notes for the crew" optional>
          <textarea className="textarea" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} placeholder="Sheets C-101 and C-501 are the ones for paving. Striping is on C-601." />
        </Field>
        {canChangeCrew && (
          <label className="switch-row" style={{ fontWeight: 500 }}>
            <input type="checkbox" className="switch" checked={crew} onChange={(e) => setCrew(e.target.checked)} />
            The crew can see it
          </label>
        )}
        {canChangeCrew && !crew && <p className="muted small" style={{ margin: "6px 0 0" }}>Office only: for a bid form with your prices on it, say. Crew leads and crews won't see it.</p>}
        <FormError error={save.error} />
        <div className="form-actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending}>Save</Button>
        </div>
      </form>
    </Dialog>
  );
}
