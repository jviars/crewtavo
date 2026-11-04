/**
 * Settings → Client notifications (features/settings/clientNotifications.ts): which rule each
 * switch turns on and off, the starters it puts back word for word, and who sees it.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { evaluateConditions, type Action, type Condition } from "@crewtavo/core/automations";
import { describe, expect, it } from "vitest";
import { CLIENT_NOTIFICATIONS, ruleFor } from "../src/features/settings/clientNotifications";
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

describe("the starters a switch puts back", () => {
  const install = readFileSync(fileURLToPath(new URL("../../../supabase/migrations/20261105000210_on_my_way_eta.sql", import.meta.url)), "utf8");
  /** A string as the migrations write it: E'…' with '' for a quote and \n for a new line. */
  const sql = (text: string) => (text.includes("\n") ? `E'${text.replace(/'/g, "''").replace(/\n/g, "\\n")}'` : `'${text.replace(/'/g, "''")}'`);

  it("are the latest install_default_automations', word for word", () => {
    for (const { recipe: r } of CLIENT_NOTIFICATIONS.filter((n) => !n.added)) {
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
    expect(group("owner", [], "Self-hosting")).toEqual(["Web address", "Hosting", "Storage"]);
  });
});
