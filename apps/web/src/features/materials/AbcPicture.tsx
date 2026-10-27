/**
 * An item's picture in the catalog: ABC's own photo when it has one (through the API, which signs
 * in to ABC for it), else a swatch of its color (Charcoal, Weathered Wood), drawn as shingle
 * courses for shingles and ridge cap, else the icon of what kind of thing it is. ABC's photos are
 * small PNGs on white, so they sit on white in either theme.
 *
 * A swatch is a guess from the color's name (swatchOf), not the manufacturer's color: several
 * colors share one, and a shingle's color is a blend of granules anyway. It says so in its tooltip,
 * and in words under it where it's shown large (`caption`). It's only ever shown to the office.
 *
 * A photo is only asked for once its card is on screen or about to be, so a category of sixty
 * items downloads the dozen in view, not all sixty. Until it comes, the swatch or icon shows.
 */
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Icon, type IconName } from "@/components/ui/Icon";
import { api } from "@/lib/api";
import { useSession } from "@/lib/session";
import { swatchOf } from "./data";

/** ABC's photo as a data URL, kept for the session: it doesn't change, and there's no sign-in in a data URL. */
function usePhoto(asset: string | null | undefined) {
  const { company } = useSession();
  return useQuery({
    queryKey: ["abc-image", company.id, asset],
    enabled: Boolean(asset),
    staleTime: Infinity,
    gcTime: 30 * 60_000,
    retry: false,
    queryFn: async () => {
      const blob = await api.blob(`/materials/images/${encodeURIComponent(asset!)}`);
      if (!blob) return null;
      return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });
    },
  });
}

const APPROXIMATE = "Approximate color, from its name. ABC has no photo of it.";

/** True once the element is on screen or within a few hundred pixels of it. */
function useNearScreen(enabled: boolean) {
  const ref = useRef<HTMLSpanElement>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    if (near || !enabled) return;
    const element = ref.current;
    if (!element || typeof IntersectionObserver === "undefined") return setNear(true);
    const watcher = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setNear(true);
        watcher.disconnect();
      }
    }, { rootMargin: "300px" });
    watcher.observe(element);
    return () => watcher.disconnect();
  }, [near, enabled]);
  return { ref, near };
}

export function AbcPicture({ item, icon = "package", caption, className = "" }: { item: { name: string; color?: string | null; image?: string | null }; icon?: IconName; caption?: boolean; className?: string }) {
  const { ref, near } = useNearScreen(Boolean(item.image));
  const photo = usePhoto(near ? item.image : null);
  // For anyone checking how pictures load: loading, shown, or none (ABC had none after all).
  const state = !item.image ? undefined : photo.data ? "shown" : photo.isFetched ? "none" : "loading";
  if (photo.data) return <span ref={ref} data-photo={state} className={`abc-picture abc-photo ${className}`}><img src={photo.data} alt="" /></span>;
  const swatch = swatchOf(item.color, item.name);
  const courses = /shingle|ridge|starter/i.test(item.name);
  if (swatch) {
    const tile = <span ref={caption ? undefined : ref} data-photo={caption ? undefined : state} className={`abc-picture abc-swatch ${courses ? "abc-courses" : ""} ${className}`} style={{ "--swatch": swatch } as CSSProperties} title={APPROXIMATE} aria-hidden="true" />;
    if (!caption) return tile;
    return (
      <span ref={ref} data-photo={state} className="abc-figure">
        {tile}
        <span className="abc-caption">Approximate color. ABC has no photo of it, so check a real sample before you choose.</span>
      </span>
    );
  }
  return <span ref={ref} data-photo={state} className={`abc-picture abc-icon ${className}`} aria-hidden="true"><Icon name={icon} size={22} /></span>;
}
