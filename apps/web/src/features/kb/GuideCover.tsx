/**
 * A guide's cover photo (sop_pages.cover_path, in the private files bucket), or a book when it has none
 * or the photo can't load. In a list a guide shows as a small tile (GuideTile): its own photo, or its
 * category's look (a flat color and a subject icon, KB-Home.dc.html), so a list isn't a column of books.
 */
import { useState } from "react";
import { usePhotoUrl } from "@/components/ui/Avatar";
import { cx } from "@/components/ui/Button";
import { Icon, type IconName } from "@/components/ui/Icon";
import s from "./kb.module.css";

export function GuideCover({ path, src, className }: { path: string | null; /** A picture that isn't saved yet (the editor's preview). */ src?: string | null; className?: string }) {
  const signed = usePhotoUrl(src ? null : path);
  const url = src ?? signed;
  const [broken, setBroken] = useState<string | null>(null);
  const empty = (!src && !path) || (url !== null && broken === url);
  return (
    <span className={className ? `guide-cover ${className}` : "guide-cover"} data-empty={empty || undefined}>
      {empty ? <Icon name="book" size={28} /> : url && <img src={url} alt="" decoding="async" draggable={false} onError={() => setBroken(url)} />}
    </span>
  );
}

/** Flat colors white reads on, in both themes: a category takes one by its place in the list, so neighbours differ. */
const TILE_COLORS = ["#a0602a", "#4a7a32", "#5a7790", "#57546f", "#7a6a2e", "#3f6f6a", "#8a4b5c", "#55617a"];

/** A subject icon from a category's name; a book when nothing fits. */
const SUBJECTS: Array<[RegExp, IconName]> = [
  [/safe|hazard|ppe|injur|emergenc|first aid|seguridad/, "alert"],
  [/snow|ice|winter|plow|nieve/, "snow"],
  [/salt/, "salt"],
  [/roof/, "roofing"],
  [/strip|layout|measur/, "ruler"],
  [/pav|asphalt|seal|concrete|drive ?way/, "paving"],
  [/truck|vehicle|fleet|equip|machine|trailer/, "truck"],
  [/tool|repair|maint|shop/, "wrench"],
  [/role|job desc|hr|people|team|staff|train|hiring/, "users"],
  [/client|customer|service|sales/, "clients"],
  [/money|financ|pric|estimat|billing|invoice|account/, "calculator"],
  [/market/, "megaphone"],
  [/field|site|route/, "map"],
  [/office|admin|policy|polic/, "clipboard"],
];

export interface CategoryLook { color: string; icon: IconName }

/** How a category draws where it has no photo. `index` is its place in the sorted list (null: no category). */
export function categoryLook(name: string | null | undefined, index: number): CategoryLook | null {
  if (name == null || index < 0) return null;
  const words = name.toLowerCase();
  const icon = SUBJECTS.find(([re]) => re.test(words))?.[1] ?? "book";
  return { color: TILE_COLORS[index % TILE_COLORS.length]!, icon };
}

/**
 * A guide or category as a small square tile: its photo when it has one, else the category's color
 * and icon, else a quiet book. Its size comes from the place it's in (CSS).
 */
export function GuideTile({ path, look, className }: { path: string | null; look: CategoryLook | null; className?: string }) {
  const url = usePhotoUrl(path);
  const [broken, setBroken] = useState<string | null>(null);
  const photo = path && url && broken !== url;
  return (
    <span className={cx(s.guideTile, className)} style={photo || !look ? undefined : { background: look.color }} data-look={photo ? "photo" : look ? "color" : "none"} aria-hidden="true">
      {photo ? <img src={url} alt="" decoding="async" draggable={false} onError={() => setBroken(url)} /> : <Icon name={look?.icon ?? "book"} size={18} />}
    </span>
  );
}
