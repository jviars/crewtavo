/**
 * What the guide editor (Tiptap) can hold, and the pieces Tiptap doesn't have: headings from "# "
 * and "## ", YouTube and Vimeo players, and callouts (Tip, Important, Warning). The HTML they make
 * is what guides store and what the page sanitiser (lib/html.ts) lets through.
 * A contract section (Settings → Contract terms) holds less: contractExtensions, kept to what
 * sanitizeContractHtml lets print on an estimate.
 */
import { videoAttributes, videoEmbed, videoFromPaste } from "@crewtavo/core/video";
import { mergeAttributes, Node, textblockTypeInputRule, wrappingInputRule, type Extensions } from "@tiptap/core";
import Heading from "@tiptap/extension-heading";
import Image from "@tiptap/extension-image";
import { OrderedList, orderedListInputRegex, TaskItem, TaskList } from "@tiptap/extension-list";
import { TableKit } from "@tiptap/extension-table";
import { Placeholder } from "@tiptap/extensions";
import { Plugin } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import { isAppPath } from "@/lib/html";

export const CALLOUTS = [
  { tone: "tip", label: "Tip" },
  { tone: "important", label: "Important" },
  { tone: "warning", label: "Warning" },
] as const;
export type CalloutTone = (typeof CALLOUTS)[number]["tone"];
const isTone = (t: string | null): t is CalloutTone => CALLOUTS.some((c) => c.tone === t);

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    callout: {
      /** Puts the selected lines in a callout, or changes the callout they're in. */
      setCallout: (tone: CalloutTone) => ReturnType;
      unsetCallout: () => ReturnType;
    };
    video: {
      /** Puts a player on a line of its own: the caret's line when it's empty, otherwise after it. */
      insertVideo: (src: string) => ReturnType;
    };
  }
}

/** The guide's title is the page's heading, so "# " makes an h2 and "## " an h3 (h4 only comes from older guides and Markdown). */
const GuideHeading = Heading.extend({
  addInputRules() {
    return [2, 3].map((level) => textblockTypeInputRule({ find: new RegExp(`^(#{${level - 1}})\\s$`), type: this.type, getAttributes: { level } }));
  },
}).configure({ levels: [2, 3, 4] });

/** A YouTube or Vimeo player, rebuilt from the video's id like everywhere else (see core/video). Stored as a line holding just the iframe. */
const Video = Node.create({
  name: "video",
  group: "block",
  atom: true,
  draggable: true,
  addAttributes() {
    return { src: { default: null } };
  },
  parseHTML() {
    const read = (frame: Element | null) => {
      const video = frame?.tagName === "IFRAME" ? videoEmbed(frame.getAttribute("src") ?? "") : null;
      return video ? { src: video.src } : false;
    };
    return [
      { tag: "p", priority: 60, getAttrs: (p) => (p.children.length === 1 && !p.textContent?.trim() ? read(p.firstElementChild) : false) },
      { tag: "iframe", getAttrs: read },
    ];
  },
  renderHTML({ node }) {
    const video = videoEmbed(String(node.attrs.src ?? ""));
    return ["p", ["iframe", video ? videoAttributes(video) : {}]];
  },
  addCommands() {
    return {
      insertVideo:
        (src) =>
        ({ state, commands }) => {
          const { $from } = state.selection;
          const blank = $from.parent.isTextblock && $from.parent.content.size === 0;
          const node = { type: this.name, attrs: { src } };
          return blank || $from.depth === 0 ? commands.insertContent(node) : commands.insertContentAt($from.after(), node);
        },
    };
  },
  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        props: {
          // A video link pasted on an empty line, or a video's embed code anywhere, becomes the video.
          handlePaste: (view, event) => {
            const text = event.clipboardData?.getData("text/plain") ?? "";
            const video = videoFromPaste(text);
            const { empty, $from } = view.state.selection;
            if (!video || !(/<iframe\b/i.test(text) || (empty && $from.parent.isTextblock && $from.parent.content.size === 0))) return false;
            return editor.commands.insertVideo(video.src);
          },
        },
      }),
    ];
  },
});

const Callout = Node.create({
  name: "callout",
  group: "block",
  content: "block+",
  defining: true,
  addAttributes() {
    return {
      tone: {
        default: "tip",
        parseHTML: (el) => {
          const tone = el.getAttribute("data-callout");
          return isTone(tone) ? tone : "tip";
        },
        renderHTML: (attrs) => ({ "data-callout": attrs.tone }),
      },
    };
  },
  parseHTML() {
    return [{ tag: "div[data-callout]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", HTMLAttributes, 0];
  },
  addCommands() {
    return {
      setCallout:
        (tone) =>
        ({ editor, commands }) =>
          editor.isActive(this.name) ? commands.updateAttributes(this.name, { tone }) : commands.wrapIn(this.name, { tone }),
      unsetCallout:
        () =>
        ({ commands }) =>
          commands.lift(this.name),
    };
  },
});

/** Where a stored picture can be seen: a short-lived link to its path, or null when there isn't one. */
export type PictureLink = (path: string) => Promise<string | null>;

/**
 * A picture. One added here (the Picture button, a paste or a drop: RichTextEditor) is stored and
 * saved by its path (data-path), with no link, since a link to a private file only lasts a while:
 * it's shown with one asked for as it's shown (`link`). An older or pasted one keeps its web address.
 */
const Picture = Image.extend<{ inline: boolean; allowBase64: boolean; HTMLAttributes: Record<string, unknown>; resize: false; link: PictureLink | null }>({
  addOptions() {
    return { ...this.parent!(), link: null };
  },
  addAttributes() {
    return {
      ...this.parent?.(),
      path: { default: null, parseHTML: (el) => el.getAttribute("data-path"), renderHTML: (a) => (a.path ? { "data-path": a.path } : {}) },
      // While it uploads: which upload it is, so it can be finished or taken out. Never saved.
      uploading: { default: null, rendered: false },
    };
  },
  parseHTML() {
    return [{ tag: "img[data-path]" }, { tag: 'img[src]:not([src^="data:"])' }];
  },
  renderHTML({ node, HTMLAttributes }) {
    const attrs = { ...HTMLAttributes };
    if (node.attrs.path) delete attrs.src;
    return ["img", attrs];
  },
  addNodeView() {
    const link = this.options.link;
    return ({ node }) => {
      const img = document.createElement("img");
      let shown = node;
      const show = (n: typeof node) => {
        shown = n;
        img.alt = n.attrs.alt ?? "";
        for (const side of ["width", "height"] as const) {
          if (n.attrs[side]) img.setAttribute(side, String(n.attrs[side]));
          else img.removeAttribute(side);
        }
        img.toggleAttribute("data-uploading", Boolean(n.attrs.uploading));
        if (n.attrs.src) img.src = n.attrs.src;
        else if (n.attrs.path && link) {
          const path = n.attrs.path as string;
          void link(path).then((url) => {
            if (url && shown.attrs.path === path && !shown.attrs.src) img.src = url;
          }, () => undefined);
        }
      };
      show(node);
      return { dom: img, update: (n) => (n.type === node.type ? (show(n), true) : false) };
    };
  },
});

export function guideExtensions(placeholder: string, link: PictureLink | null = null): Extensions {
  return [
    StarterKit.configure({
      heading: false,
      link: {
        openOnClick: false,
        defaultProtocol: "https",
        isAllowedUri: (url) => /^(https?:|mailto:|tel:)/i.test(url) || isAppPath(url),
      },
    }),
    GuideHeading,
    TaskList,
    TaskItem.configure({ nested: true }),
    TableKit.configure({ table: { resizable: false } }),
    Picture.configure({ allowBase64: false, link }),
    Video,
    Callout,
    Placeholder.configure({ placeholder }),
  ];
}

/**
 * A contract section's title prints above its words, so "# " makes an h3 and "## " an h4. Pasted
 * headings become these too, the way sanitizeContractHtml reads them: big ones (h1-h3) as h3,
 * small ones (h4-h6) as h4.
 */
const ContractHeading = Heading.extend({
  parseHTML() {
    return [1, 2, 3, 4, 5, 6].map((n) => ({ tag: `h${n}`, attrs: { level: n <= 3 ? 3 : 4 } }));
  },
  addInputRules() {
    return [3, 4].map((level) => textblockTypeInputRule({ find: new RegExp(`^(#{${level - 2}})\\s$`), type: this.type, getAttributes: { level } }));
  },
}).configure({ levels: [3, 4] });

/**
 * A contract's numbered list numbers from 1 in numbers, as it prints (contractBlocks numbers each
 * list from 1, and sanitizeContractHtml keeps no "start" or "type"): a list typed as "2. " under a
 * paragraph, or pasted from Word starting at 3 or lettered a, b, c, shows as it will print. Typing
 * the next number under a list ("3. " under two items) carries it on.
 */
const ContractOrderedList = OrderedList.extend({
  addAttributes() {
    return {};
  },
  renderHTML({ HTMLAttributes }) {
    return ["ol", mergeAttributes(this.options.HTMLAttributes, HTMLAttributes), 0];
  },
  addInputRules() {
    return [wrappingInputRule({ find: orderedListInputRegex, type: this.type, joinPredicate: (match, list) => list.childCount + 1 === Number(match[1]) })];
  },
});

/**
 * What a contract section can hold: words in bold, italic or underline, headings, numbered and
 * bulleted lists, quotes, dividers and tables. No links, pictures, video, callouts or checklists,
 * which a printed contract can't use (sanitizeContractHtml drops them). A pasted contract keeps its
 * headings and formatting, including the bold and italics Google Docs and Word write as styles,
 * and loses the rest.
 */
export function contractExtensions(placeholder: string): Extensions {
  return [
    StarterKit.configure({ heading: false, link: false, code: false, codeBlock: false, orderedList: false }),
    ContractOrderedList,
    ContractHeading,
    TableKit.configure({ table: { resizable: false } }),
    Placeholder.configure({ placeholder }),
  ];
}
