/**
 * Quo's app page (features/apps/QuoPanel.tsx): the plain logic behind it (features/apps/quo.ts),
 * following an import (catalog.ts), the number's name, and what Uninstall says for Quo and for
 * Twilio (AppDetailPage.tsx).
 */
import { describe, expect, it } from "vitest";
import { quoUninstallWords, twilioUninstallWords } from "../src/features/apps/AppDetailPage";
import { appsPollMs, quoImportRunning, type AppRow, type AppsData, type QuoImport, type QuoState } from "../src/features/apps/catalog";
import {
  canTest,
  changeHeldBack,
  deliveriesError,
  hookState,
  importProgress,
  importResult,
  importSince,
  nameIsNumber,
  numberLabel,
  testArrived,
  withQuo,
} from "../src/features/apps/quo";
import { ApiError } from "../src/lib/errors";

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
    // Quo's own way of writing an unnamed number, or the server's fallback, isn't said twice.
    expect(numberLabel({ name: "+1 540-555-0100", number: "+15405550100" })).toBe("(540) 555-0100");
    expect(numberLabel({ name: "+15405550100", number: "+15405550100" })).toBe("(540) 555-0100");
    expect(numberLabel({ name: "540.555.0100", number: "+15405550100" })).toBe("(540) 555-0100");
    expect(numberLabel({ name: "07700 900123", number: "+447700900123" })).toBe("+447700900123");
    // Another number, or a name with a number in it, is a name.
    expect(numberLabel({ name: "(540) 555-0199", number: "+15405550100" })).toBe("(540) 555-0199 · (540) 555-0100");
    expect(numberLabel({ name: "Office 100", number: "+15405550100" })).toBe("Office 100 · (540) 555-0100");
    expect(nameIsNumber("100", "+15405550100")).toBe(false);
    expect(nameIsNumber("555-0100", "+15405550100")).toBe(true);
  });

  it("holds back a change of number or key while past texts and calls come in", () => {
    const running: QuoImport = { status: "running", since: null, started_at: "2026-11-26T12:00:00Z", counts: { texts: 0, calls: 0, skipped: 0 } };
    expect(changeHeldBack(state({ import: running }))).toBe("Change the number or the API key once the past texts and calls are in.");
    expect(changeHeldBack(state({ import: { ...running, status: "done" } }))).toBeNull();
    // One whose server stopped can't be waited for.
    expect(changeHeldBack(state({ import: { ...running, stopped: true } }))).toBeNull();
    expect(changeHeldBack(state())).toBeNull();
  });

  it("puts a new number or key on the Apps list at once, connected", () => {
    const quo = { id: "quo", status: "disconnected", last_error: "Quo didn't accept the key", quo: state({ number: null }) } as AppRow;
    const twilio = { id: "twilio", status: "connected" } as AppRow;
    const data: AppsData = { mcp_url: "", apps: [twilio, quo] };
    const next = state({ number: { id: "PN2", number: "+15405550111", name: "New line" } });
    const saved = withQuo(data, next, true)!;
    expect(saved.apps[0]).toBe(twilio);
    expect(saved.apps[1]).toMatchObject({ id: "quo", status: "connected", last_error: null, quo: next });
    // A switch or a fix changes Quo's state only.
    expect(withQuo(data, next)!.apps[1]).toMatchObject({ status: "disconnected", last_error: "Quo didn't accept the key", quo: next });
    expect(withQuo(undefined, next)).toBeUndefined();
  });

  it("shows the latest error under Replies and calls, and a setup's even with Quo's problem above", () => {
    const none = { error: null, submittedAt: 0 };
    const testFailed = { error: new ApiError("Set up the webhook first.", 409), submittedAt: 1000 };
    const problem = "Quo couldn't set it up (error 500: Internal error)";
    const setUpFailed = (message: string, status = 502) => ({ error: new ApiError(message, status), submittedAt: 2000 });
    // A setup after a test: its error, not the test's older one.
    expect((deliveriesError(testFailed, setUpFailed("Quo didn't accept the API key."), null) as Error).message).toBe("Quo didn't accept the API key.");
    // A test after a setup: the test's.
    expect((deliveriesError({ ...testFailed, submittedAt: 3000 }, setUpFailed("Quo didn't accept the API key."), null) as Error).message).toBe("Set up the webhook first.");
    // With Quo's problem in the callout: the same words aren't said twice, other failures are.
    expect(deliveriesError(none, setUpFailed(problem), problem)).toBeNull();
    expect((deliveriesError(none, setUpFailed("No internet connection. Check your Wi-Fi or signal and try again.", 0), problem) as Error).message).toMatch(/^No internet connection/);
    expect((deliveriesError(none, setUpFailed("Something went wrong on our end. Try again in a moment.", 500), problem) as Error).message).toMatch(/^Something went wrong/);
    expect((deliveriesError(none, setUpFailed("Paste your Quo API key.", 400), problem) as Error).message).toBe("Paste your Quo API key.");
    // An older test error doesn't stand in for a setup the callout already speaks for.
    expect(deliveriesError(testFailed, setUpFailed(problem), problem)).toBeNull();
    expect(deliveriesError(none, none, problem)).toBeNull();
  });

  it("takes a test as arrived once something came in after the click", () => {
    expect(testArrived(null, null)).toBe(false);
    expect(testArrived(null, "2026-11-26T12:00:00Z")).toBe(true);
    expect(testArrived("2026-11-26T11:00:00Z", "2026-11-26T11:00:00Z")).toBe(false);
    expect(testArrived("2026-11-26T11:00:00Z", "2026-11-26T12:00:00Z")).toBe(true);
  });

  it("says on Uninstall where texts go next", () => {
    expect(quoUninstallWords(true)).toMatch(/^Texts stop going out from your Quo number, and go out through your Twilio account again\. Your API key is removed/);
    expect(quoUninstallWords(false)).toMatch(/^Texts stop going out from your Quo number\. Your API key is removed from Crewtavo, and the webhook Crewtavo made in Quo is taken out\. Nothing already on clients' timelines is deleted/);
    // Twilio's, while Quo sends the texts: they keep going, and only Twilio's keys go.
    expect(twilioUninstallWords(true)).toMatch(/^Texts keep going out from your Quo number, and your Twilio account's keys are removed from Crewtavo\./);
    expect(twilioUninstallWords(false)).toMatch(/^Texts stop going out from your number, and your Twilio account's keys are removed from Crewtavo\./);
  });
});
