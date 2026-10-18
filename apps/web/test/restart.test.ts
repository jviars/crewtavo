/**
 * A database request that meets the server restarting (502/503/504) isn't reported as a fault: field
 * actions retry through it (lib/offline.ts), and each try would otherwise send another report.
 */
import { describe, expect, it, vi } from "vitest";

const reportError = vi.fn();
vi.mock("../src/lib/monitoring", () => ({ reportError, startMonitoring: () => undefined }));

const { unwrap } = await import("../src/lib/api");
const { ApiError } = await import("../src/lib/errors");

describe("a database request while the server restarts", () => {
  it("fails with the restart's status and sends no report", () => {
    let error: unknown;
    try {
      unwrap({ data: null, error: { message: "This part of Crewtavo is still starting. Try again in a moment." }, status: 503 });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ApiError);
    expect((error as InstanceType<typeof ApiError>).status).toBe(503);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("still reports a real database failure", () => {
    expect(() => unwrap({ data: null, error: { message: "boom", code: "XX000" }, status: 500 })).toThrow();
    expect(reportError).toHaveBeenCalledTimes(1);
  });
});
