/**
 * The rich-text editor for guides (Tiptap): headings, bold/italic/underline, numbered steps, lists
 * and checklists, quotes, callouts, tables, links, dividers and YouTube or Vimeo videos, with
 * Markdown-style shortcuts ("# ", "- ", "1. ", "[] ", "> ") and paste that keeps only what a guide
 * can hold. Output is sanitized HTML plus plain text for search.
 *
 * In `contract` mode it writes a contract section (Settings → Contract terms) instead: headings,
 * bold/italic/underline, lists, quotes, dividers and tables (contractExtensions, which also decide
 * what a paste keeps), saved cleaned to what prints on an estimate (sanitizeContractHtml), with an
 * "Insert a fill-in" menu for words like {Customer name}.
 */
import { videoFromPaste } from "@crewtavo/core/video";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import { useId, useRef, useState } from "react";
import { sanitizeContractHtml, sanitizeHtml } from "@/lib/html";
import { CALLOUTS, contractExtensions, guideExtensions } from "./editorExtensions";
import { Icon, type IconName } from "./Icon";
import { Menu } from "./Menu";

export function RichTextEditor({
  initialHtml,
  onChange,
  placeholder = "Start writing…",
  minHeight = 320,
  label = "Content",
  mode = "guide",
  fillIns = [],
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
}) {
  const contract = mode === "contract";
  const sanitize = contract ? sanitizeContractHtml : sanitizeHtml;
  const [linking, setLinking] = useState<string | null>(null);
  const [videoForm, setVideoForm] = useState<{ error: boolean } | null>(null);
  const videoErrorId = useId();
  // The editor is made once; these keep its callbacks current.
  const changed = useRef(onChange);
  changed.current = onChange;
  const linkShortcut = useRef(() => {});

  const editor = useEditor({
    extensions: contract ? contractExtensions(placeholder) : guideExtensions(placeholder),
    content: sanitize(initialHtml),
    editorProps: {
      attributes: { class: "rte-body prose", role: "textbox", "aria-multiline": "true", "aria-label": label, style: `min-height: ${minHeight}px` },
      handleKeyDown: (_, e) => {
        if (contract || !((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k")) return false;
        e.preventDefault();
        linkShortcut.current();
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
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
    }),
  });

  const focus = () => editor.chain().focus();

  const openLink = () => {
    setVideoForm(null);
    setLinking(editor.getAttributes("link").href ?? "");
  };
  linkShortcut.current = openLink;
  const closeLink = () => {
    setLinking(null);
    editor.commands.focus();
  };
  const applyLink = (raw: string) => {
    const url = raw.trim();
    const chain = focus().extendMarkRange("link");
    if (!url) chain.unsetLink().run();
    else {
      const href = /^(https?:|mailto:|tel:)/i.test(url) ? url : /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(url) ? `mailto:${url}` : `https://${url}`;
      // With nothing selected, the link's address is its text; typing after it isn't part of the link.
      if (editor.state.selection.empty && !editor.isActive("link")) chain.insertContent({ type: "text", text: url, marks: [{ type: "link", attrs: { href } }] }).unsetMark("link").run();
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
                  <Icon name="hash" size={15} />
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
      {linking !== null && (
        <form className="rte-link" onSubmit={(e) => { e.preventDefault(); applyLink(new FormData(e.currentTarget).get("url") as string); }}>
          <Icon name="link" size={15} />
          <input name="url" className="input" defaultValue={linking} placeholder="Paste a link (https://…), email or phone" aria-label="Link" autoFocus onKeyDown={(e) => e.key === "Escape" && (e.preventDefault(), closeLink())} />
          <button type="submit" className="btn btn-sm btn-primary">Apply</button>
          {linking && <button type="button" className="btn btn-sm btn-ghost" onClick={() => applyLink("")}>Remove</button>}
          <button type="button" className="icon-btn" aria-label="Cancel" onClick={closeLink}><Icon name="x" size={16} /></button>
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
      <EditorContent editor={editor} />
    </div>
  );
}
