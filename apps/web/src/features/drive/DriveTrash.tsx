/**
 * The Trash: every file deleted in Crewtavo in the last 30 days, from Drive and from everywhere else
 * (a visit photo, a receipt, a sub's paperwork), newest first. Each shows what this person can do
 * with it (drive_trash's restore): put it back, have a copy put in Company files when where it was
 * is gone, or download it (a sub's paperwork, an applicant's files or a receipt whose record is
 * gone: those never go where more people would see them). Only the owner can delete things for good
 * before the nightly purge does, one at a time or with Empty Trash, which goes on past the 500 the list
 * shows (public.drive_trash, drive_restore; POST /api/drive/trash/delete-forever; trash.ts).
 */
import { TRASH_DAYS } from "@crewtavo/core/drive";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Icon } from "@/components/ui/Icon";
import { Menu } from "@/components/ui/Menu";
import { TableSkeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { downloadLink } from "@/features/files/files";
import { fileSize, planLink } from "@/features/plans/plans";
import { supabase } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { formatDate, timeAgo } from "@/lib/format";
import { useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import { companyFilesNote, ICON_FOR, iconKind, refreshFiles, seesDrive, SLOTS, useDriveTrash, type TrashItem } from "./data";
import styles from "./drive.module.css";
import { deletedForeverToast, deleteForever, emptyTrash, restoreTrash, TRASH_LIST_MAX, type DeletedForever, type Restored } from "./trash";

const kindIcon = (item: TrashItem) => (item.kind === "folder" ? "folder" : ICON_FOR[iconKind({ content_type: item.content_type, file_name: item.name })]);
const kindData = (item: TrashItem) => (item.kind === "folder" ? "folder" : iconKind({ content_type: item.content_type, file_name: item.name }));

/**
 * Whether a restore landed in Company files, which only Drive shows: a folder always does, a copy
 * always does, and a file or version does when it's on no client's record any more.
 */
async function inCompanyFiles(item: TrashItem, done: Restored): Promise<boolean> {
  if (item.kind === "folder" || done.result === "copied") return true;
  if (!done.fileId) return false;
  const { data, error } = await supabase().from("plan_files").select("property_id, request_id, quote_id, job_id").eq("id", done.fileId).maybeSingle();
  if (error) throw error;
  // Not readable once it's back: it's in a folder that's the office's.
  return !data || !SLOTS.some((slot) => data[slot]);
}

export function TrashList() {
  const session = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const trash = useDriveTrash(session.company.id);
  const owner = session.role === "owner";
  const office = seesDrive(session);
  const items = trash.data ?? [];

  const restore = useMutation({
    mutationFn: async (item: TrashItem) => {
      // A copy in Company files is the office's to make (and the server's to refuse for restricted
      // papers); anyone else whose file can't go back is told to download it instead.
      const done = await restoreTrash(item.kind, item.id, { copy: office });
      return { item, done, inDrive: await inCompanyFiles(item, done).catch(() => done.result === "copied") };
    },
    onSuccess: ({ item, done, inDrive }) => {
      // A restored file can be anything, anywhere: a visit photo, a receipt, a plan on a job.
      queryClient.invalidateQueries();
      const open = inDrive && office && done.fileId ? { label: "Open", onClick: () => navigate(`/drive?file=${done.fileId}`) } : undefined;
      toast.success(`${item.name} restored`, inDrive ? { description: companyFilesNote(session, done.result === "copied"), action: open, duration: open ? 8000 : 6000 } : undefined);
    },
    // Where it was went since the list loaded: the list says what can be done now.
    onError: () => queryClient.invalidateQueries({ queryKey: ["drive", session.company.id, "trash"] }),
  });
  // What the server says it deleted: anything short of what was asked for had already left the
  // Trash (put back, or deleted meanwhile), so the toast says that rather than to try again.
  const said = (r: DeletedForever) => {
    const t = deletedForeverToast(r);
    toast[t.kind](t.title, t.description ? { description: t.description } : undefined);
  };
  // Deleted for good frees its space at once, so how much storage is used is read again with the Trash.
  const remove = useMutation({
    mutationFn: (item: TrashItem) => deleteForever([item]),
    onSuccess: said,
    onSettled: () => refreshFiles(queryClient),
  });
  // Everything up to the newest thing shown, however many there are (the list shows 500 at most).
  const empty = useMutation({
    mutationFn: (upTo: string) => emptyTrash(session.company.id, upTo),
    onSuccess: said,
    onSettled: () => refreshFiles(queryClient),
  });
  const download = async (item: TrashItem) => {
    try {
      if (!item.path) throw new Error("This one has no file to download.");
      window.location.href = downloadLink(await planLink(item.path), item.name);
    } catch (error) {
      toast.error("Couldn't download it", { description: errorMessage(error) });
    }
  };

  const askDelete = async (item: TrashItem) => {
    const what = item.kind === "folder" ? "This folder and everything that was in it are" : item.kind === "file" && (item.versions ?? 1) > 1 ? `All ${item.versions} versions are` : "It's";
    if (await confirm({ title: `Delete ${item.name} forever?`, body: `${what} deleted right away instead of on ${formatDate(item.purge_at)}. This can't be undone.`, confirmLabel: "Delete forever", danger: true })) remove.mutate(item);
  };
  const askEmpty = async () => {
    // The newest thing on the list: what goes to the Trash after this was never shown, so it stays.
    const upTo = items.reduce((max, t) => (new Date(t.deleted_at).getTime() > new Date(max).getTime() ? t.deleted_at : max), items[0]!.deleted_at);
    const capped = items.length >= TRASH_LIST_MAX;
    const ok = await confirm({
      title: "Empty the Trash?",
      body: capped
        ? `Everything in the Trash is deleted forever right away: the ${TRASH_LIST_MAX} most recent shown here and every older one. This can't be undone.`
        : `${items.length === 1 ? "The one item in the Trash is" : `All ${items.length} items in the Trash are`} deleted forever right away. This can't be undone.`,
      confirmLabel: "Empty Trash",
      danger: true,
      typeToConfirm: "empty",
    });
    if (ok) empty.mutate(upTo);
  };

  return (
    <section className="stack" aria-labelledby="drive-trash">
      <div className="section-head">
        <h2 id="drive-trash" className="sr-only">Trash</h2>
        <p className="muted grow" style={{ margin: 0 }}>Files you delete stay here for {TRASH_DAYS} days, then they're deleted for good.</p>
        {owner && items.length > 0 && <Button variant="danger" icon="trash" loading={empty.isPending} onClick={() => void askEmpty()}>Empty Trash</Button>}
      </div>
      {trash.isPending ? (
        <div className="card"><TableSkeleton rows={4} columns={3} header={false} /></div>
      ) : trash.error && !trash.data ? (
        <div className="card"><ErrorState error={trash.error} onRetry={() => trash.refetch()} /></div>
      ) : items.length === 0 ? (
        <div className="card">
          <EmptyState icon="trash" title="The Trash is empty">Files deleted in Crewtavo, from a plan to a visit photo or a receipt, wait here for {TRASH_DAYS} days in case you need them back.</EmptyState>
        </div>
      ) : (
        <div className={`card${trash.isFetching && !trash.isPending ? " is-stale" : ""}`}>
          <table className={`table table-stack ${styles.files}`}>
            <thead>
              <tr><th>Name</th><th className={styles.deletedCol}>Deleted</th><th className={styles.trashActionsCol}><span className="sr-only">Actions</span></th></tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={`${item.kind}-${item.id}`} className={styles.trashRow}>
                  <td className={styles.nameCell}>
                    <div className={styles.name}>
                      <span className={styles.icon} data-kind={kindData(item)} aria-hidden="true"><Icon name={kindIcon(item)} size={18} /></span>
                      <div className={styles.body}>
                        <span className={styles.titleText}>{item.name}</span>
                        <span className={styles.meta}>
                          {[item.kind === "folder" ? "Folder" : item.kind === "version" ? "One version" : (item.versions ?? 1) > 1 ? `${item.versions} versions` : null, item.detail, fileSize(item.size_bytes)].filter(Boolean).join(" · ")}
                        </span>
                      </div>
                    </div>
                  </td>
                  <td className={styles.deletedCell}>
                    <span title={formatDate(item.deleted_at)}>Deleted {timeAgo(item.deleted_at)}{item.deleted_by_name ? ` by ${item.deleted_by_name}` : ""}</span>
                    <span className={styles.meta}>Deletes on {formatDate(item.purge_at)}</span>
                  </td>
                  <td className={styles.actionsCell}>
                    <div className={styles.trashButtons}>
                      {item.restore === "download" ? (
                        <Button size="sm" icon="download" onClick={() => void download(item)} aria-label={`Download ${item.name}`} title="Where it was is gone, so it's downloaded rather than restored">Download</Button>
                      ) : item.restore !== "none" ? (
                        <Button size="sm" icon="restore" loading={restore.isPending && restore.variables?.id === item.id} onClick={() => restore.mutate(item)} aria-label={`Restore ${item.name}`}>Restore</Button>
                      ) : null}
                      {owner && (
                        <Menu
                          triggerClassName="btn btn-sm btn-ghost btn-icon"
                          label={`More for ${item.name}`}
                          items={[{ label: "Delete forever", icon: "trash", danger: true, onSelect: () => void askDelete(item) }]}
                        />
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {items.length >= TRASH_LIST_MAX && <div className="list-foot">Showing the {TRASH_LIST_MAX} most recent. Older ones are still here, and show as these are restored or deleted.</div>}
        </div>
      )}
    </section>
  );
}
