/**
 * Quo's app page (features/apps/QuoPanel.tsx): the plain logic behind it (features/apps/quo.ts),
 * following an import (catalog.ts), the number's name, and what Uninstall says (AppDetailPage.tsx).
 */
import { describe, expect, it } from "vitest";
import { quoUninstallWords } from "../src/features/apps/AppDetailPage";
import { appsPollMs, quoImportRunning, type QuoImport, type QuoState } from "../src/features/apps/catalog";
import { canTest, hookState, importProgress, importResult, importSince } from "../src/features/apps/quo";
import { numberLabel } from "../src/features/apps/QuoPanel";

const state = (over: Partial<QuoState> = {}): QuoState => ({
  number: { id: "PN1", number: "+15405550100", name: "Main line" },
  webhook: { set: true, moved: false, url: "https://crew.example.com/api/webhooks/quo/c1", problem: null },
  reachable: true,
  heard_at: null,
  calls: true,
  quiet: true,
  import: null,
  twilio: false,
  ...over,
});

describe("Quo's app page", () => {
  it("says the webhook's most pressing state first", () => {
    expect(hookState(state({ reachable: false, webhook: { set: false, moved: false, url: "", problem: "No https" } }))).toBe("unreachable");
    expect(hookState(state({ webhook: { set: false, moved: true, url: "", problem: "Quo said no" } }))).toBe("problem");
    expect(hookState(state({ webhook: { set: false, moved: true, url: "", problem: null } }))).toBe("moved");
    expect(hookState(state({ webhook: { set: false, moved: false, url: "", problem: null } }))).toBe("unset");
    expect(hookState(state())).toBe("waiting");
    expect(hookState(state({ heard_at: "2026-11-26T12:00:00Z" }))).toBe("working");
  });

  it("offers a test until something came in in the last few minutes", () => {
    const now = Date.parse("2026-11-26T12:10:00Z");
    expect(canTest(state(), now)).toBe(true);
    expect(canTest(state({ heard_at: "2026-11-26T12:08:00Z" }), now)).toBe(false);
    expect(canTest(state({ heard_at: "2026-11-26T12:00:00Z" }), now)).toBe(true);
    expect(canTest(state({ webhook: { set: false, moved: false, url: "", problem: null } }), now)).toBe(false);
    expect(canTest(state({ webhook: { set: false, moved: true, url: "", problem: null } }), now)).toBe(false);
  });

  it("brings in from the same day 3 or 12 months back, or everything", () => {
    expect(importSince("3m", new Date(2026, 10, 26))).toBe("2026-08-26");
    expect(importSince("12m", new Date(2026, 10, 26))).toBe("2025-11-26");
    expect(importSince("all", new Date(2026, 10, 26))).toBeNull();
    // A shorter month ends the same day earlier; January goes back into last year.
    expect(importSince("3m", new Date(2026, 4, 31))).toBe("2026-02-28");
    expect(importSince("3m", new Date(2026, 0, 15))).toBe("2025-10-15");
  });

  it("says an import's progress and result", () => {
    const counts = (texts: number, calls: number, skipped: number) => ({ counts: { texts, calls, skipped } });
    expect(importProgress(counts(1, 0, 0))).toBe("1 text and 0 calls so far.");
    expect(importResult(counts(120, 14, 0))).toBe("120 texts and 14 calls came in.");
    expect(importResult(counts(3, 1, 1))).toBe("3 texts and 1 call came in. 1 with a number that isn't a client's was left in Quo.");
    expect(importResult(counts(3, 1, 8))).toBe("3 texts and 1 call came in. 8 with numbers that aren't clients' were left in Quo.");
  });

  it("follows an import while it runs, and not one whose server stopped", () => {
    const running: QuoImport = { status: "running", since: null, started_at: "2026-11-26T12:00:00Z", counts: { texts: 0, calls: 0, skipped: 0 } };
    expect(quoImportRunning(running)).toBe(true);
    expect(quoImportRunning({ ...running, stopped: true })).toBe(false);
    expect(quoImportRunning({ ...running, status: "done" })).toBe(false);
    expect(appsPollMs([{ quo: state({ import: running }) }])).toBe(4000);
    expect(appsPollMs([{ quo: state({ import: { ...running, stopped: true } }) }])).toBe(false);
  });

  it("names the number once when its name in Quo is the number", () => {
    expect(numberLabel({ name: "Main line", number: "+15405550100" })).toBe("Main line · (540) 555-0100");
    expect(numberLabel({ name: "(540) 555-0100", number: "+15405550100" })).toBe("(540) 555-0100");
    expect(numberLabel({ name: "", number: "+15405550100" })).toBe("(540) 555-0100");
  });

  it("says on Uninstall where texts go next", () => {
    expect(quoUninstallWords(true)).toMatch(/^Texts stop going out from your Quo number, and go out through your Twilio account again\. Your API key is removed/);
    expect(quoUninstallWords(false)).toMatch(/^Texts stop going out from your Quo number\. Your API key is removed from Crewtavo, and the webhook Crewtavo made in Quo is taken out\. Nothing already on clients' timelines is deleted/);
  });
});
