/**
 * Settings → Your data → Database backups (features/settings/BackupsCard.tsx): how the backups are
 * doing from what GET /api/backups answers, what a backup does and doesn't cover, and the list with
 * its downloads, which only shows for the owner's password (apps/api/src/routes/backups.ts).
 */
import type { BackupEntry, BackupStatus } from "@crewtavo/core/backups";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { backupFileName, backupLine, backupProblem, BackupList, BACKUPS_KEY, BackupsCard, secretsNote } from "../src/features/settings/BackupsCard";

const session = vi.hoisted(() => ({ platform: "railway" }));
vi.mock("../src/lib/session", () => ({
  useSession: () => ({ role: "owner", permissions: [], userId: "u-me", company: { id: "c1", name: "Radford Lawn Care", settings: {} }, config: { features: {}, platform: session.platform } }),
}));
vi.mock("../src/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/api")>()),
  api: { get: async () => ({}), post: async () => ({}), download: async () => new Blob() },
}));

const GOOD: BackupStatus = { available: true, unavailable: null, running: false, lastGoodAt: "2026-11-12T08:05:00Z", lastRun: { at: "2026-11-12T08:05:20Z", ok: true, error: null }, warning: null };
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

function card(status: BackupStatus) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(BACKUPS_KEY, status);
  return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(BackupsCard)));
}

describe("database backups in Settings → Your data", () => {
  it("says when the last good backup was, what it covers and what it doesn't", () => {
    const html = card(GOOD);
    const words = text(html);
    expect(words).toContain("Every night Crewtavo saves a copy of its whole database");
    expect(words).toContain("It keeps the last 7 days and the last 4 weeks.");
    expect(words).toContain("Last good backup: ");
    expect(words).toContain("Photos and files aren't in it.");
    expect(words).toContain("only covered if the files volume or bucket is backed up separately");
    // The dumps sit next to what they back up, so a download is the copy kept elsewhere.
    expect(words).toContain("The backups are kept on the same Railway project as Crewtavo, so if that's lost, they go with it.");
    expect(html).not.toContain("form-error");
  });

  it("says the same server off Railway", () => {
    session.platform = "compose";
    expect(text(card(GOOD))).toContain("The backups are kept on the same server as Crewtavo");
    session.platform = "railway";
  });

  it("shows no backup or download until the password is typed, and asks for it the way the Stripe key does", () => {
    const html = card(GOOD);
    expect(text(html)).toContain("Your Crewtavo password");
    expect(html).toMatch(/<input[^>]*type="password"[^>]*autoComplete="current-password"/);
    // Nothing typed yet: neither button does anything.
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled=""[^>]*>.*Show backups/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*Back up now/);
    expect(html).not.toContain("row-between");
    expect(text(html)).not.toContain("Good, ");
  });

  it("says why the last backup didn't work, and when there's been none for two days", () => {
    const failed: BackupStatus = { ...GOOD, lastRun: { at: "2026-11-12T08:05:20Z", ok: false, error: "Storage didn't take the backup (500)." }, warning: "failed" };
    expect(backupProblem(failed)).toBe("The last backup didn't work. Storage didn't take the backup (500).");
    expect(card(failed)).toContain("form-error");
    expect(backupProblem({ ...GOOD, warning: "stale" })).toBe("There's been no good backup for over two days.");
    expect(backupProblem(GOOD)).toBeNull();
  });

  it("says what's happening before the first backup, and while one is made", () => {
    const none: BackupStatus = { ...GOOD, lastGoodAt: null, lastRun: null };
    expect(backupLine(none)).toBe("No backup yet. The first one is made within the hour.");
    expect(backupLine({ ...none, running: true })).toBe("The first backup is being made now.");
    expect(backupLine({ ...none, lastRun: { at: "2026-11-12T08:05:20Z", ok: false, error: "x" } })).toBe("No backup has worked yet.");
    expect(backupLine({ ...GOOD, running: true })).toContain("A new one is being made now.");
    expect(text(card({ ...GOOD, running: true }))).toContain("Making a backup…");
  });

  it("says why where backups can't be made, without the password box", () => {
    const html = card({ available: false, unavailable: "This Crewtavo was started without the database's backup tool (pg_dump), so it can't make backups.", running: false, lastGoodAt: null, lastRun: null, warning: null });
    expect(text(html)).toContain("started without the database's backup tool");
    expect(html).not.toContain('type="password"');
    expect(text(html)).not.toContain("Back up now");
  });

  it("lists each backup with its size or why it failed, and offers only good ones to download", () => {
    const backups: BackupEntry[] = [
      { id: "b3", kind: "manual", status: "running", startedAt: "2026-11-12T15:00:00Z", finishedAt: null, bytes: null, error: null },
      { id: "b2", kind: "nightly", status: "ok", startedAt: "2026-11-12T08:05:00Z", finishedAt: "2026-11-12T08:05:20Z", bytes: 3_100_000, error: null },
      { id: "b1", kind: "nightly", status: "failed", startedAt: "2026-11-11T08:05:00Z", finishedAt: "2026-11-11T08:05:02Z", bytes: null, error: "Storage didn't take the backup (500)." },
    ];
    const html = renderToStaticMarkup(createElement(BackupList, { backups, busy: null, onDownload: () => undefined }));
    const words = text(html);
    expect(words).toContain("Good, 3.1 MB");
    expect(words).toContain("Didn't work. Storage didn't take the backup (500).");
    expect(words).toContain("Being made…");
    expect(words).toContain("(made by hand)");
    expect(html.match(/Download/g)?.length).toBe(1);
    expect(text(renderToStaticMarkup(createElement(BackupList, { backups: [], busy: null, onDownload: () => undefined })))).toContain("No backups yet.");
  });

  it("says which secrets to save, what stops working without them and where they are, by name only", () => {
    const words = text(card(GOOD));
    expect(words).toContain("Save JWT_SECRET (and ENCRYPTION_KEY, if you set one) and POSTGRES_PASSWORD somewhere outside Railway");
    expect(words).toContain("Without JWT_SECRET, a restored Crewtavo can't read its connected apps, the owner's key file stops working, and links already sent to clients stop opening");
    expect(words).toContain("In Railway they're under Variables: JWT_SECRET and ENCRYPTION_KEY on the crewtavo service, POSTGRES_PASSWORD on db.");
    // With Docker they're in one file. It's said where backups can't be made too.
    expect(secretsNote("compose")).toContain("Save a copy of the .env.instance file somewhere off this server.");
    expect(text(card({ ...GOOD, available: false, unavailable: "No pg_dump." }))).toContain("Keep your secrets with it.");
  });

  it("names a downloaded file by when the backup was made", () => {
    expect(backupFileName({ startedAt: "2026-11-12T08:05:00.123456+00:00" })).toBe("crewtavo-backup-20261112-0805.dump");
  });
});
