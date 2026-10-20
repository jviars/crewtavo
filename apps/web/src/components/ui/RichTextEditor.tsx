/**
 * A small rich-text editor (contenteditable) for SOPs and long notes: headings, bold/italic/
 * underline, lists, quotes, links, dividers and YouTube or Vimeo videos, with Markdown-style
 * shortcuts ("## ", "- ", "1. ", "> ") and sanitized paste. Output is sanitized HTML plus plain
 * text for search.
 */
import { videoFromPaste, videoIframe, type VideoEmbed } from "@crewtavo/core/video";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { hasContent, sanitizeHtml, textToHtml } from "@/lib/html";
import { Icon, type IconName } from "./Icon";

type Block = "p" | "h2" | "h3" | "blockquote";
interface Active { bold: boolean; italic: boolean; underline: boolean; ul: boolean; ol: boolean; block: Block | null }

const exec = (command: string, value?: string) => document.execCommand(command, false, value);

/** The line (block) the caret is on, or null when the caret sits straight in the editor. */
function caretLine(root: HTMLElement): HTMLElement | null {
  const node = document.getSelection()?.anchorNode ?? null;
  const line = (node instanceof Element ? node : node?.parentElement)?.closest<HTMLElement>("p, h2, h3, h4, li, blockquote, pre") ?? null;
  return line && root.contains(line) ? line : null;
}

const isBlank = (el: Element) => !el.textContent?.trim() && !el.querySelector("img, iframe, hr");

/**
 * Each video gets a line of its own that can't be typed into, so Backspace takes the video out
 * whole instead of pulling the next line in beside it. Saving drops the marker (sanitizeHtml).
 */
function lockVideos(root: HTMLElement) {
  root.querySelectorAll("iframe").forEach((frame) => {
    let line = frame.parentElement;
    if (line === root) {
      line = document.createElement("p");
      frame.replaceWith(line);
      line.append(frame);
    }
    if (line && [...line.childNodes].every((n) => n === frame || n.nodeName === "BR" || (n.nodeType === Node.TEXT_NODE && !n.textContent?.trim()))) line.contentEditable = "false";
  });
  // A line to type on after a video at the very end.
  if (root.lastElementChild?.getAttribute("contenteditable") === "false") root.append(Object.assign(document.createElement("p"), { innerHTML: "<br>" }));
}

/** The video line just before the caret (at the start of its line) or just after it (at the end of its line). */
function videoBeside(root: HTMLElement, side: "before" | "after"): Element | null {
  const sel = document.getSelection();
  const line = caretLine(root);
  if (!sel?.isCollapsed || !sel.anchorNode || !line) return null;
  const between = document.createRange();
  between.selectNodeContents(line);
  if (side === "before") between.setEnd(sel.anchorNode, sel.anchorOffset);
  else between.setStart(sel.anchorNode, sel.anchorOffset);
  if (between.toString() || between.cloneContents().querySelector("img, iframe, hr")) return null;
  const video = side === "before" ? line.previousElementSibling : line.nextElementSibling;
  return video?.getAttribute("contenteditable") === "false" && video.querySelector("iframe") ? video : null;
}

function caretTo(node: Node, atEnd: boolean) {
  const r = document.createRange();
  r.selectNodeContents(node);
  r.collapse(!atEnd);
  document.getSelection()?.removeAllRanges();
  document.getSelection()?.addRange(r);
}

/** Browsers can nest a new list inside the paragraph it came from (<p><ul>…</ul></p>); lift it out, keeping the caret. */
function liftLists(root: HTMLElement) {
  const sel = document.getSelection();
  const node = sel?.anchorNode ?? null;
  const offset = sel?.anchorOffset ?? 0;
  let moved = false;
  root.querySelectorAll("p > ul, p > ol").forEach((list) => {
    const p = list.parentElement!;
    if ([...p.childNodes].every((n) => n === list || n.nodeName === "BR" || (n.nodeType === Node.TEXT_NODE && !n.textContent?.trim()))) {
      p.replaceWith(list);
      moved = true;
    }
  });
  if (moved && node && sel && root.contains(node)) {
    const r = document.createRange();
    r.setStart(node, Math.min(offset, node.nodeType === Node.TEXT_NODE ? (node.textContent ?? "").length : node.childNodes.length));
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
  }
}

export function RichTextEditor({ initialHtml, onChange, placeholder = "Start writing…", minHeight = 320, label = "Content" }: { initialHtml: string; onChange: (html: string, text: string) => void; placeholder?: string; minHeight?: number; label?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const savedRange = useRef<Range | null>(null);
  const [active, setActive] = useState<Active>({ bold: false, italic: false, underline: false, ul: false, ol: false, block: null });
  const [empty, setEmpty] = useState(() => !hasContent(initialHtml));
  const [linking, setLinking] = useState<string | null>(null);
  const [videoForm, setVideoForm] = useState<{ error: boolean } | null>(null);
  const videoErrorId = useId();

  useEffect(() => {
    if (ref.current) {
      ref.current.innerHTML = sanitizeHtml(initialHtml);
      lockVideos(ref.current);
    }
    // Only on mount: re-setting innerHTML while typing would move the caret.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const update = () => {
      const el = ref.current;
      const sel = document.getSelection();
      if (!el || !sel?.anchorNode || !el.contains(sel.anchorNode)) return;
      const block = String(document.queryCommandValue("formatBlock") || "").toLowerCase().replace(/[<>]/g, "");
      setActive({
        bold: document.queryCommandState("bold"),
        italic: document.queryCommandState("italic"),
        underline: document.queryCommandState("underline"),
        ul: document.queryCommandState("insertUnorderedList"),
        ol: document.queryCommandState("insertOrderedList"),
        block: (["p", "h2", "h3", "blockquote"].includes(block) ? block : null) as Block | null,
      });
    };
    document.addEventListener("selectionchange", update);
    return () => document.removeEventListener("selectionchange", update);
  }, []);

  const emit = () => {
    const el = ref.current;
    if (!el) return;
    lockVideos(el);
    const text = el.innerText.trim();
    setEmpty(!text && !el.querySelector("img, hr, iframe"));
    onChange(sanitizeHtml(el.innerHTML), text);
  };
  const run = (command: string, value?: string) => {
    ref.current?.focus();
    exec(command, value);
    if (ref.current && command.endsWith("List")) liftLists(ref.current);
    emit();
  };
  const toggleBlock = (block: Block) => run("formatBlock", active.block === block ? "<p>" : `<${block}>`);

  const openLink = () => {
    const sel = document.getSelection();
    if (!sel?.rangeCount || !ref.current?.contains(sel.anchorNode)) return ref.current?.focus();
    savedRange.current = sel.getRangeAt(0).cloneRange();
    const anchor = (sel.anchorNode?.parentElement as HTMLElement | null)?.closest("a");
    setVideoForm(null);
    setLinking(anchor?.getAttribute("href") ?? "");
  };
  const applyLink = (raw: string) => {
    const sel = document.getSelection();
    ref.current?.focus();
    if (savedRange.current && sel) {
      sel.removeAllRanges();
      sel.addRange(savedRange.current);
    }
    const url = raw.trim();
    if (!url) exec("unlink");
    else {
      const href = /^(https?:|mailto:|tel:)/i.test(url) ? url : /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(url) ? `mailto:${url}` : `https://${url}`;
      if (sel?.isCollapsed) exec("insertHTML", `<a href="${href.replace(/"/g, "&quot;")}">${url.replace(/[<>&]/g, "")}</a>`);
      else exec("createLink", href);
    }
    setLinking(null);
    emit();
  };

  /** Puts a video on a line of its own: the caret's line when it's empty, otherwise a new line after it. */
  const insertVideo = (video: VideoEmbed) => {
    const el = ref.current;
    if (!el) return;
    const inside = el.contains(document.getSelection()?.anchorNode ?? null);
    el.focus();
    if (!inside) caretTo(el, true);
    const line = caretLine(el);
    if (!isBlank(line ?? el)) {
      caretTo(line ?? el, true);
      exec("insertParagraph");
    }
    // Inserted already locked (see lockVideos), so Undo can take it out again.
    exec("insertHTML", `<p contenteditable="false" data-new-video>${videoIframe(video)}</p>`);
    const added = el.querySelector("[data-new-video]");
    added?.removeAttribute("data-new-video");
    // Carry on below the video: on the next line, or on a new one when there's none to type on.
    let after: Element | null = added;
    while (after && after !== el && !after.nextElementSibling) after = after.parentElement;
    let next = after && after !== el ? after.nextElementSibling : null;
    if (!next || next.getAttribute("contenteditable") === "false") {
      const blank = Object.assign(document.createElement("p"), { innerHTML: "<br>" });
      if (next) next.before(blank);
      else el.append(blank);
      next = blank;
    }
    caretTo(next, false);
    emit();
  };
  const openVideo = () => {
    const sel = document.getSelection();
    const el = ref.current;
    if (!el) return;
    // Where the caret was, or the end when it wasn't in the editor.
    if (sel?.rangeCount && el.contains(sel.anchorNode)) savedRange.current = sel.getRangeAt(0).cloneRange();
    else {
      savedRange.current = document.createRange();
      savedRange.current.selectNodeContents(el);
      savedRange.current.collapse(false);
    }
    setLinking(null);
    setVideoForm({ error: false });
  };
  const closeVideo = () => {
    setVideoForm(null);
    ref.current?.focus();
  };
  const addVideo = (raw: string) => {
    const video = videoFromPaste(raw);
    if (!video) return setVideoForm({ error: true });
    setVideoForm(null);
    const sel = document.getSelection();
    ref.current?.focus();
    if (savedRange.current && sel) {
      sel.removeAllRanges();
      sel.addRange(savedRange.current);
    }
    insertVideo(video);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "k") {
      e.preventDefault();
      openLink();
      return;
    }
    // Backspace or Delete next to a video takes out just the video; the browser would also join the lines around it.
    const video = (e.key === "Backspace" || e.key === "Delete") && !mod && !e.altKey && videoBeside(e.currentTarget, e.key === "Backspace" ? "before" : "after");
    if (video) {
      e.preventDefault();
      video.remove();
      emit();
    }
  };

  // Markdown-style shortcuts at the start of a paragraph ("## " -> heading, "- " -> list...).
  // Listens to beforeinput so it works with any keyboard, IME or autocorrect.
  const emitRef = useRef(emit);
  emitRef.current = emit;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onBeforeInput = (e: InputEvent) => {
      if (e.inputType !== "insertText" || e.data !== " ") return;
      const sel = document.getSelection();
      const node = sel?.anchorNode;
      if (!sel?.isCollapsed || !node || node.nodeType !== Node.TEXT_NODE) return;
      const before = (node.textContent ?? "").slice(0, sel.anchorOffset);
      const block = (node.parentElement as HTMLElement | null)?.closest("p, div, h2, h3, li, blockquote");
      if (!block || block.tagName === "LI" || (block !== el && node !== block.firstChild) || (block === el && node.previousSibling)) return;
      const shortcuts: Record<string, () => void> = {
        "#": () => exec("formatBlock", "<h2>"),
        "##": () => exec("formatBlock", "<h3>"),
        "-": () => exec("insertUnorderedList"),
        "*": () => exec("insertUnorderedList"),
        "1.": () => exec("insertOrderedList"),
        ">": () => exec("formatBlock", "<blockquote>"),
        "---": () => exec("insertHorizontalRule"),
      };
      const apply = shortcuts[before];
      if (!apply) return;
      e.preventDefault();
      // Remove the marker. An empty block needs a <br> so the caret (and the formatting) stays in it.
      const rest = (node.textContent ?? "").slice(before.length);
      const range = document.createRange();
      if (rest) {
        node.textContent = rest;
        range.setStart(node, 0);
      } else {
        const host = node.parentNode as Node;
        (node as ChildNode).remove();
        if (!host.firstChild) host.appendChild(document.createElement("br"));
        range.setStart(host, 0);
      }
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
      apply();
      liftLists(el);
      emitRef.current();
    };
    el.addEventListener("beforeinput", onBeforeInput);
    return () => el.removeEventListener("beforeinput", onBeforeInput);
  }, []);

  const tool = (icon: IconName, title: string, onClick: () => void, pressed?: boolean) => (
    <button type="button" className="rte-btn" title={title} aria-label={title} aria-pressed={pressed} onMouseDown={(e) => e.preventDefault()} onClick={onClick}>
      <Icon name={icon} size={16} strokeWidth={pressed ? 2.4 : 2} />
    </button>
  );

  return (
    <div className="rte">
      <div className="rte-toolbar" role="toolbar" aria-label="Formatting">
        <button type="button" className="rte-btn rte-text" aria-pressed={active.block === "h2"} onMouseDown={(e) => e.preventDefault()} onClick={() => toggleBlock("h2")} title="Heading">H1</button>
        <button type="button" className="rte-btn rte-text" aria-pressed={active.block === "h3"} onMouseDown={(e) => e.preventDefault()} onClick={() => toggleBlock("h3")} title="Subheading">H2</button>
        <span className="rte-sep" />
        {tool("bold", "Bold (⌘B)", () => run("bold"), active.bold)}
        {tool("italic", "Italic (⌘I)", () => run("italic"), active.italic)}
        {tool("underline", "Underline (⌘U)", () => run("underline"), active.underline)}
        <span className="rte-sep" />
        {tool("list", "Bulleted list", () => run("insertUnorderedList"), active.ul)}
        {tool("listOrdered", "Numbered list", () => run("insertOrderedList"), active.ol)}
        {tool("quoteMark", "Quote", () => toggleBlock("blockquote"), active.block === "blockquote")}
        {tool("link", "Link (⌘K)", openLink)}
        {tool("video", "Video (YouTube or Vimeo)", openVideo)}
        {tool("divider", "Divider", () => run("insertHorizontalRule"))}
        <span className="rte-sep" />
        {tool("undo", "Undo (⌘Z)", () => run("undo"))}
        {tool("redo", "Redo (⇧⌘Z)", () => run("redo"))}
      </div>
      {linking !== null && (
        <form className="rte-link" onSubmit={(e) => { e.preventDefault(); applyLink(new FormData(e.currentTarget).get("url") as string); }}>
          <Icon name="link" size={15} />
          <input name="url" className="input" defaultValue={linking} placeholder="Paste a link (https://…), email or phone" autoFocus onKeyDown={(e) => e.key === "Escape" && (e.preventDefault(), setLinking(null), ref.current?.focus())} />
          <button type="submit" className="btn btn-sm btn-primary">Apply</button>
          {linking && <button type="button" className="btn btn-sm btn-ghost" onClick={() => applyLink("")}>Remove</button>}
          <button type="button" className="icon-btn" aria-label="Cancel" onClick={() => { setLinking(null); ref.current?.focus(); }}><Icon name="x" size={16} /></button>
        </form>
      )}
      {videoForm && (
        <form className="rte-link" onSubmit={(e) => { e.preventDefault(); addVideo(new FormData(e.currentTarget).get("url") as string); }}>
          <Icon name="video" size={15} />
          <input
            name="url"
            className="input"
            placeholder="Paste a YouTube or Vimeo link"
            aria-label="YouTube or Vimeo link"
            aria-invalid={videoForm.error || undefined}
            aria-describedby={videoForm.error ? videoErrorId : undefined}
            autoFocus
            onChange={() => videoForm.error && setVideoForm({ error: false })}
            onKeyDown={(e) => e.key === "Escape" && (e.preventDefault(), closeVideo())}
          />
          <button type="submit" className="btn btn-sm btn-primary">Add video</button>
          <button type="button" className="icon-btn" aria-label="Cancel" onClick={closeVideo}><Icon name="x" size={16} /></button>
          {videoForm.error && <p id={videoErrorId} className="error-text" role="alert">That isn't a YouTube or Vimeo link. On the video's page, choose Share, copy the link and paste it here.</p>}
        </form>
      )}
      <div className="rte-body-wrap">
        {empty && <div className="rte-placeholder" aria-hidden="true">{placeholder}</div>}
        <div
          ref={ref}
          className="rte-body prose"
          contentEditable
          suppressContentEditableWarning
          role="textbox"
          aria-multiline="true"
          aria-label={label}
          style={{ minHeight }}
          onFocus={() => exec("defaultParagraphSeparator", "p")}
          onInput={emit}
          onKeyDown={onKeyDown}
          onPaste={(e) => {
            e.preventDefault();
            const html = e.clipboardData.getData("text/html");
            const text = e.clipboardData.getData("text/plain");
            // A video link pasted on an empty line, or a video's embed code anywhere, becomes the video.
            const video = videoFromPaste(text);
            if (video && (/<iframe\b/i.test(text) || isBlank(caretLine(e.currentTarget) ?? e.currentTarget))) return insertVideo(video);
            exec("insertHTML", html ? sanitizeHtml(html) : textToHtml(text));
            emit();
          }}
          onDrop={(e) => e.preventDefault()}
        />
      </div>
    </div>
  );
}
