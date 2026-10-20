import { describe, expect, it } from "vitest";
import { arrivalOf, channelForMedium, deviceOf, hasScriptLine, isBot, pagePath, readPageView, siteName, type WebUrl } from "../src/analytics";

// Website analytics: reading a page view from a business's website.

// Core is built without DOM or Node types; tests run where URL exists.
declare const URL: new (url: string) => WebUrl;
const page = (href: string) => new URL(href);
const SAFARI_PHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";
const CHROME_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const ANDROID_TABLET = "Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

describe("where a visit came from", () => {
  it("names search engines, social sites, directories, AI assistants and email", () => {
    const from = (referrer: string) => arrivalOf(page("https://greenlawn.com/"), referrer);
    expect(from("https://www.google.com/")).toEqual({ source: "Google", channel: "search", campaign: null, referrer: "google.com" });
    expect(from("https://www.google.co.uk/")).toMatchObject({ source: "Google", channel: "search" });
    expect(from("https://maps.google.com/")).toMatchObject({ source: "Google Maps", channel: "search" });
    expect(from("https://www.bing.com/search?q=lawn")).toMatchObject({ source: "Bing", channel: "search" });
    expect(from("https://duckduckgo.com/")).toMatchObject({ source: "DuckDuckGo", channel: "search" });
    expect(from("https://l.facebook.com/")).toMatchObject({ source: "Facebook", channel: "social", referrer: "facebook.com" });
    expect(from("https://m.facebook.com/")).toMatchObject({ source: "Facebook", channel: "social" });
    expect(from("https://t.co/abc")).toMatchObject({ source: "X (Twitter)", channel: "social" });
    expect(from("https://nextdoor.com/")).toMatchObject({ source: "Nextdoor", channel: "social" });
    expect(from("https://www.yelp.com/biz/green-lawn")).toMatchObject({ source: "Yelp", channel: "directory", referrer: "yelp.com" });
    expect(from("https://www.angi.com/")).toMatchObject({ source: "Angi", channel: "directory" });
    expect(from("https://chatgpt.com/")).toMatchObject({ source: "ChatGPT", channel: "ai" });
    expect(from("https://gemini.google.com/")).toMatchObject({ source: "Gemini", channel: "ai" });
    expect(from("https://mail.google.com/")).toMatchObject({ source: "Gmail", channel: "email" });
    expect(from("https://www.townnews.example/best-lawn-care")).toEqual({ source: "townnews.example", channel: "referral", campaign: null, referrer: "townnews.example" });
  });

  it("goes by a campaign link's own words first", () => {
    expect(arrivalOf(page("https://greenlawn.com/?utm_source=google&utm_medium=cpc&utm_campaign=spring-aeration"), "https://www.google.com/")).toEqual({
      source: "Google", channel: "ads", campaign: "spring-aeration", referrer: "google.com",
    });
    expect(arrivalOf(page("https://greenlawn.com/?utm_source=newsletter&utm_medium=email"), "")).toMatchObject({ source: "newsletter", channel: "email" });
    expect(arrivalOf(page("https://greenlawn.com/?utm_source=yard-sign&utm_medium=qr&utm_campaign=fall"), null)).toEqual({ source: "yard-sign", channel: "campaign", campaign: "fall", referrer: null });
    expect(arrivalOf(page("https://greenlawn.com/?utm_source=fb"), null)).toMatchObject({ source: "Facebook", channel: "social" });
    // ChatGPT adds utm_source=chatgpt.com to the links it gives.
    expect(arrivalOf(page("https://greenlawn.com/?utm_source=chatgpt.com"), null)).toMatchObject({ source: "ChatGPT", channel: "ai" });
    expect(arrivalOf(page("https://greenlawn.com/?utm_campaign=door-hangers"), null)).toMatchObject({ source: "Campaign", channel: "campaign", campaign: "door-hangers" });
  });

  it("knows an ad's click", () => {
    expect(arrivalOf(page("https://greenlawn.com/?gclid=abc"), "https://www.google.com/")).toMatchObject({ source: "Google Ads", channel: "ads" });
    expect(arrivalOf(page("https://greenlawn.com/?msclkid=abc"), null)).toMatchObject({ source: "Microsoft Ads", channel: "ads" });
    expect(arrivalOf(page("https://greenlawn.com/?fbclid=abc"), null)).toMatchObject({ source: "Facebook", channel: "social" });
  });

  it("is nothing for a page within the visit", () => {
    expect(arrivalOf(page("https://greenlawn.com/services"), "https://greenlawn.com/")).toBeNull();
    expect(arrivalOf(page("https://www.greenlawn.com/services"), "https://greenlawn.com/")).toBeNull();
    // The booking form on Crewtavo's address under the business's own domain.
    expect(arrivalOf(page("https://greenlawn.com/thanks"), "https://crm.greenlawn.com/book/green-lawn/quote")).toBeNull();
    expect(arrivalOf(page("https://greenlawn.com/"), "")).toBeNull();
    expect(arrivalOf(page("https://greenlawn.com/"), "android-app://com.google.android.gm/")).toBeNull();
    expect(arrivalOf(page("https://greenlawn.com/"), "not a link")).toBeNull();
  });

  it("reads utm_medium as a kind of source", () => {
    expect(channelForMedium("CPC")).toBe("ads");
    expect(channelForMedium("paid-social")).toBe("ads");
    expect(channelForMedium("e-mail")).toBe("email");
    expect(channelForMedium("Social Media")).toBe("social");
    expect(channelForMedium("organic")).toBe("search");
    expect(channelForMedium("print")).toBe("campaign");
    expect(channelForMedium("")).toBeNull();
    expect(siteName("WWW.Example.COM.")).toBe("example.com");
  });
});

describe("a page view", () => {
  it("lists a page by its path alone", () => {
    expect(pagePath(page("https://greenlawn.com/services/?ref=nav#top"))).toBe("/services");
    expect(pagePath(page("https://greenlawn.com"))).toBe("/");
    expect(pagePath(page("https://greenlawn.com//blog//tips/"))).toBe("/blog/tips");
    expect(pagePath(page("https://greenlawn.com/about/index.html"))).toBe("/about");
    expect(pagePath(page("https://greenlawn.com/index.html"))).toBe("/");
  });

  it("tells phones, tablets and computers apart", () => {
    expect(deviceOf(SAFARI_PHONE, 390)).toBe("phone");
    expect(deviceOf(ANDROID_TABLET, 800)).toBe("tablet");
    expect(deviceOf(CHROME_MAC, 1440)).toBe("computer");
    expect(deviceOf(CHROME_MAC, 500)).toBe("phone");
    expect(deviceOf(CHROME_MAC, 800)).toBe("tablet");
    expect(deviceOf(CHROME_MAC, null)).toBe("computer");
  });

  it("isn't from a robot", () => {
    expect(isBot(SAFARI_PHONE)).toBe(false);
    expect(isBot(CHROME_MAC)).toBe(false);
    for (const agent of [
      "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
      "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
      "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)",
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.0.0 Safari/537.36",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Chrome-Lighthouse",
      "WhatsApp/2.24.1 A",
      "python-requests/2.32",
      "curl/8.7.1",
      "",
    ]) expect(isBot(agent), agent).toBe(true);
  });

  it("is read from what the script sent, unless the page is on this computer", () => {
    expect(readPageView({ u: "https://www.greenlawn.com/Lawn-Care/?utm_source=flyer", r: "", w: 390 }, SAFARI_PHONE)).toEqual({
      host: "www.greenlawn.com", path: "/Lawn-Care", device: "phone", arrival: { source: "flyer", channel: "campaign", campaign: null, referrer: null },
    });
    for (const u of ["http://localhost:4321/", "http://127.0.0.1:8080/", "http://greenlawn.test/", "http://intranet/", "file:///site/index.html", "not a page"]) {
      expect(readPageView({ u }, CHROME_MAC), u).toBeNull();
    }
  });
});

describe("finding the line on a website", () => {
  const SCRIPT = "https://crm.greenlawn.com/v.js";
  it("as written, in JSON, or with HTML's escapes", () => {
    expect(hasScriptLine('<head><script defer src="https://crm.greenlawn.com/v.js"></script></head>', SCRIPT)).toBe(true);
    expect(hasScriptLine('<script defer data-site="green-lawn" src="//CRM.greenlawn.com/v.js"></script>', SCRIPT)).toBe(true);
    expect(hasScriptLine('self.__next_s.push(["https:\\/\\/crm.greenlawn.com\\/v.js",{}])', SCRIPT)).toBe(true);
    expect(hasScriptLine("&lt;script src=&quot;https:&#x2F;&#x2F;crm.greenlawn.com&#x2F;v.js&quot;&gt;", SCRIPT)).toBe(true);
    expect(hasScriptLine('<script src="https://crm.otherlawn.com/v.js"></script>', SCRIPT)).toBe(false);
    expect(hasScriptLine("<h1>Green Lawn</h1>", SCRIPT)).toBe(false);
  });
});
