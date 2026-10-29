/**
 * Storage limits in the app (features/settings/storage.ts and StorageSettings.tsx): Settings →
 * Storage is for owners and admins with Settings, on every Crewtavo; it shows how full storage is
 * (the Trash's share included) and what that costs on Railway, the limit with Railway's default,
 * who's using it with a limit of their own that only owners set (never on an owner), limits by role,
 * and what each area holds. Drive's Apps panel shows the same total. An upload refused for space
 * says so in the server's words, with the way to Settings → Storage for those who can raise it.
 */
import { formatBytes } from "@crewtavo/core/storage";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DrivePanel } from "../src/features/apps/DrivePanel";
import { RolesSettings } from "../src/features/settings/RolesSettings";
import { settingsGroups } from "../src/features/settings/sections";
import {
  addEach, areaLabel, companyLine, fullness, gbField, limitText, managesStorage, monthly, notAdded, parseGb, personalLine, RefusedForSpace, reportStorageFull, setsAllowances,
  type StorageOverview, type StorageReport,
} from "../src/features/settings/storage";
import { StorageSettings } from "../src/features/settings/StorageSettings";
import { TeamSettings } from "../src/features/settings/TeamSettings";
import { uploadRefused } from "../src/lib/files";
import { ApiError, errorMessage, StorageFullError } from "../src/lib/errors";
import { getToasts } from "../src/lib/toast";

const COMPANY = "0f0f0f0f-0000-4000-8000-000000000000";
const session = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("../src/lib/session", () => ({
  useSession: () => session.current,
  hasRole: (s: { role: string }, ...roles: string[]) => s.role === "owner" || roles.includes(s.role),
  can: (s: { role: string; permissions: string[] }, p: string) => s.role === "owner" || s.permissions.includes(p),
  isSub: (s: { role: string }) => s.role === "subcontractor",
}));
vi.mock("../src/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/api")>()),
  api: { get: async () => ({}) },
  supabase: () => ({ rpc: async () => ({ data: null, error: null }) }),
}));

const as = (role: string, permissions: string[] = ["settings"], platform = "railway") => {
  session.current = {
    role,
    permissions,
    userId: "u-me",
    company: { id: COMPANY, name: "Green Acres", settings: {} },
    config: { singleCompany: true, platform, features: {}, googlePicker: null },
  };
};

const OVERVIEW: StorageOverview = {
  used_bytes: 45e9,
  trash_bytes: 5e9,
  files: 1234,
  limit_bytes: 50e9,
  limit_mode: "default",
  default_bytes: 50e9,
  default_basis: "Railway Hobby bucket",
  me: { used_bytes: 0, limit_bytes: null, limit_source: null },
};

const REPORT: StorageReport = {
  ...OVERVIEW,
  by_person: [
    { user_id: "u-me", name: "Pat Owner", role: "owner", role_name: "Owner", used_bytes: 20e9, limit_bytes: null, limit_source: null },
    { user_id: "u-sam", name: "Sam Crew", role: "crew_lead", role_name: "Foreman", used_bytes: 9e9, limit_bytes: 10e9, limit_source: "role" },
    { user_id: "u-ana", name: "Ana Office", role: "office", role_name: "Office", used_bytes: 3.1e9, limit_bytes: 20e9, limit_source: "person" },
    { user_id: "u-gone", name: "Lee Former", role: null, role_name: null, used_bytes: 1e9, limit_bytes: null, limit_source: null },
    { user_id: null, name: "Uploaded by Crewtavo", role: null, role_name: null, used_bytes: 7.9e9, limit_bytes: null, limit_source: null },
  ],
  by_area: [
    { area: "plans", bytes: 30e9 },
    { area: "visit", bytes: 8e9 },
    { area: "trash", bytes: 5e9 },
    { area: "applicants", bytes: 2e9 },
    { area: "empty", bytes: 0 },
  ],
  roles: [{ role_key: "crew_lead", name: "Crew lead", limit_bytes: 10e9 }],
  railway: { backend: "bucket", plan: "hobby", volumeBytes: null, pricePerGbMonth: 0.015 },
};

/** What a screen says, without its tags. */
const text = (html: string) =>
  html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/\s+/g, " ");

function render(element: ReactElement, seed: (client: QueryClient) => void) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seed(client);
  return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(MemoryRouter, null, element)));
}

const settingsPage = (report: StorageReport) =>
  render(createElement(StorageSettings), (client) => {
    client.setQueryData(["storage", COMPANY, "report"], report);
    client.setQueryData(["company-roles", COMPANY], [{ id: "role-foreman", name: "Foreman", base_role: "crew_lead", permissions: [] }]);
  });

describe("Settings → Storage in the menu", () => {
  const tabs = () => settingsGroups(session.current as never).flatMap((g) => g.items).flatMap((i) => ("tab" in i ? [i.tab] : []));

  it("is there for owners and admins with Settings, on Railway or not", () => {
    for (const platform of ["railway", "docker"]) {
      as("owner", [], platform);
      expect(tabs()).toContain("storage");
      as("admin", ["settings"], platform);
      expect(tabs()).toContain("storage");
    }
  });

  it("isn't there for an admin without Settings, the office, crews or subs", () => {
    as("admin", ["team", "apps"]);
    expect(tabs()).not.toContain("storage");
    for (const role of ["office", "estimator", "crew_lead", "field_crew", "subcontractor"]) {
      as(role, ["settings"]);
      expect(tabs(), role).not.toContain("storage");
    }
  });

  it("is found by searching for space, a limit or who's using it", () => {
    as("owner", []);
    const item = settingsGroups(session.current as never).flatMap((g) => g.items).find((i) => "tab" in i && i.tab === "storage")!;
    for (const word of ["space", "limit", "full", "who's using", "trash"]) expect(item.keywords).toContain(word);
  });

  it("sets the company's limit for owners and admins with Settings; only owners set a person's", () => {
    expect(managesStorage({ role: "owner", permissions: [] })).toBe(true);
    expect(managesStorage({ role: "admin", permissions: ["settings"] })).toBe(true);
    expect(managesStorage({ role: "admin", permissions: [] })).toBe(false);
    expect(managesStorage({ role: "office", permissions: ["settings"] })).toBe(false);
    expect(setsAllowances({ role: "owner" })).toBe(true);
    expect(setsAllowances({ role: "admin" })).toBe(false);
  });
});

describe("Settings → Storage", () => {
  beforeEach(() => as("owner", []));

  it("shows what's stored against the limit, the Trash's share, and what it costs on Railway", () => {
    const page = text(settingsPage(REPORT));
    expect(page).toContain(`${formatBytes(45e9)} of the ${formatBytes(50e9)} limit (90%) · 1,234 files`);
    expect(page).toContain(`In use ${formatBytes(40e9)}`);
    expect(page).toContain(`In the Trash ${formatBytes(5e9)}`);
    expect(page).toContain("Storage is 90% full");
    expect(page).toContain("Visit photos, quote photos, receipts and sub paperwork still go through");
    expect(page).toContain("empty the Trash to free 5 GB");
    expect(page).toContain("Railway charges $0.015 per GB a month for a bucket: about $0.67 a month for what's stored now, and about $0.75 a month if files reached the limit.");
  });

  it("says when storage is full, and has nothing to warn about while there's room", () => {
    expect(text(settingsPage({ ...REPORT, used_bytes: 51e9 }))).toContain("Storage is full New files in Drive and on plans, guide covers, résumés, chat pictures and equipment photos are turned away until there's room.");
    const roomy = text(settingsPage({ ...REPORT, used_bytes: 10e9, trash_bytes: 0 }));
    expect(roomy).not.toContain("full New files");
    expect(roomy).not.toContain("% full");
  });

  it("offers Railway's default with why, no limit, or a size of your own", () => {
    const page = text(settingsPage(REPORT));
    expect(page).toContain("Default (50 GB)");
    expect(page).toContain("50 GB: Railway Hobby bucket. Railway's Hobby plan holds up to 1 TB in buckets for your whole Railway workspace");
    expect(page).toContain("No limit");
    expect(page).toContain("Custom");
    expect(page).toContain("At 50 GB, storage would cost about $0.75 a month on Railway once files filled it.");

    const volume = text(settingsPage({ ...REPORT, default_bytes: 45e9, default_basis: "90% of your 50 GB volume", railway: { backend: "volume", plan: "pro", volumeBytes: 50e9, pricePerGbMonth: 0.15 } }));
    expect(volume).toContain("45 GB: 90% of your 50 GB volume. A volume holds only its size");
    expect(volume).toContain("for what the volume stores");

    // Not on Railway: no default, and no cost line.
    const elsewhere = text(settingsPage({ ...REPORT, limit_bytes: null, limit_mode: "default", default_bytes: null, default_basis: null, railway: null }));
    expect(elsewhere).toContain("there's no default limit");
    expect(elsewhere).toContain("No limit ·");
    expect(elsewhere).not.toContain("Railway charges");
  });

  it("lists who's using it, with each person's limit and where it comes from, and lets the owner set one for anyone but an owner", () => {
    const html = settingsPage(REPORT);
    const page = text(html);
    expect(page).toContain("Who's using it");
    // "in use" and "Limit:" show only where the table stacks, on a phone.
    expect(page).toContain("Pat Owner Owner 20 GB in use Not limited Owners never are");
    expect(page).toContain("Sam Crew Foreman 9 GB in use");
    expect(page).toContain("Limit: 10 GB From their role");
    expect(page).toContain("Limit: 20 GB Their own");
    expect(page).toContain("Uploaded by Crewtavo");
    expect(html).toContain('aria-label="Set a storage limit for Sam Crew"');
    expect(html).toContain('aria-label="Set a storage limit for Ana Office"');
    expect(html).not.toContain('aria-label="Set a storage limit for Pat Owner"');
    expect(html).not.toContain('aria-label="Set a storage limit for Uploaded by Crewtavo"');
    // Someone who left still has files here, but no limit to set.
    expect(page).toContain("Lee Former 1 GB in use — No longer on the team");
    expect(html).not.toContain('aria-label="Set a storage limit for Lee Former"');
    // Most first, with what no one in particular added at the end.
    expect(page.indexOf("Pat Owner")).toBeLessThan(page.indexOf("Sam Crew"));
    expect(page.indexOf("Ana Office")).toBeLessThan(page.indexOf("Uploaded by Crewtavo"));
  });

  it("gives owners limits by role: the company's roles and every built-in level but the owner's", () => {
    const html = settingsPage(REPORT);
    const page = text(html);
    expect(page).toContain("By role");
    expect(page).toContain("Foreman Crew lead access No limit");
    expect(page).toContain("Crew lead Built-in 10 GB each");
    for (const level of ["Admin", "Office", "Estimator", "Field crew"]) expect(html).toContain(`aria-label="Set a storage limit for ${level}"`);
    expect(html).not.toContain('aria-label="Set a storage limit for Owner"');
  });

  it("shows admins who's using it, but only owners set people's and roles' limits", () => {
    as("admin", ["settings"]);
    const html = settingsPage(REPORT);
    expect(text(html)).toContain("Who's using it");
    expect(text(html)).toContain("Owners set each person's limit.");
    expect(html).not.toContain("Set a storage limit");
    expect(text(html)).not.toContain("By role");
  });

  it("says what each area holds in plain words, biggest first, the Trash included", () => {
    const page = text(settingsPage(REPORT)).split("By area")[1]!;
    expect(page).toContain("Drive and plan files 30 GB");
    expect(page).toContain("Visit photos 8 GB");
    expect(page).toContain("The Trash 5 GB");
    expect(page).toContain("Résumés 2 GB");
    expect(page).not.toContain("Empty");
    expect(page.indexOf("Drive and plan files")).toBeLessThan(page.indexOf("Visit photos"));
  });

  it("explains what counts and what's never refused", () => {
    const page = text(settingsPage(REPORT));
    expect(page).toContain("Visit photos, quote photos, receipts and sub paperwork are never refused, so crews can always finish a job.");
    expect(page).toContain("Owners are never limited.");
    expect(page).toContain("including what's in the Trash");
  });
});

describe("Settings → People and Roles", () => {
  const member = (user_id: string, full_name: string, role: string, role_id: string | null = null) =>
    ({ user_id, role, role_id, active: true, labor_rate: null, profile: { full_name, email: `${user_id}@example.com`, color: null, avatar_url: null } });
  const seed = (client: QueryClient) => {
    client.setQueryData(["storage", COMPANY, "overview"], REPORT);
    client.setQueryData(["company-roles", COMPANY], [{ id: "role-foreman", name: "Foreman", base_role: "crew_lead", permissions: [] }]);
    client.setQueryData(["team", COMPANY], [member("u-me", "Pat Owner", "owner"), member("u-sam", "Sam Crew", "crew_lead", "role-foreman"), member("u-ana", "Ana Office", "office")]);
    client.setQueryData(["team-invites", COMPANY], []);
  };

  it("lets the owner give anyone but an owner a storage limit, from their row on People", () => {
    as("owner", []);
    const html = render(createElement(TeamSettings), seed);
    expect(html).toContain('aria-label="Storage limit for Ana Office"');
    expect(text(html)).toContain("Storage: 20 GB");
    expect(text(html)).toContain("Storage: 10 GB (role)");
    expect(html).not.toContain('aria-label="Storage limit for Pat Owner"');
    as("admin", ["team", "settings"]);
    expect(render(createElement(TeamSettings), seed)).not.toContain("Storage limit for");
  });

  it("lets the owner give a role, or a built-in level other than the owner's, a storage limit", () => {
    as("owner", []);
    const html = render(createElement(RolesSettings), seed);
    expect(html).toContain('aria-label="Storage limit for Admin"');
    expect(text(html)).toContain("Storage: 10 GB each");
    expect(html).not.toContain('aria-label="Storage limit for Owner"');
    as("admin", ["team", "settings"]);
    expect(render(createElement(RolesSettings), seed)).not.toContain("Storage limit for");
  });
});

describe("storage in words", () => {
  it("names every area as people know it, and one it doesn't know by its folder", () => {
    const named = { plans: "Drive and plan files", visit: "Visit photos", quote: "Quote photos", subs: "Sub paperwork", receipts: "Receipts", applicants: "Résumés", kb: "Guide covers", equipment: "Equipment photos", tickets: "Ticket photos", chat: "Chat", measurements: "Measure pictures", trash: "The Trash" };
    for (const [area, label] of Object.entries(named)) expect(areaLabel(area)).toBe(label);
    expect(areaLabel("site_photos")).toBe("Site photos");
    expect(areaLabel("")).toBe("Other files");
  });

  it("says how much is used, against the limit when there is one, and a person's own", () => {
    expect(companyLine({ used_bytes: 12.4e9, limit_bytes: 45e9 })).toBe("12.4 GB of 45 GB used");
    expect(companyLine({ used_bytes: 12.4e9, limit_bytes: null })).toBe("12.4 GB used");
    expect(personalLine({ used_bytes: 3.1e9, limit_bytes: 10e9, limit_source: "person" })).toBe("You've used 3.1 GB of your 10 GB");
    expect(personalLine({ used_bytes: 10.2e9, limit_bytes: 10e9, limit_source: "role" })).toBe("You've used all of your 10 GB");
    expect(personalLine({ used_bytes: 3.1e9, limit_bytes: null, limit_source: null })).toBeNull();
  });

  it("warns at 80% and 95%, the shares owners and admins are emailed at", () => {
    expect(fullness(null)).toBe("ok");
    expect(fullness(0.79)).toBe("ok");
    expect(fullness(0.8)).toBe("warning");
    expect(fullness(0.95)).toBe("danger");
    expect(fullness(1)).toBe("full");
  });

  it("reads a size in GB, and says what's wrong with one that isn't", () => {
    expect(parseGb("45")).toEqual({ bytes: 45e9 });
    expect(parseGb(" 2.5 GB ")).toEqual({ bytes: 2.5e9 });
    expect(parseGb("1,000")).toEqual({ bytes: 1000e9 });
    expect(parseGb("")).toEqual({ problem: "Enter a size in GB." });
    expect(parseGb("0")).toEqual({ problem: "Enter a size in GB, more than 0." });
    expect(parseGb("lots")).toEqual({ problem: "Enter a size in GB, more than 0." });
    expect(gbField(45e9)).toBe("45");
    expect(gbField(12_345_678_901)).toBe("12.35");
    expect(gbField(null)).toBe("");
  });

  it("prices storage as Railway bills it", () => {
    expect(monthly(60e9, 0.015)).toBe("about $0.90 a month");
    expect(monthly(100e9, 0.15)).toBe("about $15.00 a month");
    expect(monthly(1e8, 0.015)).toBe("under a cent a month");
  });

  it("says where a person's limit comes from, and that owners aren't limited", () => {
    expect(limitText({ user_id: "u1", role: "owner", limit_bytes: null, limit_source: null })).toEqual({ size: "Not limited", source: "Owners never are" });
    expect(limitText({ user_id: "u2", role: "office", limit_bytes: 10e9, limit_source: "person" })).toEqual({ size: "10 GB", source: "Their own" });
    expect(limitText({ user_id: "u3", role: "field_crew", limit_bytes: 5e9, limit_source: "role" })).toEqual({ size: "5 GB", source: "From their role" });
    expect(limitText({ user_id: "u4", role: "office", limit_bytes: null, limit_source: null })).toEqual({ size: "No limit", source: null });
    expect(limitText({ user_id: null, role: null, limit_bytes: null, limit_source: null })).toEqual({ size: "—", source: null });
  });

  it("names the files refused for space", () => {
    expect(notAdded(["Site plan.pdf"])).toBe("Site plan.pdf wasn't added");
    expect(notAdded(["Site plan.pdf", "Bid.docx"])).toBe("Site plan.pdf and Bid.docx weren't added");
    expect(notAdded(["Site plan.pdf", "Bid.docx", "Walkthrough.mp4"], "copied")).toBe("Site plan.pdf, Bid.docx and Walkthrough.mp4 weren't copied");
    expect(notAdded(["Site plan.pdf", "Bid.docx", "Walkthrough.mp4", "Specs.pdf"])).toBe("Site plan.pdf, Bid.docx and 2 more files weren't added");
  });
});

describe("an upload refused for space", () => {
  // The gateway's sentences (packages/core/src/storage.ts), as the browser gets them.
  const sentence = "This 600 MB file doesn't fit: 44.6 GB of the 45 GB storage limit is used. An owner or admin can raise it in Settings → Storage, or empty the Trash.";
  const personal = "This 600 MB file doesn't fit in your storage: you've used 9.8 GB of your 10 GB. Ask an owner to raise it, or move old files to the Trash.";

  it("shows the server's sentence as it is, never as something went wrong", () => {
    expect(errorMessage(new StorageFullError(sentence))).toBe(sentence);
    expect(errorMessage(new StorageFullError(personal))).toBe(personal);
  });

  it("says so with the way to Settings → Storage for those who set the limit, and only them", () => {
    const opened: string[] = [];
    expect(reportStorageFull(new StorageFullError(sentence), { title: "Site plan.pdf wasn't added", manages: true, open: () => opened.push("settings") })).toBe(true);
    const shown = getToasts().at(-1)!;
    expect(shown).toMatchObject({ kind: "error", title: "Site plan.pdf wasn't added", description: sentence });
    expect(shown.action?.label).toBe("Open storage settings");
    shown.action!.onClick();
    expect(opened).toEqual(["settings"]);

    // From the API (a Google Drive import), for someone who can't change it.
    expect(reportStorageFull(new ApiError(personal, 507), { title: "Bid.docx wasn't copied", manages: false, open: () => undefined })).toBe(true);
    expect(getToasts().at(-1)).toMatchObject({ title: "Bid.docx wasn't copied", description: personal, action: undefined });
  });

  it("leaves every other error to the screen", () => {
    const before = getToasts().length;
    expect(reportStorageFull(new Error("Upload failed. Try again."), { manages: true, open: () => undefined })).toBe(false);
    expect(reportStorageFull(new ApiError("Not allowed", 403), { manages: true, open: () => undefined })).toBe(false);
    expect(getToasts()).toHaveLength(before);
  });

  describe("in a batch of files", () => {
    // The gateway's sentence for the first file it refused, which gives that file's size.
    const FULL = sentence;
    /** A file of `size` bytes, without the bytes. */
    const sized = (name: string, size: number) => Object.defineProperty(new File([], name), "size", { value: size });
    const MB = 1e6;

    /** Adds `list` the way Drive and the Plans and files card do, against storage with `room` bytes left. */
    async function batch(list: File[], room: number, other: Record<string, Error> = {}) {
      const sent: string[] = [];
      const failed: string[] = [];
      const result = await addEach(
        list,
        async (f) => {
          sent.push(f.name);
          if (other[f.name]) throw other[f.name];
          // Each upload is checked on its own against the room left, as the gateway does.
          if (f.size > room) throw new StorageFullError(FULL);
          room -= f.size;
        },
        (f) => failed.push(f.name),
      );
      return { ...result, sent, failed };
    }

    it("keeps adding the rest after one is refused: a smaller one may still fit", async () => {
      const done = await batch([sized("Walkthrough.mp4", 600 * MB), sized("Site plan.pdf", 2 * MB), sized("Bid.pdf", 2 * MB), sized("Specs.pdf", 2 * MB)], 400 * MB);
      expect(done.sent).toEqual(["Walkthrough.mp4", "Site plan.pdf", "Bid.pdf", "Specs.pdf"]);
      expect(done.added).toBe(3);
      expect(done.refused.names).toEqual(["Walkthrough.mp4"]);
      expect(done.refused.title()).toBe("Walkthrough.mp4 wasn't added");
      expect(done.refused.first?.message).toBe(FULL);
      expect(done.failed).toEqual([]);
    });

    it("doesn't send a file at least as big as one already refused, and names it with the rest", async () => {
      const done = await batch([sized("Drone.mov", 500 * MB), sized("Site plan.pdf", 2 * MB), sized("Walkthrough.mp4", 600 * MB), sized("Copy.mov", 500 * MB), sized("Big plan.pdf", 300 * MB)], 400 * MB);
      expect(done.sent).toEqual(["Drone.mov", "Site plan.pdf", "Big plan.pdf"]);
      expect(done.added).toBe(2);
      expect(done.refused.names).toEqual(["Drone.mov", "Walkthrough.mp4", "Copy.mov"]);
      expect(done.refused.title()).toBe("Drone.mov, Walkthrough.mp4 and Copy.mov weren't added");
    });

    it("leaves every other failure to the screen, and a stopped file to neither", async () => {
      const stopped = new DOMException("The user aborted a request.", "AbortError");
      const done = await batch([sized("Stopped.pdf", MB), sized("Broken.pdf", MB), sized("Fine.pdf", MB)], 400 * MB, { "Stopped.pdf": stopped, "Broken.pdf": new Error("Upload failed. Try again.") });
      expect(done.failed).toEqual(["Broken.pdf"]);
      expect(done.added).toBe(1);
      expect(done.refused.first).toBeNull();
      expect(done.refused.names).toEqual([]);
    });

    it("collects a Google Drive import's refusals the same way, sizes unknown", () => {
      const refused = new RefusedForSpace();
      expect(refused.add(new Error("Google said no."), "Notes.docx")).toBe(false);
      expect(refused.add(new StorageFullError(FULL), "Walkthrough.mp4")).toBe(true);
      expect(refused.add(new ApiError(FULL, 507), "Bid.docx")).toBe(true);
      // Nothing is skipped without a size to go by.
      expect(refused.skips("Specs.pdf", 1)).toBe(false);
      expect(refused.first?.message).toBe(FULL);
      expect(refused.title("copied")).toBe("Walkthrough.mp4 and Bid.docx weren't copied");
    });
  });

  it("is a StorageFullError from a photo or a guide's cover sent in one request (supabase-js's 507)", () => {
    const full = uploadRefused({ message: sentence, status: 507, statusCode: "507" }, "You don't have permission to upload here.");
    expect(full).toBeInstanceOf(StorageFullError);
    expect(full.message).toBe(sentence);
    expect(uploadRefused({ message: "new row violates row-level security policy", status: 400, statusCode: "403" }, "You don't have permission to upload here.").message).toBe("You don't have permission to upload here.");
    expect(uploadRefused({ message: "Internal error", status: 500 }, "No.").message).toBe("Upload failed: Internal error");
  });
});

describe("Drive's Apps panel", () => {
  const panel = (overview: StorageOverview) => text(render(createElement(DrivePanel), (client) => client.setQueryData(["storage", COMPANY, "overview"], overview)));

  it("shows how much of the company's storage is used, and the way to its limit for those who set it", () => {
    as("admin", ["apps", "settings"]);
    const page = panel({ ...OVERVIEW, used_bytes: 12.4e9, limit_bytes: 45e9 });
    expect(page).toContain("Storage 12.4 GB of 45 GB used");
    expect(page).toContain("Storage limit");
    as("admin", ["apps"]);
    expect(panel({ ...OVERVIEW, used_bytes: 12.4e9, limit_bytes: 45e9 })).not.toContain("Storage limit");
  });

  it("adds a person's own limit, and says when storage is full", () => {
    as("admin", ["apps"]);
    expect(panel({ ...OVERVIEW, me: { used_bytes: 3.1e9, limit_bytes: 10e9, limit_source: "person" } })).toContain("You've used 3.1 GB of your 10 GB.");
    expect(panel({ ...OVERVIEW, used_bytes: 50e9 })).toContain("Full: 50 GB of 50 GB used");
  });
});
