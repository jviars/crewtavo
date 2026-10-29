/**
 * The file viewer's working part, loaded the first time a file is opened (FileViewer.tsx is the small
 * entry): the header (name, version, Download, Edit, Close), the file in the viewer for its kind, and
 * editing. Saving an edit adds the file's next version (features/plans/plans.ts addVersion), so the
 * one that was opened stays in its history exactly as it was.
 *
 * PDFs open with pdf.js's viewer (PdfView), Word documents with docx-preview (DocxView) and, to edit,
 * the docx editor (DocxEdit); each is its own download, fetched when first needed.
 */
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useBlocker } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Icon } from "@/components/ui/Icon";
import { StatusPill } from "@/components/ui/StatusPill";
import { addVersion, fileKind, fileSize, PLAN_FIELDS, planLink, type PlanFile } from "@/features/plans/plans";
import { supabase } from "@/lib/api";
import { downloadBlob } from "@/lib/csv";
import { errorMessage, friendlyDbError } from "@/lib/errors";
import { formatDate } from "@/lib/format";
import { toast } from "@/lib/toast";
import type { FileViewerBodyProps } from "./FileViewer";
import { downloadLink, editKind, fetchBytes, previewKind, TEXT_MAX_BYTES, type FileEditor, type ViewerFile } from "./files";
import ImageView from "./ImageView";
import { StageError, StageLoading, StageMessage, ViewerBoundary } from "./ViewerParts";
import styles from "./files.module.css";

const PdfView = lazy(() => import("./PdfView"));
const DocxView = lazy(() => import("./DocxView"));
const DocxEdit = lazy(() => import("./DocxEdit"));

export default function FileViewerBody({ file, canEdit, startEditing = false, onClose, onSaved, blockNavigation = true, onDirtyChange, titleId, closeRef }: FileViewerBodyProps) {
  const queryClient = useQueryClient();
  // The file on screen: the one opened, then each version saved here (whether or not the screen
  // that opened the viewer passes it back in).
  const [current, setCurrent] = useState<ViewerFile>(file);
  const page = useRef(1); // the PDF page in view, kept when switching between viewing and editing
  useEffect(() => {
    if (file.id === current.id) return;
    setCurrent(file);
    page.current = 1;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.id]);

  const kind = previewKind(current);
  // Only the current version can be edited: an older one already has a newer version. An archived
  // file is kept as it is.
  const editable = canEdit && editKind(current) !== null && !current.superseded_at && !current.archived;
  const [editing, setEditing] = useState(startEditing && editable);
  const [dirty, setDirtyState] = useState(false);
  // The same, readable the moment it changes: leaving the screen checks it (LeaveGuard).
  const unsaved = useRef(false);
  // A screen whose own check covers the viewer's changes hears of them straight away, and that
  // there are none once the viewer closes, however it closes.
  const onDirtyRef = useRef(onDirtyChange);
  onDirtyRef.current = onDirtyChange;
  const setDirty = useCallback((value: boolean) => {
    unsaved.current = value;
    setDirtyState(value);
    onDirtyRef.current?.(value);
  }, []);
  useEffect(() => () => onDirtyRef.current?.(false), []);
  const [saving, setSaving] = useState<number | null>(null); // upload progress while saving
  const savingRef = useRef(false);
  const editor = useRef<FileEditor>(null);
  const [attempt, setAttempt] = useState(0);

  // No longer editable (the screen behind changed its mind): leave the editor, but never with
  // unsaved changes in it. Saving those says what changed (a newer version, the Trash) and offers a copy.
  useEffect(() => {
    if (!editable && !unsaved.current) setEditing(false);
  }, [editable]);

  const versions = useVersions(current);
  const bytes = useBytes(current, (kind === "docx" || kind === "text") && !(kind === "text" && (current.size_bytes ?? 0) > TEXT_MAX_BYTES));

  const requestClose = async () => {
    if (savingRef.current) return;
    if (dirty && !(await confirm({ title: "Close without saving?", body: `The changes you made to ${current.title} aren't saved yet. They'll be lost.`, confirmLabel: "Close without saving", cancelLabel: "Keep editing", danger: true }))) return;
    unsaved.current = false;
    onClose();
  };
  useEffect(() => {
    closeRef.current = () => void requestClose();
    return () => {
      closeRef.current = null;
    };
  });

  const stopEditing = async () => {
    if (savingRef.current) return;
    if (dirty && !(await confirm({ title: "Discard your changes?", body: `The changes you made to ${current.title} aren't saved.`, confirmLabel: "Discard changes", danger: true }))) return;
    setDirty(false);
    setEditing(false);
  };

  const startEdit = () => {
    setDirty(false);
    setEditing(true);
  };

  const download = async () => {
    try {
      window.location.href = downloadLink(await planLink(current.path), current.file_name);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  const save = async () => {
    if (savingRef.current || !editor.current || !unsaved.current) return;
    savingRef.current = true;
    setSaving(0);
    let copy: Blob | null = null;
    try {
      copy = await editor.current.save();
      const previous = await latestVersion(current.id);
      const next = await addVersion(current.company_id, previous, copy, current.file_name, (fraction) => setSaving(fraction));
      if (kind === "docx") bytes.keep(next.path, await copy.arrayBuffer());
      for (const key of ["plans", "drive", "field-visit", "storage"]) void queryClient.invalidateQueries({ queryKey: [key] });
      const number = versions.number ? versions.number + 1 : null;
      setDirty(false);
      setEditing(false);
      setCurrent({ ...next, company_id: next.company_id ?? current.company_id });
      toast.success(number ? `Saved as version ${number}` : "Saved as a new version", { description: "The version you opened is kept in the file's history." });
      onSaved?.(next);
    } catch (error) {
      const kept = copy;
      toast.error(errorMessage(error), kept ? { description: "Your changes are still here. You can also download a copy of them.", action: { label: "Download a copy", onClick: () => downloadBlob(current.file_name, kept) }, duration: 15000 } : undefined);
    } finally {
      savingRef.current = false;
      setSaving(null);
    }
  };

  // ⌘S / Ctrl+S saves while editing (the Word editor's own File › Save comes here too).
  useEffect(() => {
    if (!editing) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (dirty) void save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Closing the tab or reloading with unsaved changes asks first.
  useEffect(() => {
    if (!dirty) return;
    const onUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [dirty]);

  const meta = [
    versions.label,
    current.revision?.trim(),
    fileSize(current.size_bytes),
    fileKind(current),
    current.created_at && formatDate(current.created_at),
  ].filter(Boolean).join(" · ");

  const downloadButton = (variant: "secondary" | "primary" = "secondary") => (
    <Button variant={variant} icon="download" onClick={() => void download()} aria-label="Download" title="Download">
      <span className={styles.wide}>Download</span>
    </Button>
  );

  let content: ReactNode;
  if (kind === "pdf") {
    content = (
      <PdfView
        key={`${current.id}:${editing ? "edit" : "view"}`}
        ref={editor}
        file={current}
        editing={editing}
        startPage={page.current}
        onPage={(n) => (page.current = n)}
        onDirty={setDirty}
      />
    );
  } else if (kind === "docx" || kind === "text") {
    if (bytes.error) content = <StageError error={bytes.error} onRetry={bytes.retry} />;
    else if (kind === "text" && ((current.size_bytes ?? 0) > TEXT_MAX_BYTES || (bytes.data?.byteLength ?? 0) > TEXT_MAX_BYTES)) {
      content = (
        <StageMessage icon="file" title="This file is too big to show here" action={downloadButton("primary")}>
          Download it to open it on your device.
        </StageMessage>
      );
    } else if (!bytes.data) content = <StageLoading progress={bytes.progress} />;
    else if (kind === "text") content = <TextView data={bytes.data} />;
    else if (editing) content = <DocxEdit key={current.id} ref={editor} data={bytes.data} title={current.title} onDirty={setDirty} onSave={() => void save()} />;
    else content = <DocxView key={current.id} data={bytes.data} onEscape={() => void requestClose()} />;
  } else if (kind === "image") {
    content = <ImageView key={current.id} file={current} download={downloadButton("primary")} />;
  } else {
    content = (
      <StageMessage icon="file" title="This kind of file can't be shown here" action={downloadButton("primary")}>
        Download it to open it with an app on your device.
      </StageMessage>
    );
  }

  return (
    <>
      <header className={styles.head}>
        <div className={styles.headText}>
          <h2 id={titleId} className={styles.title} title={current.title}>{current.title}</h2>
          <p className={styles.meta}>
            {editing ? (
              <span>Editing. Saving adds a new version; the one you opened stays in the file's history.</span>
            ) : (
              <>
                {current.superseded_at && <StatusPill label="Older version" />}
                <span>{meta}</span>
              </>
            )}
          </p>
        </div>
        <div className={styles.headActions}>
          {editing ? (
            <>
              <Button onClick={() => void stopEditing()} disabled={saving !== null}>Cancel</Button>
              <Button variant="primary" icon="check" loading={saving !== null} disabled={!dirty} onClick={() => void save()}>
                {saving !== null && saving > 0 && saving < 1 ? `Saving ${Math.round(saving * 100)}%` : <span>Save<span className={styles.wide}> as new version</span></span>}
              </Button>
            </>
          ) : (
            <>
              {editable && <Button icon="edit" onClick={startEdit}>Edit</Button>}
              {downloadButton()}
            </>
          )}
          <button type="button" className={`icon-btn ${styles.close}`} aria-label="Close" title="Close" onClick={() => void requestClose()} disabled={saving !== null}>
            <Icon name="x" size={20} />
          </button>
        </div>
      </header>
      <div className={styles.stage}>
        <ViewerBoundary key={`${current.id}:${editing}:${attempt}`} onRetry={() => setAttempt((n) => n + 1)}>
          <Suspense fallback={<StageLoading />}>{content}</Suspense>
        </ViewerBoundary>
      </div>
      {dirty && blockNavigation && <LeaveGuard title={current.title} unsaved={unsaved} />}
    </>
  );
}

/**
 * Going to another screen with unsaved changes asks first (closing the viewer already asked). The
 * router heeds only the newest such check, so a screen with its own passes blockNavigation={false}.
 */
function LeaveGuard({ title, unsaved }: { title: string; unsaved: MutableRefObject<boolean> }) {
  const blocker = useBlocker(({ currentLocation, nextLocation }) => unsaved.current && (currentLocation.pathname !== nextLocation.pathname || currentLocation.search !== nextLocation.search));
  useEffect(() => {
    if (blocker.state !== "blocked") return;
    void confirm({ title: "Leave without saving?", body: `Your changes to ${title} will be lost.`, confirmLabel: "Leave", danger: true }).then((ok) => (ok ? blocker.proceed() : blocker.reset()));
  }, [blocker, title]);
  return null;
}

function TextView({ data }: { data: ArrayBuffer }) {
  const [text] = useState(() => new TextDecoder("utf-8").decode(data));
  return <pre className={styles.text} tabIndex={0}>{text}</pre>;
}

/**
 * The row as it is now, to save the new version against: its current title and who sees it, and a
 * plain answer if it changed while it was being edited.
 */
async function latestVersion(id: string): Promise<PlanFile> {
  const { data, error } = await supabase().from("plan_files").select(PLAN_FIELDS).eq("id", id).maybeSingle();
  if (error) throw friendlyDbError(error);
  const row = data as unknown as PlanFile | null;
  if (!row) throw new Error("This file isn't here anymore. Someone may have moved it to the Trash.");
  if (row.superseded_at) throw new Error("Someone added a newer version of this file while you were editing it.");
  return row;
}

/**
 * "Version 2 of 3" for the header, from the file's whole history (drive_versions). Crews see only
 * the current version, so they get no number rather than a wrong one.
 */
function useVersions(file: ViewerFile): { label: string | null; number: number | null } {
  const query = useQuery({
    // Ids only, so a key of its own: Drive's Versions dialog keeps whole rows under "versions".
    queryKey: ["drive", file.company_id, "version-ids", file.id],
    queryFn: async () => {
      const { data, error } = await supabase().rpc("drive_versions", { p_file: file.id });
      if (error) throw friendlyDbError(error);
      return ((data ?? []) as Array<{ id: string }>).map((row) => row.id);
    },
    staleTime: 60_000,
    retry: false,
    meta: { silent: true },
  });
  const ids = query.data;
  const at = ids?.indexOf(file.id) ?? -1;
  if (!ids || at < 0) return { label: null, number: null };
  const total = ids.length;
  const number = total - at;
  // One version showing but it replaced another: its history is hidden from this person.
  if (total === 1) return { label: null, number: file.replaces_id ? null : 1 };
  return { label: number === total ? `Version ${number}` : `Version ${number} of ${total}`, number };
}

/**
 * A stored file's bytes (Word and text files; PDFs and pictures load from their link). A version
 * saved here is kept so it doesn't download again straight away.
 */
function useBytes(file: ViewerFile, enabled: boolean) {
  const [state, setState] = useState<{ path: string; data?: ArrayBuffer; error?: unknown; progress: number }>({ path: "", progress: 0 });
  const [attempt, setAttempt] = useState(0);
  const kept = useRef<{ path: string; data: ArrayBuffer } | null>(null);

  useEffect(() => {
    if (!enabled) return;
    if (kept.current?.path === file.path) {
      setState({ path: file.path, data: kept.current.data, progress: 1 });
      return;
    }
    const abort = new AbortController();
    setState({ path: file.path, progress: 0 });
    (async () => {
      const link = await planLink(file.path);
      const data = await fetchBytes(link, { signal: abort.signal, onProgress: (progress) => setState((s) => (s.path === file.path && !s.data ? { ...s, progress } : s)) });
      if (!abort.signal.aborted) setState({ path: file.path, data, progress: 1 });
    })().catch((error) => {
      if (!abort.signal.aborted) setState({ path: file.path, error, progress: 0 });
    });
    return () => abort.abort();
  }, [file.path, enabled, attempt]);

  const mine = state.path === file.path;
  return {
    data: mine ? state.data : undefined,
    error: mine ? state.error : undefined,
    progress: mine ? state.progress : 0,
    retry: () => setAttempt((n) => n + 1),
    keep: (path: string, data: ArrayBuffer) => (kept.current = { path, data }),
  };
}
