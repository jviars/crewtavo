/**
 * Crewtavo - Drive (features/drive): who has it in the menu (only with the app on, only the office,
 * never a sub or a crew), and the rules its Files page follows for folders, where a file is, and
 * attaching it to a client's records or taking it off them so it never ends up on nothing.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { ROLES, STAFF } from "@crewtavo/core/roles";
import { describe, expect, it } from "vitest";
import { MOBILE_TABS, mobileTabs, NAV_GROUPS, navVisible, OTHER_SCREENS, SETTINGS_ITEM } from "../src/components/shell/nav";
import {
  andList, attachLeaves, attachPatch, companyFilesNote, detachPatch, driveView, editableInDrive, fileMeta, flatTree, folderDescendants, folderNameProblem, folderPath, folderTree,
  groupClientFiles, iconKind, placeName, placesOf, seesDrive, versionRefused, type DriveFile, type DriveFolder,
} from "../src/features/drive/data";
import { deletedForeverToast } from "../src/features/drive/trash";

const DRIVE = NAV_GROUPS.flat().find((item) => item.to === "/drive")!;
const APPS = NAV_GROUPS.flat().find((item) => item.to === "/apps")!;
const ON = { drive: { enabled: true } };
const person = (role: string, permissions: string[] = [], settings: Record<string, unknown> = ON) => ({ role, permissions, company: { settings } });

describe("Drive in the menu", () => {
  it("shows once Drive is installed, to owners, admins, office staff and estimators", () => {
    expect(STAFF.filter((role) => navVisible(person(role), DRIVE))).toEqual(["owner", "admin", "office", "estimator"]);
    // It needs no area beyond the role: an estimator with only sales has it.
    expect(navVisible(person("estimator", ["sales"]), DRIVE)).toBe(true);
  });

  it("stays hidden while Drive isn't installed, even from the owner", () => {
    for (const settings of [{}, { drive: { enabled: false } }, { drive: {} }, { team_chat: { enabled: true } }]) {
      for (const role of STAFF) expect(navVisible(person(role, ["apps", "settings"], settings), DRIVE), `${role} ${JSON.stringify(settings)}`).toBe(false);
    }
  });

  it("never shows to crews or subs, whatever's turned on", () => {
    expect(navVisible(person("crew_lead", ["schedule", "timesheets", "equipment"]), DRIVE)).toBe(false);
    expect(navVisible(person("field_crew"), DRIVE)).toBe(false);
    expect(navVisible(person("subcontractor", ["subs"]), DRIVE)).toBe(false);
    const everything = { ...ON, team_chat: { enabled: true }, website: { enabled: true }, careers: { enabled: true } };
    const shown = [...NAV_GROUPS.flat(), ...OTHER_SCREENS, SETTINGS_ITEM].filter((item) => navVisible(person("subcontractor", [], everything), item)).map((item) => item.to);
    expect(shown).toEqual(["/field", "/field/jobs", "/field/paperwork"]);
  });

  it("lets in exactly the people the page itself does", () => {
    for (const role of ROLES) expect(seesDrive({ role }), role).toBe(navVisible(person(role), DRIVE));
  });

  it("lives under More on a phone, not in the bottom bar", () => {
    expect(MOBILE_TABS.some((t) => t.to === "/drive")).toBe(false);
    expect(mobileTabs(person("office")).some((t) => t.to === "/drive")).toBe(false);
  });

  it("is found by searching for files, documents or Google Drive, and so is its app", () => {
    for (const word of ["files", "documents", "folders", "google drive", "trash"]) expect(DRIVE.keywords).toContain(word);
    expect(APPS.keywords).toContain("drive files documents google drive");
  });

  it("has a Trash every team member finds in search, Drive installed or not, and a sub never does", () => {
    const TRASH = OTHER_SCREENS.find((item) => item.to === "/drive/trash")!;
    expect(TRASH.label).toBe("Trash");
    for (const settings of [{}, ON]) {
      expect(STAFF.filter((role) => navVisible(person(role, [], settings), TRASH)), JSON.stringify(settings)).toEqual([...STAFF]);
      expect(navVisible(person("subcontractor", ["subs"], settings), TRASH)).toBe(false);
    }
    for (const word of ["deleted", "restore", "undo", "recycle bin"]) expect(TRASH.keywords).toContain(word);
  });

  it("has its page and its Trash, which opens with Drive off", () => {
    const routes = readFileSync(fileURLToPath(new URL("../src/routes.tsx", import.meta.url)), "utf8");
    expect(routes).toContain('drive: () => import("@/features/drive/DrivePage")');
    expect(routes).toMatch(/path: "drive", \.\.\.page\(screens\.drive, "DrivePage"\)/);
    expect(routes).toMatch(/path: "drive\/trash", \.\.\.page\(screens\.drive, "DriveTrashPage"\)/);
  });
});

// ---------------------------------------------------------------------------------------------

const folder = (id: string, parent_id: string | null, name: string): DriveFolder => ({ id, parent_id, name, created_at: "2026-10-01T12:00:00Z", updated_at: "2026-10-01T12:00:00Z" });
const FOLDERS = [
  folder("root", null, "Company files"),
  folder("forms", "root", "Forms"),
  folder("insurance", "forms", "Insurance"),
  folder("ten", "root", "Price sheets 10"),
  folder("two", "root", "price sheets 2"),
];

describe("company folders", () => {
  const tree = folderTree(FOLDERS);

  it("finds Company files and lists each folder's folders by name, numbers in order", () => {
    expect(tree.root?.id).toBe("root");
    expect(tree.children.get("root")!.map((f) => f.name)).toEqual(["Forms", "price sheets 2", "Price sheets 10"]);
  });

  it("makes breadcrumbs from Company files down, and none for a folder that's gone", () => {
    expect(folderPath(tree, "insurance").map((f) => f.id)).toEqual(["root", "forms", "insurance"]);
    expect(folderPath(tree, null).map((f) => f.id)).toEqual(["root"]);
    expect(folderPath(tree, "trashed")).toEqual([]);
  });

  it("never offers to move a folder into itself or one of its own folders", () => {
    expect([...folderDescendants(tree, "forms")]).toEqual(["insurance"]);
    expect([...folderDescendants(tree, "root")].sort()).toEqual(["forms", "insurance", "ten", "two"]);
    expect(flatTree(tree).map(({ folder: f, depth }) => `${depth}:${f.id}`)).toEqual(["0:root", "1:forms", "2:insurance", "1:two", "1:ten"]);
  });

  it("doesn't loop on folders that point at each other", () => {
    const looped = folderTree([...FOLDERS, folder("a", "b", "A"), folder("b", "a", "B")]);
    expect(folderPath(looped, "a").map((f) => f.id)).toEqual(["b", "a"]);
    expect([...folderDescendants(looped, "a")]).toEqual(["b"]);
    expect(flatTree(looped)).toHaveLength(5);
  });

  it("checks a name the way the database does", () => {
    expect(folderNameProblem("  ")).toBe("Give the folder a name.");
    expect(folderNameProblem("Forms/2026")).toMatch(/can't have/);
    expect(folderNameProblem("Back\\up")).toMatch(/can't have/);
    expect(folderNameProblem("x".repeat(121))).toMatch(/120/);
    expect(folderNameProblem(" Insurance papers ")).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------

const file = (over: Partial<DriveFile> = {}): DriveFile => ({
  id: "f1", title: "Site plan", file_name: "site-plan.pdf", content_type: "application/pdf", size_bytes: 2_500_000, path: "c/plans/f1.pdf", revision: null, notes: null,
  crew_visible: true, archived: false, replaces_id: null, versions: 1, folder_id: null, folder_name: null, property_id: null, property_label: null, client_id: null, client_name: null,
  request_id: null, request_title: null, quote_id: null, quote_number: null, quote_title: null, job_id: null, job_number: null, job_title: null,
  created_by: null, created_by_name: null, created_at: "2026-10-19T15:00:00Z", updated_at: "2026-10-19T15:00:00Z", ...over,
});
const onJob = file({ job_id: "j12", job_number: 12, job_title: "Restripe", property_id: "p1", property_label: "14 Oak St", client_id: "c1", client_name: "Smith Roofing" });

describe("where a file is", () => {
  it("says its job, quote, request and property, each linking to its page", () => {
    expect(placesOf(onJob)).toEqual([
      { slot: "job_id", id: "j12", label: "Job #12 · Restripe", path: "/jobs/j12" },
      { slot: "property_id", id: "p1", label: "Smith Roofing · 14 Oak St", path: "/clients/c1" },
    ]);
    expect(placesOf(file({ quote_id: "q5", quote_number: 5, request_id: "r1", request_title: "Seal the lot" })).map((p) => p.label)).toEqual(["Quote #5", "Request · Seal the lot"]);
    expect(placesOf(file({ folder_id: "root" }))).toEqual([]);
  });

  it("taking a file off its last record puts it in Company files, so it never lands on nothing (the Trash)", () => {
    const row = { job_id: "j12", quote_id: null, request_id: null, property_id: null, folder_id: null };
    expect(detachPatch(row, "job_id", "root")).toEqual({ job_id: null, folder_id: "root" });
    // Still on its property, or already in a folder: only the record goes.
    expect(detachPatch({ ...row, property_id: "p1" }, "job_id", "root")).toEqual({ job_id: null });
    expect(detachPatch({ ...row, folder_id: "forms" }, "job_id", "root")).toEqual({ job_id: null });
    expect(detachPatch({ ...row, property_id: "p1" }, "property_id", "root")).toEqual({ property_id: null });
  });

  it("attaching keeps the client's other records, and leaves another client's behind", () => {
    expect(attachPatch(onJob, { slot: "quote_id", id: "q7", clientId: "c1", propertyId: "p1", label: "Quote #7" })).toEqual({ quote_id: "q7", property_id: "p1" });
    expect(attachPatch(onJob, { slot: "job_id", id: "j30", clientId: "c2", propertyId: "p9", label: "Job #30" })).toEqual({ job_id: "j30", quote_id: null, request_id: null, property_id: "p9" });
    // A company file has no client yet: it simply goes on the record.
    expect(attachPatch(file({ folder_id: "root" }), { slot: "property_id", id: "p9", clientId: "c2", propertyId: "p9", label: "9 Elm St" })).toEqual({ property_id: "p9" });
  });

  it("attaching to a job, quote or request puts the file at that record's property", () => {
    // The client's job at their other property: the file moves there, not left at the first one.
    expect(attachPatch(onJob, { slot: "job_id", id: "j15", clientId: "c1", propertyId: "p2", label: "Job #15" })).toEqual({ job_id: "j15", property_id: "p2" });
    // A request at no property: the file stays at its own.
    expect(attachPatch(onJob, { slot: "request_id", id: "r3", clientId: "c1", propertyId: null, label: "Request" })).toEqual({ request_id: "r3" });
    // Another client's, at no property: nothing of the first client's stays.
    expect(attachPatch(onJob, { slot: "request_id", id: "r4", clientId: "c2", propertyId: null, label: "Request" })).toEqual({ job_id: null, quote_id: null, request_id: "r4", property_id: null });
  });

  it("says what attaching takes a file off before it's moved: a file is on one job, quote and request, at one property", () => {
    const names = (pick: Parameters<typeof attachPatch>[1], from = onJob) => attachLeaves(placesOf(from), attachPatch(from, pick)).map((p) => placeName(from, p));
    // A second job at the same property: off the first job, still at the property.
    expect(names({ slot: "job_id", id: "j15", clientId: "c1", propertyId: "p1", label: "Job #15" })).toEqual(["Job #12"]);
    // At the client's other property: off the first job and that property.
    expect(names({ slot: "job_id", id: "j15", clientId: "c1", propertyId: "p2", label: "Job #15" })).toEqual(["Job #12", "14 Oak St"]);
    // A quote of the same client at the same property: nothing comes off, it's on both.
    expect(names({ slot: "quote_id", id: "q7", clientId: "c1", propertyId: "p1", label: "Quote #7" })).toEqual([]);
    // The job it's already on: nothing moves.
    expect(names({ slot: "job_id", id: "j12", clientId: "c1", propertyId: "p1", label: "Job #12" })).toEqual([]);
    // Another client's request: every one of the first client's records.
    const everywhere = file({ ...onJob, quote_id: "q5", quote_number: 5, request_id: "r1", request_title: " Gate code " });
    expect(names({ slot: "request_id", id: "r9", clientId: "c2", propertyId: null, label: "Request" }, everywhere)).toEqual(["Job #12", "Quote #5", "the request “Gate code”", "14 Oak St"]);
    expect(andList(["Job #12"])).toBe("Job #12");
    expect(andList(["Job #12", "14 Oak St"])).toBe("Job #12 and 14 Oak St");
    expect(andList(["Job #12", "Quote #5", "14 Oak St"])).toBe("Job #12, Quote #5 and 14 Oak St");
    // A place already taken off in the dialog isn't said again.
    const stillOn = placesOf(onJob).filter((p) => p.slot !== "job_id");
    expect(attachLeaves(stillOn, attachPatch(onJob, { slot: "job_id", id: "j15", clientId: "c1", propertyId: "p1", label: "Job #15" }))).toEqual([]);
  });

  it("offers Edit only on the current version of a file that isn't archived", () => {
    expect(editableInDrive({ superseded_at: null, archived: false })).toBe(true);
    expect(editableInDrive({ superseded_at: null })).toBe(true);
    expect(editableInDrive({ superseded_at: null, archived: true })).toBe(false);
    expect(editableInDrive({ superseded_at: "2026-10-20T10:00:00Z", archived: false })).toBe(false);
  });

  it("keeps the database's own words when it turns a new version down", () => {
    const raced = versionRefused({ code: "23505", message: "A newer version of Site plan was already added. Refresh and try again." });
    expect(raced.message).toBe("A newer version of Site plan was already added. Refresh and try again.");
    expect(versionRefused({ code: "23505", message: "duplicate key value violates unique constraint \"plan_files_path_key\"", details: null }).message).not.toMatch(/newer version/);
  });

  it("groups a client's files by property, then by job, quote and request, and the property's own last", () => {
    const groups = groupClientFiles([
      file({ id: "a", property_id: "p1", property_label: "14 Oak St" }),
      file({ id: "b", property_id: "p1", property_label: "14 Oak St", quote_id: "q5", quote_number: 5, quote_title: "Sealcoat" }),
      file({ id: "c", property_id: "p1", property_label: "14 Oak St", job_id: "j12", job_number: 12, job_title: "Restripe" }),
      file({ id: "d", property_id: "p1", property_label: "14 Oak St", job_id: "j14", job_number: 14 }),
      file({ id: "e", request_id: "r1", request_title: "Gate code" }),
      file({ id: "f", property_id: "p0", property_label: "1 Ash Ave" }),
    ]);
    expect(groups.map((g) => g.label)).toEqual(["1 Ash Ave", "14 Oak St", "Not at a property"]);
    expect(groups[1].places.map((p) => [p.label, p.files.map((f) => f.id).join()])).toEqual([
      ["Job #14", "d"],
      ["Job #12 · Restripe", "c"],
      ["Quote #5 · Sealcoat", "b"],
      ["At the property", "a"],
    ]);
    expect(groups[2].places[0]).toMatchObject({ label: "Request · Gate code", path: "/requests/r1" });
  });

  it("knows each kind of file by its type or its name", () => {
    expect(iconKind(file())).toBe("pdf");
    expect(iconKind(file({ content_type: null, file_name: "Bid form.DOCX" }))).toBe("doc");
    expect(iconKind(file({ content_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", file_name: "prices" }))).toBe("sheet");
    expect(iconKind(file({ content_type: "text/csv", file_name: "list.csv" }))).toBe("sheet");
    expect(iconKind(file({ content_type: "image/heic", file_name: "IMG_1.HEIC" }))).toBe("image");
    expect(iconKind(file({ content_type: "application/zip", file_name: "photos.zip" }))).toBe("file");
  });

  it("sums a file up in a line: version, revision, size, kind, when and who", () => {
    expect(fileMeta(file({ versions: 3, revision: " Rev B ", created_by_name: "Dana Ruiz" }))).toBe("Version 3 · Rev B · 2.4 MB · PDF · updated Oct 19, 2026 · by Dana Ruiz");
    expect(fileMeta(file({ size_bytes: null }))).toBe("PDF · Oct 19, 2026");
  });

  it("says where a restore landed when that's Company files, and how to see it with Drive off", () => {
    const at = (role: string, settings: Record<string, unknown>, permissions: string[] = ["apps"]) => ({ role, permissions, company: { settings } }) as Parameters<typeof companyFilesNote>[0];
    expect(companyFilesNote(at("admin", {}), false)).toBe("It's in Company files. Install Drive from Apps to see it.");
    expect(companyFilesNote(at("owner", {}, []), true)).toBe("Where it was is gone, so it's in Company files, under Restored files. Install Drive from Apps to see it.");
    expect(companyFilesNote(at("office", {}), false)).toBe("It's in Company files. Ask an owner or admin to install Drive to see it.");
    expect(companyFilesNote(at("admin", {}, []), false)).toBe("It's in Company files. Ask an owner or admin to install Drive to see it.");
    expect(companyFilesNote(at("estimator", ON), true)).toBe("Where it was is gone, so it's in Drive, under Restored files.");
    expect(companyFilesNote(at("crew_lead", ON), false)).toMatch(/^The office has it in Drive/);
  });

  it("after Delete forever, says a shortfall had already left the Trash, never to try again", () => {
    expect(deletedForeverToast({ count: 1, removed: 1 })).toEqual({ kind: "success", title: "Deleted forever" });
    expect(deletedForeverToast({ count: 640, removed: 640 })).toEqual({ kind: "success", title: "640 items deleted forever" });
    const one = deletedForeverToast({ count: 1, removed: 0 });
    expect(one).toMatchObject({ kind: "info", title: "It wasn't in the Trash any more" });
    expect(one.description).toMatch(/put it back|already deleted/);
    const some = deletedForeverToast({ count: 5, removed: 3 });
    expect(some).toMatchObject({ kind: "info", title: "3 of 5 items deleted forever" });
    expect(some.description).toBe("2 were no longer in the Trash: someone put them back, or they were already deleted.");
    expect(deletedForeverToast({ count: 2, removed: 0 }).title).toBe("Nothing was deleted");
    for (const r of [one, some]) expect(`${r.title} ${r.description}`).not.toMatch(/still in the Trash|try again/i);
    // Empty Trash stopped part way: how far it got, and that the rest is still there.
    const stopped = deletedForeverToast({ count: 400, removed: 400, error: new Error("You're offline.") });
    expect(stopped).toEqual({ kind: "error", title: "400 items deleted forever, then it stopped", description: "You're offline. What's left is still in the Trash." });
  });

  it("reads the page's view from its address", () => {
    expect(driveView(new URLSearchParams("view=clients&client=c1"))).toBe("clients");
    expect(driveView(new URLSearchParams("view=search&q=plan"))).toBe("search");
    expect(driveView(new URLSearchParams("view=trash"))).toBe("company");
    expect(driveView(new URLSearchParams(""))).toBe("company");
  });
});

// ---------------------------------------------------------------------------------------------

describe("Drive's code", () => {
  const DIR = fileURLToPath(new URL("../src/features/drive", import.meta.url));
  const sources = readdirSync(DIR).filter((name) => /\.tsx?$/.test(name)).map((name) => ({ name, code: readFileSync(join(DIR, name), "utf8") }));

  it("never deletes a stored file from the browser: only the server's purge does", () => {
    for (const { name, code } of sources) expect(code, name).not.toMatch(/\.remove\(\s*\[/);
  });

  it("loads no heavy library up front: every screen is fetched after sign-in", () => {
    for (const { name, code } of sources) {
      expect(code, name).not.toMatch(/^import [^;]*from "(pdfjs-dist|docx-preview|@docx-editor\.dev|tus-js-client)[^"]*"/m);
      expect(code, name).not.toMatch(/^import [^;]*from "@\/features\/files\/FileViewerBody"/m);
    }
  });

  it("asks Google only for the files people pick", () => {
    const picker = sources.find((s) => s.name === "googlePicker.ts")!.code;
    expect(picker).toContain('"https://www.googleapis.com/auth/drive.file"');
    expect(picker).not.toMatch(/auth\/drive(\.readonly)?"/);
    // The token stays in the tab's memory.
    expect(picker).not.toMatch(/localStorage|sessionStorage|indexedDB/);
  });
});
