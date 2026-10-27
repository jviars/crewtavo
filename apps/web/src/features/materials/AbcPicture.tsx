/**
 * An item's picture in the catalog: ABC's own photo when it has one (through the API, which signs
 * in to ABC for it), else a swatch of its color (Charcoal, Weathered Wood), drawn as shingle
 * courses for shingles and ridge cap, else the icon of what kind of thing it is. ABC's photos are
 * small PNGs on white, so they sit on white in either theme.
 *
 * A swatch is a guess from the color's name (swatchOf), not the manufacturer's color: several
 * colors share one, and a shingle's color is a blend of granules anyway. It says so in its tooltip,
 * and in words under it where it's shown large (`caption`). It's only ever shown to the office.
 */
import { useQuery } from "@tanstack/react-query";
import type { CSSProperties } from "react";
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

export function AbcPicture({ item, icon = "package", caption, className = "" }: { item: { name: string; color?: string | null; image?: string | null }; icon?: IconName; caption?: boolean; className?: string }) {
  const photo = usePhoto(item.image);
  if (photo.data) return <span className={`abc-picture abc-photo ${className}`}><img src={photo.data} alt="" loading="lazy" /></span>;
  const swatch = swatchOf(item.color, item.name);
  const courses = /shingle|ridge|starter/i.test(item.name);
  if (swatch) {
    const tile = <span className={`abc-picture abc-swatch ${courses ? "abc-courses" : ""} ${className}`} style={{ "--swatch": swatch } as CSSProperties} title={APPROXIMATE} aria-hidden="true" />;
    if (!caption) return tile;
    return (
      <span className="abc-figure">
        {tile}
        <span className="abc-caption">Approximate color. ABC has no photo of it, so check a real sample before you choose.</span>
      </span>
    );
  }
  return <span className={`abc-picture abc-icon ${className}`} aria-hidden="true"><Icon name={icon} size={22} /></span>;
}
