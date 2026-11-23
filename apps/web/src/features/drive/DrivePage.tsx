/**
 * Crewtavo - Drive: the Files page. Company files is the company's own folders, for what belongs to no
 * client (forms, price sheets, insurance papers); Clients is every file on each client's properties,
 * requests, quotes and jobs; then Recent, Search and the Trash. Drop files anywhere to add them to the
 * folder on screen (big ones go up in pieces), make folders, open any file in the viewer, rename, move,
 * attach to a client's record, upload a new version, choose whether the crew sees it, and move it to
 * the Trash. Import from Google Drive when this Crewtavo has Google set up.
 *
 * Drive is the office's: owners, admins, office staff and estimators. Every screen is fetched after
 * sign-in, so the viewer's editors and Google's scripts load only when they're used.
 *
 * Under the header, how much of the company's storage is used (and the person's own, when they have
 * a limit). Files turned away for space say so in the server's words, with the way to Settings →
 * Storage for those who set the limit.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useDeferredValue, useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent, type ReactNode } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import googleLogo from "@/assets/apps/google.svg";
import { featureOn } from "@/components/shell/nav";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { ContextMenu } from "@/components/ui/ContextMenu";
import { Icon } from "@/components/ui/Icon";
import { InboxGroup, InboxList, InboxRow, ListFoot, MetaLine, RowAge } from "@/components/ui/InboxList";
import { Menu, type MenuEntry } from "@/components/ui/Menu";
import { PageHeader } from "@/components/ui/PageHeader";
import { Section } from "@/components/ui/Section";
import { InboxSkeleton, Skeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState, NoAccess } from "@/components/ui/States";
import { SearchField } from "@/components/ui/Toolbar";
import { editKind, FileViewer, type ViewerFile } from "@/features/files/FileViewer";
import { usePastedFiles } from "@/features/plans/pasteFiles";
import { localPreview, PlanPreview, previewable, previewLink } from "@/features/plans/PlanPreview";
import { preparePicture, shrinksPhotos } from "@/features/plans/pictures";
import { fileSize, planLink, recordPlanFile, storePreview, titleFromFileName, TooLargeError, uploadPlanFile, usePlanLinks } from "@/features/plans/plans";
import { useTooLarge } from "@/features/plans/UploadLimit";
import {
  addEach, companyLine, fullness, managesStorage, personalLine, RefusedForSpace, shareOf, STORAGE_SETTINGS, useStorageFull, useStorageOverview,
} from "@/features/settings/storage";
import { api, supabase, unwrap } from "@/lib/api";
import { errorMessage, StorageFullError } from "@/lib/errors";
import { addressLine } from "@/lib/format";
import { can, hasRole, isSub, useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import {
  driveView, editableInDrive, folderPath, folderTree, groupByDay, groupClientFiles, ICON_FOR, iconKind, placesOf, refreshFiles, savedViewerFile, seesDrive, SLOTS, fileMeta,
  useClientProperties, useDriveClients, useDriveFolders, useDriveList, versionRefused, VIEWER_FIELDS, viewerFile, byName, type DriveFile, type DriveFolder,
  type DriveView, type FolderTree, type Target,
} from "./data";
import { AttachDialog, FolderNameDialog, GoogleReadyDialog, MoveDialog, RenameFileDialog, VersionsDialog, type MoveItem } from "./DriveDialogs";
import { TrashList } from "./DriveTrash";
import styles from "./drive.module.css";
import { forgetGoogleToken, loadGooglePicker, openGooglePicker, type PickedFile } from "./googlePicker";
import { trashFile, trashFolder, undoToast } from "./trash";

/** How many rows a list asks for at a time. */
const PAGE = 200;
/** The most rows drive_list and drive_clients send, however many are asked for: past it, search finds the rest. */
const LIST_MAX = 500;
/** A list's next, longer page, never past what the database sends. */
const longer = (step: number) => (limit: number) => Math.min(limit + step, LIST_MAX);

export function DrivePage() {
  const session = useSession();
  if (!seesDrive(session)) return <NoAccess title="Drive" />;
  if (!featureOn(session.company.settings, "drive")) return <DriveOff />;
  return <DriveBrowser />;
}

/** The Trash, for every file deleted in Crewtavo: open to the whole team, and while Drive isn't installed too. */
export function DriveTrashPage() {
  const session = useSession();
  if (isSub(session)) return <NoAccess title="Trash" />;
  const inDrive = seesDrive(session) && featureOn(session.company.settings, "drive");
  const storage = useStorageOverview(inDrive);
  return (
    <div className={styles.page}>
      <PageHeader title={inDrive ? "Drive" : "Trash"} documentTitle="Trash" lede={inDrive && storage.data ? <StorageLine /> : undefined} />
      {inDrive && <DriveTabs view="trash" />}
      <TrashList />
    </div>
  );
}

/** Drive isn't installed: say so, where to install it for those who can, and the Trash, which works anyway. */
function DriveOff() {
  const session = useSession();
  const canTurnOn = hasRole(session, "admin") && can(session, "apps");
  return (
    <div className={styles.page}>
      <PageHeader title="Drive" />
      <EmptyState
        icon="folder"
        title="Drive is off"
        action={
          <>
            {canTurnOn && <Link className="btn btn-primary" to="/apps/drive">Install Drive</Link>}
            <Link className="btn" to="/drive/trash"><Icon name="trash" size={16} />Open the Trash</Link>
          </>
        }
      >
        {canTurnOn
          ? "All your files in one place: folders for your company's own papers, every file on each client and job, versions, and a 30-day Trash."
          : "Ask an owner or admin to install Drive from Apps."}
      </EmptyState>
      {/* A file found with search still opens. */}
      <ViewerHost />
    </div>
  );
}

const TABS: Array<{ view: DriveView | "trash"; label: string }> = [
  { view: "company", label: "Company files" },
  { view: "clients", label: "Clients" },
  { view: "recent", label: "Recent" },
  { view: "search", label: "Search" },
  { view: "trash", label: "Trash" },
];

/** Drive's sections as links (Page-Drive.dc.html): underlined words on a computer, chips that scroll on a phone. Search shows only while searching. */
function DriveTabs({ view, query = "" }: { view: DriveView | "trash"; query?: string }) {
  const href = (to: DriveView | "trash") =>
    to === "trash" ? "/drive/trash" : to === "company" ? "/drive" : to === "search" ? `/drive?${new URLSearchParams({ view: "search", q: query })}` : `/drive?view=${to}`;
  return (
    <nav className={`underline-tabs ${styles.tabs}`} aria-label="Drive">
      {TABS.filter((t) => t.view !== "search" || view === "search").map((t) => (
        <Link key={t.view} to={href(t.view)} aria-current={view === t.view ? "page" : undefined}>
          {t.label}
        </Link>
      ))}
    </nav>
  );
}

// ---------------------------------------------------------------------------------------------
// The viewer, opened by ?file= (so Back closes it, and search can link to a file)
// ---------------------------------------------------------------------------------------------

function useFileParam() {
  const [, setParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const open = (id: string, options: { edit?: boolean; replace?: boolean } = {}) =>
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        next.set("file", id);
        if (options.edit) next.set("edit", "1");
        else next.delete("edit");
        return next;
      },
      // Only an entry this page added says so: replacing one (a save) keeps what it had, so a viewer
      // opened from a link or search still closes to the list rather than going back a page.
      { replace: options.replace, state: options.replace ? location.state : { driveViewer: true } },
    );
  const close = () => {
    // Opened from this page: going back closes it, so Back doesn't open it again.
    if ((location.state as { driveViewer?: boolean } | null)?.driveViewer) return navigate(-1);
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        next.delete("file");
        next.delete("edit");
        return next;
      },
      { replace: true },
    );
  };
  return { open, close };
}

/** The file the viewer has open, as it opened. */
interface Opened {
  /** The file on screen (?file= is its id). */
  file: ViewerFile;
  /** The viewer's own key: the id it first opened, kept across its saves so it stays open on each new version. */
  key: string;
  /** Decided when it opens, not on every refetch: see ViewerHost. */
  canEdit: boolean;
}

/**
 * The viewer for ?file=. The row is read once to open it; what happens to the file while it's open
 * (another version added, a move to the Trash, a refetch that fails) never takes it out from under
 * an edit. Edit stays as it was when it opened, saving says what changed (and offers a copy), and a
 * file moved to the Trash closes through the viewer's own Close, which asks about unsaved changes.
 */
function ViewerHost() {
  const session = useSession();
  const queryClient = useQueryClient();
  const [params] = useSearchParams();
  const { open, close } = useFileParam();
  const id = params.get("file");
  const file = useQuery({
    queryKey: ["drive", session.company.id, "file", id],
    enabled: Boolean(id),
    meta: { silent: true },
    queryFn: async () => unwrap(await supabase().from("plan_files").select(VIEWER_FIELDS).eq("id", id!).eq("company_id", session.company.id).maybeSingle()) as ViewerFile | null,
  });
  const [opened, setOpened] = useState<Opened | null>(null);
  // The version the viewer just saved: it opens in the same viewer.
  const savedInto = useRef<string | null>(null);
  const closeRequest = useRef<(() => void) | null>(null);

  const row = file.data && file.data.id === id ? file.data : null;
  if (!id) {
    if (opened) setOpened(null);
  } else if (row && opened?.file.id !== id) {
    const saved = opened && savedInto.current === id ? opened : null;
    // Only the current version of a file that isn't archived: an older one is kept as it was.
    setOpened({ file: row, key: saved?.key ?? id, canEdit: saved?.canEdit ?? editableInDrive(row) });
  }
  const showing = Boolean(id) && opened?.file.id === id;

  // Loaded, and not there: deleted (or another company's), or moved to the Trash while it's open. A
  // first load that failed says why; a refetch that fails while it's open changes nothing.
  const gone = Boolean(id) && file.data === null;
  const failed = Boolean(id) && file.data === undefined && file.isError;
  useEffect(() => {
    if (gone && showing) {
      toast.error("That file isn't here anymore", { description: "Someone may have moved it to the Trash." });
      (closeRequest.current ?? close)();
    } else if (gone || failed) {
      toast.error(gone ? "That file isn't here" : "Couldn't open that file", { description: gone ? "It may have been moved to the Trash." : errorMessage(file.error) });
      close();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gone, failed]);

  if (!showing || !opened) return null;
  return (
    <FileViewer
      key={opened.key}
      file={opened.file}
      canEdit={opened.canEdit}
      startEditing={params.get("edit") === "1"}
      closeRequest={closeRequest}
      onClose={close}
      onSaved={(next) => {
        const saved = savedViewerFile(session.company.id, next);
        refreshFiles(queryClient);
        // Already loaded, so the viewer stays open on the new version rather than loading it again.
        queryClient.setQueryData(["drive", session.company.id, "file", saved.id], saved);
        savedInto.current = saved.id;
        open(saved.id, { replace: true });
      }}
    />
  );
}

// ---------------------------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------------------------

/** A place new files can go, as the page offers it: a folder, or one of a client's properties. */
interface Destination {
  key: string;
  target: Target;
  /** "Forms", "Company files", "14 Oak St". */
  where: string;
}

interface Sending {
  key: string;
  name: string;
  /** The file's type, when it's known (not for a copy from Google Drive). */
  type: string | null;
  /** A picture's own link on this device, shown as it goes (revoked once it's done). */
  preview: string | null;
  size: number | null;
  /** 0 to 1; null while copying from Google Drive (no way to tell how far along). */
  progress: number | null;
  stopping?: boolean;
  abort: () => void;
}

type DialogState =
  | { kind: "folder"; folder?: DriveFolder; parent?: DriveFolder }
  | { kind: "rename"; file: DriveFile }
  | { kind: "move"; item: MoveItem }
  | { kind: "attach"; file: DriveFile }
  | { kind: "versions"; file: DriveFile }
  | null;

type DropProps = { onDragOver?: (e: DragEvent) => void; onDragLeave?: (e: DragEvent) => void; onDrop?: (e: DragEvent) => void };

/** What the lists below the page need from it. */
interface DriveActions {
  tree: FolderTree;
  /** Opens a listed file in the viewer, straight away (the list already has what it needs). */
  openFile: (f: DriveFile) => void;
  openFolder: (id: string | null) => void;
  fileMenu: (f: DriveFile) => MenuEntry[];
  folderMenu: (f: DriveFolder) => MenuEntry[];
  /** Drop files here to add them there. */
  dropProps: (zone: string, to: Destination | null) => DropProps;
  dropOn: string | null;
  upload: (to: Destination) => void;
  newFolder: (parent: DriveFolder) => void;
  importFrom: ((to: Destination) => void) | null;
  preloadGoogle: () => void;
}
const Actions = createContext<DriveActions | null>(null);
const useActions = () => useContext(Actions)!;

const folderLabel = (f: DriveFolder) => (f.parent_id ? f.name : "Company files");
const propertyLabel = (p: { label: string | null; line1: string | null; city?: string | null; region?: string | null; postal_code?: string | null }) =>
  [p.label?.trim(), p.line1 ?? addressLine(p)].filter(Boolean).join(" · ") || "A property";

function DriveBrowser() {
  const session = useSession();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const view = driveView(params);
  const folderParam = params.get("folder");
  const clientParam = view === "clients" ? params.get("client") : null;
  const q = view === "search" ? (params.get("q") ?? "") : "";
  const folders = useDriveFolders(session.company.id);
  const tree = useMemo(() => folderTree(folders.data ?? []), [folders.data]);
  const root = tree.root;
  const current = view === "company" ? (folderParam ? (tree.byId.get(folderParam) ?? null) : root) : null;
  const properties = useClientProperties(clientParam);
  const { open: openFileParam } = useFileParam();
  const tooLarge = useTooLarge();
  const storageFull = useStorageFull();
  const storage = useStorageOverview();
  const googleKeys = session.config.googlePicker ?? null;
  const [sending, setSending] = useState<Sending[]>([]);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [googleFor, setGoogleFor] = useState<Destination | null>(null);
  const [dropOn, setDropOn] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const pickFor = useRef<{ to: Destination | null; replaces: DriveFile | null } | null>(null);

  // ----- Search, kept in the address (?view=search&q=) -----------------------------------------
  const [search, setSearch] = useState(q);
  const typed = useDeferredValue(search.trim());
  const wrote = useRef(q);
  useEffect(() => {
    // Back and Forward change the search: show it in the box.
    if (q !== wrote.current) setSearch(q);
    wrote.current = q;
  }, [q]);
  useEffect(() => {
    if (typed === q) return;
    wrote.current = typed;
    setParams(typed ? { view: "search", q: typed } : {}, { replace: view === "search" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typed]);

  // ----- Where new files go ---------------------------------------------------------------------
  const destinations: Destination[] =
    view === "company"
      ? current
        ? [{ key: current.id, target: { folder_id: current.id }, where: folderLabel(current) }]
        : []
      : view === "clients"
        ? clientParam
          ? (properties.data ?? []).map((p) => ({ key: p.id, target: { property_id: p.id }, where: propertyLabel(p) }))
          : []
        : root
          ? [{ key: root.id, target: { folder_id: root.id }, where: "Company files" }]
          : [];
  const single = destinations.length === 1 ? destinations[0] : null;

  // ----- Adding files ---------------------------------------------------------------------------
  const remove = (key: string) => setSending((s) => s.filter((u) => u.key !== key));
  async function send(list: File[], to: Destination | null, replaces: DriveFile | null = null) {
    const shrink = shrinksPhotos(session.company.settings);
    const { added, refused } = await addEach(
      list,
      async (picked) => {
        const key = crypto.randomUUID();
        const preview = localPreview(picked);
        // Stop before it's sending: it isn't sent at all.
        let stopped = false;
        let abort = () => {
          stopped = true;
        };
        setSending((s) => [...s, { key, name: picked.name, type: picked.type || null, preview, size: picked.size, progress: 0, abort: () => abort() }]);
        try {
          // A camera's big photo made smaller before it's sent, so the size limits apply to what's sent.
          const prepared = await preparePicture(picked, shrink);
          if (stopped) throw new DOMException("Stopped", "AbortError");
          const file = prepared.file;
          if (file !== picked) setSending((s) => s.map((u) => (u.key === key ? { ...u, name: file.name, size: file.size } : u)));
          const upload = uploadPlanFile(session.company.id, file, (progress) => setSending((s) => s.map((u) => (u.key === key ? { ...u, progress } : u))));
          abort = upload.abort;
          const path = await upload.promise;
          const { error } = await recordPlanFile(
            {
              company_id: session.company.id,
              // A new version takes its place from the one before (the database copies it).
              ...(replaces ? {} : to?.target),
              replaces_id: replaces?.id ?? null,
              title: replaces?.title ?? titleFromFileName(file.name),
              path,
              file_name: file.name.slice(0, 255),
              content_type: (file.type || null)?.slice(0, 150) ?? null,
              size_bytes: file.size,
              // A company file is the office's until someone shows it to the crew.
              crew_visible: replaces?.crew_visible ?? !(to && "folder_id" in to.target),
            },
            await storePreview(path, prepared.preview),
          );
          // "Someone added a newer version meanwhile" in the database's words, not "That already exists."
          // A row that isn't saved leaves its stored file behind; the server tidies those away after a day.
          if (error) throw versionRefused(error);
        } finally {
          remove(key);
          if (preview) URL.revokeObjectURL(preview);
        }
      },
      (file, error) => {
        if (error instanceof TooLargeError) tooLarge.report(error);
        else toast.error(`${file.name} wasn't added`, { description: errorMessage(error) });
      },
    );
    refreshFiles(queryClient);
    // Those refused for space, in one toast: the server's sentence for the first, with the way to more room.
    if (refused.first) storageFull(refused.first, refused.title("added"));
    if (!added) return;
    if (replaces) toast.success(`New version of ${replaces.title} added`, { description: "It's the current one now. The older ones are under Versions." });
    else toast.success(added === 1 ? "File added" : `${added} files added`, to ? { description: `In ${to.where}.` } : undefined);
  }
  const pick = (to: Destination | null, replaces: DriveFile | null = null) => {
    pickFor.current = { to, replaces };
    picker.current?.click();
  };
  // A paste on the page (a screenshot, say) goes where Upload would; with a client's several properties, nowhere: which one?
  usePastedFiles(pageRef, single ? (list) => void send(list, single) : null);

  // ----- Copying from Google Drive --------------------------------------------------------------
  async function importFiles(files: PickedFile[], accessToken: string, to: Destination) {
    let added = 0;
    const skipped: Array<{ name: string; reason: string }> = [];
    // Turned away for space: the server checks each file on its own, so the rest are still copied (a
    // smaller one may fit), and those refused are said once at the end, with the way to more room.
    const refused = new RefusedForSpace();
    const run = { stopped: false };
    // One file a request: a big one can take a while, and each shows as it lands.
    for (const file of files) {
      if (run.stopped) break;
      const key = crypto.randomUUID();
      const stop = () => {
        run.stopped = true;
        setSending((s) => s.map((u) => (u.key === key ? { ...u, stopping: true } : u)));
      };
      const name = file.name ?? "A file from Google Drive";
      setSending((s) => [...s, { key, name, type: null, preview: null, size: null, progress: null, abort: stop }]);
      try {
        // `full`: a storage limit refused it, in the server's sentence.
        const res = await api.post<{ files: unknown[]; skipped: Array<{ name: string; reason: string; full?: boolean }> }>("/drive/import", { accessToken, files: [file], target: to.target });
        added += res.files.length;
        for (const s of res.skipped) {
          if (s.full) refused.add(new StorageFullError(s.reason), s.name);
          else skipped.push({ name: s.name, reason: s.reason });
        }
      } catch (error) {
        if (refused.add(error, name)) continue;
        // Google may have turned the sign-in down: the next import asks for a new one.
        forgetGoogleToken();
        toast.error("Copying from Google Drive stopped", { description: errorMessage(error) });
        break;
      } finally {
        remove(key);
      }
    }
    refreshFiles(queryClient);
    if (added) toast.success(added === 1 ? "Copied 1 file from Google Drive" : `Copied ${added} files from Google Drive`, { description: `In ${to.where}.` });
    if (refused.first) storageFull(refused.first, refused.title("copied"));
    if (skipped.length === 1) toast.error(`${skipped[0].name} wasn't copied`, { description: skipped[0].reason });
    else if (skipped.length > 1) {
      const listed = skipped.slice(0, 3).map((s) => `${s.name}: ${s.reason}`).join(" ");
      toast.error(`${skipped.length} files weren't copied`, { description: skipped.length > 3 ? `${listed} And ${skipped.length - 3} more.` : listed });
    }
  }
  const preloadGoogle = () => {
    if (googleKeys) loadGooglePicker().catch(() => undefined);
  };
  // Straight from the tap: Safari opens Google's sign-in only then.
  const importFrom = (to: Destination) => {
    if (!googleKeys) return;
    const opened = openGooglePicker(googleKeys, { picked: (files, token) => void importFiles(files, token, to), failed: (message) => toast.error(message) });
    if (!opened) setGoogleFor(to);
  };

  // ----- Changing files and folders -------------------------------------------------------------
  const crew = useMutation({
    mutationFn: async (f: DriveFile) => {
      unwrap(await supabase().from("plan_files").update({ crew_visible: !f.crew_visible }).eq("id", f.id).select("id").single());
      return f;
    },
    meta: { success: (f: DriveFile) => (f.crew_visible ? "Office only now. Crews don't see it." : "The crew can see it now") },
    onSuccess: () => refreshFiles(queryClient),
  });
  const trash = useMutation({
    mutationFn: (f: DriveFile) => trashFile(f.id),
    onSuccess: (_, f) => {
      refreshFiles(queryClient);
      undoToast(`${f.title} moved to Trash`, "file", f.id, () => refreshFiles(queryClient));
    },
  });
  const trashDir = useMutation({
    mutationFn: (f: DriveFolder) => trashFolder(f.id),
    onSuccess: (_, f) => {
      refreshFiles(queryClient);
      undoToast(`${f.name} moved to Trash`, "folder", f.id, () => refreshFiles(queryClient));
    },
  });
  const askTrashFolder = async (f: DriveFolder) => {
    const ok = await confirm({
      title: `Move ${f.name} to Trash?`,
      body: "Everything in it goes too, folders and files. It stays in the Trash for 30 days, and you can put it all back from there.",
      confirmLabel: "Move to Trash",
      danger: true,
    });
    if (ok) trashDir.mutate(f);
  };
  const download = async (f: { path: string; file_name: string }) => {
    try {
      const url = await planLink(f.path);
      window.location.href = `${url}${url.includes("?") ? "&" : "?"}download=${encodeURIComponent(f.file_name)}`;
    } catch (error) {
      toast.error("Couldn't download it", { description: errorMessage(error) });
    }
  };

  const openFolder = (id: string | null) => navigate(id && id !== root?.id ? `/drive?folder=${id}` : "/drive");
  const openFile = (f: DriveFile, edit = false) => {
    queryClient.setQueryData(["drive", session.company.id, "file", f.id], viewerFile(session.company.id, f));
    openFileParam(f.id, { edit });
  };
  const fileMenu = (f: DriveFile): MenuEntry[] => {
    const onRecord = SLOTS.some((s) => f[s]);
    return [
      { label: "Open", icon: "arrowUpRight", kbd: "O", onSelect: () => openFile(f) },
      // An archived file is kept as it is (as on a job's Plans and files card): no edit, no new version.
      { label: "Edit", icon: "pen", kbd: "E", hidden: f.archived || !editKind(f), onSelect: () => openFile(f, true) },
      { label: "Download", icon: "download", kbd: "D", onSelect: () => void download(f) },
      { separator: true },
      { label: "Rename", icon: "edit", kbd: "R", onSelect: () => setDialog({ kind: "rename", file: f }) },
      { label: f.folder_id ? "Move to folder…" : "Put in a folder…", icon: "folderMove", kbd: "M", hidden: !root, onSelect: () => setDialog({ kind: "move", item: { kind: "file", file: f } }) },
      { label: "Attach to…", icon: "paperclip", onSelect: () => setDialog({ kind: "attach", file: f }) },
      { label: "Upload a new version", icon: "upload", hidden: f.archived, onSelect: () => pick(null, f) },
      { label: "Versions", icon: "history", end: String(f.versions), hidden: f.versions < 2, onSelect: () => setDialog({ kind: "versions", file: f }) },
      // Crews see files on their jobs; a file in a folder only is the office's (attaching it asks).
      { label: f.crew_visible ? "Make it office only" : "Show it to the crew", icon: f.crew_visible ? "lock" : "users", hidden: !onRecord && !f.crew_visible, onSelect: () => crew.mutate(f) },
      { separator: true },
      { label: "Move to Trash", icon: "trash", danger: true, onSelect: () => trash.mutate(f) },
    ];
  };
  const folderMenu = (f: DriveFolder): MenuEntry[] => [
    { label: "Open", icon: "folderOpen", kbd: "O", onSelect: () => openFolder(f.id) },
    { label: "Rename", icon: "edit", kbd: "R", onSelect: () => setDialog({ kind: "folder", folder: f }) },
    { label: "Move to folder…", icon: "folderMove", kbd: "M", onSelect: () => setDialog({ kind: "move", item: { kind: "folder", folder: f } }) },
    { separator: true },
    { label: "Move to Trash", icon: "trash", danger: true, onSelect: () => void askTrashFolder(f) },
  ];

  // ----- Dropping files -------------------------------------------------------------------------
  const dropProps = (zone: string, to: Destination | null): DropProps =>
    to
      ? {
          onDragOver: (e) => {
            if (!e.dataTransfer.types.includes("Files")) return;
            e.preventDefault();
            e.stopPropagation();
            setDropOn(zone);
          },
          onDragLeave: (e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropOn((z) => (z === zone ? null : z));
          },
          onDrop: (e) => {
            e.preventDefault();
            e.stopPropagation();
            setDropOn(null);
            const list = [...e.dataTransfer.files];
            if (list.length) void send(list, to);
          },
        }
      : {};
  const dropping = dropOn ? (dropOn === "page" ? single : null) : null;

  const actions: DriveActions = {
    tree,
    openFile: (f) => openFile(f),
    openFolder,
    fileMenu,
    folderMenu,
    dropProps,
    dropOn,
    upload: (to) => pick(to),
    newFolder: (parent) => setDialog({ kind: "folder", parent }),
    importFrom: googleKeys ? importFrom : null,
    preloadGoogle,
  };

  // ----- Header ---------------------------------------------------------------------------------
  const googleLabel = (
    <>
      <img src={googleLogo} alt="" width={16} height={16} />
      Import<span className="hide-mobile">from Google Drive</span>
    </>
  );
  const headerActions = (
    <>
      {googleKeys && single && (
        <button type="button" className="btn" onPointerEnter={preloadGoogle} onFocus={preloadGoogle} onClick={() => importFrom(single)} title="Import from Google Drive">
          {googleLabel}
        </button>
      )}
      {googleKeys && destinations.length > 1 && (
        <span onPointerEnter={preloadGoogle} onFocus={preloadGoogle}>
          <Menu label="Import from Google Drive to which property?" title="Import to which property?" triggerClassName="btn" trigger={googleLabel} items={[{ heading: "To which property?" }, ...destinations.map((d) => ({ label: d.where, icon: "pin" as const, onSelect: () => importFrom(d) }))]} />
        </span>
      )}
      {view === "company" && current && <Button icon="folderPlus" onClick={() => setDialog({ kind: "folder", parent: current })}>New folder</Button>}
      {single && <Button variant="primary" icon="upload" onClick={() => pick(single)}>Upload</Button>}
      {destinations.length > 1 && (
        <Menu
          label="Upload to which property?"
          title="Upload to which property?"
          triggerClassName="btn btn-primary"
          trigger={<><Icon name="upload" size={16} />Upload</>}
          items={[{ heading: "To which property?" }, ...destinations.map((d) => ({ label: d.where, icon: "pin" as const, onSelect: () => pick(d) }))]}
        />
      )}
    </>
  );
  // Clients with files, found by name (Clients).
  const [findClient, setFindClient] = useState("");
  // The search over every file, on the right of the row under the sections (on a phone, over them).
  const searchBox = <SearchField value={search} onChange={setSearch} placeholder="Search every file" label="Search every file" />;

  return (
    <Actions.Provider value={actions}>
      <div ref={pageRef} className={styles.page} {...(view === "company" || view === "recent" || view === "search" ? dropProps("page", single) : {})}>
        <PageHeader title="Drive" actions={headerActions} lede={storage.data ? <StorageLine /> : undefined} />
        <DriveTabs view={view} query={q} />
        {/* One row for every view, so the search keeps its place (and its focus) as typing moves to the results. */}
        <Bar search={searchBox}>
          {view === "company" && current && <FolderCrumbs current={current} />}
          {view === "clients" && (clientParam ? <ClientCrumb clientId={clientParam} /> : <SearchField value={findClient} onChange={setFindClient} placeholder="Find a client" label="Find a client" shortcut={false} />)}
        </Bar>
        <Uploads sending={sending} />
        {folders.error && !folders.data ? (
          <ErrorState error={folders.error} onRetry={() => folders.refetch()} />
        ) : view === "company" ? (
          <CompanyFiles key={folderParam ?? "root"} folderId={folderParam} loading={folders.isPending} dropping={dropOn === "page"} />
        ) : view === "clients" ? (
          clientParam ? <ClientFiles key={clientParam} clientId={clientParam} /> : <ClientList find={findClient} onClear={() => setFindClient("")} />
        ) : view === "recent" ? (
          <FileList scope="recent" dropping={dropOn === "page"} />
        ) : (
          <SearchResults query={q} dropping={dropOn === "page"} />
        )}
        {dropping && (
          <div className={styles.dropBanner} aria-hidden="true">
            <Icon name="upload" size={16} />
            <span>Drop to add to {dropping.where}</span>
          </div>
        )}
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
            void send(ask.replaces ? list.slice(0, 1) : list, ask.to, ask.replaces);
          }}
        />
      </div>

      {dialog?.kind === "folder" && <FolderNameDialog folder={dialog.folder} parent={dialog.parent} onClose={() => setDialog(null)} />}
      {dialog?.kind === "rename" && <RenameFileDialog file={dialog.file} onClose={() => setDialog(null)} />}
      {dialog?.kind === "move" && <MoveDialog item={dialog.item} tree={tree} onClose={() => setDialog(null)} />}
      {dialog?.kind === "attach" && <AttachDialog file={dialog.file} rootId={root?.id ?? null} onClose={() => setDialog(null)} />}
      {dialog?.kind === "versions" && (
        <VersionsDialog
          file={dialog.file}
          onOpen={(id) => {
            setDialog(null);
            openFileParam(id);
          }}
          onDownload={(f) => void download(f)}
          onClose={() => setDialog(null)}
        />
      )}
      {googleFor && googleKeys && (
        <GoogleReadyDialog
          load={loadGooglePicker}
          onChoose={() => {
            const to = googleFor;
            setGoogleFor(null);
            importFrom(to);
          }}
          onClose={() => setGoogleFor(null)}
        />
      )}
      <ViewerHost />
      {tooLarge.dialog}
    </Actions.Provider>
  );
}

/**
 * How much of the company's storage is used, against its limit; the person's own, when they have a
 * limit; and the way to Settings → Storage for those who set it. Nothing when it can't be read.
 */
function StorageLine() {
  const session = useSession();
  const storage = useStorageOverview();
  if (!storage.data) return null;
  const o = storage.data;
  const share = shareOf(o.used_bytes, o.limit_bytes);
  const level = fullness(share);
  const mine = personalLine(o.me);
  return (
    <span className={styles.storage}>
      {share !== null && (
        <span className={styles.storageBar} data-level={level} role="img" aria-label={`${Math.floor(share * 100)}% of the storage limit used`}>
          <span style={{ width: `${Math.min(100, share * 100)}%` }} />
        </span>
      )}
      <span data-level={level}>{level === "full" ? `Storage is full: ${companyLine(o)}` : companyLine(o)}</span>
      {mine && <span data-level={fullness(shareOf(o.me.used_bytes, o.me.limit_bytes))}>{mine}</span>}
      {managesStorage(session) && <Link to={STORAGE_SETTINGS}>Storage settings</Link>}
    </span>
  );
}

/**
 * The row under the sections: where you are on the left (a folder's path, a client), the search over
 * every file on the right. On a phone its two halves take their own places: the search over the
 * sections, where you are under them.
 */
function Bar({ children, search }: { children?: ReactNode; search: ReactNode }) {
  return (
    <div className={styles.bar}>
      <div className={styles.barStart}>{children}</div>
      {search}
    </div>
  );
}

/** A client's name, as Drive's Clients view reads it (shared by its crumb and its list). */
function useDriveClient(clientId: string) {
  const session = useSession();
  return useQuery({
    queryKey: ["drive", session.company.id, "client", clientId],
    queryFn: async () => unwrap(await supabase().from("clients").select("id, display_name").eq("id", clientId).maybeSingle()),
  });
}

/** Where a folder is in Company files: each folder above it a link back up. At the top, just "Company files" (not on a phone, where the chip says it). */
function FolderCrumbs({ current }: { current: DriveFolder }) {
  const a = useActions();
  const path = folderPath(a.tree, current.id);
  return (
    <nav aria-label="Folder" className={current.parent_id ? undefined : styles.atRoot}>
      <ol className={styles.crumbs}>
        {path.map((f, i) => (
          <li key={f.id}>
            {i > 0 && <Icon name="chevronRight" size={13} />}
            {i === path.length - 1 ? <span aria-current="page">{folderLabel(f)}</span> : <Link to={f.parent_id ? `/drive?folder=${f.id}` : "/drive"}>{folderLabel(f)}</Link>}
          </li>
        ))}
      </ol>
    </nav>
  );
}

/** Clients › a client's name, and the way to their page. */
function ClientCrumb({ clientId }: { clientId: string }) {
  const client = useDriveClient(clientId);
  return (
    <>
      <nav aria-label="Client">
        <ol className={styles.crumbs}>
          <li><Link to="/drive?view=clients">Clients</Link></li>
          <li><Icon name="chevronRight" size={13} /><span aria-current="page">{client.isPending ? <Skeleton width={120} /> : (client.data?.display_name ?? "Client")}</span></li>
        </ol>
      </nav>
      <Link className={styles.openClient} to={`/clients/${clientId}`}>Open client<Icon name="arrowRight" size={13} /></Link>
    </>
  );
}

/** Files on their way up, or being copied from Google Drive, each with a way to stop it. */
function Uploads({ sending }: { sending: Sending[] }) {
  if (!sending.length) return null;
  return (
    <ul className={styles.uploads} aria-label="Adding files">
      {sending.map((u) => {
        const copying = u.progress === null;
        const status = copying ? (u.stopping ? "Stopping after this one…" : "Copying from Google Drive…") : u.progress! >= 1 ? "Saving…" : `${Math.round(u.progress! * 100)}% of ${fileSize(u.size)}`;
        return (
          <li key={u.key} className={styles.upload} role="status">
            <FileIcon file={{ content_type: u.type, file_name: u.name }} preview={u.preview ?? undefined} />
            <div className={styles.uploadBody}>
              <div className={styles.uploadHead}>
                <span title={u.name}>{u.name}</span>
                <span className={styles.uploadStatus}>{status}</span>
              </div>
              <div className={`progress${copying ? ` ${styles.indeterminate}` : ""}`} aria-hidden="true">
                <span style={copying ? undefined : { width: `${Math.round(u.progress! * 100)}%` }} />
              </div>
            </div>
            {(copying ? !u.stopping : u.progress! < 1) ? (
              <Button size="sm" variant="ghost" icon="x" aria-label={copying ? `Stop copying after ${u.name}` : `Stop uploading ${u.name}`} title="Stop" onClick={u.abort} />
            ) : (
              <span />
            )}
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------------------------

/** A file's kind as an icon on a small tile, or a picture's preview (`preview`, a link to it) once it has loaded. */
function FileIcon({ file, preview }: { file: Pick<DriveFile, "content_type" | "file_name">; preview?: string }) {
  const kind = iconKind(file);
  return (
    <span className={styles.icon} data-kind={kind} aria-hidden="true">
      <Icon name={ICON_FOR[kind]} size={17} />
      {preview && <PlanPreview src={preview} />}
    </span>
  );
}

/** Opened with the keyboard or a plain click: the viewer, here. With a modifier key, the browser's own way (a new tab). */
const plainClick = (e: MouseEvent) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

/**
 * Folders, then files, as rows (Page-Drive.dc.html): each opens with a tap or Enter, and has its menu
 * at the end. `where` adds the column saying where each file is. `heads` puts "Folders" and "Files"
 * over them, as a folder's own list does.
 */
function FileRows({ folders = [], files, where, label, heads = false }: { folders?: DriveFolder[]; files: DriveFile[]; where: "records" | "all" | null; label: string; heads?: boolean }) {
  // Links for the pictures' previews (the rest make theirs when they're opened or downloaded).
  const links = usePlanLinks(previewable(files));
  const folderRows = folders.map((f) => <FolderRow key={f.id} folder={f} where={Boolean(where)} />);
  const fileRows = files.map((f) => <FileRow key={f.id} file={f} where={where} preview={previewLink(f, links.data?.open)} />);
  if (!heads) return <InboxGroup>{folderRows}{fileRows}</InboxGroup>;
  return (
    <>
      {folders.length > 0 && <InboxGroup label="Folders" count={folders.length}>{folderRows}</InboxGroup>}
      {files.length > 0 && <InboxGroup label={label} count={files.length}>{fileRows}</InboxGroup>}
    </>
  );
}

/** The address that opens a file in the viewer, from where the list is. */
function useFileHref() {
  const location = useLocation();
  return (id: string) => {
    const next = new URLSearchParams(location.search);
    next.set("file", id);
    next.delete("edit");
    return `${location.pathname}?${next}`;
  };
}

function FolderRow({ folder, where }: { folder: DriveFolder; where: boolean }) {
  const a = useActions();
  const inside = a.tree.children.get(folder.id)?.length ?? 0;
  const zone = `folder:${folder.id}`;
  return (
    <ContextMenu render={<li />} items={a.folderMenu(folder)} className={`${styles.row}${where ? "" : ` ${styles.rowNoWhere}`}`} data-drop={a.dropOn === zone || undefined} {...a.dropProps(zone, { key: folder.id, target: { folder_id: folder.id }, where: folder.name })}>
      <span className={styles.icon} data-kind="folder" aria-hidden="true"><Icon name="folder" size={17} /></span>
      <div className={styles.rowBody}>
        <Link className="il-link" to={folder.parent_id ? `/drive?folder=${folder.id}` : "/drive"}>
          <span className="il-l1"><span className="il-title">{folder.name}</span></span>
        </Link>
        <MetaLine className="il-meta" parts={["Folder", inside ? `${inside} ${inside === 1 ? "folder" : "folders"} inside` : null]} />
      </div>
      {where && <span className={styles.where} />}
      <span className={styles.more}>
        <Menu triggerClassName="btn btn-sm btn-ghost btn-icon" label={`Actions for ${folder.name}`} title={folder.name} align="end" items={a.folderMenu(folder)} />
      </span>
    </ContextMenu>
  );
}

function FileRow({ file: f, where, preview }: { file: DriveFile; where: "records" | "all" | null; preview?: string }) {
  const a = useActions();
  const href = useFileHref();
  const onRecord = SLOTS.some((s) => f[s]);
  const places = placesOf(f);
  const folder = f.folder_id ? a.tree.byId.get(f.folder_id) : undefined;
  const showFolder = where === "all" && Boolean(f.folder_id);
  // Who sees it, and whether it's kept as it was: by the name on a computer, on the quiet line on a phone (Mobile-Business.dc.html), first so a long line cuts the date instead.
  const tags = [onRecord && !f.crew_visible && "Office only", !onRecord && f.crew_visible && "Crew leads see it", f.archived && "Archived"].filter((x): x is string => Boolean(x));
  return (
    <ContextMenu render={<li />} items={a.fileMenu(f)} className={`${styles.row}${where ? "" : ` ${styles.rowNoWhere}`}`}>
      <FileIcon file={f} preview={preview} />
      <div className={styles.rowBody}>
        <Link
          className="il-link"
          to={href(f.id)}
          state={{ driveViewer: true }}
          onClick={(e) => {
            if (!plainClick(e)) return;
            e.preventDefault();
            a.openFile(f);
          }}
        >
          <span className="il-l1">
            <span className="il-title">{f.title}</span>
            {tags.map((tag) => <span key={tag} className="tag">{tag}</span>)}
          </span>
        </Link>
        <MetaLine className="il-meta" parts={[...tags.map((tag) => <span key={tag} className={styles.metaTag}>{tag}</span>), fileMeta(f)]} />
      </div>
      {where && (
        <span className={styles.where}>
          {showFolder && (
            <Link to={folder?.parent_id ? `/drive?folder=${f.folder_id}` : "/drive"} title={folder ? folderPath(a.tree, folder.id).map(folderLabel).join(" › ") : undefined}>
              {folder ? folderLabel(folder) : (f.folder_name ?? "Company files")}
            </Link>
          )}
          {places.map((p) => (p.path ? <Link key={p.slot} to={p.path} title={p.label}>{p.label}</Link> : <span key={p.slot} title={p.label}>{p.label}</span>))}
        </span>
      )}
      <span className={styles.more}>
        <Menu triggerClassName="btn btn-sm btn-ghost btn-icon" label={`Actions for ${f.title}`} title={f.title} align="end" items={a.fileMenu(f)} />
      </span>
    </ContextMenu>
  );
}

/**
 * Under a list that came back full: "Load more". At the most the database sends, it says so instead,
 * so a long list never looks complete when it isn't.
 */
function more({ shown, limit, onMore, beyond = "Search to find others." }: { shown: number; limit: number; onMore: () => void; beyond?: string }) {
  if (shown < Math.min(limit, LIST_MAX)) return undefined;
  if (shown >= LIST_MAX) return <ListFoot>Showing the first {LIST_MAX}. {beyond}</ListFoot>;
  return <ListFoot more={{ onClick: onMore, label: "Show more" }}>Showing the first {shown}.</ListFoot>;
}

/** A list's place while it loads. */
const ListSkeleton = () => <InboxSkeleton rows={5} />;

/** What the page says when a list is empty or failed: straight on the page, and where files can be dropped, outlined while they're over it. */
function DropArea({ dropping, children }: { dropping: boolean; children: ReactNode }) {
  return <div className={`${styles.dropArea}${dropping ? ` ${styles.dropping}` : ""}`}>{children}</div>;
}

// ---------------------------------------------------------------------------------------------
// Company files
// ---------------------------------------------------------------------------------------------

function CompanyFiles({ folderId, loading, dropping }: { folderId: string | null; loading: boolean; dropping: boolean }) {
  const session = useSession();
  const a = useActions();
  const [limit, setLimit] = useState(PAGE);
  const current = folderId ? a.tree.byId.get(folderId) : (a.tree.root ?? undefined);
  const files = useDriveList(session.company.id, "folder", current?.id ?? null, null, limit, Boolean(current));

  if (loading) return <ListSkeleton />;
  if (!current) {
    return (
      <EmptyState icon="folder" title="That folder isn't here" action={<Button onClick={() => a.openFolder(null)}>Go to Company files</Button>}>
        It may have been moved to the Trash.
      </EmptyState>
    );
  }
  const subfolders = a.tree.children.get(current.id) ?? [];
  const rows = files.data ?? [];
  const isRoot = !current.parent_id;
  const to = { key: current.id, target: { folder_id: current.id }, where: folderLabel(current) };

  return (
    <>
      {files.isPending ? (
        <ListSkeleton />
      ) : files.error && !files.data ? (
        <ErrorState error={files.error} onRetry={() => files.refetch()} />
      ) : !subfolders.length && !rows.length ? (
        <DropArea dropping={dropping}>
          <EmptyState
            icon={isRoot ? "folder" : "folderOpen"}
            title={isRoot ? "No company files yet" : `Nothing in ${current.name} yet`}
            action={
              <>
                <Button icon="folderPlus" onClick={() => a.newFolder(current)}>New folder</Button>
                <Button icon="upload" onClick={() => a.upload(to)}>Upload</Button>
              </>
            }
          >
            Make folders for your forms, price sheets and insurance papers, or drop or paste files here.
          </EmptyState>
        </DropArea>
      ) : (
        <InboxList label={`In ${folderLabel(current)}`} stale={files.isPlaceholderData} className={dropping ? styles.dropping : undefined} foot={more({ shown: rows.length, limit, onMore: () => setLimit(longer(PAGE)) })}>
          <FileRows folders={subfolders} files={rows} where="records" label="Files" heads />
        </InboxList>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Recent and search
// ---------------------------------------------------------------------------------------------

function FileList({ scope, dropping }: { scope: "recent"; dropping: boolean }) {
  const session = useSession();
  const [limit, setLimit] = useState(100);
  const files = useDriveList(session.company.id, scope, null, null, limit);
  const rows = files.data ?? [];
  const groups = useMemo(() => groupByDay(rows, session.company.timezone), [rows, session.company.timezone]);
  const links = usePlanLinks(previewable(rows));
  let body: ReactNode;
  if (files.isPending) body = <ListSkeleton />;
  else if (files.error && !files.data) body = <ErrorState error={files.error} onRetry={() => files.refetch()} />;
  else if (!rows.length) {
    body = (
      <DropArea dropping={dropping}>
        <EmptyState icon="clock" title="No files yet">Files added anywhere in Crewtavo, on a job, a quote or in your company folders, show up here newest first.</EmptyState>
      </DropArea>
    );
  } else {
    body = (
      <InboxList label="Recent files" stale={files.isPlaceholderData} className={dropping ? styles.dropping : undefined} foot={more({ shown: rows.length, limit, onMore: () => setLimit(longer(100)) })}>
        {groups.map((g) => (
          <InboxGroup key={g.key} label={g.label} count={g.files.length}>
            {g.files.map((f) => <FileRow key={f.id} file={f} where="all" preview={previewLink(f, links.data?.open)} />)}
          </InboxGroup>
        ))}
      </InboxList>
    );
  }
  return body;
}

function SearchResults({ query, dropping }: { query: string; dropping: boolean }) {
  const session = useSession();
  const navigate = useNavigate();
  const a = useActions();
  const [limit, setLimit] = useState(100);
  useEffect(() => setLimit(100), [query]);
  // A job or quote number can be one digit.
  const searching = query.length >= 2 || /^#?\d+$/.test(query);
  const files = useDriveList(session.company.id, "search", null, query, limit, searching);
  const needle = query.toLowerCase();
  // Folders whose names match, those starting with it first.
  const starts = (f: DriveFolder) => (f.name.toLowerCase().startsWith(needle) ? 0 : 1);
  const folders = needle ? [...a.tree.byId.values()].filter((f) => f.parent_id && f.name.toLowerCase().includes(needle)).sort((x, y) => starts(x) - starts(y) || byName(x, y)).slice(0, 20) : [];
  const rows = searching ? (files.data ?? []) : [];

  let body: ReactNode;
  if (!query) body = <EmptyState icon="search" title="Search every file">By name, revision, notes, client or job number.</EmptyState>;
  else if (searching && files.isPending && !folders.length) body = <ListSkeleton />;
  else if (files.error && !files.data) body = <ErrorState error={files.error} onRetry={() => files.refetch()} />;
  else if (!folders.length && !rows.length && (!searching || !files.isFetching)) {
    body = (
      <DropArea dropping={dropping}>
        <EmptyState icon="search" title="No files match" action={<Button onClick={() => navigate("/drive")}>Clear search</Button>}>
          {searching ? "Try part of the name, a revision, a client's name or a job number." : "Type another letter or two."}
        </EmptyState>
      </DropArea>
    );
  } else {
    body = (
      <InboxList
        label={`Files matching ${query}`}
        stale={files.isPlaceholderData || (searching && files.isFetching)}
        className={dropping ? styles.dropping : undefined}
        foot={more({ shown: rows.length, limit, onMore: () => setLimit(longer(100)), beyond: "Add to the search to find others." })}
      >
        <FileRows folders={folders} files={rows} where="all" label="Files" heads />
      </InboxList>
    );
  }
  return body;
}

// ---------------------------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------------------------

function ClientList({ find, onClear }: { find: string; onClear: () => void }) {
  const session = useSession();
  const term = useDeferredValue(find.trim());
  const [limit, setLimit] = useState(100);
  const clients = useDriveClients(session.company.id, term, limit);
  const rows = clients.data ?? [];

  let body: ReactNode;
  if (clients.isPending) body = <ListSkeleton />;
  else if (clients.error && !clients.data) body = <ErrorState error={clients.error} onRetry={() => clients.refetch()} />;
  else if (!rows.length) {
    body = term ? (
      <EmptyState icon="search" title="No clients match" action={<Button onClick={onClear}>Clear</Button>}>Only clients with files show here.</EmptyState>
    ) : (
      <EmptyState icon="clients" title="No client files yet">Files on your clients' properties, requests, quotes and jobs show up here, by client.</EmptyState>
    );
  } else {
    body = (
      <InboxList label="Clients with files" stale={clients.isPlaceholderData} foot={more({ shown: rows.length, limit, onMore: () => setLimit(longer(100)), beyond: "Find a client above to see others." })}>
        <InboxGroup>
          {rows.map((c) => (
            <InboxRow
              key={c.client_id}
              to={`/drive?view=clients&client=${c.client_id}`}
              title={c.client_name}
              meta={c.files === 1 ? "1 file" : `${c.files} files`}
              aside={<RowAge at={c.updated_at} />}
            />
          ))}
        </InboxGroup>
      </InboxList>
    );
  }
  return body;
}

function ClientFiles({ clientId }: { clientId: string }) {
  const session = useSession();
  const navigate = useNavigate();
  const [limit, setLimit] = useState(PAGE * 2);
  const client = useDriveClient(clientId);
  const properties = useClientProperties(clientId);
  const files = useDriveList(session.company.id, "client", clientId, null, limit);
  const groups = useMemo(() => groupClientFiles(files.data ?? []), [files.data]);
  const name = client.data?.display_name ?? files.data?.[0]?.client_name ?? "Client";

  const shown = new Set(groups.map((g) => g.propertyId));
  // Properties with no files yet still show, to drop files on.
  const empty = (properties.data ?? []).filter((p) => !shown.has(p.id));
  const label = (id: string | null, fallback: string) => {
    const p = properties.data?.find((x) => x.id === id);
    return p ? propertyLabel(p) : fallback;
  };


  if (files.isPending) return <ListSkeleton />;
  if (client.data === null) {
    return <EmptyState icon="clients" title="That client isn't here" action={<Button onClick={() => navigate("/drive?view=clients")}>See clients</Button>}>They may have been deleted.</EmptyState>;
  }
  return (
    <>
      {files.error && !files.data && <ErrorState error={files.error} onRetry={() => files.refetch()} />}
      {files.data && !groups.length && !empty.length && (
        <EmptyState icon="file" title={`No files for ${name} yet`}>
          {properties.data && !properties.data.length ? "Add a property to this client first. A client's files are kept with a property." : "Files on their properties, requests, quotes and jobs show up here."}
        </EmptyState>
      )}
      {groups.map((g) => (
        <PropertySection key={g.key} propertyId={g.propertyId} label={g.propertyId ? label(g.propertyId, g.label) : g.label} count={g.places.reduce((n, p) => n + p.files.length, 0)}>
          {g.places.map((p) => (
            <div key={p.key} className={styles.place}>
              <h3 className={styles.placeHead}>{p.path ? <Link to={p.path}>{p.label}</Link> : p.label}</h3>
              <InboxList label={`${p.label}, ${g.label}`}>
                <FileRows files={p.files} where={null} label="Files" />
              </InboxList>
            </div>
          ))}
        </PropertySection>
      ))}
      {empty.map((p) => (
        <PropertySection key={p.id} propertyId={p.id} label={propertyLabel(p)}>
          <EmptyState inline title="No files here yet">Drop files here, or use Upload.</EmptyState>
        </PropertySection>
      ))}
      {files.data && more({ shown: files.data.length, limit, onMore: () => setLimit(longer(PAGE)) })}
    </>
  );
}

/** One of a client's properties, with its files: drop files on it, or use its own Upload. */
function PropertySection({ propertyId, label, count, children }: { propertyId: string | null; label: string; count?: number; children: ReactNode }) {
  const a = useActions();
  const to = propertyId ? { key: propertyId, target: { property_id: propertyId }, where: label } : null;
  const zone = `property:${propertyId ?? "none"}`;
  return (
    <div className={styles.dropZone} {...a.dropProps(zone, to)}>
      <Section
        title={<span title={label}>{label}</span>}
        count={count}
        flush
        className={a.dropOn === zone ? styles.dropping : undefined}
        action={
          to && (
            <>
              {a.importFrom && (
                <button type="button" onPointerEnter={a.preloadGoogle} onFocus={a.preloadGoogle} onClick={() => a.importFrom!(to)} aria-label={`Import from Google Drive to ${label}`} title="Import from Google Drive">
                  <img src={googleLogo} alt="" width={14} height={14} />Import
                </button>
              )}
              <button type="button" onClick={() => a.upload(to)} aria-label={`Upload to ${label}`}><Icon name="upload" size={14} />Upload</button>
            </>
          )
        }
      >
        {children}
      </Section>
    </div>
  );
}
