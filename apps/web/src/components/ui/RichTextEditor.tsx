/**
 * A small rich-text editor (contenteditable) for SOPs and long notes: headings, bold/italic/
 * underline, lists, quotes, links and dividers, with Markdown-style shortcuts ("## ", "- ", "1. ",
 * "> ") and sanitized paste. Output is sanitized HTML plus plain text for search.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { sanitizeHtml, textToHtml } from "@/lib/html";
import { Icon, type IconName } from "./Icon";

type Block = "p" | "h2" | "h3" | "blockquote";
interface Active { bold: boolean; italic: boolean; underline: boolean; ul: boolean; ol: boolean; block: Block | null }

const exec = (command: string, value?: string) => document.execCommand(command, false, value);

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
  const [empty, setEmpty] = useState(!initialHtml.replace(/<[^>]+>/g, "").trim());
  const [linking, setLinking] = useState<string | null>(null);

  useEffect(() => {
    if (ref.current) ref.current.innerHTML = sanitizeHtml(initialHtml);
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
    const text = el.innerText.trim();
    setEmpty(!text && !el.querySelector("img, hr"));
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

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "k") {
      e.preventDefault();
      openLink();
      return;
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
            exec("insertHTML", html ? sanitizeHtml(html) : textToHtml(text));
            emit();
          }}
          onDrop={(e) => e.preventDefault()}
        />
      </div>
    </div>
  );
}
