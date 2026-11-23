/**
 * Claude and ChatGPT under Apps are what powers Crewtavo's own AI (a key, or for ChatGPT a person's
 * own plan). Using Crewtavo from inside either chat app is the connector, which is added and
 * managed in Settings → AI assistants and nowhere else: the app pages only point there.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { companyFeatures } from "../src/lib/api";
import { APP_INFO, type AppRow } from "../src/features/apps/catalog";
import { isInstalled } from "../src/features/apps/installed";
import { parts } from "@crewtavo/core/i18n/es";

const source = (path: string) => readFileSync(fileURLToPath(new URL(`../src/${path}`, import.meta.url)), "utf8");
const app = (more: Partial<AppRow>) => ({ id: "chatgpt", auth: "api_key", status: "disconnected", ...more }) as AppRow;

describe("the Claude and ChatGPT apps", () => {
  it.each(["anthropic", "chatgpt"])("%s is about Crewtavo's own AI, and points to Settings for the connector", (id) => {
    const info = APP_INFO[id]!;
    expect(info.about).toContain("add the connector in Settings → AI assistants");
    expect(info.connectsWith).not.toMatch(/connector/i);
    // What goes to the AI service and what doesn't, as the other AI app (fal.ai) says it.
    expect(info.access[0]).toMatch(/^Send (Anthropic|OpenAI) what an ask is about/);
    expect(info.access).toContain("Nothing else: it can't look things up in Crewtavo or change anything");
    // Nothing left that says it reads clients or changes the price list: that was the connector.
    expect(JSON.stringify(info)).not.toMatch(/Search clients|once you allow it|full access/);
  });

  it("ChatGPT says both ways to pay, and whose asks a plan covers", () => {
    const info = APP_INFO.chatgpt!;
    expect(info.access).toContain("With an API key, OpenAI bills your API account directly for what's used");
    expect(info.access.some((line) => line.startsWith("With Continue with ChatGPT, your own ChatGPT plan pays for what you ask yourself"))).toBe(true);
    expect(info.about).toContain("ChatGPT Plus or Pro plan");
    expect(info.about).toContain("never anyone else's asks");
  });

  it("have no connector link on their pages: that's in Settings alone", () => {
    const page = source("features/apps/AppDetailPage.tsx");
    expect(page).not.toMatch(/ConnectorCard|mcp_url|mcpUrl|CONNECTOR_STEPS|Connector link copied/);
    expect(page).toContain("<div>Using Crewtavo from inside {app.name}</div>");
    expect(page).toContain('Add the connector in <Link to="/settings?tab=assistants" style={{ textDecoration: "underline" }}>Settings → AI assistants</Link>.');
    const settings = source("features/settings/AssistantSettings.tsx");
    expect(settings).toContain("Connector link copied");
    expect(settings).toContain("CONNECTOR_STEPS.chatgpt");
  });
});

describe("whether ChatGPT is installed", () => {
  it("is so with the company's OpenAI key, or with the person's own plan connected, and not otherwise", () => {
    expect(isInstalled(app({}))).toBe(false);
    expect(isInstalled(app({ status: "connected" }))).toBe(true);
    expect(isInstalled(app({ my_plan: true }))).toBe(true);
    // Or at a company that lets its team connect theirs: there's something of ChatGPT's turned on to uninstall.
    expect(isInstalled(app({ team_plans: true }))).toBe(true);
    expect(isInstalled(app({ id: "anthropic", status: "connected" }))).toBe(true);
    expect(isInstalled(app({ id: "anthropic" }))).toBe(false);
  });

  it("isn't decided by an assistant someone connected in Settings anymore", () => {
    // A server from before this still calls ChatGPT a connector: nothing to install there.
    expect(isInstalled(app({ auth: "connector" }))).toBe(false);
    expect(source("features/apps/installed.ts")).not.toMatch(/assistantAppFor|useAssistantConnections/);
  });
});

describe("AI across the app", () => {
  const features = { ai: false, payments: false, email: false, sms: false, roofInsights: false };

  it("is on for a company with a key, and for a person whose own ChatGPT plan is connected", () => {
    expect(companyFeatures(features, {})).toMatchObject({ ai: false, chatgptPlan: false });
    expect(companyFeatures(features, { ai_connected: true })).toMatchObject({ ai: true, chatgptPlan: false });
    expect(companyFeatures(features, { ai_connected: true, chatgpt_plan: true })).toMatchObject({ ai: true, chatgptPlan: true });
  });
});

describe("words that name the AI", () => {
  const screens = ["kb/KnowledgeBasePage.tsx", "quotes/QuotePage.tsx", "quotes/DraftedCallout.tsx", "requests/RequestPage.tsx", "marketing/CampaignPage.tsx", "marketing/ShowcaseDialog.tsx", "marketing/GoogleReviews.tsx", "marketing/SocialComposer.tsx", "settings/QuoteSettings.tsx", "settings/JobCostSettings.tsx"];

  it("say AI, not Claude, on the screens that use Crewtavo's own AI: it may be OpenAI answering", () => {
    for (const screen of screens) {
      // Words people read: text between tags and quoted sentences, not code comments or the "claude" value drafts are saved with.
      const words = source(`features/${screen}`).split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n").replace(/Claude or OpenAI key/g, "");
      expect([screen, /\bClaude\b/.test(words)]).toEqual([screen, false]);
    }
    expect(source("features/settings/QuoteSettings.tsx")).toContain("Draft quotes with AI");
    expect(source("features/settings/JobCostSettings.tsx")).toContain("Read receipts and supplier invoices with AI");
  });

  it("say Using ChatGPT plan, with Manage usage, beside the AI buttons of someone whose plan is answering", () => {
    for (const screen of ["kb/KnowledgeBasePage.tsx", "quotes/QuotePage.tsx", "marketing/CampaignPage.tsx", "marketing/ShowcaseDialog.tsx", "marketing/GoogleReviews.tsx", "marketing/SocialComposer.tsx"]) {
      expect([screen, source(`features/${screen}`).includes("<UsingChatGptPlan />")]).toEqual([screen, true]);
    }
    const note = source("features/apps/UsingChatGptPlan.tsx");
    expect(note).toContain("if (!session.config.features.chatgptPlan) return null;");
    expect(note).toContain('href="https://chatgpt.com/settings/usage"');
    // A crew sees it under an answer from the guides, so it has its Spanish.
    expect((parts.team as Record<string, unknown>)["Using ChatGPT plan"]).toBe("Usando tu plan de ChatGPT");
    expect((parts.team as Record<string, unknown>)["Manage usage"]).toBe("Administrar uso");
  });

  it("keep OpenAI's own words on the plan's card", () => {
    const card = source("features/apps/ChatGptPlan.tsx");
    for (const said of [
      ">Continue with ChatGPT</Button>",
      "Use your ChatGPT plan",
      "Complete eligible AI requests in this app with usage included in your ChatGPT plan or credits balance.",
      'title="You\'re using your ChatGPT plan"',
      "Eligible usage in this app uses your ChatGPT plan. Manage usage in your ChatGPT settings.",
      ">Got it</Button>",
      "<strong>Using ChatGPT plan</strong>",
      "Usage limit reached",
      "Review your plan or this app's limit in ChatGPT settings.",
      "ChatGPT Plus and Pro plans can be used; an OpenAI API key is the other way.",
    ]) expect([said, card.includes(said)]).toEqual([said, true]);
    // Manage usage is the main action at the limit.
    expect(card).toContain('<a className="btn btn-primary btn-sm" href={usage} target="_blank" rel="noreferrer">Manage usage');
    // The two steps say what they'll see and what to copy.
    expect(card).toContain("says the page can't be reached. That's expected");
    expect(card).toContain("Copy that whole address from the address bar and paste it here.");
  });
});
