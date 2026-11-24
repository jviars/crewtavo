/**
 * The public booking form with a keyboard and a screen reader (features/booking/BookingFormPage.tsx):
 * its file and photo question can be reached and used (WCAG 2.1.1), and a missing time, choice or
 * file is said out loud and takes the focus (3.3.1, 4.1.3).
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/publicApi", () => ({ publicFetch: async () => ({}), useTurnstile: () => ({ token: null, widget: null, reset: () => undefined }) }));
const { FileQuestion, FIRST_PROBLEM, QuestionField } = await import("../src/features/booking/BookingFormPage");

const photos = { key: "pics", label: "Photos of the area", type: "photos" as const, required: true };
const files = { key: "plans", label: "Plans", type: "files" as const, required: false };
const fileQuestion = (q: typeof photos | typeof files, over: { invalid?: boolean; disabled?: boolean; room?: number } = {}) =>
  renderToStaticMarkup(createElement(FileQuestion, { q, files: [], room: over.room ?? 10, invalid: over.invalid ?? false, disabled: over.disabled ?? false, onChange: () => undefined }));
const input = (html: string) => /<input[^>]*type="file"[^>]*>/.exec(html)![0];

describe("the file and photo question", () => {
  it("has a real file picker in the page, not one hidden from the keyboard", () => {
    const picker = input(fileQuestion(photos));
    // `hidden` took it out of the tab order and away from screen readers: it's only out of sight now.
    expect(picker).not.toMatch(/\shidden(=|\s|>|\/)/);
    expect(picker).toContain('class="sr-only"');
    expect(picker).toContain('multiple=""');
    expect(picker).toContain('accept="image/*"');
    // .sr-only keeps it focusable, and its label (the button) shows the focus.
    const css = readFileSync(new URL("../src/styles/base.css", import.meta.url), "utf8") + readFileSync(new URL("../src/styles/components.css", import.meta.url), "utf8");
    expect(/\.sr-only \{[^}]*\}/.exec(css)![0]).not.toMatch(/display:\s*none|visibility:\s*hidden/);
    expect(css).toMatch(/label\.btn:focus-within \{/);
  });

  it("says what it's for: the words on the button, then the question, and whether it's needed", () => {
    expect(input(fileQuestion(photos))).toContain('aria-label="Add photos: Photos of the area"');
    expect(input(fileQuestion(photos))).toContain('aria-required="true"');
    expect(input(fileQuestion(files))).toContain('aria-label="Add files: Plans (optional)"');
    expect(input(fileQuestion(files))).not.toContain("aria-required");
    // The button's own words are the start of the name, so speaking them finds it (WCAG 2.5.3).
    expect(fileQuestion(photos)).toContain("Add photos<input");
  });

  it("announces a missing file, ties the message to the picker, and marks the question for the focus", () => {
    const html = fileQuestion(photos, { invalid: true });
    const alert = /<span id="([^"]+)" class="field-error" role="alert">Add a file to send with your request\.<\/span>/.exec(html);
    expect(alert).not.toBeNull();
    expect(input(html)).toContain('aria-invalid="true"');
    expect(input(html)).toContain(`aria-describedby="${alert![1]}"`);
    expect(html).toMatch(/^<div class="field" data-invalid="true"/);
    // Nothing is said, or marked, while there's nothing wrong.
    const fine = fileQuestion(photos);
    expect(fine).not.toContain('role="alert"');
    expect(fine).not.toContain("data-invalid");
    expect(input(fine)).not.toContain("aria-invalid");
  });

  it("can't be opened while the request is sending or there's no room for more", () => {
    expect(input(fileQuestion(photos, { disabled: true }))).toContain('disabled=""');
    expect(input(fileQuestion(photos, { room: 0 }))).toContain('disabled=""');
  });
});

describe("a choice that's missing", () => {
  const choice = { key: "size", label: "How big is the yard?", type: "choice" as const, required: true, options: ["Small", "Large"] };
  const render = (invalid: boolean) => renderToStaticMarkup(createElement(QuestionField, { q: choice, value: undefined, invalid, onChange: () => undefined }));

  it("is announced, and its group is marked so the first choice takes the focus", () => {
    const html = render(true);
    expect(html).toContain('<span class="field-error" role="alert">Answer this one to send your request.</span>');
    expect(html).toMatch(/^<fieldset class="field" data-invalid="true"/);
    expect(render(false)).not.toContain("data-invalid");
    expect(render(false)).not.toContain('role="alert"');
  });
});

describe("sending the form with something missing", () => {
  const page = readFileSync(new URL("../src/features/booking/BookingFormPage.tsx", import.meta.url), "utf8");

  it("moves the keyboard to the first thing to fix once the form has said what's wrong", () => {
    // After the render that marks them: asking the page straight away found nothing the first time.
    expect(page).toContain("if (refused) formRef.current?.querySelector<HTMLElement>(FIRST_PROBLEM)?.focus();");
    expect(page).toContain("setRefused((n) => n + 1);");
    // A field, then the first button of a marked group or its file picker; never the group itself, which can't take focus.
    expect(FIRST_PROBLEM).toBe(":invalid:not(form):not(fieldset), [aria-invalid='true'], [data-invalid='true'] button:not(:disabled), [data-invalid='true'] input:not(:disabled)");
  });

  it("announces a missing time, and marks the times for the focus", () => {
    expect(page).toContain('<span className="field-error" role="alert">Pick a time for your visit.</span>');
    expect(page).toContain('<span className="field-error" role="alert">Enter your {postalWord}, then pick a time.</span>');
    expect(page).toContain('<fieldset className="field" data-invalid={invalid || undefined} style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 10 }}>');
  });
});
