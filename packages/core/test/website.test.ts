import { describe, expect, it } from "vitest";
import { repoUrl, siteName, websiteOf } from "../src/website";

const site = { enabled: true, admin_url: "https://www.greenlawn.com/admin/", cms: "sveltia", backend: "github", repo: "greenlawn/website", branch: "main", framing: "ok", checked_at: "2026-10-20T16:00:00Z" };

describe("the website's editor", () => {
  it("is read from the company's settings only when it's whole and on https", () => {
    expect(websiteOf({ website: site, team_chat: { enabled: true } })).toEqual(site);
    expect(websiteOf({})).toBeNull();
    expect(websiteOf(null)).toBeNull();
    expect(websiteOf({ website: { ...site, enabled: false } })).toBeNull();
    expect(websiteOf({ website: { ...site, admin_url: "http://greenlawn.com/admin/" } })).toBeNull();
    expect(websiteOf({ website: { ...site, admin_url: "javascript:alert(1)" } })).toBeNull();
  });

  it("is named the way people say the site", () => {
    expect(siteName(site)).toBe("greenlawn.com");
    expect(siteName({ admin_url: "https://Green-Lawn.example:8443/cms/" })).toBe("green-lawn.example");
  });

  it("links to its repository on GitHub or GitLab", () => {
    expect(repoUrl(site)).toBe("https://github.com/greenlawn/website");
    expect(repoUrl({ backend: "gitlab", repo: "greenlawn/marketing/site" })).toBe("https://gitlab.com/greenlawn/marketing/site");
    expect(repoUrl({ backend: "gitea", repo: "greenlawn/website" })).toBeNull();
    expect(repoUrl({ backend: "github", repo: "../../evil" })).toBeNull();
    expect(repoUrl({ backend: "github", repo: null })).toBeNull();
  });
});
