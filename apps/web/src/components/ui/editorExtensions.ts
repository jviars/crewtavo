/**
 * What the guide editor (Tiptap) can hold, and the pieces Tiptap doesn't have: headings from "# "
 * and "## ", YouTube and Vimeo players, and callouts (Tip, Important, Warning). The HTML they make
 * is what guides store and what the page sanitiser (lib/html.ts) lets through.
 */
import { videoAttributes, videoEmbed, videoFromPaste } from "@crewtavo/core/video";
import { Node, textblockTypeInputRule, type Extensions } from "@tiptap/core";
import Heading from "@tiptap/extension-heading";
import Image from "@tiptap/extension-image";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { TableKit } from "@tiptap/extension-table";
import { Placeholder } from "@tiptap/extensions";
import { Plugin } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";

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

export function guideExtensions(placeholder: string): Extensions {
  return [
    StarterKit.configure({
      heading: false,
      link: {
        openOnClick: false,
        defaultProtocol: "https",
        isAllowedUri: (url) => /^(https?:|mailto:|tel:)/i.test(url),
      },
    }),
    GuideHeading,
    TaskList,
    TaskItem.configure({ nested: true }),
    TableKit.configure({ table: { resizable: false } }),
    // No way to add one yet, but older guides (and pasted pages) can have pictures.
    Image.configure({ allowBase64: false }),
    Video,
    Callout,
    Placeholder.configure({ placeholder }),
  ];
}
