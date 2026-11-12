/**
 * Starting up when the database or its services aren't there yet (lib/startup.ts): server.ts tries
 * again by itself, a little later each time, until the instance is ready, so background tasks come
 * back without anyone redeploying. A migration that failed stays failed. And stopping: the server
 * waits for the requests and tasks under way, up to a limit.
 */
import { afterEach, describe, expect, it } from "vitest";
import { retryDelay, retryStartup, setStartup, startup, whenIdle, worthRetrying, type MigrationProblem, type Startup } from "../src/lib/startup";

afterEach(() => setStartup(null));

describe("which failed starts are tried again", () => {
  it("the ones that pass by themselves", () => {
    for (const problem of ["services_not_ready", "unreachable", "busy"] satisfies MigrationProblem[]) expect(worthRetrying({ state: "failed", problem })).toBe(true);
  });

  it("not the ones that need someone: a wrong password, a bad address, a migration that failed", () => {
    for (const problem of ["wrong_password", "bad_url", "migration_failed", "newer_database"] satisfies MigrationProblem[]) expect(worthRetrying({ state: "failed", problem })).toBe(false);
    expect(worthRetrying({ state: "failed" })).toBe(false);
  });

  it("nothing that isn't a failure", () => {
    expect(worthRetrying(null)).toBe(false);
    expect(worthRetrying({ state: "migrating" })).toBe(false);
    expect(worthRetrying({ state: "ready" })).toBe(false);
    expect(worthRetrying({ state: "ready", problem: "newer_database" })).toBe(false);
  });
});

it("waits longer each time, up to five minutes", () => {
  expect([0, 1, 2, 3, 4, 5, 6, 7, 50, 5000].map(retryDelay)).toEqual([5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000, 300_000]);
});

describe("trying a failed start again", () => {
  /** A start that goes the way `outcomes` say, one try at a time; the pauses it was given between them. */
  function tries(outcomes: Startup[]) {
    const pauses: number[] = [];
    let count = 0;
    const again = async () => {
      setStartup(outcomes[count++]);
    };
    return { pauses, count: () => count, run: (stopping?: () => boolean) => retryStartup(again, async (ms) => void pauses.push(ms), stopping) };
  }

  it("keeps on until the instance is ready", async () => {
    setStartup({ state: "failed", problem: "services_not_ready" });
    const start = tries([{ state: "failed", problem: "unreachable" }, { state: "failed", firstInstall: false, problem: "busy" }, { state: "ready" }]);
    await start.run();
    expect(startup()).toEqual({ state: "ready" });
    expect(start.count()).toBe(3);
    expect(start.pauses).toEqual([5_000, 10_000, 20_000]);
  });

  it("leaves a start that worked, or never ran, alone", async () => {
    for (const state of [null, { state: "ready" }] satisfies Array<Startup | null>) {
      setStartup(state);
      const start = tries([]);
      await start.run();
      expect(start.count()).toBe(0);
      expect(start.pauses).toEqual([]);
    }
  });

  it("doesn't loop on a migration that failed", async () => {
    setStartup({ state: "failed", firstInstall: false, problem: "migration_failed", detail: "20990101000000_x.sql: column missing" });
    const start = tries([]);
    await start.run();
    expect(start.count()).toBe(0);
    expect(startup()?.state).toBe("failed");
  });

  it("stops when a try ends in a failure that needs someone", async () => {
    setStartup({ state: "failed", problem: "unreachable" });
    const start = tries([{ state: "failed", problem: "unreachable" }, { state: "failed", firstInstall: false, problem: "migration_failed" }, { state: "ready" }]);
    await start.run();
    expect(start.count()).toBe(2);
    expect(startup()).toMatchObject({ state: "failed", problem: "migration_failed" });
  });

  it("stops when the server is shutting down", async () => {
    setStartup({ state: "failed", problem: "unreachable" });
    const start = tries([{ state: "failed", problem: "unreachable" }, { state: "ready" }]);
    // Shutting down from the second pause on.
    await start.run(() => start.pauses.length >= 2);
    expect(start.count()).toBe(1);
    expect(startup()?.state).toBe("failed");
  });
});

describe("waiting for work under way before stopping", () => {
  it("doesn't wait when nothing is", async () => {
    const before = Date.now();
    expect(await whenIdle(() => true, 10_000)).toBe(true);
    expect(Date.now() - before).toBeLessThan(50);
  });

  it("waits until what was under way has finished", async () => {
    let looks = 0;
    expect(await whenIdle(() => ++looks >= 4, 10_000, 1)).toBe(true);
    expect(looks).toBe(4);
  });

  it("gives up at the limit, and says so", async () => {
    const before = Date.now();
    expect(await whenIdle(() => false, 40, 5)).toBe(false);
    expect(Date.now() - before).toBeGreaterThanOrEqual(40);
    expect(Date.now() - before).toBeLessThan(1_000);
  });
});
