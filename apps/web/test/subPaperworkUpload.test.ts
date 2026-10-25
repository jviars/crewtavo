/**
 * A sub sending paperwork from My paperwork (features/subs/subsData.ts addSubDocument): the file goes
 * into their own folder, <company>/subs/<their sub>/, never over another one (upsert off), and the
 * row the database then checks against it; a row the database turns down takes its file back out.
 * And whose sign-ins can't connect an AI assistant (the consent page).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ uploads: [] as unknown[][], removed: [] as unknown[][], inserted: [] as unknown[], refuse: null as null | { message: string; code: string } }));
vi.mock("../src/lib/api", () => ({
  api: {},
  unwrap: (r: { data: unknown; error: unknown }) => {
    if (r.error) throw r.error;
    return r.data;
  },
  supabase: () => ({
    storage: {
      from: (bucket: string) => ({
        upload: async (...args: unknown[]) => (calls.uploads.push([bucket, ...args]), { data: { path: args[0] }, error: null }),
        remove: async (...args: unknown[]) => (calls.removed.push([bucket, ...args]), { data: [], error: null }),
      }),
    },
    from: (table: string) => ({
      insert: (row: unknown) => {
        calls.inserted.push({ table, row });
        return { select: () => ({ single: async () => (calls.refuse ? { data: null, error: calls.refuse } : { data: { id: "doc-1" }, error: null }) }) };
      },
    }),
  }),
}));
const { addSubDocument } = await import("../src/features/subs/subsData");
const { onlySubs } = await import("../src/lib/session");

const pdf = () => new File([new Uint8Array(2048)], "Certificate.PDF", { type: "application/pdf" });
const row = { kind: "liability", title: null, carrier: null, policy_number: null, starts_on: null, expires_on: "2027-06-30" };

beforeEach(() => {
  calls.uploads = [];
  calls.removed = [];
  calls.inserted = [];
  calls.refuse = null;
});

describe("sending paperwork", () => {
  it("stores the file in the sub's own folder, without replacing anything, then files it", async () => {
    expect(await addSubDocument("co-1", "sub-1", pdf(), row)).toBe("doc-1");
    expect(calls.uploads).toHaveLength(1);
    const [bucket, path, , options] = calls.uploads[0]!;
    expect(bucket).toBe("files");
    expect(path).toMatch(/^co-1\/subs\/sub-1\/[0-9a-f-]{36}\.pdf$/);
    expect(options).toEqual({ contentType: "application/pdf", upsert: false });
    expect(calls.inserted).toEqual([{
      table: "sub_documents",
      row: { company_id: "co-1", subcontractor_id: "sub-1", path, file_name: "Certificate.PDF", content_type: "application/pdf", size_bytes: 2048, ...row },
    }]);
    expect(calls.removed).toEqual([]);
  });

  it("takes the file back out when the database turns the document down, and says why", async () => {
    calls.refuse = { message: "That date has already passed. Check it, or send the newer one.", code: "22023" };
    await expect(addSubDocument("co-1", "sub-1", pdf(), row)).rejects.toThrow(/already passed/);
    expect(calls.removed).toEqual([["files", [calls.uploads[0]![1]]]]);
  });
});

describe("AI assistants", () => {
  it("aren't for someone whose every sign-in is a sub's", () => {
    expect(onlySubs([{ role: "subcontractor" }, { role: "subcontractor" }])).toBe(true);
    expect(onlySubs([{ role: "subcontractor" }, { role: "field_crew" }])).toBe(false);
    expect(onlySubs([{ role: "owner" }])).toBe(false);
    expect(onlySubs([])).toBe(false);
    expect(onlySubs(null)).toBe(false);
  });
});
