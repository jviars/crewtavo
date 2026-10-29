/**
 * Settings → Hosting → Files storage (features/settings/HostingSettings.tsx): where photos and files
 * are kept, the way to move them to a Railway bucket and back, and a move as it goes, from what
 * GET /api/railway/storage answers (apps/api/src/services/storageBucket.ts).
 */
import type { StorageMove, StorageOverview } from "@crewtavo/core/hosting";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FILES_STORAGE_KEY, FilesStorage } from "../src/features/settings/HostingSettings";

const ON_VOLUME: StorageOverview = {
  backend: "volume",
  bucket: null,
  volume: { usedGb: 1.2, sizeGb: 5 },
  move: null,
  unavailable: null,
  projectUrl: "https://railway.com/project/proj-1?environmentId=env-1",
};

const MOVE: StorageMove = {
  direction: "to_bucket",
  step: "copying",
  startedAt: "2026-10-28T12:00:00Z",
  updatedAt: "2026-10-28T12:01:00Z",
  finishedAt: null,
  files: 3,
  copied: 1,
  bytes: 3_000_000_000,
  copiedBytes: 1_000_000_000,
  missing: 0,
  problems: [],
  stranded: 0,
  switchedAt: null,
  byHand: null,
  error: null,
};

function page(storage: StorageOverview) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(FILES_STORAGE_KEY, storage);
  return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(FilesStorage, { plan: "hobby" })));
}

describe("files storage", () => {
  it("says files are on the volume, and offers the bucket", () => {
    const html = page(ON_VOLUME);
    expect(html).toContain("Photos and files are on the storage service&#x27;s volume: 1.2 GB of 5 GB.");
    expect(html).toContain("Move files to a bucket");
    expect(html).toContain("doesn&#x27;t back buckets up");
    expect(html).not.toContain("Move back to the volume");
  });

  it("follows a move as it copies, without offering another", () => {
    const html = page({ ...ON_VOLUME, move: MOVE });
    expect(html).toContain("Copying files to the bucket…");
    expect(html).toContain("1 of 3 files (1 GB of 3 GB)");
    expect(html).toContain("You can leave this page");
    expect(html).not.toContain("Move files to a bucket");
  });

  it("lists a step to do in Railway, with the variables to paste, and Carry on when Crewtavo can't see it done", () => {
    const watching = page({
      ...ON_VOLUME,
      move: { ...MOVE, step: "switching", byHand: { title: "Switch storage to the bucket in Railway", steps: ["Open the storage service in Railway."], lines: ["STORAGE_BACKEND=s3", "STORAGE_S3_BUCKET=${{files.BUCKET}}"], link: "https://railway.com/x", watching: true } },
    });
    expect(watching).toContain("Switch storage to the bucket in Railway");
    expect(watching).toContain("STORAGE_BACKEND=s3\nSTORAGE_S3_BUCKET=${{files.BUCKET}}");
    expect(watching).toContain("Copy the variables");
    expect(watching).toContain("carries on by itself");
    expect(watching).not.toContain("Carry on</button>");

    const parked = page({ ...ON_VOLUME, move: { ...MOVE, step: "by_hand", byHand: { title: "Add a bucket in Railway", steps: ["Press Create, choose Bucket."], link: "https://railway.com/x", watching: false } } });
    expect(parked).toContain("Add a bucket in Railway");
    expect(parked).toContain("Carry on");
  });

  it("says when a move stopped, and why", () => {
    const html = page({ ...ON_VOLUME, move: { ...MOVE, step: "failed", error: "1 file didn't copy to the bucket, so Crewtavo didn't switch over.", problems: ["plans/0b1c.pdf: the bucket answered 500"] } });
    expect(html).toContain("Files didn&#x27;t move to the bucket");
    expect(html).toContain("plans/0b1c.pdf: the bucket answered 500");
    expect(html).toContain("Try again");
  });

  it("in the bucket: what it holds, files that didn't make it, and the way back", () => {
    const html = page({
      ...ON_VOLUME,
      backend: "bucket",
      bucket: { id: "bkt-1", name: "files", usedGb: 1.3, objects: 1204 },
      move: { ...MOVE, step: "done", copied: 3, finishedAt: "2026-10-28T12:30:00Z", switchedAt: "2026-10-28T12:29:00Z", stranded: 2 },
    });
    expect(html).toContain("Photos and files are in a Railway bucket (files): 1.3 GB in 1,204 files.");
    expect(html).toContain("Files moved to the bucket on");
    expect(html).toContain("2 files didn&#x27;t make it to the bucket");
    expect(html).toContain("Move back to the volume");
  });

  it("offers to finish moving back when not every file came back", () => {
    const html = page({ ...ON_VOLUME, move: { ...MOVE, direction: "to_volume", step: "failed", switchedAt: "2026-10-28T12:29:00Z", error: "2 files didn't copy back yet." } });
    expect(html).toContain("Finish moving back");
    expect(html).not.toContain("Move files to a bucket");
  });
});
