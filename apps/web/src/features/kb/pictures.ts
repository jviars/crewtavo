/**
 * Pictures in a guide: added in the guide editor (the Picture button, or pasting or dropping one),
 * stored in the company's private kb/ folder, and saved in the guide by their path
 * (<img data-path="…">). Each is shown with a short-lived link, asked for as the guide is shown (the
 * database keeps them while any version of a guide shows them: 20261108000400_guide_pictures.sql).
 */
import { useQueries } from "@tanstack/react-query";
import { useMemo } from "react";
import { photoQuery } from "@/components/ui/Avatar";
import { coverPicture } from "@/lib/files";

/** What the Picture button's file picker offers. */
export const PICTURE_ACCEPT = "image/*,.heic,.heif";

/** The stored pictures a guide's HTML names, each once. */
export function picturePaths(html: string): string[] {
  return [...new Set([...html.matchAll(/data-path="([^"]+)"/g)].map((m) => m[1]))];
}

/**
 * A picture from the computer or phone, ready to store: a JPEG at most 1600 pixels across (as a
 * cover photo is), with its size. Null when the browser can't open it (HEIC in some browsers).
 */
export async function guidePicture(file: File): Promise<{ file: File; width: number; height: number } | null> {
  const jpeg = await coverPicture(file);
  if (!jpeg) return null;
  const bitmap = await createImageBitmap(jpeg).catch(() => null);
  const size = { width: bitmap?.width ?? 0, height: bitmap?.height ?? 0 };
  bitmap?.close();
  return { file: new File([jpeg], "picture.jpg", { type: "image/jpeg" }), ...size };
}

/** A guide's HTML (sanitized) with its stored pictures' links filled in as they come, each loading as it scrolls into view. */
export function useGuidePictures(html: string): string {
  const paths = useMemo(() => picturePaths(html), [html]);
  const links = useQueries({ queries: paths.map((path) => photoQuery(path)) });
  const ready = links.map((l) => l.data ?? "").join("\n");
  return useMemo(() => {
    if (!html.includes("<img")) return html;
    const urls = new Map(paths.map((path, i) => [path, links[i]?.data ?? null]));
    const doc = new DOMParser().parseFromString(html, "text/html");
    for (const img of doc.querySelectorAll("img")) {
      img.setAttribute("loading", "lazy");
      img.setAttribute("decoding", "async");
      const url = urls.get(img.getAttribute("data-path") ?? "");
      if (url) img.setAttribute("src", url);
    }
    return doc.body.innerHTML;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [html, ready]);
}
