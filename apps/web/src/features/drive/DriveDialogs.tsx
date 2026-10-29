/**
 * Drive's dialogs: a new folder or a folder's name, a file's name, moving a file or folder to another
 * folder, attaching a file to a client's property, request, quote or job (and taking it off one), a
 * file's versions, and getting Google Drive ready when its scripts weren't loaded yet.
 */
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useDeferredValue, useEffect, useState, type FormEvent, type KeyboardEvent } from "react";
import { Button, Spinner } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { Icon, type IconName } from "@/components/ui/Icon";
import { Skeleton } from "@/components/ui/Skeleton";
import { PropertySelect } from "@/features/clients/ClientForm";
import { fileSize } from "@/features/plans/plans";
import { searchTerm, supabase, unwrap } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { getRecents } from "@/lib/recent";
import { useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import {
  andList, attachLeaves, attachPatch, detachPatch, FOLDER_FIELDS, flatTree, folderDescendants, folderNameProblem, folderPath, placeFile, placeName, placesOf, refreshFiles,
  useDriveVersions, type AttachPick, type DriveFile, type DriveFolder, type FolderTree, type Place, type Slot,
} from "./data";
import styles from "./drive.module.css";
import { trashVersion, undoToast } from "./trash";

/** The database's "already a folder called that here", in words. */
function savedFolder<R extends { data: unknown; error: { code?: string; message: string } | null }>(result: R, name: string, where: string): NonNullable<R["data"]> {
  if (result.error?.code === "23505") throw new Error(`There's already a folder called ${name} ${where}.`);
  return unwrap(result);
}

// ---------------------------------------------------------------------------------------------
// A folder's name
// ---------------------------------------------------------------------------------------------

/** A new folder inside `parent`, or a new name for `folder`. */
export function FolderNameDialog({ folder, parent, onClose, onSaved }: { folder?: DriveFolder; parent?: DriveFolder; onClose: () => void; onSaved?: (folder: DriveFolder) => void }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const [name, setName] = useState(folder?.name ?? "");
  const save = useMutation({
    meta: { inline: true, success: folder ? "Folder renamed" : "Folder added" },
    mutationFn: async () => {
      const problem = folderNameProblem(name);
      if (problem) throw new Error(problem);
      const clean = name.trim();
      const result = folder
        ? await supabase().from("drive_folders").update({ name: clean }).eq("id", folder.id).select(FOLDER_FIELDS).single()
        : await supabase().from("drive_folders").insert({ company_id: session.company.id, parent_id: parent!.id, name: clean }).select(FOLDER_FIELDS).single();
      return savedFolder(result, clean, "here") as unknown as DriveFolder;
    },
    onSuccess: (saved) => {
      queryClient.invalidateQueries({ queryKey: ["drive"] });
      onSaved?.(saved);
      onClose();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };
  return (
    <Dialog open onClose={onClose} title={folder ? "Rename folder" : "New folder"} description={!folder && parent?.parent_id ? `Inside ${parent.name}` : undefined} size="sm">
      <form onSubmit={submit}>
        <Field label="Name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="Forms" autoFocus /></Field>
        <FormError error={save.error} />
        <div className="form-actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!name.trim()}>{folder ? "Rename" : "Add folder"}</Button>
        </div>
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------------------------
// A file's name
// ---------------------------------------------------------------------------------------------

/** A file's name (its title: the name it was uploaded with never changes) and the revision marked on it. */
export function RenameFileDialog({ file, onClose }: { file: DriveFile; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState(file.title);
  const [revision, setRevision] = useState(file.revision ?? "");
  const save = useMutation({
    meta: { inline: true, success: "Saved" },
    mutationFn: async () => {
      if (!title.trim()) throw new Error("Give it a name.");
      unwrap(await supabase().from("plan_files").update({ title: title.trim(), revision: revision.trim() || null }).eq("id", file.id).select("id").single());
    },
    onSuccess: () => {
      refreshFiles(queryClient);
      onClose();
    },
  });
  return (
    <Dialog open onClose={onClose} title="Rename" description={file.file_name} size="sm">
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Field label="Name"><input className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} autoFocus /></Field>
        <Field label="Revision" optional hint="As it's marked on the file, so everyone knows which one they're looking at.">
          <input className="input" value={revision} onChange={(e) => setRevision(e.target.value)} maxLength={60} placeholder="Rev B, 2026 edition" />
        </Field>
        <FormError error={save.error} />
        <div className="form-actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending}>Save</Button>
        </div>
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------------------------
// Moving
// ---------------------------------------------------------------------------------------------

export type MoveItem = { kind: "file"; file: DriveFile } | { kind: "folder"; folder: DriveFolder };

/** Pick a folder to move a file or folder to. A folder can't go inside itself or one of its own folders. */
export function MoveDialog({ item, tree, onClose }: { item: MoveItem; tree: FolderTree; onClose: () => void }) {
  const queryClient = useQueryClient();
  const here = item.kind === "file" ? item.file.folder_id : item.folder.parent_id;
  const [to, setTo] = useState<string | null>(null);
  const blocked = item.kind === "folder" ? new Set([item.folder.id, ...folderDescendants(tree, item.folder.id)]) : new Set<string>();
  const rows = flatTree(tree).filter((r) => !blocked.has(r.folder.id));
  const name = (f: DriveFolder) => (f.parent_id ? f.name : "Company files");
  const destination = to ? tree.byId.get(to) : undefined;
  const move = useMutation({
    meta: { inline: true, success: () => (destination ? `Moved to ${name(destination)}` : "Moved") },
    mutationFn: async () => {
      if (!to || !destination) throw new Error("Pick a folder to move it to.");
      if (item.kind === "file") return placeFile(item.file.id, () => ({ folder_id: to }));
      const result = await supabase().from("drive_folders").update({ parent_id: to }).eq("id", item.folder.id).select("id").single();
      savedFolder(result, item.folder.name, `in ${name(destination)}`);
    },
    onSuccess: () => {
      refreshFiles(queryClient);
      onClose();
    },
  });
  const title = item.kind === "file" ? item.file.title : item.folder.name;
  return (
    <Dialog open onClose={onClose} title={`Move ${title}`} description={here ? `Now in ${folderPath(tree, here).map(name).join(" › ")}` : "Pick a folder in Company files."} size="sm">
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          move.mutate();
        }}
      >
        <div className={`card ${styles.tree}`} role="listbox" aria-label="Folders">
          {rows.map(({ folder, depth }) => {
            const current = folder.id === here;
            return (
              <button
                key={folder.id}
                type="button"
                role="option"
                aria-selected={to === folder.id}
                disabled={current}
                className={styles.treeOption}
                style={{ ["--depth" as string]: depth }}
                onClick={() => setTo(folder.id)}
              >
                <Icon name={to === folder.id ? "folderOpen" : "folder"} size={16} />
                <span className="grow ellipsis">{name(folder)}</span>
                {current && <span className="muted small">Here now</span>}
              </button>
            );
          })}
        </div>
        <FormError error={move.error} />
        <div className="form-actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={move.isPending} disabled={!to}>Move here</Button>
        </div>
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------------------------
// Attaching to a client's records
// ---------------------------------------------------------------------------------------------

type Found = { kind: "client" | "property" | "request" | "quote" | "job"; id: string; title: string; subtitle: string; clientId: string | null; number: number | null };
const KINDS = new Set(["client", "property", "request", "quote", "job"]);
const KIND_ICON: Record<Found["kind"], IconName> = { client: "clients", property: "pin", request: "requests", quote: "quote", job: "job" };
const NOUN: Record<Found["kind"], string> = { client: "Client", property: "Property", request: "Request", quote: "Quote", job: "Job" };
const TABLE: Record<Exclude<Slot, "property_id">, "jobs" | "quotes" | "requests"> = { job_id: "jobs", quote_id: "quotes", request_id: "requests" };
const RECORD_SLOT: Record<"request" | "quote" | "job", Exclude<Slot, "property_id">> = { request: "request_id", quote: "quote_id", job: "job_id" };

const foundLabel = (f: Found) => (f.kind === "property" ? [f.title, f.subtitle].filter(Boolean).join(" · ") : [f.number ? `${NOUN[f.kind]} #${f.number}` : NOUN[f.kind], f.title].filter(Boolean).join(" · "));

/**
 * The record picked in Attach to…, with whose it is and where it is (a recently opened record doesn't
 * say): a file moving to another client leaves the first one's records, and it's at the property the
 * record is at.
 */
async function pickFor(chosen: Found, propertyId: string | null): Promise<AttachPick> {
  if (chosen.kind === "client") {
    if (!propertyId) throw new Error("Pick one of their properties. A client's files are kept with a property.");
    return { slot: "property_id", id: propertyId, clientId: chosen.id, propertyId, label: chosen.title };
  }
  if (chosen.kind === "property") {
    const clientId = chosen.clientId ?? unwrap(await supabase().from("properties").select("client_id").eq("id", chosen.id).maybeSingle())?.client_id ?? null;
    return { slot: "property_id", id: chosen.id, clientId, propertyId: chosen.id, label: foundLabel(chosen) };
  }
  const slot = RECORD_SLOT[chosen.kind];
  const row = unwrap(await supabase().from(TABLE[slot]).select("client_id, property_id").eq("id", chosen.id).maybeSingle());
  if (!row) throw new Error(`That ${NOUN[chosen.kind].toLowerCase()} isn't here anymore. It may have been deleted.`);
  return { slot, id: chosen.id, clientId: row.client_id ?? chosen.clientId, propertyId: row.property_id ?? null, label: foundLabel(chosen) };
}

/**
 * Put a file on a client's property, request, quote or job, by search (recently opened records first).
 * A client asks which of their properties. The file keeps its folder. Its places so far are listed with
 * a way to take it off each one. A file is on one job, one quote and one request at a time, so picking
 * a second job moves it there: the dialog says what it comes off before it's moved, and the toast after.
 */
export function AttachDialog({ file, rootId, onClose }: { file: DriveFile; rootId: string | null; onClose: () => void }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const [term, setTerm] = useState("");
  const [index, setIndex] = useState(0);
  const query = useDeferredValue(searchTerm(term));
  const [chosen, setChosen] = useState<Found | null>(null);
  const [propertyId, setPropertyId] = useState<string | null>(null);
  const [crew, setCrew] = useState(file.crew_visible);
  const [removed, setRemoved] = useState<Slot[]>([]);
  const places = placesOf(file).filter((p) => !removed.includes(p.slot));

  const results = useQuery({
    queryKey: ["drive", session.company.id, "attach-search", query],
    enabled: query.length >= 2 && !chosen,
    placeholderData: keepPreviousData,
    meta: { silent: true },
    queryFn: async () => {
      const rows = unwrap(await supabase().rpc("global_search", { p_company_id: session.company.id, p_query: query, p_limit: 6 }));
      return rows.filter((r) => KINDS.has(r.kind)).map((r): Found => ({ kind: r.kind as Found["kind"], id: r.id, title: r.title, subtitle: r.subtitle, clientId: r.client_id, number: r.number }));
    },
  });
  const recents: Found[] = getRecents(session.company.id)
    .filter((r) => KINDS.has(r.kind))
    .map((r) => ({ kind: r.kind as Found["kind"], id: r.id, title: r.title, subtitle: r.subtitle ?? "", clientId: r.kind === "client" ? r.id : null, number: null }));
  const options = query.length >= 2 ? (results.data ?? []) : recents;
  useEffect(() => setIndex(0), [query]);

  // The record picked, looked up as soon as it's picked, so what the file comes off shows before Attach.
  const pickable = Boolean(chosen) && (chosen?.kind !== "client" || Boolean(propertyId));
  const picked = useQuery({
    queryKey: ["drive", session.company.id, "attach-pick", chosen?.kind, chosen?.id, propertyId],
    enabled: pickable,
    retry: false,
    meta: { silent: true },
    queryFn: () => pickFor(chosen!, propertyId),
  });
  const leaves = picked.data ? attachLeaves(places, attachPatch(file, picked.data)) : [];

  const attach = useMutation({
    meta: { inline: true },
    mutationFn: async () => {
      if (!chosen) throw new Error("Pick where it goes.");
      // Looked up again: the record may have changed since it was picked.
      const pick = await pickFor(chosen, propertyId);
      const patch = attachPatch(file, pick);
      const seen: { row?: Pick<DriveFile, Slot | "folder_id"> } = {};
      await placeFile(file.id, (row) => ((seen.row = row), patch), { crew_visible: crew });
      // What it came off, as the file was when it moved (not as the list showed it).
      const left = attachLeaves(placesOf(file).filter((p) => seen.row?.[p.slot] === p.id), patch);
      return { label: pick.label, left: left.map((p) => placeName(file, p)) };
    },
    onSuccess: ({ label, left }) => {
      toast.success(left.length ? `Moved to ${label}` : `Attached to ${label}`, left.length ? { description: `It's no longer on ${andList(left)}.` } : undefined);
      refreshFiles(queryClient);
      onClose();
    },
  });
  const detach = useMutation({
    meta: { inline: true, success: (_: void, place: Place) => `Taken off ${place.label}` },
    mutationFn: async (place: Place) => {
      if (!rootId) throw new Error("Drive is still loading. Try again in a moment.");
      await placeFile(file.id, (row) => detachPatch(row, place.slot, rootId));
    },
    onSuccess: (_, place) => {
      setRemoved((r) => [...r, place.slot]);
      refreshFiles(queryClient);
    },
  });

  const choose = (found: Found) => {
    setChosen(found);
    setPropertyId(null);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIndex((i) => Math.min(options.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIndex((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (options[index]) choose(options[index]);
    }
  };

  return (
    <Dialog open onClose={onClose} title="Attach to…" description={`${file.title}. It stays in its folder too.`} size="md">
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          attach.mutate();
        }}
      >
        {places.length > 0 && (
          <div className="stack-sm">
            <span className="small strong muted">On now</span>
            {places.map((p) => (
              <div key={p.slot} className={styles.attached}>
                <span className={styles.place} data-slot={p.slot} title={p.label}>{p.label}</span>
                <Button size="sm" variant="ghost" loading={detach.isPending && detach.variables?.slot === p.slot} onClick={() => detach.mutate(p)}>
                  Remove from {p.slot === "property_id" ? "this property" : p.label.split(" · ")[0]}
                </Button>
              </div>
            ))}
            <FormError error={detach.error} />
          </div>
        )}

        {chosen ? (
          <div className="stack-sm">
            <div className="row card" style={{ padding: "8px 8px 8px 12px", boxShadow: "none", background: "var(--fill)" }}>
              <Icon name={KIND_ICON[chosen.kind]} size={16} />
              <span className="grow ellipsis"><strong>{foundLabel(chosen)}</strong>{chosen.kind !== "property" && chosen.subtitle && <span className="muted"> · {chosen.subtitle}</span>}</span>
              <Button size="sm" variant="ghost" onClick={() => setChosen(null)}>Change</Button>
            </div>
            {chosen.kind === "client" && (
              <Field label="Which property?" hint="A client's files are kept with one of their properties.">
                <PropertySelect clientId={chosen.id} value={propertyId} onChange={setPropertyId} />
              </Field>
            )}
            {leaves.length > 0 && (
              <p className="small" role="status" style={{ margin: 0, color: "var(--warning)" }}>
                It comes off {andList(leaves.map((p) => placeName(file, p)))}.
              </p>
            )}
            <FormError error={picked.error} />
            <label className="switch-row" style={{ fontWeight: 500 }}>
              <input type="checkbox" className="switch" checked={crew} onChange={(e) => setCrew(e.target.checked)} />
              The crew can see it
            </label>
            {chosen.kind === "job" && crew && <p className="muted small" style={{ margin: 0 }}>The crew on its upcoming visits gets a notification.</p>}
          </div>
        ) : (
          <div className="stack-sm">
            <div className="input-group">
              <span className="addon"><Icon name="search" size={16} /></span>
              <input
                className="input"
                placeholder="Search clients, addresses, requests, quotes and jobs"
                value={term}
                onChange={(e) => setTerm(e.target.value)}
                onKeyDown={onKeyDown}
                aria-label="Search for where it goes"
                autoComplete="off"
                autoFocus
              />
            </div>
            <div className={`card ${styles.results}`} role="listbox" aria-label={query.length >= 2 ? "Matches" : "Recently opened"}>
              {query.length < 2 && options.length > 0 && <div className={styles.resultsHead}>Recently opened</div>}
              {query.length >= 2 && results.isPending && [0, 1, 2].map((i) => <div key={i} className="card-row" style={{ padding: "12px" }}><Skeleton width={`${60 - i * 12}%`} /></div>)}
              {options.map((o, i) => (
                <button key={`${o.kind}-${o.id}`} type="button" role="option" aria-selected={i === index} className={`card-row ${styles.result}`} onMouseMove={() => setIndex(i)} onClick={() => choose(o)}>
                  <Icon name={KIND_ICON[o.kind]} size={16} />
                  <span className="grow" style={{ minWidth: 0 }}>
                    <strong className="ellipsis" style={{ display: "block" }}>{o.kind === "property" ? o.title : foundLabel(o)}</strong>
                    <span className="muted small ellipsis" style={{ display: "block" }}>{[NOUN[o.kind], o.subtitle].filter(Boolean).join(" · ")}</span>
                  </span>
                </button>
              ))}
              {query.length >= 2 && results.data && !options.length && <div className="empty" style={{ padding: 16 }}>Nothing matches. Try a client's name, an address or a job number.</div>}
              {query.length < 2 && !options.length && <div className="empty" style={{ padding: 16 }}>Type a client's name, an address, or a request, quote or job.</div>}
            </div>
          </div>
        )}

        <FormError error={attach.error} />
        <div className="form-actions">
          <Button onClick={onClose}>{places.length !== placesOf(file).length ? "Done" : "Cancel"}</Button>
          {/* Not before the record's looked up: what the file would come off shows first. */}
          <Button type="submit" variant="primary" icon="paperclip" loading={attach.isPending} disabled={!pickable || picked.isPending || picked.isFetching}>
            {leaves.length ? "Move here" : "Attach"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------------------------

/** A file's versions, newest first: open or download any, and take the newest back to the one before. */
export function VersionsDialog({ file, onOpen, onDownload, onClose }: { file: DriveFile; onOpen: (id: string) => void; onDownload: (f: { path: string; file_name: string }) => void; onClose: () => void }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const versions = useDriveVersions(session.company.id, file.id);
  const rows = versions.data ?? [];
  const back = useMutation({
    mutationFn: (id: string) => trashVersion(id),
    onSuccess: (_, id) => {
      refreshFiles(queryClient);
      undoToast(`Version ${rows.length} moved to Trash`, "version", id, () => refreshFiles(queryClient));
      onClose();
    },
  });
  return (
    <Dialog open onClose={onClose} title="Versions" description={file.title} size="md">
      <div className="dialog-body">
        {versions.isPending && <div className="stack-sm"><Skeleton height={44} /><Skeleton height={44} /></div>}
        {versions.error && <FormError error={versions.error} />}
        {rows.length > 0 && (
          <div className="card">
            {rows.map((v, i) => (
              <div key={v.id} className={`card-row ${styles.version}`}>
                <span className="grow" style={{ minWidth: 0 }}>
                  <strong>Version {rows.length - i}</strong>
                  {i === 0 && <span className="chip chip-green" style={{ marginLeft: 8 }}>Current</span>}
                  <span className="muted small" style={{ display: "block" }}>
                    {[v.revision?.trim(), fileSize(v.size_bytes), `added ${formatDate(v.created_at)}`, v.created_by_name && `by ${v.created_by_name}`].filter(Boolean).join(" · ")}
                  </span>
                </span>
                <span className={styles.versionButtons}>
                  <Button size="sm" onClick={() => onOpen(v.id)}>Open</Button>
                  <Button size="sm" variant="ghost" icon="download" aria-label={`Download version ${rows.length - i}`} title="Download" onClick={() => onDownload(v)} />
                </span>
              </div>
            ))}
          </div>
        )}
        {rows.length > 1 && (
          <div className="stack-sm">
            <p className="muted small" style={{ margin: 0 }}>Added a version by mistake? Move it to the Trash and version {rows.length - 1} becomes the current one again.</p>
            <FormError error={back.error} />
            <Button variant="danger" icon="trash" style={{ justifySelf: "start" }} loading={back.isPending} onClick={() => back.mutate(rows[0].id)}>Move version {rows.length} to Trash</Button>
          </div>
        )}
        <div className="form-actions"><Button variant="primary" onClick={onClose}>Done</Button></div>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------------------------
// Google Drive, the first time
// ---------------------------------------------------------------------------------------------

/**
 * Google's scripts weren't loaded when Import was tapped (on an iPad there's no hover to start them
 * early). Load them here, then a tap of Choose files opens Google's sign-in straight from that tap, as
 * Safari needs for a popup.
 */
export function GoogleReadyDialog({ load, onChoose, onClose }: { load: () => Promise<void>; onChoose: () => void; onClose: () => void }) {
  const ready = useQuery({
    queryKey: ["google-picker"],
    queryFn: async () => {
      await load();
      return true;
    },
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
    meta: { silent: true },
  });
  return (
    <Dialog open onClose={onClose} title="Import from Google Drive" size="sm">
      <div className="dialog-body">
        {ready.isPending && (
          <p className="row" style={{ margin: 0 }} role="status"><Spinner size={16} /> Getting Google Drive ready…</p>
        )}
        {ready.error && <FormError error={ready.error} />}
        {ready.data && <p style={{ margin: 0 }}>Sign in to Google if it asks, then pick the files to copy into Crewtavo, up to 20 at a time.</p>}
        <div className="form-actions">
          <Button onClick={onClose}>Cancel</Button>
          {ready.error ? (
            <Button variant="primary" icon="refresh" onClick={() => ready.refetch()}>Try again</Button>
          ) : (
            <Button variant="primary" disabled={!ready.data} onClick={onChoose}>Choose files</Button>
          )}
        </div>
      </div>
    </Dialog>
  );
}
