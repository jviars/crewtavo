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
import { Icon, type IconName } from "@/components/ui/Icon";
import { Menu, type MenuEntry } from "@/components/ui/Menu";
import { PageHeader } from "@/components/ui/PageHeader";
import { Skeleton, TableSkeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState, NoAccess } from "@/components/ui/States";
import { editKind, FileViewer, type ViewerFile } from "@/features/files/FileViewer";
import { fileSize, planLink, titleFromFileName, TooLargeError, uploadPlanFile } from "@/features/plans/plans";
import { useTooLarge } from "@/features/plans/UploadLimit";
import {
  addEach, companyLine, fullness, managesStorage, personalLine, RefusedForSpace, shareOf, STORAGE_SETTINGS, useStorageFull, useStorageOverview,
} from "@/features/settings/storage";
import { api, supabase, unwrap } from "@/lib/api";
import { errorMessage, StorageFullError } from "@/lib/errors";
import { addressLine, timeAgo } from "@/lib/format";
import { can, hasRole, isSub, useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import {
  driveView, editableInDrive, folderPath, folderTree, groupClientFiles, ICON_FOR, iconKind, placesOf, refreshFiles, savedViewerFile, seesDrive, SLOTS, fileMeta,
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
  return (
    <div className={styles.page}>
      <PageHeader title={inDrive ? "Drive" : "Trash"} documentTitle="Trash" />
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
      <div className="card">
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
      </div>
      {/* A file found with search still opens. */}
      <ViewerHost />
    </div>
  );
}

const TABS: Array<{ view: DriveView | "trash"; label: string; icon: IconName }> = [
  { view: "company", label: "Company files", icon: "folder" },
  { view: "clients", label: "Clients", icon: "clients" },
  { view: "recent", label: "Recent", icon: "clock" },
  { view: "search", label: "Search", icon: "search" },
  { view: "trash", label: "Trash", icon: "trash" },
];

function DriveTabs({ view }: { view: DriveView | "trash" }) {
  const navigate = useNavigate();
  const go = (to: DriveView | "trash") => navigate(to === "trash" ? "/drive/trash" : to === "company" ? "/drive" : `/drive?view=${to}`);
  return (
    <div className="underline-tabs" role="tablist" aria-label="Drive">
      {TABS.filter((t) => t.view !== "search" || view === "search").map((t) => (
        <button key={t.view} type="button" role="tab" aria-selected={view === t.view} onClick={() => go(t.view)}>
          <Icon name={t.icon} size={16} />
          {t.label}
        </button>
      ))}
    </div>
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
  const googleKeys = session.config.googlePicker ?? null;
  const [sending, setSending] = useState<Sending[]>([]);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [googleFor, setGoogleFor] = useState<Destination | null>(null);
  const [dropOn, setDropOn] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);
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
    const { added, refused } = await addEach(
      list,
      async (file) => {
        const key = crypto.randomUUID();
        const upload = uploadPlanFile(session.company.id, file, (progress) => setSending((s) => s.map((u) => (u.key === key ? { ...u, progress } : u))));
        setSending((s) => [...s, { key, name: file.name, size: file.size, progress: 0, abort: upload.abort }]);
        try {
          const path = await upload.promise;
          const { error } = await supabase()
            .from("plan_files")
            .insert({
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
            })
            .select("id")
            .single();
          // "Someone added a newer version meanwhile" in the database's words, not "That already exists."
          // A row that isn't saved leaves its stored file behind; the server tidies those away after a day.
          if (error) throw versionRefused(error);
        } finally {
          remove(key);
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
      setSending((s) => [...s, { key, name, size: null, progress: null, abort: stop }]);
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
      { label: "Open", icon: "eye", onSelect: () => openFile(f) },
      // An archived file is kept as it is (as on a job's Plans and files card): no edit, no new version.
      { label: "Edit", icon: "pen", hidden: f.archived || !editKind(f), onSelect: () => openFile(f, true) },
      { label: "Download", icon: "download", onSelect: () => void download(f) },
      { separator: true },
      { label: "Rename", icon: "edit", onSelect: () => setDialog({ kind: "rename", file: f }) },
      { label: f.folder_id ? "Move to folder" : "Put in a folder", icon: "folderMove", hidden: !root, onSelect: () => setDialog({ kind: "move", item: { kind: "file", file: f } }) },
      { label: "Attach to…", icon: "paperclip", onSelect: () => setDialog({ kind: "attach", file: f }) },
      { label: "Upload a new version", icon: "upload", hidden: f.archived, onSelect: () => pick(null, f) },
      { label: "Versions", icon: "history", hidden: f.versions < 2, onSelect: () => setDialog({ kind: "versions", file: f }) },
      // Crews see files on their jobs; a file in a folder only is the office's (attaching it asks).
      { label: f.crew_visible ? "Make it office only" : "Show it to the crew", icon: f.crew_visible ? "lock" : "users", hidden: !onRecord && !f.crew_visible, onSelect: () => crew.mutate(f) },
      { separator: true },
      { label: "Move to Trash", icon: "trash", danger: true, onSelect: () => trash.mutate(f) },
    ];
  };
  const folderMenu = (f: DriveFolder): MenuEntry[] => [
    { label: "Open", icon: "folderOpen", onSelect: () => openFolder(f.id) },
    { label: "Rename", icon: "edit", onSelect: () => setDialog({ kind: "folder", folder: f }) },
    { label: "Move", icon: "folderMove", onSelect: () => setDialog({ kind: "move", item: { kind: "folder", folder: f } }) },
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
          <Menu label="Import from Google Drive to which property?" triggerClassName="btn" trigger={googleLabel} items={[{ heading: "To which property?" }, ...destinations.map((d) => ({ label: d.where, icon: "pin" as const, onSelect: () => importFrom(d) }))]} />
        </span>
      )}
      {view === "company" && current && <Button icon="folderPlus" onClick={() => setDialog({ kind: "folder", parent: current })}>New folder</Button>}
      {single && <Button variant="primary" icon="upload" onClick={() => pick(single)}>Upload</Button>}
      {destinations.length > 1 && (
        <Menu
          label="Upload to which property?"
          triggerClassName="btn btn-primary"
          trigger={<><Icon name="upload" size={16} />Upload</>}
          items={[{ heading: "To which property?" }, ...destinations.map((d) => ({ label: d.where, icon: "pin" as const, onSelect: () => pick(d) }))]}
        />
      )}
    </>
  );

  return (
    <Actions.Provider value={actions}>
      <div className={styles.page} {...(view === "company" || view === "recent" || view === "search" ? dropProps("page", single) : {})}>
        <PageHeader title="Drive" actions={headerActions} />
        <StorageLine />
        <DriveTabs view={view} />
        <div className="toolbar">
          <div className="input-group">
            <span className="addon"><Icon name="search" size={16} /></span>
            <input className="input" type="search" placeholder="Search every file" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search every file" />
          </div>
        </div>
        {sending.length > 0 && <Uploads sending={sending} />}
        {folders.error && !folders.data ? (
          <div className="card"><ErrorState error={folders.error} onRetry={() => folders.refetch()} /></div>
        ) : view === "company" ? (
          <CompanyFiles key={folderParam ?? "root"} folderId={folderParam} loading={folders.isPending} dropping={dropOn === "page"} />
        ) : view === "clients" ? (
          clientParam ? <ClientFiles key={clientParam} clientId={clientParam} /> : <ClientList />
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
    <div className={styles.storage}>
      {share !== null && (
        <span className={styles.storageBar} data-level={level} role="img" aria-label={`${Math.floor(share * 100)}% of the storage limit used`}>
          <span style={{ width: `${Math.min(100, share * 100)}%` }} />
        </span>
      )}
      <span data-level={level}>{level === "full" ? `Storage is full: ${companyLine(o)}` : companyLine(o)}</span>
      {mine && <span data-level={fullness(shareOf(o.me.used_bytes, o.me.limit_bytes))}>{mine}</span>}
      {managesStorage(session) && <Link to={STORAGE_SETTINGS}>Storage settings</Link>}
    </div>
  );
}

/** Files on their way up, or being copied from Google Drive, each with a way to stop it. */
function Uploads({ sending }: { sending: Sending[] }) {
  return (
    <div className={`card card-pad ${styles.uploads}`}>
      {sending.map((u) => {
        const copying = u.progress === null;
        const status = copying ? (u.stopping ? "Stopping after this one…" : "Copying from Google Drive…") : u.progress! >= 1 ? "Saving…" : `${Math.round(u.progress! * 100)}% of ${fileSize(u.size)}`;
        return (
          <div key={u.key} className={styles.upload} role="status">
            <div className={styles.uploadHead}>
              <span title={u.name}>{u.name}</span>
              <span className="muted small tabular">{status}</span>
              {(copying ? !u.stopping : u.progress! < 1) && (
                <Button size="sm" variant="ghost" icon="x" aria-label={copying ? `Stop copying after ${u.name}` : `Stop uploading ${u.name}`} title="Stop" onClick={u.abort} />
              )}
            </div>
            <div className={`progress${copying ? ` ${styles.indeterminate}` : ""}`} aria-hidden="true">
              <span style={copying ? undefined : { width: `${Math.round(u.progress! * 100)}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------------------------

/** Folders, then files: each opens with a tap, and has its menu at the end. `where` adds the column saying where each file is. */
function FileTable({ folders = [], files, where, caption }: { folders?: DriveFolder[]; files: DriveFile[]; where: "records" | "all" | null; caption: string }) {
  return (
    <table className={`table table-stack ${styles.files}`}>
      <caption className="sr-only">{caption}</caption>
      <thead>
        <tr>
          <th>Name</th>
          {where && <th className={styles.whereCol}>Where</th>}
          <th className={styles.actionsCol}><span className="sr-only">Actions</span></th>
        </tr>
      </thead>
      <tbody>
        {folders.map((f) => <FolderRow key={f.id} folder={f} where={Boolean(where)} />)}
        {files.map((f) => <FileRow key={f.id} file={f} where={where} />)}
      </tbody>
    </table>
  );
}

function FolderRow({ folder, where }: { folder: DriveFolder; where: boolean }) {
  const a = useActions();
  const inside = a.tree.children.get(folder.id)?.length ?? 0;
  const zone = `folder:${folder.id}`;
  return (
    <tr className="row-link" data-drop={a.dropOn === zone || undefined} onClick={() => a.openFolder(folder.id)} {...a.dropProps(zone, { key: folder.id, target: { folder_id: folder.id }, where: folder.name })}>
      <td className={styles.nameCell}>
        <div className={styles.name}>
          <span className={styles.icon} data-kind="folder" aria-hidden="true"><Icon name="folder" size={18} /></span>
          <div className={styles.body}>
            <button type="button" className={styles.title} onClick={(e) => { e.stopPropagation(); a.openFolder(folder.id); }}>{folder.name}</button>
            <span className={styles.meta}>Folder{inside ? ` · ${inside} ${inside === 1 ? "folder" : "folders"} inside` : ""}</span>
          </div>
        </div>
      </td>
      {where && <td className={styles.whereCell} />}
      <td className={styles.actionsCell} onClick={(e) => e.stopPropagation()}>
        <Menu triggerClassName="btn btn-sm btn-ghost btn-icon" label={`Actions for ${folder.name}`} items={a.folderMenu(folder)} />
      </td>
    </tr>
  );
}

function FileRow({ file: f, where }: { file: DriveFile; where: "records" | "all" | null }) {
  const a = useActions();
  const kind = iconKind(f);
  const onRecord = SLOTS.some((s) => f[s]);
  const places = placesOf(f);
  const folder = f.folder_id ? a.tree.byId.get(f.folder_id) : undefined;
  const stop = (e: MouseEvent) => e.stopPropagation();
  return (
    <tr className="row-link" onClick={() => a.openFile(f)}>
      <td className={styles.nameCell}>
        <div className={styles.name}>
          <span className={styles.icon} data-kind={kind} aria-hidden="true"><Icon name={ICON_FOR[kind]} size={18} /></span>
          <div className={styles.body}>
            <button type="button" className={styles.title} onClick={(e) => { stop(e); a.openFile(f); }}>{f.title}</button>
            <span className={styles.meta}>{fileMeta(f)}</span>
            {(f.archived || (onRecord && !f.crew_visible) || (!onRecord && f.crew_visible)) && (
              <div className={styles.flags}>
                {onRecord && !f.crew_visible && <span className="chip chip-amber"><Icon name="lock" size={11} />Office only</span>}
                {!onRecord && f.crew_visible && <span className="chip chip-blue"><Icon name="users" size={11} />Crew leads see it</span>}
                {f.archived && <span className="chip">Archived</span>}
              </div>
            )}
          </div>
        </div>
      </td>
      {where && (
        <td className={styles.whereCell}>
          {(places.length > 0 || (where === "all" && f.folder_id)) && (
            <div className={styles.where}>
              {where === "all" && f.folder_id && (
                <Link className={styles.place} data-slot="folder" to={folder?.parent_id ? `/drive?folder=${f.folder_id}` : "/drive"} onClick={stop} title={folder ? folderPath(a.tree, folder.id).map(folderLabel).join(" › ") : undefined}>
                  {folder ? folderLabel(folder) : (f.folder_name ?? "Company files")}
                </Link>
              )}
              {places.map((p) =>
                p.path ? (
                  <Link key={p.slot} className={styles.place} data-slot={p.slot} to={p.path} onClick={stop} title={p.label}>{p.label}</Link>
                ) : (
                  <span key={p.slot} className={styles.place} data-slot={p.slot} title={p.label}>{p.label}</span>
                ),
              )}
            </div>
          )}
        </td>
      )}
      <td className={styles.actionsCell} onClick={stop}>
        <Menu triggerClassName="btn btn-sm btn-ghost btn-icon" label={`Actions for ${f.title}`} items={a.fileMenu(f)} />
      </td>
    </tr>
  );
}

/**
 * "Show more" under a list that came back full. At the most the database sends, it says so instead,
 * so a long list never looks complete when it isn't.
 */
function More({ shown, limit, onMore, beyond = "Search to find others." }: { shown: number; limit: number; onMore: () => void; beyond?: string }) {
  if (shown < Math.min(limit, LIST_MAX)) return null;
  if (shown >= LIST_MAX) {
    return (
      <div className="list-foot">
        <span>Showing the first {LIST_MAX}. {beyond}</span>
      </div>
    );
  }
  return (
    <div className="list-foot">
      <span>Showing the first {shown}.</span>
      <Button size="sm" onClick={onMore}>Show more</Button>
    </div>
  );
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
      <div className="card">
        <EmptyState icon="folder" title="That folder isn't here" action={<Button onClick={() => a.openFolder(null)}>Go to Company files</Button>}>
          It may have been moved to the Trash.
        </EmptyState>
      </div>
    );
  }
  const path = folderPath(a.tree, current.id);
  const subfolders = a.tree.children.get(current.id) ?? [];
  const rows = files.data ?? [];
  const isRoot = !current.parent_id;
  const to = { key: current.id, target: { folder_id: current.id }, where: folderLabel(current) };

  return (
    <section className="stack" aria-label={folderLabel(current)}>
      {path.length > 1 && (
        <nav aria-label="Folder">
          <ol className={styles.crumbs}>
            {path.map((f, i) => (
              <li key={f.id}>
                {i > 0 && <Icon name="chevronRight" size={14} />}
                {i === path.length - 1 ? <span aria-current="page">{folderLabel(f)}</span> : <button type="button" onClick={() => a.openFolder(f.id)}>{folderLabel(f)}</button>}
              </li>
            ))}
          </ol>
        </nav>
      )}
      {files.isPending ? (
        <ListSkeleton />
      ) : files.error && !files.data ? (
        <div className="card"><ErrorState error={files.error} onRetry={() => files.refetch()} /></div>
      ) : !subfolders.length && !rows.length ? (
        <div className={`card${dropping ? ` ${styles.dropping}` : ""}`}>
          <EmptyState
            icon={isRoot ? "folder" : "folderOpen"}
            title={isRoot ? "No company files yet" : `Nothing in ${current.name} yet`}
            action={
              <>
                <Button icon="folderPlus" onClick={() => a.newFolder(current)}>New folder</Button>
                <Button variant="primary" icon="upload" onClick={() => a.upload(to)}>Upload</Button>
              </>
            }
          >
            Make folders for your forms, price sheets and insurance papers, or drop files here.
          </EmptyState>
        </div>
      ) : (
        <div className={`card${files.isPlaceholderData ? " is-stale" : ""}${dropping ? ` ${styles.dropping}` : ""}`}>
          <FileTable folders={subfolders} files={rows} where="records" caption={`In ${folderLabel(current)}`} />
          <More shown={rows.length} limit={limit} onMore={() => setLimit(longer(PAGE))} />
        </div>
      )}
    </section>
  );
}

function ListSkeleton() {
  return <div className="card"><TableSkeleton rows={5} columns={2} header={false} /></div>;
}

// ---------------------------------------------------------------------------------------------
// Recent and search
// ---------------------------------------------------------------------------------------------

function FileList({ scope, dropping }: { scope: "recent"; dropping: boolean }) {
  const session = useSession();
  const [limit, setLimit] = useState(100);
  const files = useDriveList(session.company.id, scope, null, null, limit);
  const rows = files.data ?? [];
  if (files.isPending) return <ListSkeleton />;
  if (files.error && !files.data) return <div className="card"><ErrorState error={files.error} onRetry={() => files.refetch()} /></div>;
  if (!rows.length) {
    return (
      <div className={`card${dropping ? ` ${styles.dropping}` : ""}`}>
        <EmptyState icon="clock" title="No files yet">Files added anywhere in Crewtavo, on a job, a quote or in your company folders, show up here newest first.</EmptyState>
      </div>
    );
  }
  return (
    <div className={`card${files.isPlaceholderData ? " is-stale" : ""}${dropping ? ` ${styles.dropping}` : ""}`}>
      <FileTable files={rows} where="all" caption="Recent files" />
      <More shown={rows.length} limit={limit} onMore={() => setLimit(longer(100))} />
    </div>
  );
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

  if (!query) {
    return (
      <div className="card">
        <EmptyState icon="search" title="Search every file">By name, revision, notes, client or job number.</EmptyState>
      </div>
    );
  }
  if (searching && files.isPending && !folders.length) return <ListSkeleton />;
  if (files.error && !files.data) return <div className="card"><ErrorState error={files.error} onRetry={() => files.refetch()} /></div>;
  if (!folders.length && !rows.length && (!searching || !files.isFetching)) {
    return (
      <div className={`card${dropping ? ` ${styles.dropping}` : ""}`}>
        <EmptyState icon="search" title="No files match" action={<Button onClick={() => navigate("/drive")}>Clear search</Button>}>
          {searching ? "Try part of the name, a revision, a client's name or a job number." : "Type another letter or two."}
        </EmptyState>
      </div>
    );
  }
  return (
    <div className={`card${files.isPlaceholderData || (searching && files.isFetching) ? " is-stale" : ""}${dropping ? ` ${styles.dropping}` : ""}`}>
      <FileTable folders={folders} files={rows} where="all" caption={`Files matching ${query}`} />
      <More shown={rows.length} limit={limit} onMore={() => setLimit(longer(100))} beyond="Add to the search to find others." />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------------------------

function ClientList() {
  const session = useSession();
  const navigate = useNavigate();
  const [find, setFind] = useState("");
  const term = useDeferredValue(find.trim());
  const [limit, setLimit] = useState(100);
  const clients = useDriveClients(session.company.id, term, limit);
  const rows = clients.data ?? [];
  const open = (id: string) => navigate(`/drive?view=clients&client=${id}`);

  if (clients.isPending) return <ListSkeleton />;
  return (
    <div className={`card${clients.isPlaceholderData ? " is-stale" : ""}`}>
      <div className={styles.clientFind}>
        <div className="input-group">
          <span className="addon"><Icon name="search" size={16} /></span>
          <input className="input" type="search" placeholder="Find a client" value={find} onChange={(e) => setFind(e.target.value)} aria-label="Find a client" />
        </div>
      </div>
      {clients.error && !clients.data ? (
        <ErrorState error={clients.error} onRetry={() => clients.refetch()} />
      ) : rows.length === 0 ? (
        term ? (
          <EmptyState icon="search" title="No clients match" action={<Button onClick={() => setFind("")}>Clear</Button>}>Only clients with files show here.</EmptyState>
        ) : (
          <EmptyState icon="clients" title="No client files yet">Files on your clients' properties, requests, quotes and jobs show up here, by client.</EmptyState>
        )
      ) : (
        <>
          <div>
            {rows.map((c) => (
              <button key={c.client_id} type="button" className={`card-row ${styles.clientRow}`} onClick={() => open(c.client_id)}>
                <span className={styles.icon} aria-hidden="true"><Icon name="clients" size={18} /></span>
                <span className="grow">
                  <strong className="ellipsis">{c.client_name}</strong>
                  <span className="muted small">{c.files === 1 ? "1 file" : `${c.files} files`} · updated {timeAgo(c.updated_at)}</span>
                </span>
                <Icon name="chevronRight" size={16} />
              </button>
            ))}
          </div>
          <More shown={rows.length} limit={limit} onMore={() => setLimit(longer(100))} beyond="Find a client above to see others." />
        </>
      )}
    </div>
  );
}

function ClientFiles({ clientId }: { clientId: string }) {
  const session = useSession();
  const navigate = useNavigate();
  const [limit, setLimit] = useState(PAGE * 2);
  const client = useQuery({
    queryKey: ["drive", session.company.id, "client", clientId],
    queryFn: async () => unwrap(await supabase().from("clients").select("id, display_name").eq("id", clientId).maybeSingle()),
  });
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

  const head = (
    <div className={styles.crumbBar}>
      <nav aria-label="Client">
        <ol className={styles.crumbs}>
          <li><button type="button" onClick={() => navigate("/drive?view=clients")}>Clients</button></li>
          <li><Icon name="chevronRight" size={14} /><span aria-current="page">{client.isPending ? <Skeleton width={120} /> : name}</span></li>
        </ol>
      </nav>
      <Link className="btn btn-sm" to={`/clients/${clientId}`}>Open client<Icon name="arrowRight" size={14} /></Link>
    </div>
  );

  if (files.isPending) return <section className="stack">{head}<ListSkeleton /></section>;
  if (client.data === null) {
    return (
      <div className="card">
        <EmptyState icon="clients" title="That client isn't here" action={<Button onClick={() => navigate("/drive?view=clients")}>See clients</Button>}>They may have been deleted.</EmptyState>
      </div>
    );
  }
  return (
    <section className="stack" aria-label={`${name}'s files`}>
      {head}
      {files.error && !files.data && <div className="card"><ErrorState error={files.error} onRetry={() => files.refetch()} /></div>}
      {files.data && !groups.length && !empty.length && (
        <div className="card">
          <EmptyState icon="file" title={`No files for ${name} yet`}>
            {properties.data && !properties.data.length ? "Add a property to this client first. A client's files are kept with a property." : "Files on their properties, requests, quotes and jobs show up here."}
          </EmptyState>
        </div>
      )}
      {groups.map((g) => (
        <PropertyCard key={g.key} propertyId={g.propertyId} label={g.propertyId ? label(g.propertyId, g.label) : g.label}>
          {g.places.map((p) => (
            <div key={p.key}>
              <h3 className={styles.placeHead}>{p.path ? <Link to={p.path}>{p.label}</Link> : p.label}</h3>
              <FileTable files={p.files} where={null} caption={`${p.label}, ${g.label}`} />
            </div>
          ))}
        </PropertyCard>
      ))}
      {empty.map((p) => (
        <PropertyCard key={p.id} propertyId={p.id} label={propertyLabel(p)}>
          <div className={styles.groupEmpty}>No files here yet. Drop files on this card, or use Upload.</div>
        </PropertyCard>
      ))}
      {files.data && <More shown={files.data.length} limit={limit} onMore={() => setLimit(longer(PAGE))} />}
    </section>
  );
}

/** One of a client's properties, with its files: drop files on it, or use its own Upload. */
function PropertyCard({ propertyId, label, children }: { propertyId: string | null; label: string; children: ReactNode }) {
  const a = useActions();
  const to = propertyId ? { key: propertyId, target: { property_id: propertyId }, where: label } : null;
  const zone = `property:${propertyId ?? "none"}`;
  return (
    <section className={`card ${styles.group}${a.dropOn === zone ? ` ${styles.dropping}` : ""}`} aria-label={label} {...a.dropProps(zone, to)}>
      <div className={styles.groupHead}>
        <h2><Icon name="pin" size={16} /><span title={label}>{label}</span></h2>
        {to && a.importFrom && (
          <Button size="sm" onPointerEnter={a.preloadGoogle} onFocus={a.preloadGoogle} onClick={() => a.importFrom!(to)} aria-label={`Import from Google Drive to ${label}`} title="Import from Google Drive">
            <img src={googleLogo} alt="" width={14} height={14} />Import
          </Button>
        )}
        {to && <Button size="sm" icon="upload" onClick={() => a.upload(to)} aria-label={`Upload to ${label}`}>Upload</Button>}
      </div>
      {children}
    </section>
  );
}
