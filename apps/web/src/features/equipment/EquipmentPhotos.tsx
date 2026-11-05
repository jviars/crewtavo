/**
 * A machine's photos (public.equipment_photos): the machine, its VIN plate, the registration card,
 * damage. Anyone on the team adds them, as they log work; the person who added one or an equipment
 * manager takes it out, with Undo, and it goes to the Trash. Mirrors a visit's photos
 * (FieldVisitPage useVisitPhotos).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ChangeEvent } from "react";
import { Icon } from "@/components/ui/Icon";
import { Skeleton } from "@/components/ui/Skeleton";
import { supabase, unwrap } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { signedUrls, storedType, uploadFile } from "@/lib/files";
import { useListAnimation } from "@/lib/motion";
import { useSession } from "@/lib/session";
import { startTask } from "@/lib/tasks";
import { undoable } from "@/lib/undo";
import { IN_TRASH } from "../drive/trash";
import { managesEquipment } from "./equipmentData";

interface Photo {
  id: string;
  path: string;
  file_name: string | null;
  created_by: string | null;
  created_at: string;
  url: string | null;
}

export type EquipmentPhotoList = ReturnType<typeof useEquipmentPhotos>;

export function useEquipmentPhotos(equipmentId: string) {
  const session = useSession();
  const { company } = session;
  const queryClient = useQueryClient();
  const key = ["equipment", company.id, "photos", equipmentId];
  const [uploading, setUploading] = useState(0);
  // Removed and waiting on Undo: kept off the screen even if the list loads again meanwhile.
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const list = useQuery({
    queryKey: key,
    queryFn: async () => {
      const rows = unwrap(await supabase().from("equipment_photos").select("id, path, file_name, created_by, created_at").eq("equipment_id", equipmentId).order("created_at"));
      const urls = await signedUrls(rows.map((r) => r.path)).catch(() => ({}) as Record<string, string>);
      return rows.map((r): Photo => ({ ...r, url: urls[r.path] ?? null }));
    },
  });
  const upload = useMutation({
    networkMode: "online",
    onMutate: (files: File[]) => setUploading((n) => n + files.length),
    mutationFn: async (files: File[]) => {
      let stopped = false;
      const task = startTask({ label: files.length === 1 ? "Adding a photo" : `Adding ${files.length} photos`, total: files.length, cancel: () => (stopped = true) });
      const problems: string[] = [];
      let sent = 0;
      for (const file of files) {
        if (!stopped) {
          try {
            const path = await uploadFile(company.id, `equipment/${equipmentId}`, file);
            unwrap(await supabase().from("equipment_photos").insert({ company_id: company.id, equipment_id: equipmentId, path, file_name: file.name.slice(0, 200), content_type: storedType(path, file), size_bytes: file.size }));
          } catch (error) {
            problems.push(`${file.name}: ${errorMessage(error)}`);
          }
          task.progress(++sent);
          queryClient.invalidateQueries({ queryKey: key });
        }
        setUploading((n) => n - 1);
      }
      const saved = sent - problems.length;
      if (problems.length) task.fail(problems.length === 1 ? problems[0]! : `${problems.length} photos didn't upload. ${problems[0]}`);
      else task.done(saved === 1 ? "Photo added" : `${saved} photos added`);
    },
  });
  // Once its Undo has passed, the photo goes to the Trash with its row (the database moves it).
  const remove = useMutation({
    meta: { inline: true },
    mutationFn: async (p: Photo) => {
      const gone = unwrap(await supabase().from("equipment_photos").delete().eq("id", p.id).select("id"));
      if (!gone.length) throw new Error("You can only remove photos you added. Ask whoever looks after equipment to remove this one.");
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: key }),
  });
  const without = (id: string) => (h: ReadonlySet<string>) => new Set([...h].filter((x) => x !== id));
  return {
    photos: (list.data ?? []).filter((p) => !hidden.has(p.id)),
    loading: list.isPending,
    uploading,
    add: (files: File[]) => upload.mutate(files),
    canRemove: (p: Photo) => p.created_by === session.userId || managesEquipment(session),
    remove: (p: Photo) =>
      undoable({
        title: "Photo removed",
        description: IN_TRASH,
        hide: () => {
          void queryClient.cancelQueries({ queryKey: key });
          setHidden((h) => new Set(h).add(p.id));
          queryClient.setQueryData<Photo[]>(key, (rows) => rows?.filter((r) => r.id !== p.id));
        },
        restore: () => {
          setHidden(without(p.id));
          queryClient.setQueryData<Photo[]>(key, (rows) => (rows && !rows.some((r) => r.id === p.id) ? [...rows, p].sort((a, b) => a.created_at.localeCompare(b.created_at)) : rows));
        },
        commit: () => remove.mutateAsync(p),
      }),
  };
}

/** Take or choose photos: several at once, from the camera or the library. */
function PhotoInput({ photos }: { photos: EquipmentPhotoList }) {
  return (
    <input
      type="file"
      accept="image/*"
      multiple
      className="sr-only"
      onChange={(e: ChangeEvent<HTMLInputElement>) => {
        const files = [...(e.target.files ?? [])];
        e.target.value = "";
        if (files.length) photos.add(files);
      }}
    />
  );
}

export function EquipmentPhotos({ photos, name }: { photos: EquipmentPhotoList; name: string }) {
  const grid = useListAnimation<HTMLDivElement>();
  const empty = !photos.loading && !photos.photos.length && !photos.uploading;
  return (
    <section className="stack">
      <div className="section-head">
        <h2 className="section-title">Photos</h2>
        {!empty && (
          <label className="btn btn-sm">
            <Icon name="camera" size={16} />
            {photos.uploading ? "Uploading…" : "Add photos"}
            <PhotoInput photos={photos} />
          </label>
        )}
      </div>
      <div className="card card-pad">
        {empty ? (
          <label className="dropzone">
            <Icon name="camera" size={22} />
            <span className="small strong">Add photos</span>
            <span className="muted small">The machine, its VIN plate, the registration card, damage: anything worth a picture.</span>
            <PhotoInput photos={photos} />
          </label>
        ) : (
          <div ref={grid} className="thumbs">
            {photos.loading && [0, 1, 2].map((i) => <Skeleton key={i} height={96} radius={8} />)}
            {photos.photos.map((p) => (
              <div key={p.id} className="thumb">
                {p.url ? <a href={p.url} target="_blank" rel="noreferrer"><img src={p.url} alt={p.file_name ? `${name}: ${p.file_name}` : name} loading="lazy" /></a> : <span className="muted small">Unavailable</span>}
                {photos.canRemove(p) && <button type="button" className="thumb-x" aria-label="Remove photo" onClick={() => photos.remove(p)}><Icon name="x" size={12} strokeWidth={2} /></button>}
              </div>
            ))}
            {Array.from({ length: photos.uploading }, (_, i) => <div key={`u${i}`} className="thumb" style={{ display: "grid", placeItems: "center" }}><span className="spinner" style={{ width: 20, height: 20, color: "var(--text-3)" }} /></div>)}
          </div>
        )}
      </div>
    </section>
  );
}
