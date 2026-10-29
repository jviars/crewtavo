import { describe, expect, it } from "vitest";
import { extensionFor, fileTitle, GOOGLE_EXPORTS, TRASH_DAYS, trashPurgeAt } from "../src/drive";

// The stored path's rule (supabase/migrations/20261019001700_plan_files.sql): <company>/plans/<uuid>.<ext>.
const STORED_EXTENSION = /^[a-z0-9]{1,8}$/;

describe("a stored file's extension", () => {
  it("is the name's own, in lowercase", () => {
    expect(extensionFor("Bid set.PDF", "application/pdf")).toBe("pdf");
    expect(extensionFor("Site photo.JPEG", "image/jpeg")).toBe("jpeg");
    expect(extensionFor("archive.tar.gz")).toBe("gz");
    // A name's extension wins over its type.
    expect(extensionFor("notes.txt", "application/octet-stream")).toBe("txt");
  });

  it("comes from the type when the name has none", () => {
    expect(extensionFor("Proposal", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe("docx");
    expect(extensionFor("Scan", "application/pdf; charset=binary")).toBe("pdf");
    expect(extensionFor("Roof", "image/jpeg")).toBe("jpg");
    expect(extensionFor("Roof", "image/heic")).toBe("heic");
    expect(extensionFor("Drawing", "application/vnd.google-apps.drawing")).toBe("png");
  });

  it("is bin when nothing says what it is, and always fits the stored path", () => {
    expect(extensionFor("README")).toBe("bin");
    expect(extensionFor("data", "application/x-unknown")).toBe("bin");
    // Too long, or not letters and digits: not an extension at all.
    expect(extensionFor("photo.verylongext")).toBe("bin");
    expect(extensionFor("file.tar_gz")).toBe("bin");
    expect(extensionFor("weird", "image/+++")).toBe("bin");
    for (const [name, mime] of [["a.PNG", null], ["b", "image/svg+xml"], ["c", "image/x-portable-anymap-extra"], ["d.", "text/csv"], ["", ""]] as const) {
      expect(extensionFor(name, mime)).toMatch(STORED_EXTENSION);
    }
  });
});

describe("a file's title", () => {
  it("is its name without the extension", () => {
    expect(fileTitle("Bid set rev 3.pdf")).toBe("Bid set rev 3");
    expect(fileTitle("site_plan__final.DWG")).toBe("site plan final");
    expect(fileTitle("  Proposal  ")).toBe("Proposal");
    expect(fileTitle("Report v1.2.docx")).toBe("Report v1.2");
  });

  it("is never empty or longer than 200 characters", () => {
    expect(fileTitle(".pdf")).toBe("Untitled");
    expect(fileTitle("")).toBe("Untitled");
    const long = fileTitle(`${"a".repeat(199)} ${"b".repeat(50)}.pdf`);
    expect(long).toBe("a".repeat(199));
    expect(fileTitle(`${"x".repeat(300)}.pdf`)).toHaveLength(200);
  });
});

describe("Google's own documents", () => {
  it("come in as Word, Excel, PDF and pictures", () => {
    expect(GOOGLE_EXPORTS["application/vnd.google-apps.document"]).toEqual({ mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ext: "docx" });
    expect(GOOGLE_EXPORTS["application/vnd.google-apps.spreadsheet"]?.ext).toBe("xlsx");
    expect(GOOGLE_EXPORTS["application/vnd.google-apps.presentation"]).toEqual({ mime: "application/pdf", ext: "pdf" });
    expect(GOOGLE_EXPORTS["application/vnd.google-apps.drawing"]).toEqual({ mime: "image/png", ext: "png" });
    // Folders, forms and sites have nothing to bring in.
    expect(GOOGLE_EXPORTS["application/vnd.google-apps.folder"]).toBeUndefined();
    expect(GOOGLE_EXPORTS["application/vnd.google-apps.form"]).toBeUndefined();
    for (const { ext } of Object.values(GOOGLE_EXPORTS)) expect(ext).toMatch(STORED_EXTENSION);
  });
});

describe("the Trash", () => {
  it("keeps things for 30 days", () => {
    expect(TRASH_DAYS).toBe(30);
    expect(trashPurgeAt("2026-10-28T12:00:00Z").toISOString()).toBe("2026-11-27T12:00:00.000Z");
    expect(trashPurgeAt(new Date("2026-02-01T00:00:00Z")).toISOString()).toBe("2026-03-03T00:00:00.000Z");
  });
});
