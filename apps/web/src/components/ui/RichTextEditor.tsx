/**
 * The rich-text editor for guides (Tiptap): headings, bold/italic/underline, numbered steps, lists
 * and checklists, quotes, callouts, tables, links, dividers, pictures (with `pictures`: the Picture
 * button, or pasting or dropping one in) and YouTube or Vimeo videos, with Markdown-style shortcuts
 * ("# ", "- ", "1. ", "[] ", "> ") and paste that keeps only what a guide can hold. Output is
 * sanitized HTML plus plain text for search.
 *
 * In `contract` mode it writes a contract section (Settings → Contract terms) instead: headings,
 * bold/italic/underline, lists, quotes, dividers and tables (contractExtensions, which also decide
 * what a paste keeps), saved cleaned to what prints on an estimate (sanitizeContractHtml), with an
 * "Insert a fill-in" menu for words like {Customer name}.
 */
import { videoFromPaste } from "@crewtavo/core/video";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import { useEffect, useId, useRef, useState } from "react";
import { isAppPath, sanitizeContractHtml, sanitizeHtml } from "@/lib/html";
import { CALLOUTS, contractExtensions, guideExtensions, type PictureLink } from "./editorExtensions";
import { Icon, type IconName } from "./Icon";
import { Menu } from "./Menu";

/** Something the link box offers as you type, like a guide: its title, where it goes, and a word about it. */
export interface LinkTarget { title: string; href: string; detail?: string }

/** Adding pictures: storing one (its path and size, or an error to show), and a link to show a stored one. */
export interface Pictures {
  add: (file: File) => Promise<{ path: string; width: number; height: number }>;
  link: PictureLink;
  /** What the Picture button's file picker offers. */
  accept: string;
}

const isPicture = (f: File) => f.type.startsWith("image/") || /\.(heic|heif)$/i.test(f.name);

export function RichTextEditor({
  initialHtml,
  onChange,
  placeholder = "Start writing…",
  minHeight = 320,
  label = "Content",
  mode = "guide",
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

  const editor = useEditor({
    extensions: contract ? contractExtensions(placeholder) : guideExtensions(placeholder, (path) => pics.current?.link(path) ?? Promise.resolve(null)),
    content: sanitize(initialHtml),
    editorProps: {
      attributes: { class: "rte-body prose", role: "textbox", "aria-multiline": "true", "aria-label": label, style: `min-height: ${minHeight}px` },
      handleKeyDown: (_, e) => {
        if (contract || !((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k")) return false;
        e.preventDefault();
        linkShortcut.current();
        return true;
      },
      // A picture pasted (a screenshot, or one copied from somewhere) is stored and added where the cursor is.
      handlePaste: (_, event) => {
        const files = picturesIn(event.clipboardData?.files);
        if (!files.length) return false;
        event.preventDefault();
        addPicturesNow.current(files);
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
    onUpdate: ({ editor: e }) => changed.current(sanitize(e.getHTML()), e.getText({ blockSeparator: "\n" }).trim()),
  });

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
          setPictureError(`${file.name || "That picture"} wasn't added. ${error instanceof Error ? error.message : "Try again."}`);
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

  const tool = (icon: IconName, title: string, onClick: () => void, pressed?: boolean, disabled?: boolean) => (
    <button type="button" className="rte-btn" title={title} aria-label={title} aria-pressed={pressed} disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={onClick}>
      <Icon name={icon} size={16} strokeWidth={pressed ? 2 : undefined} />
    </button>
  );
  // A guide's headings sit under its title (h2, h3); a contract section's under the section's own title (h3, h4).
  const heading = (level: 2 | 3 | 4, text: string, title: string) => (
    <button type="button" className="rte-btn rte-text" title={title} aria-pressed={level === 2 ? active.h2 : level === 3 ? active.h3 : active.h4} onMouseDown={(e) => e.preventDefault()} onClick={() => focus().toggleHeading({ level }).run()}>{text}</button>
  );

  return (
    <div className="rte">
      <div className="rte-toolbar" role="toolbar" aria-label="Formatting">
        {heading(contract ? 3 : 2, "H1", "Heading")}
        {heading(contract ? 4 : 3, "H2", "Subheading")}
        <span className="rte-sep" />
        {tool("bold", "Bold (⌘B)", () => focus().toggleBold().run(), active.bold)}
        {tool("italic", "Italic (⌘I)", () => focus().toggleItalic().run(), active.italic)}
        {tool("underline", "Underline (⌘U)", () => focus().toggleUnderline().run(), active.underline)}
        <span className="rte-sep" />
        {tool("listOrdered", contract ? "Numbered list" : "Numbered steps", () => focus().toggleOrderedList().run(), active.steps)}
        {tool("list", "Bulleted list", () => focus().toggleBulletList().run(), active.bullets)}
        {!contract && tool("checklist", "Checklist", () => focus().toggleTaskList().run(), active.checklist)}
        <span className="rte-sep" />
        {tool("quoteMark", "Quote", () => focus().toggleBlockquote().run(), active.quote)}
        {!contract && (
          <Menu
            label="Callout"
            trigger={<Icon name="callout" size={16} />}
            triggerClassName={`rte-btn${active.callout ? " is-on" : ""}`}
            align="start"
            items={[
              ...CALLOUTS.map((c) => ({ label: c.label, icon: (active.callout === c.tone ? "check" : c.tone === "tip" ? "info" : "alert") as IconName, onSelect: () => focus().setCallout(c.tone).run() })),
              { separator: true, hidden: !active.callout },
              { label: "Remove callout", icon: "x", hidden: !active.callout, onSelect: () => focus().unsetCallout().run() },
            ]}
          />
        )}
        <Menu
          label="Table"
          trigger={<Icon name="table" size={16} />}
          triggerClassName={`rte-btn${active.table ? " is-on" : ""}`}
          align="start"
          items={[
            { label: "Insert table", icon: "table", hidden: active.table, onSelect: () => focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
            { label: "Add row below", icon: "plus", hidden: !active.table, onSelect: () => focus().addRowAfter().run() },
            { label: "Add column to the right", icon: "plus", hidden: !active.table, onSelect: () => focus().addColumnAfter().run() },
            { label: "Header row on or off", icon: "heading", hidden: !active.table, onSelect: () => focus().toggleHeaderRow().run() },
            { separator: true, hidden: !active.table },
            { label: "Delete row", icon: "minus", hidden: !active.table, onSelect: () => focus().deleteRow().run() },
            { label: "Delete column", icon: "minus", hidden: !active.table, onSelect: () => focus().deleteColumn().run() },
            { label: "Delete table", icon: "trash", danger: true, hidden: !active.table, onSelect: () => focus().deleteTable().run() },
          ]}
        />
        {!contract && tool("link", "Link (⌘K)", openLink)}
        {pictures && tool("image", "Picture (or paste or drop one in)", () => pictureInput.current?.click())}
        {!contract && tool("video", "Video (YouTube or Vimeo)", openVideo)}
        {tool("divider", "Divider", () => focus().setHorizontalRule().run())}
        <span className="rte-sep" />
        {tool("undo", "Undo (⌘Z)", () => focus().undo().run(), undefined, !active.canUndo)}
        {tool("redo", "Redo (⇧⌘Z)", () => focus().redo().run(), undefined, !active.canRedo)}
        {fillIns.length > 0 && (
          <>
            <span className="rte-sep" />
            <Menu
              label="Insert a fill-in"
              trigger={
                <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                  <Icon name="hash" size={14} />
                  Fill-in
                </span>
              }
              triggerClassName="rte-btn"
              align="start"
              items={[{ heading: "Filled in on each estimate" }, ...fillIns.map((f) => ({ label: f.label, onSelect: () => focus().insertContent({ type: "text", text: f.token }).run() }))]}
            />
          </>
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
      {(adding > 0 || pictureError) && (
        <div className="rte-link" role="status">
          <Icon name={pictureError ? "alert" : "image"} size={14} />
          <span className="grow small" style={{ color: pictureError ? "var(--danger)" : undefined }}>{pictureError ?? (adding === 1 ? "Adding the picture…" : `Adding ${adding} pictures…`)}</span>
          {pictureError && <button type="button" className="icon-btn" aria-label="Dismiss" onClick={() => setPictureError(null)}><Icon name="x" size={16} /></button>}
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
            placeholder="Describe the picture, for anyone who can't see it (optional)"
            aria-label="Picture description"
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
            placeholder="Paste a YouTube or Vimeo link"
            aria-label="YouTube or Vimeo link"
            aria-invalid={videoForm.error || undefined}
            aria-describedby={videoForm.error ? videoErrorId : undefined}
            autoFocus
            onChange={() => videoForm.error && setVideoForm({ error: false })}
            onKeyDown={(e) => {
              if (e.key === "Escape") { e.preventDefault(); closeVideo(); }
              else if (e.key === "Enter") { e.preventDefault(); addVideo(e.currentTarget.value); }
            }}
          />
          <button type="button" className="btn btn-sm btn-primary" onClick={() => addVideo(videoInput.current?.value ?? "")}>Add video</button>
          <button type="button" className="icon-btn" aria-label="Cancel" onClick={closeVideo}><Icon name="x" size={16} /></button>
          {videoForm.error && <p id={videoErrorId} className="error-text" role="alert">That isn't a YouTube or Vimeo link. On the video's page, choose Share, copy the link and paste it here.</p>}
        </div>
      )}
      <EditorContent editor={editor} />
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
        placeholder={find ? "Search guides, or paste a link, email or phone" : "Paste a link (https://…), email or phone"}
        aria-label="Link"
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
      <button type="button" className="btn btn-sm btn-primary" onClick={apply}>Apply</button>
      {initial && <button type="button" className="btn btn-sm btn-ghost" onClick={() => onApply("")}>Remove</button>}
      <button type="button" className="icon-btn" aria-label="Cancel" onClick={onClose}><Icon name="x" size={16} /></button>
      {find && typed && !address && !hits.length && <p className="muted small rte-link-note">No guide has that in its title. Paste a link instead, or try other words.</p>}
      {hits.length > 0 && (
        <div className="tag-suggest" id={listId} role="listbox" aria-label="Guides">
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
