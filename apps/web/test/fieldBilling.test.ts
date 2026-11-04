/**
 * Finishing the paperwork on site (features/field/fieldMoney.ts and FieldBilling.tsx): by role, who
 * adds work, and who makes the invoice, sees its total and records cash or check; work added sends
 * the item and how many, never a price, and waits on the phone without one; cash or check goes the
 * office's own Record payment way (features/invoices/recordPayment.ts).
 */
import { memberPermissions, ROLES, STAFF, type Role } from "@crewtavo/core/roles";
import { onlineManager, QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => [] as Array<{ op: string; on: string; args: unknown }>);
vi.mock("../src/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/api")>();
  const done = Promise.resolve({ data: null, error: null });
  const from = (on: string) => {
    const q = {
      update: (args: unknown) => (calls.push({ op: "update", on, args }), q),
      insert: (args: unknown) => (calls.push({ op: "insert", on, args }), done),
      eq: () => done,
    };
    return q;
  };
  const rpc = (on: string, args: unknown) => (calls.push({ op: "rpc", on, args }), Promise.resolve({ data: "line-1", error: null }));
  return { ...real, supabase: () => ({ from, rpc }) };
});

const { addsWork, fieldInvoiceKind, takesMoney, takesWork } = await import("../src/features/field/fieldMoney");
const { addJobLine, pendingJobLines, waitingScopeLine } = await import("../src/features/field/fieldActions");
const { recordPayment } = await import("../src/features/invoices/recordPayment");

/** A member as the session has them: their level's areas, or their custom role's within it. */
const member = (role: Role, custom?: string[]) => ({ role, permissions: memberPermissions(role, custom) });
const sealing = { visitId: "v1", jobId: "j1", lineId: "line-1", serviceId: "s1", quantity: 40, name: "Crack seal", unit: "lf" };

beforeEach(() => void calls.splice(0));
afterEach(() => onlineManager.setOnline(true));

describe("who sees the money on site", () => {
  it("makes the invoice, sees its total and records cash or check: owners, admins and office", () => {
    expect(ROLES.filter((role) => takesMoney(member(role)))).toEqual(["owner", "admin", "office"]);
  });

  it("not an office or admin role with invoices switched off", () => {
    expect(takesMoney(member("office", ["schedule", "settings"]))).toBe(false);
    expect(takesMoney(member("admin", ["reports", "team"]))).toBe(false);
    expect(takesMoney(member("office", ["invoices"]))).toBe(true);
  });

  it("never crews, estimators or subs, whatever their role lists: their level can't have invoices", () => {
    for (const role of ["crew_lead", "field_crew", "estimator", "subcontractor"] as const) expect(takesMoney(member(role, ["invoices", "job_costs"])), role).toBe(false);
  });

  it("the team adds work from the price list, a sub never does", () => {
    expect(ROLES.filter((role) => addsWork(member(role)))).toEqual([...STAFF]);
  });

  it("work goes on a one-off job still open, not a repeating one (its lines bill every visit) or a closed one", () => {
    expect(takesWork({ kind: "one_off", status: "active" })).toBe(true);
    expect(takesWork({ kind: "one_off", status: "requires_invoicing" })).toBe(true);
    expect(takesWork({ kind: "recurring", status: "active" })).toBe(false);
    expect(takesWork({ kind: "one_off", status: "completed" })).toBe(false);
  });

  it("Create invoice makes what the job page offers first: the final invoice, or the visits; none for a fixed price billed monthly", () => {
    expect(fieldInvoiceKind({ kind: "one_off", pricing: null })).toBe("standard");
    expect(fieldInvoiceKind({ kind: "recurring", pricing: "per_visit" })).toBe("visits");
    expect(fieldInvoiceKind({ kind: "recurring", pricing: "fixed" })).toBeNull();
  });
});

describe("adding work from the field", () => {
  it("sends the item and how many, never a price: the office's applies", async () => {
    await addJobLine(sealing);
    expect(calls).toEqual([{ op: "rpc", on: "add_field_line", args: { p_visit: "v1", p_service: "s1", p_quantity: 40, p_id: "line-1" } }]);
  });

  it("shows on the visit while it waits with what the crew sees of any line: no price", () => {
    expect(waitingScopeLine(sealing)).toEqual({ id: "line-1", name: "Crack seal", description: null, quantity: 40, unit: "lf", sort: Number.MAX_SAFE_INTEGER });
  });

  it("waits on the phone with no signal, and the job's list of work finds it there", async () => {
    const qc = new QueryClient();
    qc.mount();
    onlineManager.setOnline(false);
    const queue = (v: object) => void qc.getMutationCache().build(qc, { mutationKey: ["job-line-add"], networkMode: "online", mutationFn: async () => undefined }).execute(v);
    queue(sealing);
    queue({ ...sealing, jobId: "j2", lineId: "line-2" });
    await new Promise((r) => setTimeout(r, 0));
    expect(pendingJobLines(qc, "j1").map((l) => l.lineId)).toEqual(["line-1"]);
    expect(calls).toEqual([]);
    qc.unmount();
  });
});

describe("cash or check", () => {
  const draft = { id: "i1", client_id: "cl1", balance: 400, draft: true };

  it("goes the office's Record payment way: a draft is marked sent, then the payment with its check number", async () => {
    await recordPayment({ companyId: "c1", currency: "USD", invoice: draft, amount: 150, method: "check", receivedAt: "2026-11-03T15:00:00.000Z", notes: "1042 · Left in the mailbox" });
    expect(calls).toEqual([
      { op: "update", on: "invoices", args: { status: "sent" } },
      { op: "insert", on: "payments", args: { company_id: "c1", invoice_id: "i1", client_id: "cl1", amount: 150, tip_amount: 0, method: "check", received_at: "2026-11-03T15:00:00.000Z", notes: "1042 · Left in the mailbox" } },
    ]);
  });

  it("turns down more than is owed, or nothing, before anything is written", async () => {
    await expect(recordPayment({ companyId: "c1", currency: "USD", invoice: draft, amount: 500, method: "cash", receivedAt: "2026-11-03T15:00:00.000Z", notes: null })).rejects.toThrow("That's more than the $400.00 balance.");
    await expect(recordPayment({ companyId: "c1", currency: "USD", invoice: draft, amount: 0, method: "cash", receivedAt: "2026-11-03T15:00:00.000Z", notes: null })).rejects.toThrow("greater than zero");
    expect(calls).toEqual([]);
  });
});
