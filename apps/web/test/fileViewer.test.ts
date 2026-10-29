import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { describe, expect, it } from "vitest";
import { clampView, downloadLink, editKind, fitView, minScale, previewKind, zoomAt, ZOOM_MAX } from "../src/features/files/files";
import { isForeignPdfRule } from "../src/features/files/pdfViewer";

const file = (file_name: string, content_type: string | null = null) => ({ file_name, content_type });

describe("which files the viewer shows and edits", () => {
  it("knows PDFs, Word documents, pictures and text by type or by name", () => {
    expect(previewKind(file("Site plan.pdf", "application/pdf"))).toBe("pdf");
    expect(previewKind(file("SITE PLAN.PDF", "application/octet-stream"))).toBe("pdf");
    expect(previewKind(file("Contract", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"))).toBe("docx");
    expect(previewKind(file("Contract.docx"))).toBe("docx");
    expect(previewKind(file("roof.jpg", "image/jpeg"))).toBe("image");
    expect(previewKind(file("IMG_0001.HEIC"))).toBe("image");
    expect(previewKind(file("prices.csv", "text/csv; charset=utf-8"))).toBe("text");
    expect(previewKind(file("notes.md"))).toBe("text");
    expect(previewKind(file("export.json", "application/json"))).toBe("text");
  });

  it("offers a download for everything else", () => {
    expect(previewKind(file("Bid.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"))).toBeNull();
    expect(previewKind(file("Old letter.doc", "application/msword"))).toBeNull();
    expect(previewKind(file("plans.dwg"))).toBeNull();
  });

  it("edits only PDFs and Word documents", () => {
    expect(editKind(file("Site plan.pdf"))).toBe("pdf");
    expect(editKind(file("Contract.docx"))).toBe("docx");
    expect(editKind(file("roof.jpg", "image/jpeg"))).toBeNull();
    expect(editKind(file("notes.txt", "text/plain"))).toBeNull();
  });

  it("saves under the file's own name", () => {
    expect(downloadLink("https://x/sign/files/a.pdf?token=t", "Site plan #2.pdf")).toBe("https://x/sign/files/a.pdf?token=t&download=Site%20plan%20%232.pdf");
  });
});

describe("panning and zooming a picture", () => {
  const stage = { width: 1000, height: 700 };
  const photo = { width: 4000, height: 3000 };

  it("fits a big picture in the stage, centered, and never enlarges a small one", () => {
    const view = fitView(stage, photo);
    expect(view.scale).toBeCloseTo((700 - 32) / 3000, 5);
    expect(view.x).toBeCloseTo((1000 - 4000 * view.scale) / 2, 5);
    expect(view.y).toBeCloseTo(16, 5);
    expect(fitView(stage, { width: 200, height: 100 }).scale).toBe(1);
  });

  it("keeps the spot under the fingers in place while zooming", () => {
    const view = fitView(stage, photo);
    const spot = { x: 600, y: 300 };
    const before = { x: (spot.x - view.x) / view.scale, y: (spot.y - view.y) / view.scale };
    const zoomed = zoomAt(view, 3, spot, stage, photo);
    expect((spot.x - zoomed.x) / zoomed.scale).toBeCloseTo(before.x, 5);
    expect((spot.y - zoomed.y) / zoomed.scale).toBeCloseTo(before.y, 5);
  });

  it("stops at its limits and keeps the picture in reach", () => {
    const view = fitView(stage, photo);
    expect(zoomAt(view, 1000, { x: 0, y: 0 }, stage, photo).scale).toBe(ZOOM_MAX);
    expect(zoomAt(view, 0.0001, { x: 0, y: 0 }, stage, photo).scale).toBeCloseTo(minScale(stage, photo), 5);
    // Dragged far off to the right: its left edge comes back to the stage's left edge.
    const big = { scale: 1, x: 5000, y: -100 };
    expect(clampView(big, stage, photo)).toEqual({ scale: 1, x: 0, y: -100 });
    // Smaller than the stage: centered.
    expect(clampView({ scale: 0.1, x: -50, y: 900 }, stage, photo)).toEqual({ scale: 0.1, x: 300, y: 200 });
  });
});

describe("pdf.js's stylesheet", () => {
  it("drops the rules for pdf.js's own app that would restyle Crewtavo", () => {
    expect(isForeignPdfRule(".dialog")).toBe(true);
    expect(isForeignPdfRule(".dialog .mainContainer *:focus-visible")).toBe(true);
    expect(isForeignPdfRule(".primaryButton, .secondaryButton")).toBe(true);
    expect(isForeignPdfRule(".sidebar")).toBe(true);
    expect(isForeignPdfRule(":is(.dialog.altText, .dialog.newAltText) .title")).toBe(true);
    expect(isForeignPdfRule("button.hasPopupMenu")).toBe(true);
  });

  it("keeps the pages, text, forms and markup", () => {
    expect(isForeignPdfRule(".pdfViewer .page")).toBe(false);
    expect(isForeignPdfRule(".textLayer span")).toBe(false);
    expect(isForeignPdfRule(".annotationLayer .textWidgetAnnotation :is(input, textarea)")).toBe(false);
    expect(isForeignPdfRule(".annotationEditorLayer .freeTextEditor")).toBe(false);
    expect(isForeignPdfRule(".sidebarResizer")).toBe(false);
    expect(isForeignPdfRule("#addSignatureDialog")).toBe(false);
  });
});

describe("leaving a screen with unsaved changes in the viewer", () => {
  const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

  it("asks once on Measure, and Measure's check covers the plan's unsaved markup too", () => {
    // The router heeds only one check: on Measure it's Measure's, told about the viewer's changes.
    const card = read("../src/features/measure/PlanOnMap.tsx");
    expect(card).toMatch(/blockNavigation=\{false\}\s*onDirtyChange=\{plan\.setViewerDirty\}/);
    const measure = read("../src/features/measure/MeasurePage.tsx");
    expect(measure.match(/useBlocker\(/g)).toHaveLength(1);
    expect(measure).toMatch(/useBlocker\(\(\{ currentLocation, nextLocation \}\) => \(dirty \|\| plan\.viewerDirty\)/);
    // The viewer's own check stays everywhere else, and it reports its changes, and none once closed.
    const body = read("../src/features/files/FileViewerBody.tsx");
    expect(body).toMatch(/dirty && blockNavigation && <LeaveGuard/);
    expect(body).toMatch(/onDirtyRef\.current\?\.\(value\)/);
    expect(body).toMatch(/useEffect\(\(\) => \(\) => onDirtyRef\.current\?\.\(false\), \[\]\)/);
  });
});
