/**
 * Editing a Word document in the file viewer, with the docx editor (@docx-editor.dev, Apache-2.0):
 * pages laid out like Word, its own toolbar and menus, and saving back to .docx with everything it
 * didn't touch kept as it was. It's a big download, so it loads only when someone presses Edit.
 *
 * Line and page breaks are measured with real font metrics: HarfBuzz (a small WebAssembly file
 * served with the app) and open-licensed stand-ins for Word's fonts (Carlito for Calibri, Liberation
 * Sans for Arial…), loaded as a document asks for them. Nothing is fetched from anywhere else.
 */
import "@docx-editor.dev/core/styles/editor.css";
import harfbuzzWasm from "@docx-editor.dev/core/harfbuzz.wasm?url";
import { setHarfBuzzWasmUrl } from "@docx-editor.dev/core/layout";
import { packagedFonts } from "@docx-editor.dev/fonts";
import { DocxEditor, useFonts, type DocxEditorRef } from "@docx-editor.dev/react";
import { forwardRef, useImperativeHandle, useMemo, useRef, useState } from "react";
import { DOCX_TYPE, type FileEditor } from "./files";
import styles from "./files.module.css";

// Before the first editor is made: the shaper reads where its WebAssembly is once. The copy that
// came with the installed package (it refuses any other version).
setHarfBuzzWasmUrl(harfbuzzWasm);

/** No "Report issue" row: it would send the page's address to the editor's project on GitHub. */
const MENU = { reportIssue: false } as const;

export interface DocxEditProps {
  data: ArrayBuffer;
  title: string;
  onDirty(dirty: boolean): void;
  /** The editor's own File › Save and ⌘S. */
  onSave(): void;
}

export default forwardRef<FileEditor, DocxEditProps>(function DocxEdit({ data, title, onDirty, onSave }, ref) {
  const editor = useRef<DocxEditorRef>(null);
  const fonts = useFonts(packagedFonts());
  // A copy: the editor may hand the bytes to a worker, and the preview still needs them after.
  const bytes = useMemo(() => new Uint8Array(data.slice(0)), [data]);
  const [dark] = useState(() => document.documentElement.classList.contains("dark"));

  useImperativeHandle(ref, () => ({
    async save() {
      const saved = await editor.current?.save();
      if (!saved) throw new Error("The document is still opening. Try again in a moment.");
      return new Blob([saved], { type: DOCX_TYPE });
    },
  }), []);

  return (
    <div className={styles.docxEdit}>
      <DocxEditor
        ref={editor}
        document={bytes}
        mode="edit"
        title={title}
        colorMode={dark ? "dark" : "light"}
        fonts={fonts}
        menu={MENU}
        onSave={onSave}
        // Opening the document reports a change too ("load"); only edits count.
        onChange={(change) => {
          if (!change.source) onDirty(true);
        }}
        onFontError={(error) => console.warn("Word editor font", error)}
      />
    </div>
  );
});
