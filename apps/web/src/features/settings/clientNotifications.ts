/**
 * Settings → Client notifications, Jobber's list of what a business sends its clients by itself.
 * Each switch is one automation rule: the starter rule every business gets
 * (private.install_default_automations, latest in 20261105000210_on_my_way_eta.sql), so a
 * deleted one comes back from the recipe here, word for word.
 */
import { AUTOMATED_CAMPAIGNS, type StarterRule } from "@crewtavo/core/campaigns";
import { askRuleUpdate } from "@crewtavo/core/marketing";
import type { RuleRow } from "../automations/AutomationsPage";

export interface ClientNotification {
  label: string;
  recipe: Omit<StarterRule, "description"> & { description: string | null };
  /** Not one of the starters every business gets: it's made the first time it's turned on. */
  added?: boolean;
}

export const CLIENT_NOTIFICATIONS: ClientNotification[] = [
  {
    label: "Request received",
    added: true,
    recipe: {
      template_key: "request_received",
      name: "Tell clients their request came in",
      description: "Sent when someone asks for work from a booking or website form, the Client Hub or a referral.",
      trigger: "request.created",
      delay_minutes: 0,
      // Not for requests the office types in: the client already knows.
      conditions: [{ field: "source", op: "in", value: ["web_form", "hub", "referral"] }],
      actions: [
        {
          type: "send_email",
          subject: "{{company.name}} got your request",
          body: "Hi {{client.first_name}},\n\nThanks for reaching out. We got your request and will be in touch soon about the next step.\n\nQuestions? Reply to this email or call {{company.phone}}.\n\n{{company.name}}",
        },
      ],
      enabled: false,
    },
  },
  {
    label: "Visit and assessment reminders",
    recipe: {
      template_key: "visit_reminder",
      name: "Remind clients the day before a visit",
      description: "Sent the day before each scheduled visit or assessment.",
      trigger: "visit.reminder",
      delay_minutes: 0,
      conditions: [],
      actions: [
        {
          type: "send_email",
          subject: "Reminder: {{company.name}} is coming {{date}}",
          body: "Hi {{client.first_name}},\n\nThis is a reminder that {{company.name}} is scheduled to visit {{address}} on {{date}}{{time}}.\n\nQuestions? Reply to this email or call {{company.phone}}.",
        },
      ],
      enabled: false,
    },
  },
  {
    label: "On my way",
    recipe: {
      template_key: "on_my_way",
      name: "Text the client when the crew is on the way",
      description: "Sent when a crew taps “On my way” in the app.",
      trigger: "visit.en_route",
      delay_minutes: 0,
      conditions: [],
      // {{eta}}: " and should arrive in about 20 minutes", or nothing when that isn't known.
      actions: [{ type: "send_sms", body: "Hi {{client.first_name}}, this is {{company.name}}. Our crew is on the way to {{address}} now{{eta}}." }],
      enabled: false,
    },
  },
  { label: "Quote follow-up", recipe: AUTOMATED_CAMPAIGNS.close_quotes.starter },
  {
    label: "Invoice follow-up",
    recipe: {
      template_key: "invoice_overdue",
      name: "Remind clients when an invoice is past due",
      description: null,
      trigger: "invoice.overdue",
      delay_minutes: 0,
      conditions: [],
      actions: [
        {
          type: "send_email",
          subject: "Reminder: invoice #{{number}} from {{company.name}} is past due",
          body: "Hi {{client.first_name}},\n\nThis is a friendly reminder that invoice #{{number}} has a balance of {{balance}}. You can view and pay it here:\n\n{{link}}\n\nThank you,\n{{company.name}}",
        },
      ],
      enabled: true,
    },
  },
  // Marketing → Reviews edits the same rule.
  { label: "Review request after a job", recipe: askRuleUpdate(null, "after_job", { when: "job.completed", channel: "email", enabled: false }) as StarterRule },
];

type Rule = Pick<RuleRow, "id" | "template_key" | "trigger" | "actions" | "enabled">;

// The starter itself (its template_key), or else the first rule on the same trigger with the same kind of action.
export const ruleFor = <R extends Rule>(n: ClientNotification, rules: R[]): R | undefined =>
  rules.find((r) => r.template_key === n.recipe.template_key) ??
  rules.find((r) => r.trigger === n.recipe.trigger && r.actions.some((a) => a.type === n.recipe.actions[0]!.type));
