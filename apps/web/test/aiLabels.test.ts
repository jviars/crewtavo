/**
 * What AI wrote says so, where the crew and the office read it: a guide answer, a drafted quote, a
 * showcase write-up and a suggested review reply. The people reading aren't always the ones who
 * turned the feature on, and Anthropic's terms have its customers tell their users that "factual
 * assertions in Outputs should not be relied upon without independently checking their accuracy".
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parts } from "@crewtavo/core/i18n/es";
import { draftedWords } from "@/features/quotes/DraftedCallout";

const source = (path: string) => readFileSync(new URL(`../src/features/${path}`, import.meta.url), "utf8");

describe("AI answers and drafts say they're AI's, and to check them", () => {
  it("under an answer from the guides, in the crew's language", () => {
    const page = source("kb/KnowledgeBasePage.tsx");
    const line = "Written by AI from your guides. It can be wrong: check the guide before you rely on it.";
    expect(page).toContain(`{ask.data && <p className={s.disclaimer}>{t("${line}")}</p>}`);
    expect((parts.team as Record<string, unknown>)[line]).toBe("Escrita por IA a partir de tus guías. Puede estar equivocada: revisa la guía antes de confiar en ella.");
  });

  it("on a quote AI drafted, and not on one drafted from the price list", () => {
    expect(draftedWords({ by: "claude", request_number: 12 }, [])[0]).toBe(
      "Written by AI: this was drafted from request #12 and your price list. It can be wrong, so check every line, quantity and price before you send it.",
    );
    expect(draftedWords({ by: "price_list", request_number: 12 }, [])[0]).toBe("Drafted from request #12 and your price list. Look it over before you send it.");
    // And on the request it was drafted for.
    const request = source("requests/RequestPage.tsx");
    expect(request).toContain('drafted.by === "claude" ? "by AI" : "from your price list"');
    expect(request).toContain('drafted.by === "claude" ? " It can be wrong: check it before you send it." : ""');
  });

  it("under a showcase write-up, once AI wrote it", () => {
    const dialog = source("marketing/ShowcaseDialog.tsx");
    expect(dialog).toContain("setAiWrote(true);");
    expect(dialog).toContain(`{aiWrote && <span className="muted small" role="status">Written by AI from the job's services. It can be wrong: check it says what you did before you publish.</span>}`);
  });

  it("under a review reply, once AI suggested it", () => {
    const reviews = source("marketing/GoogleReviews.tsx");
    expect(reviews).toContain("setSuggested(true);");
    expect(reviews).toContain(`{suggested && <span className="muted small" role="status">Written by AI from their review. It can be wrong: read it and make it yours before you post it.</span>}`);
  });
});
