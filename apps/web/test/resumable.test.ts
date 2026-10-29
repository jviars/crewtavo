/**
 * Sending files to Storage in pieces (src/lib/resumable.ts, with tus-js-client stood in for): 6 MB
 * pieces to the resumable endpoint, never over a file that's there, a fresh sign-in on every
 * request, Storage's "too big", "full" and "not allowed" as sentences, carrying on with an unfinished upload
 * of the same file, Stop, and one request when Storage has no resumable endpoint. Then plan files
 * (features/plans/plans.ts): where they go, and an edited file saved as a new version.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

interface FakeTus {
  file: Blob;
  options: Record<string, any>;
  url: string | null;
  started: boolean;
  terminated: boolean | null;
  resumedFrom: unknown;
  lookedForPrevious: boolean;
}

const state = vi.hoisted(() => ({
  uploads: [] as FakeTus[],
  previous: [] as unknown[],
  tokens: [] as string[],
  inserted: [] as Array<{ table: string; row: Record<string, unknown> }>,
  refuse: null as null | { message: string; code: string },
  xhrs: [] as any[],
}));

vi.mock("tus-js-client", () => ({
  Upload: class {
    url: string | null = null;
    started = false;
    terminated: boolean | null = null;
    resumedFrom: unknown = null;
    lookedForPrevious = false;
    constructor(public file: Blob, public options: Record<string, unknown>) {
      state.uploads.push(this as unknown as FakeTus);
    }
    start() {
      this.started = true;
    }
    abort(terminate?: boolean) {
      this.terminated = Boolean(terminate);
      return Promise.resolve();
    }
    findPreviousUploads() {
      this.lookedForPrevious = true;
      return Promise.resolve(state.previous);
    }
    resumeFromPreviousUpload(previous: { uploadUrl: string }) {
      this.resumedFrom = previous;
      this.url = previous.uploadUrl;
    }
  },
}));

vi.mock("../src/lib/api", () => ({
  ApiError: class extends Error {
    constructor(message: string, public status: number, public code?: string) {
      super(message);
    }
  },
  loadConfig: async () => ({ supabaseUrl: "https://crew.example.com", supabaseKey: "anon-key" }),
  supabase: () => ({
    auth: { getSession: async () => ({ data: { session: state.tokens.length ? { access_token: state.tokens.shift() } : null } }) },
    from: (table: string) => ({
      insert: (row: Record<string, unknown>) => {
        state.inserted.push({ table, row });
        return { select: () => ({ single: async () => (state.refuse ? { data: null, error: state.refuse } : { data: { ...row, id: "v2", created_at: "2026-10-28T12:00:00Z" }, error: null }) }) };
      },
    }),
  }),
}));

/** A tus request or answer, as tus-js-client hands them to its callbacks. */
const request = (method: string) => ({ getMethod: () => method, getURL: () => "https://crew.example.com/storage/v1/upload/resumable", getHeader: () => undefined, setHeader: vi.fn() });
const failed = (method: string, status: number | null, body = "", causingError: Error | null = null) =>
  Object.assign(new Error("tus: unexpected response"), {
    originalRequest: request(method),
    originalResponse: status === null ? null : { getStatus: () => status, getBody: () => body, getHeader: () => undefined },
    causingError,
  });

class FakeXhr {
  method = "";
  url = "";
  headers: Record<string, string> = {};
  body: unknown = null;
  status = 0;
  responseText = "";
  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  constructor() {
    state.xhrs.push(this);
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  send(body: unknown) {
    this.body = body;
  }
  abort() {
    this.onabort?.();
  }
}
vi.stubGlobal("XMLHttpRequest", FakeXhr);

// The module keeps what it learned about Storage for the visit: a fresh one for each test.
let lib: typeof import("../src/lib/resumable");
let plans: typeof import("../src/features/plans/plans");
beforeEach(async () => {
  state.uploads = [];
  state.previous = [];
  state.tokens = ["token-1", "token-2", "token-3"];
  state.inserted = [];
  state.refuse = null;
  state.xhrs = [];
  vi.resetModules();
  lib = await import("../src/lib/resumable");
  plans = await import("../src/features/plans/plans");
});

const pdf = (name = "Site plan.pdf", bytes = 12 * 1024 * 1024) => new File([new Uint8Array(bytes)], name, { type: "application/pdf", lastModified: Date.parse("2026-10-20T09:00:00Z") });
/** The nth upload handed to tus (the first by default), once it has started. */
const started = async (n = 1) => {
  await vi.waitFor(() => expect(state.uploads[n - 1]?.started).toBe(true));
  return state.uploads[n - 1]!;
};

describe("sending a file in pieces", () => {
  it("sends 6 MB pieces to Storage's resumable endpoint, into the files bucket, never over a file that's there", async () => {
    const progress: number[] = [];
    const upload = lib.resumableUpload({ path: "co-1/plans/f1.pdf", file: pdf(), contentType: "application/pdf", onProgress: (f) => progress.push(f) });
    const tus = await started();
    expect(tus.options).toMatchObject({
      endpoint: "https://crew.example.com/storage/v1/upload/resumable",
      chunkSize: 6 * 1024 * 1024,
      uploadDataDuringCreation: false,
      removeFingerprintOnSuccess: true,
      retryDelays: [0, 3000, 5000, 10000, 20000],
      headers: { apikey: "anon-key", "x-upsert": "false" },
      metadata: { bucketName: "files", objectName: "co-1/plans/f1.pdf", contentType: "application/pdf", cacheControl: "3600" },
    });
    tus.options.onProgress(3, 12);
    tus.options.onSuccess({});
    await expect(upload.promise).resolves.toBe("co-1/plans/f1.pdf");
    expect(progress).toEqual([0.25, 1]);
  });

  it("signs every request with the access token of the moment, since a slow upload outlasts one", async () => {
    lib.resumableUpload({ path: "co-1/plans/f1.pdf", file: pdf(), contentType: "application/pdf", onProgress: () => undefined });
    const tus = await started();
    const first = request("POST");
    const second = request("PATCH");
    await tus.options.onBeforeRequest(first);
    await tus.options.onBeforeRequest(second);
    expect(first.setHeader).toHaveBeenCalledWith("authorization", "Bearer token-1");
    expect(second.setHeader).toHaveBeenCalledWith("authorization", "Bearer token-2");
  });

  it("says so when the person is signed out, without trying again", async () => {
    state.tokens = [];
    const upload = lib.resumableUpload({ path: "co-1/plans/f1.pdf", file: pdf(), contentType: "application/pdf", onProgress: () => undefined });
    const tus = await started();
    const signedOut = await tus.options.onBeforeRequest(request("POST")).catch((e: Error) => e);
    const error = failed("POST", null, "", signedOut);
    expect(tus.options.onShouldRetry(error, 0, tus.options)).toBe(false);
    tus.options.onError(error);
    await expect(upload.promise).rejects.toThrow("You're signed out. Sign in again, then add the file.");
  });

  it("turns Storage's 413 into a too-big file, with its name and size, that the limit can be raised for", async () => {
    const upload = lib.resumableUpload({ path: "co-1/plans/f1.pdf", file: pdf("Set A.pdf", 120 * 1024 * 1024), contentType: "application/pdf", onProgress: () => undefined });
    const tus = await started();
    tus.options.onError(failed("POST", 413, '{"statusCode":"413","error":"Payload too large","message":"The object exceeded the maximum allowed size"}'));
    const error = await upload.promise.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(lib.TooLargeError);
    expect((error as InstanceType<typeof lib.TooLargeError>).fromServer).toBe(true);
    expect((error as Error).message).toBe("Set A.pdf (120 MB) is bigger than this Crewtavo accepts.");
  });

  it("says plainly when Storage won't take it from this person, or the connection gave out", async () => {
    const refused = lib.resumableUpload({ path: "co-1/plans/f1.pdf", file: pdf(), contentType: "application/pdf", onProgress: () => undefined });
    (await started()).options.onError(failed("POST", 403, '{"message":"new row violates row-level security policy"}'));
    await expect(refused.promise).rejects.toThrow("You don't have permission to add files here.");

    const dropped = lib.resumableUpload({ path: "co-1/plans/f2.pdf", file: pdf(), contentType: "application/pdf", onProgress: () => undefined });
    (await started(2)).options.onError(failed("PATCH", null));
    await expect(dropped.promise).rejects.toThrow("The upload stopped. Check the connection and try again.");

    const broken = lib.resumableUpload({ path: "co-1/plans/f3.pdf", file: pdf(), contentType: "application/pdf", onProgress: () => undefined });
    (await started(3)).options.onError(failed("PATCH", 502, "<html><body>Bad gateway</body></html>"));
    await expect(broken.promise).rejects.toThrow("Upload failed. Try again.");
  });

  it("tries a piece again when the connection dropped or the server stumbled, not when Storage said no", async () => {
    lib.resumableUpload({ path: "co-1/plans/f1.pdf", file: pdf(), contentType: "application/pdf", onProgress: () => undefined });
    const { options } = await started();
    const retries = (method: string, status: number | null) => options.onShouldRetry(failed(method, status), 0, options);
    expect(retries("PATCH", null)).toBe(true);
    expect(retries("PATCH", 503)).toBe(true);
    expect(retries("PATCH", 409)).toBe(true);
    expect(retries("PATCH", 423)).toBe(true);
    expect(retries("POST", 409)).toBe(false);
    expect(retries("POST", 413)).toBe(false);
    expect(retries("PATCH", 403)).toBe(false);
    // Full isn't the server stumbling: trying again changes nothing.
    expect(retries("POST", 507)).toBe(false);
    expect(retries("PATCH", 507)).toBe(false);
  });

  it("turns Storage's 507 into storage full, in the server's own words, without trying again", async () => {
    const sentence = "Crewtavo's storage is full: 45 GB of the 50 GB limit. An owner or admin can raise it in Settings → Storage, or empty the Trash.";
    const upload = lib.resumableUpload({ path: "co-1/plans/f1.pdf", file: pdf(), contentType: "application/pdf", onProgress: () => undefined });
    const tus = await started();
    tus.options.onError(failed("POST", 507, JSON.stringify({ statusCode: "507", error: "Storage full", message: sentence })));
    const error = await upload.promise.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(lib.StorageFullError);
    expect((error as Error).message).toBe(sentence);
    expect((error as InstanceType<typeof lib.StorageFullError>).status).toBe(507);
    // Not a resumable endpoint that isn't there: no one-request try after it.
    expect(state.xhrs).toHaveLength(0);

    // A person's own limit, and a 507 whose body didn't come through.
    const mine = lib.storageError(507, '{"statusCode":"507","error":"Storage full","message":"You\'ve used your 10 GB of storage. Ask an owner to raise it, or move old files to the Trash."}', "Set A.pdf", 1);
    expect(mine).toBeInstanceOf(lib.StorageFullError);
    expect(mine.message).toBe("You've used your 10 GB of storage. Ask an owner to raise it, or move old files to the Trash.");
    expect(lib.storageError(507, "<html>Insufficient Storage</html>", "Set A.pdf", 1).message).toBe("Crewtavo's storage is full. An owner or admin can raise the limit in Settings → Storage, or empty the Trash.");
  });

  it("carries on with an unfinished upload of the same file to the same folder, and says where that one goes", async () => {
    const now = new Date().toISOString();
    const earlier = (objectName: string, uploadUrl: string, creationTime = now, bucketName = "files") => ({ size: 1, metadata: { bucketName, objectName }, creationTime, urlStorageKey: uploadUrl, uploadUrl, parallelUploadUrls: null });
    state.previous = [
      earlier("co-2/plans/elsewhere.pdf", "https://crew.example.com/storage/v1/upload/resumable/other-company"),
      earlier("co-1/subs/s1/paper.pdf", "https://crew.example.com/storage/v1/upload/resumable/other-folder"),
      earlier("co-1/plans/stale.pdf", "https://crew.example.com/storage/v1/upload/resumable/stale", "2026-01-01T00:00:00Z"),
      earlier("co-1/plans/picture.png", "https://crew.example.com/storage/v1/upload/resumable/other-type"),
      earlier("co-1/plans/half.pdf", "https://crew.example.com/storage/v1/upload/resumable/half"),
    ];
    const upload = lib.resumableUpload({ path: "co-1/plans/new.pdf", file: pdf(), contentType: "application/pdf", onProgress: () => undefined });
    const tus = await started();
    expect(tus.resumedFrom).toMatchObject({ uploadUrl: "https://crew.example.com/storage/v1/upload/resumable/half" });
    tus.options.onSuccess({});
    await expect(upload.promise).resolves.toBe("co-1/plans/half.pdf");
  });

  it("never sends the same file twice at once to one upload: the second starts afresh and keeps nothing to carry on with", async () => {
    const half = "https://crew.example.com/storage/v1/upload/resumable/half";
    state.previous = [{ size: 1, metadata: { bucketName: "files", objectName: "co-1/plans/half.pdf" }, creationTime: new Date().toISOString(), urlStorageKey: "k", uploadUrl: half, parallelUploadUrls: null }];
    // Dropped on job A, then on job B while it's still going.
    const first = lib.resumableUpload({ path: "co-1/plans/a.pdf", file: pdf(), contentType: "application/pdf", onProgress: () => undefined });
    const a = await started();
    expect(a.resumedFrom).toMatchObject({ uploadUrl: half });
    expect(a.options.storeFingerprintForResuming).toBe(true);
    const second = lib.resumableUpload({ path: "co-1/plans/b.pdf", file: pdf(), contentType: "application/pdf", onProgress: () => undefined });
    const b = await started(2);
    expect(b.lookedForPrevious).toBe(false);
    expect(b.resumedFrom).toBeNull();
    expect(b.options.storeFingerprintForResuming).toBe(false);
    b.url = "https://crew.example.com/storage/v1/upload/resumable/b";
    b.options.onSuccess({});
    a.options.onSuccess({});
    // Each lands where its own row will say it is.
    await expect(second.promise).resolves.toBe("co-1/plans/b.pdf");
    await expect(first.promise).resolves.toBe("co-1/plans/half.pdf");

    // Once neither is going, the same file added again may carry on with an unfinished one again.
    lib.resumableUpload({ path: "co-1/plans/c.pdf", file: pdf(), contentType: "application/pdf", onProgress: () => undefined });
    const c = await started(3);
    expect(c.lookedForPrevious).toBe(true);
    expect(c.options.storeFingerprintForResuming).toBe(true);
  });

  it("starts afresh, keeping nothing, while another tab is sending the same file", async () => {
    const asked: Array<{ name: string; options: unknown }> = [];
    vi.stubGlobal("navigator", {
      onLine: true,
      locks: { request: (name: string, options: unknown, callback: (lock: unknown) => unknown) => (asked.push({ name, options }), Promise.resolve(callback(null))) },
    });
    try {
      state.previous = [{ size: 1, metadata: { bucketName: "files", objectName: "co-1/plans/half.pdf" }, creationTime: new Date().toISOString(), urlStorageKey: "k", uploadUrl: "https://crew.example.com/storage/v1/upload/resumable/half", parallelUploadUrls: null }];
      lib.resumableUpload({ path: "co-1/plans/a.pdf", file: pdf(), contentType: "application/pdf", onProgress: () => undefined });
      const tus = await started();
      expect(asked[0]).toMatchObject({ options: { ifAvailable: true } });
      expect(asked[0]!.name).toContain("Site plan.pdf");
      expect(tus.lookedForPrevious).toBe(false);
      expect(tus.options.storeFingerprintForResuming).toBe(false);
    } finally {
      vi.unstubAllGlobals();
      vi.stubGlobal("XMLHttpRequest", FakeXhr);
    }
  });

  it("starts afresh when the unfinished one had gone (Storage made a new one), and never resumes a file made here", async () => {
    state.previous = [{ size: 1, metadata: { bucketName: "files", objectName: "co-1/plans/half.pdf" }, creationTime: new Date().toISOString(), urlStorageKey: "k", uploadUrl: "https://crew.example.com/storage/v1/upload/resumable/half", parallelUploadUrls: null }];
    const upload = lib.resumableUpload({ path: "co-1/plans/new.pdf", file: pdf(), contentType: "application/pdf", onProgress: () => undefined });
    const tus = await started();
    tus.url = "https://crew.example.com/storage/v1/upload/resumable/created-again";
    tus.options.onSuccess({});
    await expect(upload.promise).resolves.toBe("co-1/plans/new.pdf");

    const edited = new Blob([new Uint8Array(1024)], { type: "application/pdf" });
    lib.resumableUpload({ path: "co-1/plans/edit.pdf", file: edited, contentType: "application/pdf", onProgress: () => undefined });
    const fresh = await started(2);
    expect(fresh.lookedForPrevious).toBe(false);
    expect(fresh.resumedFrom).toBeNull();
    expect(fresh.options.storeFingerprintForResuming).toBe(false);
  });

  it("stops on Stop without ever deleting anything on the server", async () => {
    const upload = lib.resumableUpload({ path: "co-1/plans/f1.pdf", file: pdf(), contentType: "application/pdf", onProgress: () => undefined });
    const tus = await started();
    upload.abort();
    const error = await upload.promise.catch((e: unknown) => e);
    expect(lib.isAbort(error)).toBe(true);
    expect(tus.terminated).toBe(false);
  });

  it("sends the whole file in one request when Storage names an address that doesn't lead back to it", async () => {
    const upload = lib.resumableUpload({ path: "co-1/plans/f1.pdf", file: pdf(), contentType: "application/pdf", onProgress: () => undefined });
    const tus = await started();
    tus.url = "https://crew.example.com/storage/v1/upload/resumable/abc";
    tus.options.onUploadUrlAvailable();
    expect(tus.terminated).toBeNull();
    // Without the /storage/v1 prefix (or on http), the pieces would land on the app's own pages.
    tus.url = "http://crew.example.com/upload/resumable/abc";
    tus.options.onUploadUrlAvailable();
    expect(tus.terminated).toBe(false);
    await vi.waitFor(() => expect(state.xhrs[0]?.body).toBeTruthy());
    // Under a new name beside it: Storage had already begun one at the first.
    const [, stored] = (state.xhrs[0].url as string).match(/\/object\/files\/(co-1\/plans\/[0-9a-f-]{36}\.pdf)$/)!;
    expect(stored).not.toBe("co-1/plans/f1.pdf");
    state.xhrs[0].status = 200;
    state.xhrs[0].onload();
    await expect(upload.promise).resolves.toBe(stored);
  });

  it("sends the whole file in one request when Storage has no resumable endpoint, and keeps doing so", async () => {
    const progress: number[] = [];
    const upload = lib.resumableUpload({ path: "co-1/plans/f1.pdf", file: pdf(), contentType: "application/pdf", onProgress: (f) => progress.push(f) });
    (await started()).options.onError(failed("POST", 404, '{"message":"Route POST:/upload/resumable not found"}'));
    await vi.waitFor(() => expect(state.xhrs).toHaveLength(1));
    const xhr = state.xhrs[0];
    await vi.waitFor(() => expect(xhr.body).not.toBeNull());
    expect(xhr.method).toBe("POST");
    expect(xhr.url).toBe("https://crew.example.com/storage/v1/object/files/co-1/plans/f1.pdf");
    expect(xhr.headers).toEqual({ Authorization: "Bearer token-1", apikey: "anon-key", "x-upsert": "false" });
    expect((xhr.body as FormData).get("cacheControl")).toBe("3600");
    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 5, total: 10 });
    xhr.status = 200;
    xhr.onload();
    await expect(upload.promise).resolves.toBe("co-1/plans/f1.pdf");
    expect(progress).toEqual([0.5, 1]);

    // The next file goes straight to one request.
    const next = lib.resumableUpload({ path: "co-1/plans/f2.pdf", file: pdf(), contentType: "application/pdf", onProgress: () => undefined });
    await vi.waitFor(() => expect(state.xhrs).toHaveLength(2));
    expect(state.uploads).toHaveLength(1);
    await vi.waitFor(() => expect(state.xhrs[1].body).not.toBeNull());
    state.xhrs[1].status = 413;
    state.xhrs[1].responseText = '{"message":"The object exceeded the maximum allowed size"}';
    state.xhrs[1].onload();
    await expect(next.promise).rejects.toBeInstanceOf(lib.TooLargeError);
  });

  it("says storage is full when the one request is turned away for space", async () => {
    const upload = lib.resumableUpload({ path: "co-1/plans/f1.pdf", file: pdf(), contentType: "application/pdf", onProgress: () => undefined });
    (await started()).options.onError(failed("POST", 404, "Not found"));
    await vi.waitFor(() => expect(state.xhrs[0]?.body).toBeTruthy());
    state.xhrs[0].status = 507;
    state.xhrs[0].responseText = '{"statusCode":"507","error":"Storage full","message":"Crewtavo\'s storage is full: 50 GB of the 50 GB limit. An owner or admin can raise it in Settings → Storage, or empty the Trash."}';
    state.xhrs[0].onload();
    const error = await upload.promise.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(lib.StorageFullError);
    expect((error as Error).message).toContain("50 GB of the 50 GB limit");
  });
});

describe("plan files", () => {
  const previous = {
    id: "v1", company_id: "co-1", property_id: "p1", request_id: null, quote_id: null, job_id: "j1", folder_id: "folder-1", title: "Site plan", revision: "Rev B", notes: "Sheets C-101",
    path: "co-1/plans/v1.pdf", file_name: "Site plan.pdf", content_type: "application/pdf", size_bytes: 1000, crew_visible: false, archived: false, replaces_id: null, superseded_at: null,
    created_by: "u1", created_at: "2026-10-01T12:00:00Z", deleted_at: null,
  };

  it("go to <company>/plans/ in pieces, with their own type and a lowercase extension", async () => {
    plans.uploadPlanFile("co-1", pdf("C-101 Site Plan.PDF"), () => undefined);
    const tus = await started();
    expect(tus.options.metadata.objectName).toMatch(/^co-1\/plans\/[0-9a-f-]{36}\.pdf$/);
    expect(tus.options.metadata.contentType).toBe("application/pdf");
  });

  it("over 200 MB or empty, aren't sent at all", async () => {
    const huge = plans.uploadPlanFile("co-1", pdf("Huge.pdf", 201 * 1024 * 1024), () => undefined);
    const error = await huge.promise.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(plans.TooLargeError);
    expect((error as InstanceType<typeof plans.TooLargeError>).fromServer).toBe(false);
    await expect(plans.uploadPlanFile("co-1", pdf("Empty.pdf", 0), () => undefined).promise).rejects.toThrow("Empty.pdf is empty.");
    expect(state.uploads).toHaveLength(0);
  });

  it("saves an edit as a new version: a new stored file, and a row that replaces the old one where it was", async () => {
    const saving = plans.addVersion("co-1", previous, new Blob([new Uint8Array(2048)], { type: "application/pdf" }), "Site plan.pdf");
    const tus = await started();
    expect(tus.options.metadata.objectName).toMatch(/^co-1\/plans\/[0-9a-f-]{36}\.pdf$/);
    tus.options.onSuccess({});
    const next = await saving;
    expect(state.inserted).toEqual([{
      table: "plan_files",
      row: {
        company_id: "co-1", property_id: "p1", request_id: null, quote_id: null, job_id: "j1", folder_id: "folder-1", replaces_id: "v1", title: "Site plan", revision: null,
        path: tus.options.metadata.objectName, file_name: "Site plan.pdf", content_type: "application/pdf", size_bytes: 2048, crew_visible: false,
      },
    }]);
    expect(next).toMatchObject({ id: "v2", replaces_id: "v1" });
  });

  it("knows a Word document made here without a type, and says what the database said when it turns the version down", async () => {
    state.refuse = { message: "A newer version of Site plan was already added. Refresh and try again.", code: "23505" };
    const saving = plans.addVersion("co-1", { ...previous, file_name: "Letter.docx", content_type: null }, new Blob([new Uint8Array(10)]), "Letter.docx");
    const tus = await started();
    expect(tus.options.metadata.contentType).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(tus.options.metadata.objectName).toMatch(/\.docx$/);
    tus.options.onSuccess({});
    await expect(saving).rejects.toThrow("A newer version of Site plan was already added. Refresh and try again.");
  });
});
