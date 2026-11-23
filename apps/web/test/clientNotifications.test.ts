/**
 * Settings → Client notifications (features/settings/clientNotifications.ts): which rule each
 * switch turns on and off, the starters it puts back word for word, and who sees it.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { evaluateConditions, type Action, type Condition } from "@crewtavo/core/automations";
import { describe, expect, it } from "vitest";
import { channelsOf, CLIENT_NOTIFICATIONS, otherVisitRules, ruleFor } from "../src/features/settings/clientNotifications";
import { settingsGroups } from "../src/features/settings/sections";

const notification = (label: string) => CLIENT_NOTIFICATIONS.find((n) => n.label === label)!;
const rule = (id: string, trigger: string, actions: Action[], template_key: string | null = null) => ({ id, trigger, actions, template_key, enabled: false });

describe("a client notification's rule", () => {
  const reminder = notification("Visit and assessment reminders");
  const email: Action[] = [{ type: "send_email", subject: "See you tomorrow", body: "Hi" }];

  it("is the starter rule, however it was edited, before any other rule on the same trigger", () => {
    const own = rule("own", "visit.reminder", email);
    const starter = rule("starter", "visit.reminder", [{ type: "send_sms", body: "Tomorrow!" }], "visit_reminder");
    expect(ruleFor(reminder, [own, starter])?.id).toBe("starter");
  });

  it("is a rule on the same trigger with the same kind of action, when the starter was deleted", () => {
    expect(ruleFor(reminder, [rule("tell-office", "visit.reminder", [{ type: "notify", roles: ["office"], title: "Visit" }]), rule("own", "visit.reminder", email)])?.id).toBe("own");
    // Asking for referrals after a job isn't the review request.
    expect(ruleFor(notification("Review request after a job"), [rule("referral", "job.completed", [{ type: "request_referral" }], "referral_after_job")])).toBeUndefined();
    expect(ruleFor(reminder, [])).toBeUndefined();
  });
});

describe("the request received email", () => {
  it("goes out for requests clients send, not ones the office types in", () => {
    const conditions = notification("Request received").recipe.conditions as Condition[];
    for (const source of ["web_form", "hub", "referral"]) expect(evaluateConditions(conditions, { source }, "request").pass).toBe(true);
    for (const source of ["manual", "phone", "email", "assistant"]) expect(evaluateConditions(conditions, { source }, "request").pass).toBe(false);
  });
});

describe("what a client hears about a visit", () => {
  const visit = CLIENT_NOTIFICATIONS.filter((n) => n.visit);

  it("is together, in the order it happens: booked, moved, cancelled, the reminder, on the way", () => {
    expect(visit.map((n) => n.label)).toEqual(["Visit booked", "Visit moved", "Visit cancelled", "Visit and assessment reminders", "On my way"]);
    expect(visit.map((n) => n.recipe.trigger)).toEqual(["visit.scheduled", "visit.rescheduled", "visit.cancelled", "visit.reminder", "visit.en_route"]);
    expect(CLIENT_NOTIFICATIONS.filter((n) => !n.visit).map((n) => n.label)).toEqual(["Request received", "Quote follow-up", "Invoice follow-up", "Review request after a job"]);
  });

  it("says when a booking, a move and a cancelling go, and what a move is", () => {
    const note = (label: string) => notification(label).note ?? "";
    for (const label of ["Visit booked", "Visit moved", "Visit cancelled"]) expect(note(label)).toContain("Goes 10 minutes after the change");
    expect(note("Visit booked")).toContain("Not for the visits a recurring job makes");
    expect(note("Visit moved")).toContain("its start time changes by an hour or more");
    expect(note("Visit moved")).toContain("arrival window");
    expect(note("Visit cancelled")).toContain("cancelled, deleted or taken off the schedule");
  });

  it("includes the business's own rules that message a client about a visit, and no others", () => {
    const starter = rule("starter", "visit.reminder", [{ type: "send_email", subject: "Tomorrow", body: "Hi" }], "visit_reminder");
    const second = rule("second", "visit.reminder", [{ type: "send_sms", body: "Tomorrow" }]);
    const thanks = rule("thanks", "visit.completed", [{ type: "add_tag", tag: "Visited" }, { type: "send_email", subject: "Thanks", body: "Hi" }]);
    const office = rule("office", "visit.scheduled", [{ type: "notify", roles: ["office"], title: "Booked" }]);
    const asked = rule("asked", "visit.reschedule_requested", [{ type: "send_email", subject: "We got it", body: "Hi" }]);
    const quote = rule("quote", "quote.sent", [{ type: "send_email", subject: "Quote", body: "Hi" }]);
    const all = [starter, second, thanks, office, asked, quote];
    const shown = CLIENT_NOTIFICATIONS.map((n) => ruleFor(n, all));
    expect(otherVisitRules(all, shown).map((r) => r.id)).toEqual(["second", "thanks"]);
  });

  it("says how each reaches the client", () => {
    expect(channelsOf(notification("Visit booked").recipe)).toBe("Email");
    expect(channelsOf(notification("On my way").recipe)).toBe("Text");
    expect(channelsOf({ actions: [{ type: "send_email", subject: "Moved", body: "Hi" }, { type: "send_sms", body: "Moved" }] })).toBe("Email and text");
    expect(channelsOf({ actions: [{ type: "request_review", channel: "both" }] })).toBe("Email and text");
    expect(channelsOf({ actions: [{ type: "request_review", channel: "sms" }] })).toBe("Text");
    expect(channelsOf({ actions: [{ type: "notify", roles: ["office"], title: "Booked" }] })).toBe("No message");
  });
});

describe("the starters a switch puts back", () => {
  const read = (name: string) => readFileSync(fileURLToPath(new URL(`../../../supabase/migrations/${name}`, import.meta.url)), "utf8");
  // A visit booked, moved or cancelled has its own (private.install_visit_notice_rules); the rest are install_default_automations'.
  const defaults = read("20261105000210_on_my_way_eta.sql");
  const visits = read("20261113000510_visit_notice_rules.sql");
  /** A string as the migrations write it: E'…' with '' for a quote and \n for a new line. */
  const sql = (text: string) => (text.includes("\n") ? `E'${text.replace(/'/g, "''").replace(/\n/g, "\\n")}'` : `'${text.replace(/'/g, "''")}'`);

  it("are the latest starters in the database, word for word", () => {
    expect(CLIENT_NOTIFICATIONS.filter((n) => n.recipe.template_key.startsWith("visit_") && n.recipe.template_key !== "visit_reminder").map((n) => n.recipe.template_key)).toEqual(["visit_scheduled", "visit_rescheduled", "visit_cancelled"]);
    for (const { recipe: r } of CLIENT_NOTIFICATIONS.filter((n) => !n.added)) {
      const install = ["visit_scheduled", "visit_rescheduled", "visit_cancelled"].includes(r.template_key) ? visits : defaults;
      expect(install, r.template_key).toContain(`(p_company, '${r.template_key}', ${sql(r.name)},\n     ${r.description === null ? "null" : sql(r.description)}, '${r.trigger}', ${r.delay_minutes},`);
      for (const a of r.actions) {
        if (a.type === "send_email") expect(install, r.template_key).toContain(`'subject', ${sql(a.subject)},\n       'body', ${sql(a.body)})`);
        if (a.type === "send_sms") expect(install, r.template_key).toContain(`'body', ${sql(a.body)})`);
      }
    }
  });
});

describe("Client notifications in Settings", () => {
  const session = (role: string, permissions: string[]) => ({ role, permissions, config: { singleCompany: true, platform: "railway" } }) as never;
  const group = (role: string, permissions: string[], title: string) => settingsGroups(session(role, permissions)).find((g) => g.title === title)?.items.map((i) => i.label) ?? [];

  it("is for the people who see Automations, with booking and email", () => {
    expect(group("owner", [], "Client communication")).toEqual(["Online booking", "Client notifications", "Email"]);
    expect(group("office", ["automations"], "Client communication")).toContain("Client notifications");
    expect(group("office", ["settings"], "Client communication")).not.toContain("Client notifications");
    expect(group("estimator", ["automations"], "Client communication")).not.toContain("Client notifications");
    expect(group("owner", [], "About")).toEqual(["Storage", "Web address", "Hosting", "Terms and license"]);
    expect(group("crew_lead", [], "About")).toEqual(["Terms and license"]);
  });
});
