/**
 * Add, rename, reorder and remove knowledge base categories, and give them cover photos (KB-Extras,
 * Categories). Hairline rows: a handle to drag (or move with the arrow keys), the photo (or, without
 * one, the color and icon its card has on the knowledge base), the name to type over, how many guides
 * it holds, and Remove. Changes save as you make them.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState, type ButtonHTMLAttributes, type FormEvent, type KeyboardEvent, type PointerEvent } from "react";
import { Button, cx, Spinner, useJustDone } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Dialog } from "@/components/ui/Dialog";
import { Icon } from "@/components/ui/Icon";
import { Menu } from "@/components/ui/Menu";
import { Skeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/States";
import { supabase, unwrap } from "@/lib/api";
import { coverPicture, uploadFile } from "@/lib/files";
import { useListAnimation } from "@/lib/motion";
import { useSession } from "@/lib/session";
import { categoryLook, GuideCover, GuideTile, type CategoryLook } from "./GuideCover";
import { useCategories } from "./kbData";
import s from "./kbWrite.module.css";

interface Category { id: string; name: string; sort: number; cover_path: string | null }
type GripProps = Pick<ButtonHTMLAttributes<HTMLButtonElement>, "onPointerDown" | "onKeyDown">;

/** The list with one row moved from one place to another. */
const moved = <T,>(list: readonly T[], from: number, to: number) => {
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
};

export function CategoriesDialog({ onClose, counts }: { onClose: () => void; counts: (id: string) => number }) {
  const { company } = useSession();
  const queryClient = useQueryClient();
  const categories = useCategories();
  const key = ["kb", company.id, "categories"];
  const [name, setName] = useState("");
  const [said, setSaid] = useState("");
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["kb", company.id] });

  const add = useMutation({
    // The new row appearing, and the button, say it worked.
    meta: { inline: true },
    mutationFn: async (value: string) => {
      const list = categories.data ?? [];
      if (list.some((c) => c.name.toLowerCase() === value.toLowerCase())) throw new Error("There's already a category with that name.");
      unwrap(await supabase().from("sop_categories").insert({ company_id: company.id, name: value, sort: (list.at(-1)?.sort ?? 0) + 1 }));
    },
    onSuccess: () => { setName(""); refresh(); },
  });
  const rename = useMutation({
    meta: { success: "Category renamed" },
    mutationFn: async ({ id, value }: { id: string; value: string }) => unwrap(await supabase().from("sop_categories").update({ name: value }).eq("id", id)),
    onSettled: refresh,
  });
  // Shown in its new place at once; every category's place is saved.
  const reorder = useMutation({
    mutationFn: async ({ from, to }: { from: number; to: number }) => {
      const list = moved(categories.data ?? [], from, to);
      queryClient.setQueryData<Category[]>(key, list.map((c, i) => ({ ...c, sort: i })));
      await Promise.all(list.map((c, i) => supabase().from("sop_categories").update({ sort: i }).eq("id", c.id).then((r) => unwrap(r))));
    },
    onSettled: refresh,
  });
  const remove = useMutation({
    meta: { success: "Category removed" },
    // Its cover photo goes to the Trash with it, by itself (20261102000100_category_covers_kept.sql).
    mutationFn: async (id: string) => unwrap(await supabase().from("sop_categories").delete().eq("id", id)),
    onSettled: refresh,
  });

  const added = useJustDone(add);
  const listRef = useListAnimation<HTMLUListElement>();
  const rows = useRef<HTMLUListElement | null>(null);
  // The list animates rows into their new places, and is measured while a row is dragged.
  const listRefs = useCallback((el: HTMLUListElement | null) => {
    rows.current = el;
    listRef(el);
  }, [listRef]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) add.mutate(name.trim());
  };

  // Dragging a row by its handle: where it was, and where it would go if let go now.
  const [drag, setDrag] = useState<{ id: string; name: string; from: number; to: number; mids: number[] } | null>(null);
  const list = categories.data ?? [];
  const shown = drag ? moved(list, drag.from, drag.to) : list;
  const place = (from: number, to: number, c: { name: string }) => {
    if (to < 0 || to >= list.length || to === from) return;
    reorder.mutate({ from, to });
    setSaid(`${c.name} moved to ${to + 1} of ${list.length}`);
  };
  // The pointer is followed on the window: the dragged row moves in the list as it goes, which
  // takes the pointer capture off its handle, and the pointer can wander off the handle too.
  const dragNow = useRef(drag);
  dragNow.current = drag;
  const placeNow = useRef(place);
  placeNow.current = place;
  const dragging = drag !== null;
  useEffect(() => {
    if (!dragging) return;
    const move = (e: globalThis.PointerEvent) => {
      const d = dragNow.current;
      if (!d) return;
      const to = d.mids.filter((m, k) => k !== d.from && m < e.clientY).length;
      if (to !== d.to) setDrag({ ...d, to });
    };
    const end = (e: globalThis.PointerEvent) => {
      const d = dragNow.current;
      setDrag(null);
      if (d && e.type === "pointerup") placeNow.current(d.from, d.to, d);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
  }, [dragging]);
  const grip = (c: Category, i: number): GripProps => ({
    onPointerDown: (e: PointerEvent<HTMLButtonElement>) => {
      if (e.button !== 0 || reorder.isPending) return;
      const mids = [...(rows.current?.querySelectorAll<HTMLElement>("[data-cat]") ?? [])].map((r) => {
        const box = r.getBoundingClientRect();
        return box.top + box.height / 2;
      });
      setDrag({ id: c.id, name: c.name, from: i, to: i, mids });
    },
    onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => {
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      e.preventDefault();
      if (!reorder.isPending) place(i, i + (e.key === "ArrowUp" ? -1 : 1), c);
    },
  });

  return (
    <Dialog open onClose={onClose} title="Categories" description="A category's photo shows on its card in the knowledge base.">
      <div className={cx("dialog-body", s.catsBody)}>
        {categories.isPending ? (
          <div className={s.catsSkel} aria-busy="true" aria-label="Loading">{[0, 1, 2].map((i) => <Skeleton key={i} height={40} radius={8} />)}</div>
        ) : categories.data?.length === 0 ? (
          <EmptyState inline title="No categories yet" />
        ) : (
          <ul className={s.cats} aria-label="Categories" ref={listRefs} data-dragging={dragging || undefined}>
            {shown.map((c) => (
              <CategoryRow
                key={c.id}
                category={c}
                look={categoryLook(c.name, list.indexOf(c))}
                count={counts(c.id)}
                dragging={drag?.id === c.id}
                grip={grip(c, list.indexOf(c))}
                onRename={(value) => rename.mutate({ id: c.id, value })}
                onRemove={async () => {
                  const n = counts(c.id);
                  if (await confirm({ title: `Remove “${c.name}”?`, body: n ? `Its ${n} ${n === 1 ? "guide moves" : "guides move"} to Uncategorized. Nothing is deleted.` : "This category is empty.", confirmLabel: "Remove", danger: true })) remove.mutate(c.id);
                }}
              />
            ))}
          </ul>
        )}
        <span className="sr-only" role="status">{said}</span>
        <form className={s.addrow} style={{ marginTop: 14 }} onSubmit={submit}>
          <input
            className="input"
            value={name}
            onChange={(e) => { setName(e.target.value); add.reset(); }}
            placeholder="New category, e.g. Equipment"
            maxLength={60}
            aria-label="New category name"
            aria-invalid={add.isError || undefined}
            aria-describedby={add.isError ? "new-category-error" : undefined}
          />
          <Button type="submit" icon="plus" loading={add.isPending} done={added} doneLabel="Added" disabled={!name.trim() && !added}>Add</Button>
        </form>
        {add.error instanceof Error && <p className={s.err} id="new-category-error" role="alert">{add.error.message}</p>}
      </div>
      <div className="form-actions">
        <span className={s.footNote}>Drag a row by its handle to reorder. Changes save as you make them.</span>
        <Button variant="primary" onClick={onClose}>Done</Button>
      </div>
    </Dialog>
  );
}

/** One category: its handle, photo, name (typed over to rename it), how many guides it holds, and Remove. */
function CategoryRow({ category: c, look, count, dragging, grip, onRename, onRemove }: {
  category: Category;
  look: CategoryLook | null;
  count: number;
  dragging: boolean;
  grip: GripProps;
  onRename: (value: string) => void;
  onRemove: () => void;
}) {
  const [typing, setTyping] = useState(false);
  return (
    <li className={s.cat} data-cat="" data-dragging={dragging || undefined}>
      <button type="button" className={s.grip} aria-label={`Move ${c.name}: drag, or press the arrow keys`} title="Drag to reorder" {...grip}>
        <Icon name="grip" size={15} />
      </button>
      <CategoryPhoto category={c} look={look} />
      <input
        className={s.name}
        defaultValue={c.name}
        maxLength={60}
        aria-label={`Name of ${c.name}`}
        onChange={(e) => setTyping(e.target.value.trim() !== c.name)}
        onBlur={(e) => {
          setTyping(false);
          const value = e.target.value.trim();
          if (!value) e.target.value = c.name;
          else if (value !== c.name) onRename(value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.currentTarget.blur();
          } else if (e.key === "Escape" && typing) {
            // Puts the name back, rather than closing the dialog.
            e.preventDefault();
            e.currentTarget.value = c.name;
            setTyping(false);
          }
        }}
      />
      <span className={s.cnt}>
        {typing ? <><kbd className="kbd" aria-hidden="true">↵</kbd>to save</> : `${count} ${count === 1 ? "guide" : "guides"}`}
      </span>
      <button type="button" className={s.iconBtn} aria-label={`Remove ${c.name}`} title="Remove" onClick={onRemove}>
        <Icon name="trash" size={15} />
      </button>
    </li>
  );
}

/**
 * A category's cover photo: its thumbnail opens a menu to change or remove it. Without one it shows
 * the color and icon the category's card has, and adds a photo (a picture icon over it says so).
 */
function CategoryPhoto({ category, look }: { category: { id: string; name: string; cover_path: string | null }; look: CategoryLook | null }) {
  const { company } = useSession();
  const queryClient = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const save = useMutation({
    meta: { success: (_: unknown, file: File | null) => (file ? "Photo saved" : "Photo removed") },
    mutationFn: async (file: File | null) => {
      let path: string | null = null;
      if (file) {
        const jpeg = await coverPicture(file);
        if (!jpeg) throw new Error("Crewtavo can't open that picture here. Try a JPEG or PNG.");
        path = await uploadFile(company.id, "kb", new File([jpeg], "cover.jpg", { type: "image/jpeg" }));
      }
      // The cover it had goes to the Trash by itself. A new one uploaded for a save that fails is left
      // behind: only the server deletes stored files.
      unwrap(await supabase().from("sop_categories").update({ cover_path: path }).eq("id", category.id));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["kb", company.id] }),
  });
  const pick = () => input.current?.click();
  return (
    <>
      {save.isPending ? (
        <span className={s.photo} role="status" aria-label="Saving the photo"><Spinner size={14} /></span>
      ) : category.cover_path ? (
        <Menu
          label={`Photo for ${category.name}`}
          title={`Photo for ${category.name}`}
          trigger={<GuideCover path={category.cover_path} />}
          triggerClassName={s.photo}
          align="start"
          items={[
            { label: "Change photo", icon: "image", onSelect: pick },
            { label: "Remove photo", icon: "trash", onSelect: () => save.mutate(null) },
          ]}
        />
      ) : (
        <button type="button" className={s.photo} data-look="" aria-label={`Add a photo for ${category.name}`} title="Add a photo" onClick={pick}>
          <GuideTile path={null} look={look} />
          <span className={s.photoAdd} aria-hidden="true"><Icon name="image" size={15} /></span>
        </button>
      )}
      <input ref={input} type="file" accept="image/*,.heic,.heif" hidden onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ""; if (file) save.mutate(file); }} />
    </>
  );
}
