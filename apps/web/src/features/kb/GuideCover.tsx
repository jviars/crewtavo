/** A guide's cover photo (sop_pages.cover_path, in the private files bucket), or a book when it has none or the photo can't load. */
import { useState } from "react";
import { usePhotoUrl } from "@/components/ui/Avatar";
import { Icon } from "@/components/ui/Icon";

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
