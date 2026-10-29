import { describe, expect, it } from "vitest";
import {
  BUCKET_DEFAULTS,
  companyStorageFull,
  defaultStorageLimit,
  formatBytes,
  GB,
  PERSON_LIMITED_FOLDERS,
  personStorageFull,
  STORAGE_FIELD_FOLDERS,
  STORAGE_WARN_AT,
  storageFolderRule,
  storageMonthlyCost,
  storagePricePerGb,
} from "../src/storage";

describe("sizes for people", () => {
  it("counts in decimal units, like Railway and Settings → Hosting", () => {
    expect(formatBytes(45 * GB)).toBe("45 GB");
    expect(formatBytes(812_000_000)).toBe("812 MB");
    expect(formatBytes(12_400_000_000)).toBe("12.4 GB");
    expect(formatBytes(3_400)).toBe("3.4 KB");
    expect(formatBytes(1000 * GB)).toBe("1 TB");
    expect(formatBytes(900 * GB)).toBe("900 GB");
  });

  it("shows one decimal under 100 and none above", () => {
    expect(formatBytes(3_141_592_653)).toBe("3.1 GB");
    expect(formatBytes(45_050_000_000)).toBe("45.1 GB");
    expect(formatBytes(123_456_789)).toBe("123 MB");
    expect(formatBytes(99_960_000)).toBe("100 MB");
  });

  it("moves up a unit rather than say 1000 of one", () => {
    expect(formatBytes(999_960_000)).toBe("1 GB");
    expect(formatBytes(999_960)).toBe("1 MB");
  });

  it("says bytes for tiny files, and nothing for nothing", () => {
    expect(formatBytes(1)).toBe("1 byte");
    expect(formatBytes(512)).toBe("512 bytes");
    expect(formatBytes(0)).toBe("0 bytes");
    expect(formatBytes(-5)).toBe("0 bytes");
    expect(formatBytes(Number.NaN)).toBe("0 bytes");
  });
});

describe("which limits refuse an upload", () => {
  it("never refuses what crews need to finish a job, or what the server stores", () => {
    for (const folder of ["visit", "quote", "subs", "tickets", "receipts", "measurements", "avatars", "logo", "letterhead", "packages", "services"]) {
      expect(storageFolderRule(folder), folder).toEqual({ company: false, person: false });
    }
    expect([...STORAGE_FIELD_FOLDERS].sort()).toEqual(["avatars", "letterhead", "logo", "measurements", "packages", "quote", "receipts", "services", "subs", "tickets", "visit"]);
  });

  it("refuses Drive and plan files and guides by the company's limit and a person's", () => {
    expect(storageFolderRule("plans")).toEqual({ company: true, person: true });
    expect(storageFolderRule("kb")).toEqual({ company: true, person: true });
    expect([...PERSON_LIMITED_FOLDERS]).toEqual(["plans", "kb"]);
  });

  it("refuses résumés, chat, equipment and anything new by the company's limit only", () => {
    for (const folder of ["applicants", "chat", "equipment", "something-new", ""]) {
      expect(storageFolderRule(folder), folder).toEqual({ company: true, person: false });
    }
  });
});

describe("the default company limit", () => {
  it("is 90% of the storage service's volume", () => {
    expect(defaultStorageLimit({ backend: "volume", volumeBytes: 50 * GB, plan: "hobby" })).toEqual({ bytes: 45 * GB, basis: "90% of your 50 GB volume" });
    expect(defaultStorageLimit({ backend: "volume", volumeBytes: 5 * GB, plan: "pro" })).toEqual({ bytes: 4.5 * GB, basis: "90% of your 5 GB volume" });
  });

  it("follows Railway's plan for a bucket", () => {
    expect(defaultStorageLimit({ backend: "bucket", volumeBytes: 50 * GB, plan: "hobby" })).toEqual({ bytes: 900 * GB, basis: "Railway Hobby bucket" });
    expect(defaultStorageLimit({ backend: "bucket", volumeBytes: null, plan: "pro" })).toEqual({ bytes: 1000 * GB, basis: "Railway Pro bucket" });
    expect(BUCKET_DEFAULTS.trial.bytes).toBeLessThan(BUCKET_DEFAULTS.hobby.bytes);
  });

  it("is none when where files live isn't known", () => {
    const none = { bytes: null, basis: null };
    expect(defaultStorageLimit({ backend: null, volumeBytes: 50 * GB, plan: "hobby" })).toEqual(none);
    expect(defaultStorageLimit({ backend: "volume", volumeBytes: null, plan: "hobby" })).toEqual(none);
    expect(defaultStorageLimit({ backend: "volume", volumeBytes: 0, plan: "hobby" })).toEqual(none);
    expect(defaultStorageLimit({ backend: "bucket", volumeBytes: 50 * GB, plan: null })).toEqual(none);
  });
});

describe("what a limit costs", () => {
  it("prices a GB-month at Railway's rates", () => {
    expect(storagePricePerGb("bucket")).toBe(0.015);
    expect(storagePricePerGb("volume")).toBe(0.15);
    expect(storagePricePerGb(null)).toBeNull();
    expect(storageMonthlyCost(1000 * GB, 0.015)).toBeCloseTo(15);
  });
});

describe("refusals and warnings", () => {
  it("says the file doesn't fit, how full it is, and who can fix it", () => {
    expect(companyStorageFull(44.9 * GB, 45 * GB, 240_000_000)).toBe(
      "This 240 MB file doesn't fit: 44.9 GB of the 45 GB storage limit is used. An owner or admin can raise it in Settings → Storage, or empty the Trash.",
    );
    expect(companyStorageFull(812_000_000, 1 * GB, 2_400_000)).toContain("812 MB of the 1 GB storage limit is used");
    expect(personStorageFull(9.9 * GB, 10 * GB, 300_000_000)).toBe(
      "This 300 MB file doesn't fit in your storage: you've used 9.9 GB of your 10 GB. Ask an owner to raise it, or move old files to the Trash.",
    );
  });

  it("leaves the file's size out when it isn't known", () => {
    expect(companyStorageFull(45 * GB, 45 * GB)).toBe("45 GB of the 45 GB storage limit is used. An owner or admin can raise it in Settings → Storage, or empty the Trash.");
    expect(companyStorageFull(45 * GB, 45 * GB, null)).toBe(companyStorageFull(45 * GB, 45 * GB));
    expect(personStorageFull(10 * GB, 10 * GB, 0)).toBe("You've used 10 GB of your 10 GB. Ask an owner to raise it, or move old files to the Trash.");
  });

  it("says a tiny file's size in bytes", () => {
    expect(companyStorageFull(45 * GB, 45 * GB, 512)).toMatch(/^This 512-byte file doesn't fit: /);
    expect(personStorageFull(10 * GB, 10 * GB, 1)).toMatch(/^This 1-byte file doesn't fit in your storage: /);
  });

  it("warns at 80% and 95%", () => {
    expect([...STORAGE_WARN_AT]).toEqual([0.8, 0.95]);
  });
});
