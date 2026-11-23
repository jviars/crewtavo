/**
 * The rich-text editor for guides (Tiptap): headings, bold/italic/underline, numbered steps, lists
 * and checklists, quotes, callouts, tables, links, dividers, pictures (with `pictures`: the Picture
 * button, or pasting or dropping one in) and YouTube or Vimeo videos, with Markdown-style shortcuts
 * ("# ", "- ", "1. ", "[] ", "> ") and paste that keeps only what a guide can hold. Output is
 * sanitized HTML plus plain text for search. Insert (or "/" typed at the start of a line, which
 * opens the same blocks under the caret, narrowed as you type) adds any block.
 *
 * Laid out as a field in a form (`layout` "box"), or as a page to write on (`layout` "page", the
 * guide editor: the tools on a hairline that stays under the page's own bar, then a reading column
 * that starts with `lead`, the cover and title, so what's written is laid out as it's read).
 *
 * In `contract` mode it writes a contract section (Settings → Contract terms) instead: headings,
 * bold/italic/underline, lists, quotes, dividers and tables (contractExtensions, which also decide
 * what a paste keeps), saved cleaned to what prints on an estimate (sanitizeContractHtml), with an
 * "Insert a fill-in" menu for words like {Customer name}.
 */
import { videoFromPaste } from "@crewtavo/core/video";
import { EditorContent, useEditor, useEditorState, type Editor } from "@tiptap/react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { isAppPath, sanitizeContractHtml, sanitizeHtml } from "@/lib/html";
import { markdownPaste } from "@/lib/markdownPaste";
import { CALLOUTS, contractExtensions, guideExtensions, type CalloutTone, type PictureLink } from "./editorExtensions";
import { Icon, type IconName } from "./Icon";
import { Menu, type MenuEntry } from "./Menu";
import { t } from "@/lib/i18n";

/** Something the link box offers as you type, like a guide: its title, where it goes, and a word about it. */
export interface LinkTarget { title: string; href: string; detail?: string }

/** Adding pictures: storing one (its path and size, or an error to show), and a link to show a stored one. */
export interface Pictures {
  add: (file: File) => Promise<{ path: string; width: number; height: number }>;
  link: PictureLink;
  /** What the Picture button's file picker offers. */
  accept: string;
}

type Chain = ReturnType<Editor["chain"]>;

/** A block Insert (or "/") adds: an editor command, or a box to fill in first (a link, a video, a picture). */
interface Block {
  key: string;
  group: string;
  label: string;
  icon: IconName;
  /** In place of the icon (a callout's, in its tone's color). */
  lead?: ReactNode;
  description?: string;
  /** The Markdown shortcut that makes it, shown as a key. */
  hint?: string;
  /** Quiet words on the right. */
  end?: string;
  /** Other words "/" finds it by. */
  words: string;
  chain?: (c: Chain) => Chain;
  open?: () => void;
}

const isPicture = (f: File) => f.type.startsWith("image/") || /\.(heic|heif)$/i.test(f.name);
/** "/" at the start of a line, then what's typed after it: what the blocks are narrowed by. */
const SLASH = /^\/([^/￼]{0,32})$/;
/** How far the caret is kept from the window's edges as a page is written (see editorProps). */
const PAGE_SCROLL_MARGIN = { top: 184, right: 0, bottom: 48, left: 0 };

/** A callout's icon in its tone's color, as the guide shows it. */
function CalloutIcon({ tone }: { tone: CalloutTone }) {
  return (
    <span className="rte-tone" data-tone={tone}>
      <Icon name={tone === "important" ? "alertCircle" : tone === "warning" ? "alert" : "info"} size={16} />
    </span>
  );
}

export function RichTextEditor({
  initialHtml,
  onChange,
  placeholder = t("Start writing…"),
  minHeight = 320,
  label = t("Content"),
  mode = "guide",
  layout = "box",
  lead,
  fillIns = [],
  findLinks,
  pictures,
  onBusy,
}: {
  initialHtml: string;
  onChange: (html: string, text: string) => void;
  placeholder?: string;
  minHeight?: number;
  label?: string;
  /** A guide, or a contract section (less to choose from, cleaned for paper). Fixed once it's shown. */
  mode?: "guide" | "contract";
  /** A field in a form, or the page being written (the guide editor). */
  layout?: "box" | "page";
  /** What the page starts with, above the words: the guide's cover and title. */
  lead?: ReactNode;
  /** What the "Insert a fill-in" menu offers, like { token: "{Customer name}", label: "Customer name" }. */
  fillIns?: ReadonlyArray<{ token: string; label: string }>;
  /** What the link box offers for what's typed (other guides), best first. Without it the box only takes addresses. */
  findLinks?: (term: string) => LinkTarget[];
  /** Pictures in guides. Without it there's no Picture button, and pasting or dropping a picture adds nothing. */
  pictures?: Pictures;
  /** Whether pictures are still uploading: a save then would leave them out. */
  onBusy?: (busy: boolean) => void;
}) {
  const contract = mode === "contract";
  const sanitize = contract ? sanitizeContractHtml : sanitizeHtml;
  const [linking, setLinking] = useState<string | null>(null);
  const [videoForm, setVideoForm] = useState<{ error: boolean } | null>(null);
  const videoErrorId = useId();
  const videoInput = useRef<HTMLInputElement>(null);
  // The editor is made once; these keep its callbacks current.
  const changed = useRef(onChange);
  changed.current = onChange;
  const linkShortcut = useRef(() => {});
  const pics = useRef(pictures);
  pics.current = pictures;
  const addPicturesNow = useRef<(files: File[], at?: number) => void>(() => {});
  const pictureInput = useRef<HTMLInputElement>(null);
  const [adding, setAdding] = useState(0);
  const [pictureError, setPictureError] = useState<string | null>(null);
  // Previews of pictures added here, shown until the editor goes.
  const previews = useRef<string[]>([]);
  useEffect(() => () => previews.current.forEach((url) => URL.revokeObjectURL(url)), []);
  const busy = useRef(onBusy);
  busy.current = onBusy;
  useEffect(() => busy.current?.(adding > 0), [adding]);
  const picturesIn = (list: FileList | null | undefined) => (pics.current ? [...(list ?? [])].filter(isPicture) : []);

  // "/" at the start of a line: where it is and what's typed after it; the one picked; one closed with Escape stays closed.
  const [slash, setSlash] = useState<{ from: number; to: number; query: string } | null>(null);
  const [slashAt, setSlashAt] = useState(0);
  const slashClosed = useRef<number | null>(null);
  const slashKeys = useRef<(e: KeyboardEvent) => boolean>(() => false);
  const slashListId = useId();
  const paper = useRef<HTMLDivElement>(null);
  const slashList = useRef<HTMLDivElement>(null);
  const readSlash = useRef((_: Editor) => {});
  readSlash.current = (e: Editor) => {
    if (contract) return;
    const { selection } = e.state;
    const $from = selection.$from;
    // A line of its own: in the guide, or in a callout or quote (not in a list or a table, which hold only some blocks).
    const line = selection.empty && $from.parent.type.name === "paragraph" && ["doc", "callout", "blockquote"].includes($from.node(-1).type.name);
    const before = line ? $from.parent.textBetween(0, $from.parentOffset, undefined, "￼") : "";
    const match = SLASH.exec(before);
    if (!before.startsWith("/")) slashClosed.current = null;
    const next = match && !/^\s/.test(match[1]!) && slashClosed.current !== $from.start() ? { from: $from.start(), to: selection.from, query: match[1]! } : null;
    setSlash((was) => (was?.from === next?.from && was?.to === next?.to && was?.query === next?.query ? was : next));
    if (next?.query !== slash?.query) setSlashAt(0);
  };

  const editorRef = useRef<Editor | null>(null);
  const editor = useEditor({
    extensions: contract ? contractExtensions(placeholder) : guideExtensions(placeholder, (path) => pics.current?.link(path) ?? Promise.resolve(null)),
    content: sanitize(initialHtml),
    editorProps: {
      attributes: { class: "rte-body prose", role: "textbox", "aria-multiline": "true", "aria-label": label, style: `min-height: ${minHeight}px` },
      // As a page, the top bar, the editor's bar and the tools stay stuck over the top of the words
      // (about 150px, 170 on a phone): the line being typed on is kept clear of them.
      ...(layout === "page" && { scrollThreshold: PAGE_SCROLL_MARGIN, scrollMargin: PAGE_SCROLL_MARGIN }),
      handleKeyDown: (_, e) => {
        if (slashKeys.current(e)) return true;
        if (contract || !((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k")) return false;
        e.preventDefault();
        linkShortcut.current();
        return true;
      },
      // A picture pasted (a screenshot, or one copied from somewhere) is stored and added where the cursor is.
      // Markdown pasted as plain text (a .md file, a chat with an AI) comes in as the guide's formatting.
      handlePaste: (_, event) => {
        const files = picturesIn(event.clipboardData?.files);
        if (files.length) {
          event.preventDefault();
          addPicturesNow.current(files);
          return true;
        }
        const markdown = contract ? null : markdownPaste(event.clipboardData?.getData("text/plain") ?? "", event.clipboardData?.getData("text/html") ?? "");
        if (!markdown) return false;
        event.preventDefault();
        editorRef.current?.chain().focus().insertContent(sanitize(markdown)).run();
        return true;
      },
      // Dropped from the computer: added where it's dropped. A picture moved within the guide moves as before.
      handleDrop: (view, event, _slice, moved) => {
        const files = moved ? [] : picturesIn(event.dataTransfer?.files);
        if (!files.length) return false;
        event.preventDefault();
        addPicturesNow.current(files, view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos);
        return true;
      },
    },
    onUpdate: ({ editor: e }) => {
      changed.current(sanitize(e.getHTML()), e.getText({ blockSeparator: "\n" }).trim());
      readSlash.current(e);
    },
    onSelectionUpdate: ({ editor: e }) => readSlash.current(e),
    onBlur: () => setSlash(null),
  });

  editorRef.current = editor;
  const active = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      h2: e.isActive("heading", { level: 2 }),
      h3: e.isActive("heading", { level: 3 }),
      h4: e.isActive("heading", { level: 4 }),
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      underline: e.isActive("underline"),
      bullets: e.isActive("bulletList"),
      steps: e.isActive("orderedList"),
      checklist: e.isActive("taskList"),
      quote: e.isActive("blockquote"),
      callout: e.isActive("callout") ? String(e.getAttributes("callout").tone) : null,
      table: e.isActive("table"),
      // A picture picked: its description, and where it is (a new one picked starts its own box).
      picture: e.isActive("image") ? { alt: String(e.getAttributes("image").alt ?? ""), at: e.state.selection.from } : null,
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
    }),
  });

  const focus = () => editor.chain().focus();

  /** Pictures stored one by one, each shown at once (a preview) and saved once it's stored. */
  const addPictures = (files: File[], at?: number) => {
    const add = pics.current?.add;
    if (!add) return;
    setPictureError(null);
    for (const [i, file] of files.entries()) {
      const id = crypto.randomUUID();
      const src = URL.createObjectURL(file);
      previews.current.push(src);
      const picture = { type: "image", attrs: { src, alt: "", uploading: id } };
      if (at !== undefined && i === 0) editor.chain().focus().insertContentAt(Math.min(at, editor.state.doc.content.size), picture).run();
      else focus().insertContent(picture).run();
      setAdding((n) => n + 1);
      add(file)
        .then((stored) => settle(id, { path: stored.path, width: stored.width || null, height: stored.height || null }))
        .catch((error: unknown) => {
          settle(id, null);
          setPictureError(`${file.name ? t("{name} wasn't added.", { name: file.name }) : t("That picture wasn't added.")} ${error instanceof Error ? t(error.message) : t("Try again.")}`);
        })
        .finally(() => setAdding((n) => n - 1));
    }
  };
  addPicturesNow.current = addPictures;
  /** A picture's upload finished (its stored path) or failed (null: it's taken out). Not an undo step of its own. */
  const settle = (id: string, stored: { path: string; width: number | null; height: number | null } | null) => {
    if (editor.isDestroyed) return;
    let at = -1;
    editor.state.doc.descendants((n, pos) => {
      if (at < 0 && n.type.name === "image" && n.attrs.uploading === id) at = pos;
      return at < 0;
    });
    // Taken out while it uploaded: the stored file goes with the daily sweep (nothing names it).
    if (at < 0) return;
    const node = editor.state.doc.nodeAt(at)!;
    const tr = stored ? editor.state.tr.setNodeMarkup(at, undefined, { ...node.attrs, ...stored, uploading: null }) : editor.state.tr.delete(at, at + node.nodeSize);
    editor.view.dispatch(tr.setMeta("addToHistory", false));
  };

  const openLink = () => {
    setVideoForm(null);
    setLinking(editor.getAttributes("link").href ?? "");
  };
  linkShortcut.current = openLink;
  const closeLink = () => {
    setLinking(null);
    editor.commands.focus();
  };
  const applyLink = (raw: string, text?: string) => {
    const url = raw.trim();
    const chain = focus().extendMarkRange("link");
    if (!url) chain.unsetLink().run();
    else {
      // A pasted address of a screen in Crewtavo keeps just its path, so it opens here and not in a new tab.
      const own = url.startsWith(`${location.origin}/`) ? url.slice(location.origin.length) : url;
      const href = isAppPath(own) || /^(https?:|mailto:|tel:)/i.test(own) ? own : /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(own) ? `mailto:${own}` : `https://${own}`;
      // With nothing selected, the link's text is what was picked (a guide's title) or the address; typing after it isn't part of the link.
      if (editor.state.selection.empty && !editor.isActive("link")) chain.insertContent({ type: "text", text: text ?? url, marks: [{ type: "link", attrs: { href } }] }).unsetMark("link").run();
      else chain.setLink({ href }).run();
    }
    setLinking(null);
  };

  const openVideo = () => {
    setLinking(null);
    setVideoForm({ error: false });
  };
  const closeVideo = () => {
    setVideoForm(null);
    editor.commands.focus();
  };
  const addVideo = (raw: string) => {
    const video = videoFromPaste(raw);
    if (!video) return setVideoForm({ error: true });
    setVideoForm(null);
    focus().insertVideo(video.src).run();
  };

  // What Insert and "/" add, in the order the menu shows them.
  const textAndLists = t("Text and lists");
  const callouts = t("Callouts");
  const blocksGroup = t("Blocks");
  const media = t("Media and links");
  const CALLOUT_WORDS: Record<CalloutTone, string> = {
    tip: t("A faster or better way to do it"),
    important: t("Something nobody can skip"),
    warning: t("Could hurt someone or damage property"),
  };
  // On a touch screen there's nothing to drop a picture from.
  const touch = typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;
  const blocks: Block[] = contract
    ? []
    : [
        { key: "h2", group: textAndLists, label: t("Heading"), icon: "heading", hint: "#", words: "h1 title", chain: (c) => c.setHeading({ level: 2 }) },
        { key: "h3", group: textAndLists, label: t("Subheading"), icon: "heading", hint: "##", words: "h2 title", chain: (c) => c.setHeading({ level: 3 }) },
        { key: "steps", group: textAndLists, label: t("Numbered steps"), icon: "listOrdered", hint: "1.", words: "numbered ordered list 1", chain: (c) => c.toggleOrderedList() },
        { key: "bullets", group: textAndLists, label: t("Bulleted list"), icon: "list", hint: "-", words: "bullets list", chain: (c) => c.toggleBulletList() },
        { key: "checklist", group: textAndLists, label: t("Checklist"), icon: "checklist", hint: "[]", words: "todo task check boxes", chain: (c) => c.toggleTaskList() },
        { key: "quote", group: textAndLists, label: t("Quote", { context: "text" }), icon: "quoteMark", hint: ">", words: "quote blockquote", chain: (c) => c.toggleBlockquote() },
        // i18n-ignore: more words "/" finds a callout by, besides its name
        ...CALLOUTS.map((c): Block => ({ key: c.tone, group: callouts, label: t(c.label), icon: "callout", lead: <CalloutIcon tone={c.tone} />, description: CALLOUT_WORDS[c.tone], words: `callout note ${c.tone}`, chain: (ch) => ch.setCallout(c.tone) })),
        { key: "table", group: blocksGroup, label: t("Table"), icon: "table", end: "3 × 3", words: "table grid columns rows", chain: (c) => c.insertTable({ rows: 3, cols: 3, withHeaderRow: true }) },
        { key: "divider", group: blocksGroup, label: t("Divider"), icon: "divider", words: "divider line rule hr", chain: (c) => c.setHorizontalRule() },
        ...(pictures ? [{ key: "picture", group: media, label: t("Picture"), icon: "image", end: touch ? undefined : t("or drop one in"), words: "picture image photo", open: () => pictureInput.current?.click() } satisfies Block] : []),
        { key: "video", group: media, label: t("Video"), icon: "video", end: t("YouTube or Vimeo"), words: "video youtube vimeo", open: openVideo },
        { key: "link", group: media, label: t("Link"), icon: "link", hint: "⌘K", words: "link url guide", open: openLink },
      ];
  const runBlock = (b: Block) => (b.chain ? b.chain(focus()).run() : b.open?.());

  // "/": the blocks whose name (or another word for them) starts with what's typed.
  const query = slash?.query.trim().toLowerCase() ?? "";
  const slashItems = slash ? blocks.filter((b) => !query || `${b.label} ${b.words}`.toLowerCase().split(/\s+/).some((w) => w.startsWith(query)) || b.label.toLowerCase().includes(query)) : [];
  const slashOpen = slashItems.length > 0;
  const pickSlash = (b: Block) => {
    if (!slash) return;
    const range = { from: slash.from, to: slash.to };
    setSlash(null);
    if (b.chain) b.chain(editor.chain().focus().deleteRange(range)).run();
    else {
      editor.chain().focus().deleteRange(range).run();
      b.open?.();
    }
  };
  slashKeys.current = (e) => {
    if (!slashOpen || !slash) return false;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      setSlashAt((i) => (i + (e.key === "ArrowDown" ? 1 : slashItems.length - 1)) % slashItems.length);
      return true;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      const b = slashItems[Math.min(slashAt, slashItems.length - 1)];
      if (b) pickSlash(b);
      return true;
    }
    if (e.key === "Escape") {
      slashClosed.current = slash.from;
      setSlash(null);
      return true;
    }
    return false;
  };
  // The editor's text box points at the block it would add, as a combobox does.
  const slashActive = slashOpen ? `${slashListId}-${Math.min(slashAt, slashItems.length - 1)}` : null;
  useEffect(() => {
    const dom = editor.view.dom;
    if (slashActive) {
      dom.setAttribute("aria-controls", slashListId);
      dom.setAttribute("aria-activedescendant", slashActive);
      // Scrolled within the menu only: scrollIntoView would move the page under the caret too.
      const box = slashList.current;
      const item = box?.querySelector<HTMLElement>('[aria-selected="true"]');
      if (box && item) {
        const foot = box.querySelector<HTMLElement>(".rte-slash-foot")?.offsetHeight ?? 0;
        if (item.offsetTop < box.scrollTop) box.scrollTop = item.offsetTop - 4;
        else if (item.offsetTop + item.offsetHeight > box.scrollTop + box.clientHeight - foot) box.scrollTop = item.offsetTop + item.offsetHeight - box.clientHeight + foot + 4;
      }
    } else {
      dom.removeAttribute("aria-controls");
      dom.removeAttribute("aria-activedescendant");
    }
  }, [editor, slashActive, slashListId]);
  // Under the caret's line, or over it when there's more room there, kept clear of the tools stuck at the top.
  let slashPlace: { left: number; top?: number; bottom?: number; maxHeight: number } | null = null;
  if (slashOpen && slash && paper.current) {
    try {
      const at = editor.view.coordsAtPos(slash.from);
      const box = paper.current.getBoundingClientRect();
      const left = Math.max(0, Math.min(at.left - box.left - 8, box.width - 280));
      // The visible part of the window: on a phone the keyboard takes the bottom of it.
      const seen = (window.visualViewport?.height ?? window.innerHeight) + (window.visualViewport?.offsetTop ?? 0);
      const tools = paper.current.parentElement?.querySelector(".rte-top")?.getBoundingClientRect().bottom ?? 0;
      const below = seen - at.bottom - 12;
      const above = at.top - Math.max(tools, 0) - 12;
      slashPlace = below >= 300 || below >= above
        ? { left, top: at.bottom - box.top + 6, maxHeight: Math.max(160, Math.min(340, below)) }
        : { left, bottom: box.bottom - at.top + 6, maxHeight: Math.max(160, Math.min(340, above)) };
    } catch {
      slashPlace = null;
    }
  }

  const insertMenu: MenuEntry[] = blocks.length
    ? [
        { heading: textAndLists },
        ...blocks.filter((b) => b.group === textAndLists).map((b) => ({ label: b.label, icon: b.icon, kbd: b.hint, onSelect: () => runBlock(b) })),
        { heading: blocksGroup },
        { label: t("Callout"), icon: "callout", items: blocks.filter((b) => b.group === callouts).map((b) => ({ label: b.label, lead: b.lead, description: b.description, checked: active.callout === b.key ? true : undefined, onSelect: () => runBlock(b) })) },
        ...blocks.filter((b) => b.group === blocksGroup).map((b) => ({ label: b.label, icon: b.icon, end: b.end, onSelect: () => runBlock(b) })),
        { heading: media },
        ...blocks.filter((b) => b.group === media).map((b) => ({ label: b.label, icon: b.icon, end: b.end, kbd: b.hint, onSelect: () => runBlock(b) })),
      ]
    : [];

  const tool = (icon: IconName, title: string, onClick: () => void, pressed?: boolean, disabled?: boolean, className?: string) => (
    <button type="button" className={className ? `rte-btn ${className}` : "rte-btn"} title={title} aria-label={title} aria-pressed={pressed} disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={onClick}>
      <Icon name={icon} size={16} bold={pressed} />
    </button>
  );
  // A guide's headings sit under its title (h2, h3); a contract section's under the section's own title (h3, h4).
  const heading = (level: 2 | 3 | 4, text: string, title: string) => (
    <button type="button" className="rte-btn rte-text" title={title} aria-label={title} aria-pressed={level === 2 ? active.h2 : level === 3 ? active.h3 : active.h4} onMouseDown={(e) => e.preventDefault()} onClick={() => focus().toggleHeading({ level }).run()}>{text}</button>
  );
  const opens = (icon: IconName) => (
    <>
      <Icon name={icon} size={16} />
      <span className="rte-caret"><Icon name="chevronDown" size={12} /></span>
    </>
  );

  return (
    <div className="rte" data-layout={layout}>
      <div className="rte-top">
        <div className="rte-toolbar" role="toolbar" aria-label={t("Formatting")}>
          {insertMenu.length > 0 && (
            <>
              <Menu
                label={t("Insert")}
                title={t("Insert")}
                trigger={
                  <>
                    <Icon name="plus" size={16} />
                    <span className="rte-insert-text">{t("Insert")}</span>
                    <kbd className="kbd rte-insert-kbd" aria-hidden="true">/</kbd>
                  </>
                }
                triggerClassName="rte-btn rte-insert"
                align="start"
                items={insertMenu}
              />
              <span className="rte-sep" />
            </>
          )}
          {heading(contract ? 3 : 2, "H1", t("Heading"))}
          {heading(contract ? 4 : 3, "H2", t("Subheading"))}
          <span className="rte-sep" />
          {tool("bold", t("Bold (⌘B)"), () => focus().toggleBold().run(), active.bold)}
          {tool("italic", t("Italic (⌘I)"), () => focus().toggleItalic().run(), active.italic)}
          {tool("underline", t("Underline (⌘U)"), () => focus().toggleUnderline().run(), active.underline)}
          <span className="rte-sep" />
          {tool("listOrdered", contract ? t("Numbered list") : t("Numbered steps"), () => focus().toggleOrderedList().run(), active.steps)}
          {tool("list", t("Bulleted list"), () => focus().toggleBulletList().run(), active.bullets)}
          {!contract && tool("checklist", t("Checklist"), () => focus().toggleTaskList().run(), active.checklist)}
          <span className="rte-sep" />
          {tool("quoteMark", t("Quote", { context: "text" }), () => focus().toggleBlockquote().run(), active.quote)}
          {!contract && (
            <Menu
              label={t("Callout")}
              title={t("Callout")}
              trigger={opens("callout")}
              triggerClassName={`rte-btn rte-opens${active.callout ? " is-on" : ""}`}
              align="start"
              items={[
                ...CALLOUTS.map((c) => ({ label: t(c.label), lead: <CalloutIcon tone={c.tone} />, description: CALLOUT_WORDS[c.tone], checked: active.callout === c.tone ? true : undefined, onSelect: () => focus().setCallout(c.tone).run() })),
                { separator: true, hidden: !active.callout },
                { label: t("Remove callout"), icon: "x", hidden: !active.callout, onSelect: () => focus().unsetCallout().run() },
              ]}
            />
          )}
          {/* Outside a table the button just adds one (a menu of one item says nothing); inside one, its caret opens what can be done to it. */}
          {active.table ? (
            <Menu
              label={t("Table")}
              title={t("Table")}
              trigger={opens("table")}
              triggerClassName="rte-btn rte-opens is-on"
              align="start"
              items={[
                { label: t("Add row below"), icon: "plus", onSelect: () => focus().addRowAfter().run() },
                { label: t("Add column to the right"), icon: "plus", onSelect: () => focus().addColumnAfter().run() },
                { label: t("Header row on or off"), icon: "heading", onSelect: () => focus().toggleHeaderRow().run() },
                { separator: true },
                { label: t("Delete row"), icon: "minus", onSelect: () => focus().deleteRow().run() },
                { label: t("Delete column"), icon: "minus", onSelect: () => focus().deleteColumn().run() },
                { label: t("Delete table"), icon: "trash", danger: true, onSelect: () => focus().deleteTable().run() },
              ]}
            />
          ) : (
            tool("table", t("Insert table"), () => focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run())
          )}
          <span className="rte-sep" />
          {!contract && tool("link", t("Link (⌘K)"), openLink)}
          {pictures && tool("image", t("Picture (or paste or drop one in)"), () => pictureInput.current?.click())}
          {!contract && tool("video", t("Video (YouTube or Vimeo)"), openVideo)}
          {tool("divider", t("Divider"), () => focus().setHorizontalRule().run())}
          {tool("undo", t("Undo (⌘Z)"), () => focus().undo().run(), undefined, !active.canUndo, "rte-push")}
          {tool("redo", t("Redo (⇧⌘Z)"), () => focus().redo().run(), undefined, !active.canRedo)}
          {fillIns.length > 0 && (
            <>
              <span className="rte-sep" />
              <Menu
                label={t("Insert a fill-in")}
                title={t("Insert a fill-in")}
                trigger={
                  <>
                    <Icon name="hash" size={14} />
                    <span>{t("Fill-in")}</span>
                    <span className="rte-caret"><Icon name="chevronDown" size={12} /></span>
                  </>
                }
                triggerClassName="rte-btn rte-insert"
                align="start"
                items={[{ heading: t("Filled in on each estimate") }, ...fillIns.map((f) => ({ label: f.label, onSelect: () => focus().insertContent({ type: "text", text: f.token }).run() }))]}
              />
            </>
          )}
        </div>
        {(adding > 0 || pictureError) && (
          <div className="rte-link" role="status">
            <Icon name={pictureError ? "alert" : "image"} size={14} />
            <span className="grow small" style={{ color: pictureError ? "var(--danger)" : undefined }}>{pictureError ?? (adding === 1 ? t("Adding the picture…") : t("Adding {count} pictures…", { count: adding }))}</span>
            {pictureError && <button type="button" className="icon-btn" aria-label={t("Dismiss")} onClick={() => setPictureError(null)}><Icon name="x" size={16} /></button>}
          </div>
        )}
        {active.picture && linking === null && !videoForm && (
          <div className="rte-link">
            <Icon name="image" size={14} />
            <input
              key={active.picture.at}
              className="input"
              defaultValue={active.picture.alt}
              maxLength={300}
              placeholder={t("Describe the picture, for anyone who can't see it (optional)")}
              aria-label={t("Picture description")}
              onChange={(e) => editor.commands.updateAttributes("image", { alt: e.target.value || null })}
              onKeyDown={(e) => (e.key === "Escape" || e.key === "Enter") && (e.preventDefault(), editor.commands.focus())}
            />
          </div>
        )}
        {linking !== null && <LinkForm initial={linking} find={findLinks} onApply={applyLink} onClose={closeLink} />}
        {videoForm && (
          <div className="rte-link">
            <Icon name="video" size={14} />
            <input
              ref={videoInput}
              className="input"
              placeholder={t("Paste a YouTube or Vimeo link")}
              aria-label={t("YouTube or Vimeo link")}
              aria-invalid={videoForm.error || undefined}
              aria-describedby={videoForm.error ? videoErrorId : undefined}
              autoFocus
              onChange={() => videoForm.error && setVideoForm({ error: false })}
              onKeyDown={(e) => {
                if (e.key === "Escape") { e.preventDefault(); closeVideo(); }
                else if (e.key === "Enter") { e.preventDefault(); addVideo(e.currentTarget.value); }
              }}
            />
            <button type="button" className="btn btn-sm" onClick={() => addVideo(videoInput.current?.value ?? "")}>{t("Add video")}</button>
            <button type="button" className="icon-btn" aria-label={t("Cancel")} onClick={closeVideo}><Icon name="x" size={16} /></button>
            {videoForm.error && <p id={videoErrorId} className="error-text" role="alert">{t("That isn't a YouTube or Vimeo link. On the video's page, choose Share, copy the link and paste it here.")}</p>}
          </div>
        )}
      </div>
      {pictures && (
        <input
          ref={pictureInput}
          type="file"
          accept={pictures.accept}
          multiple
          hidden
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = "";
            if (files.length) addPictures(files);
          }}
        />
      )}
      <div className="rte-paper" ref={paper}>
        {lead}
        <EditorContent editor={editor} />
        {slashOpen && slashPlace && (
          <div ref={slashList} className="menu rte-slash" style={slashPlace} onMouseDown={(e) => e.preventDefault()}>
            <div id={slashListId} role="listbox" aria-label={t("Insert")}>
              {[...new Set(slashItems.map((b) => b.group))].map((group) => (
                <div key={group} role="group" aria-label={group}>
                  <div className="menu-label" aria-hidden="true">{group}</div>
                  {slashItems.map((b, i) => b.group === group && (
                    <div
                      key={b.key}
                      id={`${slashListId}-${i}`}
                      role="option"
                      aria-selected={i === Math.min(slashAt, slashItems.length - 1)}
                      className="menu-item"
                      onMouseMove={() => i !== slashAt && setSlashAt(i)}
                      onClick={() => pickSlash(b)}
                    >
                      {b.lead ?? <Icon name={b.icon} size={16} />}
                      <span className="menu-text">
                        {b.label}
                        {b.description && <span className="menu-desc">{b.description}</span>}
                      </span>
                      {(b.end || b.hint) && (
                        <span className="menu-trail">
                          {b.end && <span className="menu-end">{b.end}</span>}
                          {b.hint && <kbd className="menu-kbd" aria-hidden="true">{b.hint}</kbd>}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              ))}
            </div>
            <div className="rte-slash-foot" aria-hidden="true">
              <kbd className="kbd">↑</kbd><kbd className="kbd">↓</kbd><span>{t("to move")}</span>
              <kbd className="kbd">↵</kbd><span>{t("to insert")}</span>
              <kbd className="kbd">{t("Esc")}</kbd><span>{t("to close")}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** The link box: an address, email or phone, or (with `find`) a guide picked by typing part of its title. */
function LinkForm({ initial, find, onApply, onClose }: { initial: string; find?: (term: string) => LinkTarget[]; onApply: (url: string, text?: string) => void; onClose: () => void }) {
  const [term, setTerm] = useState(initial);
  const [index, setIndex] = useState(0);
  const listId = useId();
  const typed = term.trim();
  // An address (https://…, /kb/…, name@site.com, site.com) is linked as it is, not searched for.
  const address = /^(https?:|mailto:|tel:|\/)/i.test(typed) || /^\S+\.\S+$/.test(typed);
  const hits = find && typed && !address ? find(typed).slice(0, 8) : [];
  const apply = () => (hits[index] ? onApply(hits[index].href, hits[index].title) : onApply(term));
  // Not a <form>: the editor sits inside the page's form, and browsers don't pass a nested form's submit on.
  return (
    <div className="rte-link">
      <Icon name="link" size={14} />
      <input
        className="input"
        value={term}
        onChange={(e) => { setTerm(e.target.value); setIndex(0); }}
        placeholder={find ? t("Search guides, or paste a link, email or phone") : t("Paste a link (https://…), email or phone")}
        aria-label={t("Link")}
        autoFocus
        autoComplete="off"
        role={find ? "combobox" : undefined}
        aria-autocomplete={find ? "list" : undefined}
        aria-expanded={find ? hits.length > 0 : undefined}
        aria-controls={hits.length ? listId : undefined}
        aria-activedescendant={hits[index] ? `${listId}-${index}` : undefined}
        onKeyDown={(e) => {
          if (e.key === "Escape") { e.preventDefault(); onClose(); }
          else if (e.key === "Enter") { e.preventDefault(); apply(); }
          else if (e.key === "ArrowDown" && hits.length) { e.preventDefault(); setIndex((i) => (i + 1) % hits.length); }
          else if (e.key === "ArrowUp" && hits.length) { e.preventDefault(); setIndex((i) => (i <= 0 ? hits.length - 1 : i - 1)); }
        }}
      />
      <button type="button" className="btn btn-sm" onClick={apply}>{t("Apply")}</button>
      {initial && <button type="button" className="btn btn-sm btn-ghost" onClick={() => onApply("")}>{t("Remove")}</button>}
      <button type="button" className="icon-btn" aria-label={t("Cancel")} onClick={onClose}><Icon name="x" size={16} /></button>
      {find && typed && !address && !hits.length && <p className="muted small rte-link-note">{t("No guide has that in its title. Paste a link instead, or try other words.")}</p>}
      {hits.length > 0 && (
        <div className="tag-suggest" id={listId} role="listbox" aria-label={t("Guides")}>
          {hits.map((t, i) => (
            <button key={t.href} id={`${listId}-${i}`} type="button" role="option" aria-selected={i === index} className="menu-item" onMouseDown={(e) => e.preventDefault()} onMouseMove={() => i !== index && setIndex(i)} onClick={() => onApply(t.href, t.title)}>
              <Icon name="book" size={14} />
              <span className="grow ellipsis">{t.title}</span>
              {t.detail && <span className="muted small">{t.detail}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
