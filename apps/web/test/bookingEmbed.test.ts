import ts from "typescript";
import { describe, expect, it } from "vitest";
import { EMBED_HEIGHT, EMBED_SCRIPT, embedCode, nextEmbedCode } from "../src/features/booking/embed";

const FORM_URL = "https://crm.greenlawn.com/book/green-lawn/free-estimate";

/** Runs the website's script against stand-in frames; returns what a message from one of them does. */
function website(frameCount: number, script = EMBED_SCRIPT) {
  let listener: ((e: { source: unknown; data: unknown }) => void) | undefined;
  const scrolls: number[] = [];
  const frames = Array.from({ length: frameCount }, () => ({
    contentWindow: {},
    style: { height: `${EMBED_HEIGHT}px` },
    top: 300,
    getBoundingClientRect() { return { top: this.top }; },
  }));
  const document = { querySelectorAll: (selector: string) => (selector === "iframe[data-crewtavo-form]" ? frames : []) };
  const addEventListener = (type: string, fn: typeof listener) => { if (type === "message") listener = fn; };
  const scrollBy = ({ top }: { top: number }) => scrolls.push(top);
  new Function("addEventListener", "document", "scrollBy", script)(addEventListener, document, scrollBy);
  return { frames, scrolls, post: (source: unknown, data: unknown) => listener!({ source, data }) };
}

interface Element { type: unknown; props: Record<string, unknown> }

/** Compiles the Next.js component as a project would, then renders it with stand-ins for React and next/script. */
function renderNext(code: string) {
  const { outputText, diagnostics } = ts.transpileModule(code, {
    reportDiagnostics: true,
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  expect(diagnostics?.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"))).toEqual([]);
  const Script = Symbol("next/script");
  const element = (type: unknown, props: Record<string, unknown>): Element => ({ type, props });
  const modules: Record<string, unknown> = { "react/jsx-runtime": { jsx: element, jsxs: element, Fragment: "fragment" }, "next/script": { __esModule: true, default: Script } };
  const exports: Record<string, unknown> = {};
  new Function("require", "exports", outputText)((name: string) => modules[name], exports);
  const [frame, script] = (exports.BookingForm as () => Element)().props.children as Element[];
  return { frame: frame!, script: script!, Script };
}

describe("booking form embed code", () => {
  it("frames the form with ?embed=1, named for screen readers, at a fixed height to start", () => {
    const code = embedCode(FORM_URL, "Free estimate");
    expect(code).toContain(`<iframe src="${FORM_URL}?embed=1" title="Free estimate" data-crewtavo-form`);
    expect(code).toContain(`height:${EMBED_HEIGHT}px`);
    expect(code).toMatch(/<\/iframe>\n<script>\n[\s\S]+\n<\/script>$/);
  });

  it("keeps a form's name from breaking out of its attribute", () => {
    const code = embedCode(FORM_URL, `Mowing & "edging" <weekly>`);
    expect(code).toContain('title="Mowing &amp; &quot;edging&quot; &lt;weekly&gt;"');
  });

  it("fits each frame to its own form, whatever else posts messages", () => {
    const { frames, post } = website(2);
    post(frames[1]!.contentWindow, { crewtavo: "height", height: 612.4 });
    expect(frames.map((f) => f.style.height)).toEqual([`${EMBED_HEIGHT}px`, "613px"]);

    post({}, { crewtavo: "height", height: 50 });
    post(frames[0]!.contentWindow, "not ours");
    post(frames[0]!.contentWindow, null);
    post(frames[0]!.contentWindow, { crewtavo: "height", height: "lots" });
    post(frames[0]!.contentWindow, { crewtavo: "height", height: -5 });
    expect(frames[0]!.style.height).toBe(`${EMBED_HEIGHT}px`);
  });

  it("gives a Next.js site a component that renders the same frame and loads the same script once", () => {
    const { frame, script, Script } = renderNext(nextEmbedCode(FORM_URL, "Free estimate"));
    expect(frame.type).toBe("iframe");
    expect(frame.props).toMatchObject({ src: `${FORM_URL}?embed=1`, title: "Free estimate", "data-crewtavo-form": "", style: { width: "100%", height: EMBED_HEIGHT } });
    expect(script.type).toBe(Script);
    expect(script.props).toMatchObject({ id: "crewtavo-forms", strategy: "afterInteractive" });

    const { frames, post } = website(1, script.props.children as string);
    post(frames[0]!.contentWindow, { crewtavo: "height", height: 480 });
    expect(frames[0]!.style.height).toBe("480px");
  });

  it("keeps quotes and ampersands in a form's name intact in JSX", () => {
    const name = `Mow & "edge" &amp; {weekly}`;
    expect(renderNext(nextEmbedCode(FORM_URL, name)).frame.props.title).toBe(name);
    expect(renderNext(nextEmbedCode(FORM_URL, "Spring {cleanup} <yard>")).frame.props.title).toBe("Spring {cleanup} <yard>");
  });

  it("brings a sent form into view, below a sticky header, only when its top is out of sight", () => {
    const { frames, scrolls, post } = website(1);
    post(frames[0]!.contentWindow, { crewtavo: "top" });
    expect(scrolls).toEqual([]);
    frames[0]!.top = -400;
    post(frames[0]!.contentWindow, { crewtavo: "top" });
    post(frames[0]!.contentWindow, { crewtavo: "height", height: 240 });
    expect(scrolls).toEqual([-500]);
  });
});
