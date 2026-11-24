/**
 * Pasting files to add them: a screenshot, or files copied in the computer's file manager, pasted
 * anywhere on a page with a Plans and files card or on Drive go where Add files or Upload would put
 * them. Not while typing (a pasted picture in a text box or an editor is the editor's), and only in
 * the layer the card is in: the page, or the dialog it's in (a snow customer's details), never with
 * the file viewer or another dialog open over it.
 */
import { useEffect, useRef, type RefObject } from "react";
import { englishDateLocale, formatDate } from "@/lib/format";

/** What browsers call a picture that came from the clipboard rather than from a file. */
const CLIPBOARD_NAME = /^image\.(png|jpe?g|gif|webp|bmp|tiff?)$/i;

/**
 * A name for a pasted picture that has none of its own ("image.png", from a screenshot):
 * "Pasted picture Nov 18, 2026 4.05 PM.png", so it can be told apart from the next one. Null for a
 * file with a name of its own (copied in the file manager), which keeps it.
 */
export function pastedName(name: string, type: string, now: Date): string | null {
  if (name && !CLIPBOARD_NAME.test(name)) return null;
  const ext = name.match(/\.([a-z]+)$/i)?.[1]?.toLowerCase() ?? type.match(/^image\/([a-z]+)/i)?.[1]?.toLowerCase().replace("jpeg", "jpg") ?? "png";
  // A colon can't be in a file name on Windows, or shows as a slash on a Mac.
  const time = now.toLocaleTimeString(englishDateLocale(), { hour: "numeric", minute: "2-digit" }).replace(":", ".");
  return `Pasted picture ${formatDate(now)} ${time}.${ext}`;
}

function typing(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])'));
}

/** A dialog, or the file viewer (a layer of its own). */
const LAYER = 'dialog[open], [role="dialog"][aria-modal="true"]';

/**
 * Nothing is open over `here`: every dialog or viewer that's open has it inside. Not where focus
 * is, which can fall back to <body> under the viewer.
 */
const onTop = (here: Element) => [...document.querySelectorAll(LAYER)].every((layer) => layer.contains(here));

/**
 * The files in a paste that `here` (the card, the Drive page) should add, named (pastedName); none
 * when it isn't for it: with the file viewer or another dialog open over it.
 */
export function pastedFiles(e: ClipboardEvent, here: Element | null, now = new Date()): File[] {
  if (e.defaultPrevented || !here || typing(e.target) || !onTop(here)) return [];
  return [...(e.clipboardData?.files ?? [])].map((file) => {
    const name = pastedName(file.name, file.type, now);
    return name ? new File([file], name, { type: file.type, lastModified: file.lastModified }) : file;
  });
}

/** Calls `onFiles` with files pasted where `here` is, while it's given (null: pasting adds nothing here). */
export function usePastedFiles(here: RefObject<Element>, onFiles: ((files: File[]) => void) | null) {
  const latest = useRef(onFiles);
  latest.current = onFiles;
  const on = Boolean(onFiles);
  useEffect(() => {
    if (!on) return;
    const listener = (e: ClipboardEvent) => {
      const files = pastedFiles(e, here.current);
      if (!files.length || !latest.current) return;
      e.preventDefault();
      latest.current(files);
    };
    document.addEventListener("paste", listener);
    return () => document.removeEventListener("paste", listener);
  }, [on, here]);
}
