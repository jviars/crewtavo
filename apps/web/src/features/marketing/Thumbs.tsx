/**
 * The picture at the start of a showcase's or a postcard's row, as a social post has its photo
 * (Social's PostThumb, the same .post-thumb tile): a job photo (its marked-up copy when that's the
 * one used) or an uploaded file, signed for an hour. Until it loads, or with no picture, the tile
 * shows an icon instead.
 */
import { useQuery } from "@tanstack/react-query";
import { Icon, type IconName } from "@/components/ui/Icon";
import { supabase, unwrap } from "@/lib/api";
import { signedUrls } from "@/lib/files";
import { useSession } from "@/lib/session";

/** One row's picture: a job photo's attachment, or a file's own path. */
export type ThumbPick = { key: string; attachmentId?: string | null; marked?: boolean; path?: string | null };

/** Signed links for each row's picture, by its key. Missing ones are left out. */
export function useThumbs(picks: ThumbPick[]) {
  const session = useSession();
  const shown = picks.filter((p) => p.attachmentId || p.path);
  return useQuery({
    queryKey: ["marketing-thumbs", session.company.id, shown.map((p) => `${p.key}:${p.attachmentId ?? p.path}:${p.marked ? 1 : 0}`).join("|")],
    enabled: shown.length > 0,
    // Links last an hour: fetched again well before they stop working.
    staleTime: 30 * 60_000,
    meta: { silent: true },
    queryFn: async () => {
      const ids = [...new Set(shown.flatMap((p) => (p.attachmentId ? [p.attachmentId] : [])))];
      const files = ids.length ? unwrap(await supabase().from("attachments").select("id, path, marked_path").in("id", ids)) : [];
      const byId = new Map(files.map((f) => [f.id, f]));
      const pathOf = (p: ThumbPick) => {
        const file = p.attachmentId ? byId.get(p.attachmentId) : null;
        return file ? ((p.marked && file.marked_path) || file.path) : (p.path ?? null);
      };
      const urls = await signedUrls(shown.flatMap((p) => pathOf(p) ?? [])).catch(() => ({}) as Record<string, string>);
      return Object.fromEntries(shown.flatMap((p) => {
        const url = urls[pathOf(p) ?? ""];
        return url ? [[p.key, url]] : [];
      })) as Record<string, string>;
    },
  });
}

export function Thumb({ url, icon = "image" }: { url?: string | null; icon?: IconName }) {
  return url ? <div className="post-thumb"><img src={url} alt="" loading="lazy" /></div> : <div className="post-thumb"><Icon name={icon} size={18} /></div>;
}
