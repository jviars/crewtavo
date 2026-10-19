import { describe, expect, it } from "vitest";
import { addressProblem, hostLabel, normalizeDomain, prefixedAddress, suggestAddress } from "../src/address";
import { DNS_PROVIDERS, GENERIC_DNS_PROVIDER, cloudflareTokenUrl, fillStep, providerById, providerForNameservers } from "../src/dns";

describe("DNS providers", () => {
  it.each(DNS_PROVIDERS)("$label is consistent", (p) => {
    expect(p.id).toMatch(/^[a-z0-9]+$/);
    expect(p.match.length).toBeGreaterThan(0);
    for (const m of p.match) expect(m).toBe(m.toLowerCase());
    expect(p.dnsUrl).toMatch(/^https:\/\//);
    expect(p.steps.length).toBeGreaterThanOrEqual(2);
    expect(p.steps.length).toBeLessThanOrEqual(4);
    const steps = p.steps.join(" ");
    for (const placeholder of ["{type}", "{host}", "{value}"]) expect(steps, placeholder).toContain(placeholder);
  });

  it("has one entry per id", () => {
    const ids = DNS_PROVIDERS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain(GENERIC_DNS_PROVIDER.id);
  });
});

describe("providerForNameservers", () => {
  it.each([
    [["ns01.domaincontrol.com", "ns02.domaincontrol.com"], "godaddy"],
    [["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"], "cloudflare"],
    [["ns-1234.awsdns-12.org", "ns-567.awsdns-07.net", "ns-89.awsdns-11.com", "ns-1800.awsdns-33.co.uk"], "route53"],
    [["dns1.registrar-servers.com", "dns2.registrar-servers.com"], "namecheap"],
    [["ns-cloud-a1.googledomains.com", "ns-cloud-a2.googledomains.com"], "squarespace"],
    [["dns1.p05.nsone.net", "ns01.squarespacedns.com"], "squarespace"],
    [["ns1.dns-parking.com", "ns2.dns-parking.com"], "hostinger"],
    [["ns1045.ui-dns.com", "ns1045.ui-dns.de", "ns1045.ui-dns.org", "ns1045.ui-dns.biz"], "ionos"],
    [["curitiba.ns.porkbun.com", "salvador.ns.porkbun.com"], "porkbun"],
    [["ns2.wixdns.net", "ns3.wixdns.net"], "wix"],
    [["ns1.bluehost.com", "ns2.bluehost.com"], "bluehost"],
    [["ns41.worldnic.com", "ns42.worldnic.com"], "networksolutions"],
    [["ns1.dnsimple.com", "ns2.dnsimple.com"], "dnsimple"],
    [["ns1.dnsimple-edge.com", "ns2.dnsimple-edge.net", "ns3.dnsimple-edge.io", "ns4.dnsimple-edge.org"], "dnsimple"],
    [["ns1abc.name.com", "ns2def.name.com"], "namecom"],
    [["ns1.hover.com", "ns2.hover.com"], "hover"],
    [["ns1.vercel-dns.com", "ns2.vercel-dns.com"], "vercel"],
    // NS1 is shared by many hosts, so on its own it says nothing.
    [["dns1.p01.nsone.net", "dns2.p01.nsone.net"], "other"],
    [["ns1.digitalocean.com", "ns2.digitalocean.com"], "digitalocean"],
  ])("%j → %s", (nameservers, id) => {
    expect(providerForNameservers(nameservers).id).toBe(id);
  });

  it("ignores case and a trailing dot", () => {
    expect(providerForNameservers(["NS01.DomainControl.COM.", "ns02.domaincontrol.com."]).id).toBe("godaddy");
    expect(providerForNameservers(["ADA.NS.CLOUDFLARE.COM."]).id).toBe("cloudflare");
  });

  it("matches on any of the nameservers", () => {
    expect(providerForNameservers(["ns1.unknown-host.net", "bob.ns.cloudflare.com"]).id).toBe("cloudflare");
  });

  it("falls back to the generic steps", () => {
    expect(providerForNameservers([])).toBe(GENERIC_DNS_PROVIDER);
    expect(providerForNameservers(["ns1.example-hosting.com", "ns2.example-hosting.com"])).toBe(GENERIC_DNS_PROVIDER);
    // Whole labels only: myname.com isn't Name.com, and notporkbun.com isn't Porkbun.
    expect(providerForNameservers(["ns1.myname.com", "ns1.notporkbun.com"])).toBe(GENERIC_DNS_PROVIDER);
  });
});

describe("providerById", () => {
  it("finds a provider, or the generic one", () => {
    expect(providerById("cloudflare").label).toBe("Cloudflare");
    expect(providerById("route53").label).toBe("Amazon Route 53");
    expect(providerById("other")).toBe(GENERIC_DNS_PROVIDER);
    expect(providerById("nope")).toBe(GENERIC_DNS_PROVIDER);
    expect(providerById(null)).toBe(GENERIC_DNS_PROVIDER);
    expect(providerById(undefined)).toBe(GENERIC_DNS_PROVIDER);
  });

  it("knows which providers can point the domain itself elsewhere", () => {
    expect(providerById("cloudflare").rootCname).toBe(true);
    expect(providerById("dnsimple").rootCname).toBe(true);
    expect(providerById("namecheap").rootCname).toBe(true);
    for (const id of ["route53", "hostinger", "godaddy", "squarespace", "other"]) expect(providerById(id).rootCname, id).toBe(false);
  });
});

describe("cloudflareTokenUrl", () => {
  it("pre-fills a DNS edit, Zone read token named Crewtavo", () => {
    const [page, query] = cloudflareTokenUrl().split("?");
    expect(page).toBe("https://dash.cloudflare.com/profile/api-tokens");
    const params = Object.fromEntries(query.split("&").map((pair) => pair.split("=").map(decodeURIComponent)));
    expect(JSON.parse(params.permissionGroupKeys)).toEqual([
      { key: "dns", type: "edit" },
      { key: "zone", type: "read" },
    ]);
    expect(params).toMatchObject({ accountId: "*", zoneId: "all", name: "Crewtavo" });
    // Encoded, so the JSON's quotes, brackets and commas can't break the query string.
    expect(query).not.toMatch(/["[\]{},]/);
  });
});

describe("fillStep", () => {
  it("puts the record into a step", () => {
    const record = { type: "CNAME", host: "app", value: "abc123.up.railway.app" };
    expect(fillStep("Add a {type} record with Name {host} and Value {value}.", record)).toBe(
      "Add a CNAME record with Name app and Value abc123.up.railway.app.",
    );
    expect(fillStep("{host}, {host} and {type}", record)).toBe("app, app and CNAME");
    expect(fillStep("Press Save.", record)).toBe("Press Save.");
  });

  it("says where to find a value only Railway knows", () => {
    expect(fillStep("Put {value} in Value.", { type: "TXT", host: "_railway-verify.app", value: null })).toBe(
      "Put the value Railway shows in Value.",
    );
    expect(fillStep("Put {value} in Value.", { type: "A", host: "app", value: null }, "your server's IP address")).toBe("Put your server's IP address in Value.");
  });

  it("fills every provider's steps", () => {
    for (const p of [...DNS_PROVIDERS, GENERIC_DNS_PROVIDER]) {
      for (const step of p.steps) expect(fillStep(step, { type: "TXT", host: "app", value: "x" })).not.toMatch(/[{}]/);
    }
  });
});

describe("normalizeDomain", () => {
  it("strips the scheme, path, case and a trailing dot", () => {
    expect(normalizeDomain("https://app.example.com/settings?tab=1")).toBe("app.example.com");
    expect(normalizeDomain("http://app.example.com")).toBe("app.example.com");
    expect(normalizeDomain("app.example.com/")).toBe("app.example.com");
    expect(normalizeDomain("app.example.com.")).toBe("app.example.com");
    expect(normalizeDomain("  App.Example.COM  ")).toBe("app.example.com");
  });

  it("returns international names in their xn-- form", () => {
    expect(normalizeDomain("café.com")).toBe("xn--caf-dma.com");
    expect(normalizeDomain("CAFÉ.com")).toBe("xn--caf-dma.com");
  });

  it("refuses what isn't a host name", () => {
    for (const bad of [
      "",
      "   ",
      "192.168.1.10",
      "http://10.0.0.1/",
      "[::1]",
      "app.example.com:8080",
      "localhost",
      "example",
      "not a domain",
      "foo..com",
      "-bad.example.com",
      "under_score.example.com",
      "user@example.com",
      "https://",
      "@@@",
    ]) {
      expect(normalizeDomain(bad), bad).toBeNull();
    }
  });
});

describe("addressProblem", () => {
  it("refuses Railway and local addresses", () => {
    expect(addressProblem("crewtavo-production.up.railway.app")).toMatch(/Railway address/);
    expect(addressProblem("localhost")).toMatch(/inside a network/);
    expect(addressProblem("crewtavo.localhost")).toMatch(/inside a network/);
  });

  it("allows an address the business owns", () => {
    expect(addressProblem("app.greenlawn.com")).toBeNull();
    expect(addressProblem("myrailway.app")).toBeNull();
  });
});

describe("suggestAddress", () => {
  it("uses the website, then the email domain", () => {
    expect(suggestAddress("https://www.greenlawn.com", null)).toBe("crm.greenlawn.com");
    expect(suggestAddress("https://www.greenlawn.com", "owner@gmail.com")).toBe("crm.greenlawn.com");
    expect(suggestAddress(null, "office@greenlawn.com")).toBe("crm.greenlawn.com");
    expect(suggestAddress("", "Office@GreenLawn.com")).toBe("crm.greenlawn.com");
    expect(suggestAddress("https://app.greenlawn.com", null)).toBe("crm.greenlawn.com");
  });

  it("skips free mailboxes and Railway addresses", () => {
    expect(suggestAddress(null, "greenlawn@gmail.com")).toBeNull();
    expect(suggestAddress(undefined, undefined)).toBeNull();
    expect(suggestAddress("https://greenlawn.up.railway.app", "greenlawn@gmail.com")).toBeNull();
  });
});

describe("prefixedAddress", () => {
  it("puts crm. in front of whatever domain was typed or pasted", () => {
    expect(prefixedAddress("greenlawn.com")).toBe("crm.greenlawn.com");
    expect(prefixedAddress("https://www.GreenLawn.com/about")).toBe("crm.greenlawn.com");
    expect(prefixedAddress("crm.greenlawn.com")).toBe("crm.greenlawn.com");
    expect(prefixedAddress("office@greenlawn.com")).toBe("crm.greenlawn.com");
    expect(prefixedAddress("greenlawn.co.uk")).toBe("crm.greenlawn.co.uk");
  });

  it("waits for a whole domain", () => {
    expect(prefixedAddress("")).toBeNull();
    expect(prefixedAddress("greenlawn")).toBeNull();
    expect(prefixedAddress("www.com")).toBeNull();
    expect(prefixedAddress("green lawn.com")).toBeNull();
  });
});

describe("hostLabel", () => {
  it("is what goes in the provider's Name box", () => {
    expect(hostLabel("app.example.com", "example.com")).toBe("app");
    expect(hostLabel("_railway-verify.app.example.com", "example.com")).toBe("_railway-verify.app");
    expect(hostLabel("example.com", "example.com")).toBe("@");
  });

  it("keeps the whole name when the zone is unknown or different", () => {
    expect(hostLabel("app.example.com", null)).toBe("app.example.com");
    expect(hostLabel("app.notexample.com", "example.com")).toBe("app.notexample.com");
  });
});
